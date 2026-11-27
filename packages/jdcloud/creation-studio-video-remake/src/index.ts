/** JDCloud-authenticated reference-video analysis for the Creation Studio workbench. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { RemakeSourceLine } from './analysis.ts'
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import z from '@deepseek-ai/schemastery'
import { AnalysisError, dialogueOf, durationOf, MAX_WORKER_CONCURRENCY, prepareSource, readUpload, requestWorker, shotsOf } from './analysis.ts'
import { createUploadQueue } from './upload-queue.ts'

export { AnalysisError as VideoRemakeError, dialogueOf as readRemakeDialogue, shotsOf as readRemakeShots } from './analysis.ts'

const prefix = '/api/external/v1/creation-studio/video-remake'
const mib = 1024 * 1024

/** A reference video's analysis and the exact amount to settle. */
export interface RemakeUsage {
  /** Verified source duration, in seconds. */
  duration: number
  /** Measured cut times, in playback order. */
  shots: { start: number; end: number }[]
  /** Full-source transcript. Receipts issued before transcription omit this field. */
  dialogue?: RemakeSourceLine[]
  /** Number of bytes received by the Host. */
  bytes: number
  /** Final charge in hundredths of a point. */
  cents: number
  /** Published launch rates in hundredths of a point. */
  rates: { secondCents: number; mibCents: number }
}

type RemakeConfirmation = { spaceId: Branded<'CreationStudioSpaceId'>; requestId: Branded<'VideoRemakeRequestId'>; maxCents: number }

/** Direct operations use the authenticated JDCloud account's space and ledger. */
export interface CreationStudioRemakeBilling {
  /**
   * Authorize an editor, reuse a previously saved result, and confirm its ledger debit.
   * @param input - Current space, stable operation ID, uploaded bytes digest and approved ceiling.
   * @param perform - Measure and analyze on a new request. The callback checks the available balance before analysis.
   * @returns The measured result and the amount verified against the ledger.
   */
  settle(
    input: RemakeConfirmation & { digest: string },
    perform: (checkBalance: (cents: number) => Promise<void>) => Promise<RemakeUsage>,
  ): Promise<RemakeUsage>
  /**
   * Verify the caller's saved operation without starting a charge or analysis.
   * @param input - The original space, operation ID, approved ceiling, and optional source digest for conversion.
   * @returns The stored analysis after verifying its ledger debit.
   */
  checkRemake(input: RemakeConfirmation & { digest?: string }): Promise<RemakeUsage>
}

/** Private analysis worker, rates, and operation limits. */
export interface Config {
  /** Private HTTP(S) endpoint accepting one video per POST. */
  workerURL?: string
  /** Hundredths of a point for one started second. */
  secondCents?: number
  /** Hundredths of a point for one started MiB. */
  mibCents?: number
  /** Existing platform automation that deducts directly from the space balance. */
  balanceDebitAssistant?: {
    /** JDCloud data assistant ID. */
    id: string
    /** ID of the node that commits the space balance update. */
    nodeId: string
  }
  /** Maximum request size in bytes. */
  maxBytes: number
  /** Whole-request deadline, including queueing, authentication, upload and analysis. */
  timeoutMs: number
  /** Use the worker's advertised capacity or set a lower limit for this Host. */
  concurrency: 'auto' | number
  /** Number of additional worker requests allowed to wait on this Host. */
  maxQueued: number
}

/** Stable Loader plugin name. */
export const name = 'creation-studio-video-remake'
/** Host services required by the authenticated HTTP operation. */
export const inject = ['jdcloudAuthController', 'webServer']

/** Validate independent deployment limits before registering the route. */
export const Config = z.object({
  workerURL: z.string(),
  secondCents: z.natural().min(1).max(1_000),
  mibCents: z.natural().min(1).max(1_000),
  balanceDebitAssistant: z.object({
    id: z.string().pattern(/^[a-f0-9]{24}$/iu),
    nodeId: z.string().pattern(/^[\w-]+$/u),
  }),
  maxBytes: z.natural().min(1).max(30 * mib).default(30 * mib),
  timeoutMs: z.natural().min(1).max(420_000).default(210_000),
  concurrency: z.union(['auto', z.natural().min(1).max(MAX_WORKER_CONCURRENCY)]).default('auto'),
  maxQueued: z.natural().max(64).default(8),
})

/**
 * Compose the uploader with the media plugin's private settlement callback.
 * @param platformURL - JDCloud origin that authenticates the caller.
 * @param tenantId - Tenant authorized to use the uploader.
 * @param billing - Space authorization and settlement owned by the parent plugin.
 * @returns A child plugin with its own reversible HTTP registrations.
 */
export function videoRemakePlugin(platformURL: string, tenantId: string, billing: CreationStudioRemakeBilling): Plugin.Object<Config> {
  return {
    name,
    inject,
    apply(ctx, config) {
      registerRoutes(ctx, config, platformURL, tenantId, billing)
    },
  }
}

function registerRoutes(ctx: Context, config: Config, platformURL: string, tenantId: string, billing: CreationStudioRemakeBilling): void {
  const platform = new URL(platformURL)
  const worker = config.workerURL ? new URL(config.workerURL) : undefined
  const probe = worker ? new URL('./probe', worker) : undefined
  const sourceWorker = worker ? new URL('./prepare-source', worker) : undefined
  const rates = config.secondCents && config.mibCents ? { secondCents: config.secondCents, mibCents: config.mibCents } : undefined
  if (platform.protocol !== 'https:' || platform.href !== platform.origin + '/'
    || !/^[a-f0-9]{24}$/iu.test(tenantId)
    || (worker && (!['http:', 'https:'].includes(worker.protocol) || worker.username || worker.password || worker.hash || worker.search))
    || Boolean(config.secondCents) !== Boolean(config.mibCents)) {
    throw new HarnessError('Invalid Creation Studio video analysis configuration.', 'video-remake/config')
  }
  const lifetime = new AbortController()
  const initialConcurrency = config.concurrency === 'auto' ? 1 : config.concurrency
  const concurrencyLimit = config.concurrency === 'auto' ? MAX_WORKER_CONCURRENCY : config.concurrency
  const uploadQueue = createUploadQueue(initialConcurrency, config.maxQueued)
  const active = new Set<Promise<void>>()

  for (const action of ['quote', 'analyze', 'status', 'prepare-source'] as const) ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/${action}`,
      auth: 'anonymous',
      handler(req, res) {
        function send(status: number, payload: object): void {
          if (res.destroyed) return
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ code: status, ...payload }))
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          send(405, { errorCode: 'video-remake/method', message: '请使用 POST 上传视频。' })
          return
        }
        // The raw JDCloud credential may itself contain an authorization scheme.
        const token = /^Bearer\s+(.+)$/iu.exec(req.headers.authorization ?? '')?.[1]?.trim()
        if (!token || req.headers['x-tenant-id'] !== tenantId) {
          send(401, { errorCode: 'video-remake/auth', message: '请重新登录后上传视频。' })
          return
        }
        if (!worker || !probe || !sourceWorker || !rates) {
          const message = !worker ? '参考视频拆解服务未启用，请检查 Harness 和拆解 Worker 配置。'
            : '参考视频拆解尚未配置积分单价，请联系管理员。'
          send(503, { errorCode: 'video-remake/not-configured', message })
          return
        }
        const spaceId = req.headers['x-studio-space-id']
        const requestId = req.headers['x-studio-request-id']
        const maxCents = Number(req.headers['x-studio-remake-max-cents'])
        const confirmed = typeof spaceId === 'string' && /^[a-f0-9]{24}$/iu.test(spaceId)
          && typeof requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
          && Number.isSafeInteger(maxCents) && maxCents >= 1 && maxCents <= 60_000
        if (action !== 'quote' && !confirmed) {
          send(400, { errorCode: 'video-remake/invalid-confirmation', message: '请先获取报价并确认拆解费用。' })
          return
        }
        const confirmation = confirmed ? {
          spaceId: brandString<Branded<'CreationStudioSpaceId'>>(spaceId),
          requestId: brandString<Branded<'VideoRemakeRequestId'>>(requestId),
          maxCents,
        } : undefined
        const disconnect = new AbortController()
        const signal = AbortSignal.any([lifetime.signal, disconnect.signal, AbortSignal.timeout(config.timeoutMs)])
        const onClose = () => { disconnect.abort() }
        res.once('close', onClose)
        let authorized = false
        const run = () => ctx.jdcloudAuthController.runExternalRequest(token, tenantId, platform.origin, signal, async () => {
          authorized = true
          if (action === 'status' && confirmation) return billing.checkRemake(confirmation)
          const bytes = await readUpload(req, config.maxBytes, signal)
          if (action === 'prepare-source' && confirmation) {
            const digest = createHash('sha256').update(bytes).digest('hex')
            await billing.checkRemake({ ...confirmation, digest })
            return prepareSource(bytes, sourceWorker, config.maxBytes, signal)
          }
          const quote = async () => {
            const { data, concurrency } = await requestWorker(bytes, probe, signal)
            const duration = durationOf(data)
            uploadQueue.setConcurrency(Math.min(concurrency ?? initialConcurrency, concurrencyLimit))
            const cents = Math.ceil(duration) * rates.secondCents + Math.ceil(bytes.length / mib) * rates.mibCents
            return { duration, bytes: bytes.length, cents, rates }
          }
          if (action === 'quote' || !confirmation) return quote()
          const digest = createHash('sha256').update(bytes).digest('hex')
          return billing.settle({ ...confirmation, digest }, async (checkBalance) => {
            const actual = await quote()
            if (actual.cents > maxCents)
              throw new AnalysisError(409, 'quote-changed', '拆解费用有变化，请重新获取报价后确认。')
            await checkBalance(actual.cents)
            const { data: result } = await requestWorker(bytes, worker, signal)
            const shots = shotsOf(result, actual.duration)
            const dialogue = dialogueOf(typeof result === 'object' && result !== null && 'dialogue' in result ? result.dialogue : undefined, actual.duration, shots)
            signal.throwIfAborted()
            return { ...actual, shots, dialogue }
          })
        })
        const task = (action === 'status' ? run() : uploadQueue.run(signal, run, action === 'analyze' ? confirmation?.spaceId : undefined)).then((data) => {
          if (Buffer.isBuffer(data)) {
            if (res.destroyed) return
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Cache-Control': 'no-store' })
            res.end(data)
          } else {
            send(200, { data })
          }
        }).catch((cause: unknown) => {
          if (cause instanceof AnalysisError) {
            send(cause.status, { errorCode: cause.code, message: cause.message })
            return
          }
          if (signal.aborted) {
            if (action === 'prepare-source') {
              send(504, { errorCode: 'video-remake/source-timeout', message: '转换参考视频超时，请重试进入分镜资产。' })
            } else {
              send(504, { errorCode: 'video-remake/timeout', message: '视频拆解超时，请重试。' })
            }
            return
          }
          if (!authorized && cause instanceof Error && 'code' in cause
            && (cause.code === 'jdcloud/auth-required' || cause.code === 'jdcloud/external-tenant-forbidden')) {
            send(401, { errorCode: 'video-remake/auth', message: '登录已失效或租户不匹配，请重新登录。' })
            return
          }
          if (action === 'prepare-source') {
            ctx.logger.warn('Creation Studio reference video conversion failed (%s)', authorized ? 'conversion' : 'authentication')
            send(503, { errorCode: 'video-remake/source-unavailable', message: '参考视频转存失败，请检查拆解 Worker 后重试进入分镜资产。' })
            return
          }
          ctx.logger.warn('Creation Studio video analysis failed (%s)', authorized ? 'analysis' : 'authentication')
          send(503, { errorCode: 'video-remake/unavailable', message: '视频拆解服务暂不可用，请稍后重试。' })
        }).finally(() => {
          active.delete(task)
          res.off('close', onClose)
        })
        active.add(task)
        return task
      },
    })
    return async () => {
      unregister()
      lifetime.abort()
      await Promise.allSettled(active)
    }
  }, `${name}:${action}`)
}
