/** Host-only account credentials and durable generation reservations; public receipts contain account IDs only. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createAccountPoolReader } from './account-pool-reader.mjs'
import { SEEDANCE_MODELS } from './seedance-request.mjs'
import { assertSpacePoints } from './project-points.mjs'

const open = new Set(['reserved', 'submitting', 'pending', 'queued', 'running', 'unknown', 'in_queue', 'generating'])
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (message, code) => Object.assign(new Error(message), { code, status: 503 })
const modelsByKind = {
  ark: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', ...SEEDANCE_MODELS.map(model => model.value)],
  jimeng: ['jimeng_t2i_v40'],
}

/**
 * Allocate least-loaded accounts, randomizing ties, within one Host state directory.
 * @param config - Fixed tenant, private account table, and reader credential reference.
 * @param auth - Current caller identity, used only for audit attribution.
 * @param keys - Host credential resolver; a missing pool reader enables numbered environment credentials.
 * @param fetcher - Transport for the fixed private platform.
 * @returns Account acquisition, original-account resolution, and durable settlement operations.
 */
export function createProviderAccountPool(config, auth, keys, fetcher = fetch) {
  const directory = join(config.stateDirectory, 'provider-calls')
  const reader = createAccountPoolReader(config, keys, fetcher)
  const capacityWaiters = new Set()
  let queueStopped = false
  let tail = Promise.resolve()
  const serial = operation => {
    const next = tail.then(operation)
    tail = next.catch(() => { /* The caller receives the failure; later acquisitions must still run. */ })
    return next
  }
  async function persist(receipt) {
    const path = join(directory, `${receipt.providerLeaseId}.json`)
    await writeFileAtomic(path, JSON.stringify(receipt), { mode: 0o600, dirMode: 0o700 })
  }
  async function environmentAccount(kind) {
    const row = kind === 'ark'
      ? { apiKey: await keys(config.arkKeyRef || 'ARK_API_KEY') }
      : { accessKeyId: await keys(config.jimengAccessKeyRef || 'JIMENG_ACCESS_KEY_ID'),
          secretAccessKey: await keys(config.jimengSecretKeyRef || 'JIMENG_SECRET_ACCESS_KEY') }
    return (kind === 'ark' ? row.apiKey : row.accessKeyId && row.secretAccessKey)
      ? { ...row, _id: `env-${kind}`, accountCode: `ENV-${kind.toUpperCase()}`, enabled: true, models: modelsByKind[kind], scenarios: kind === 'ark' ? ['image', 'video'] : ['image'], maxConcurrent: Number.MAX_SAFE_INTEGER } : undefined
  }
  async function accounts(kind) {
    const call = await reader()
    if (!call) {
      // Existing deployments keep explicit numbered credentials until the private table reader is configured.
      const row = await environmentAccount(kind)
      return row ? [row] : []
    }
    const identity = await call('/api/oauth/currentUser')
    if (identity.userInfo?.corpId !== config.tenantId)
      throw failure('账号池服务凭据不属于当前租户。', 'accounts/tenant-mismatch')
    const result = []
    for (let page = 1; ; page++) {
      const data = await call('/api/visualdev/form/list', {
        menuId: config.accountPoolTableId || '6aead43ac3ca9f3dcdaf4b23', currentPage: page, pageSize: 200,
        connect: 'and', association: false, userInfoConvert: false,
        filter: [{ enCode: 'provider', method: 'eq', type: 'custom', value: kind }],
      })
      if (!Array.isArray(data?.list))
        throw failure('账号池返回格式异常。', 'accounts/invalid-response')
      result.push(...data.list)
      if (data.list.length < 200 || result.length >= Number(data.pagination?.total)) break
    }
    const codes = new Set()
    const credentials = new Set()
    for (const row of result) {
      const secret = kind === 'ark' && typeof row.apiKey === 'string' ? row.apiKey.trim().replace(/^Bearer\s+/iu, '') : kind === 'ark' ? row.apiKey : row.accessKeyId
      if (row.provider !== kind || !/^[a-f0-9]{24}$/iu.test(row._id || '')
        || typeof row.accountCode !== 'string' || !row.accountCode.trim() || codes.has(row.accountCode.trim())
        || !Number.isSafeInteger(row.maxConcurrent) || row.maxConcurrent < 1
        || !Array.isArray(row.scenarios) || !row.scenarios.length || row.scenarios.some(value => !['image', 'video'].includes(value))
        || !Array.isArray(row.models) || !row.models.length || row.models.some(model => !modelsByKind[kind].includes(model))
        || typeof secret !== 'string' || !secret.trim() || credentials.has(secret.trim())
        || (kind === 'jimeng' && (typeof row.secretAccessKey !== 'string' || !row.secretAccessKey.trim())))
        throw failure('账号池存在无效编号、模型、重复密钥、缺失凭据或并发上限，请由管理员核对。', 'accounts/invalid-account')
      row.accountCode = row.accountCode.trim()
      if (kind === 'ark') row.apiKey = secret.trim()
      else {
        row.accessKeyId = secret.trim()
        row.secretAccessKey = row.secretAccessKey.trim()
      }
      codes.add(row.accountCode)
      credentials.add(secret.trim())
    }
    return result
  }
  async function reservations() {
    let files
    try { files = await readdir(directory) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
      .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
  }
  /** Waiting happens outside the reservation lock so settlement can release account slots. */
  async function acquire(kind, input, waitForCapacity) {
    for (;;) {
      let wake
      // Register before reading capacity; a settlement during that read cannot be missed.
      const changed = waitForCapacity ? new Promise(resolve => { wake = resolve; capacityWaiters.add(wake) }) : undefined
      try {
        return await serial(async () => {
          if (queueStopped)
            throw failure('媒体账号队列正在停止，排队任务已保留。', 'accounts/queue-stopped')
          // 图片、视频和白底图只在新占用供应商账号时查积分，原任务查询不受余额影响。
          await assertSpacePoints(auth, input.spaceId)
          const rows = await accounts(kind)
          const receipts = await reservations()
          const loads = new Map()
          for (const receipt of receipts.filter(item => open.has(item.status)))
            loads.set(receipt.providerAccountId, (loads.get(receipt.providerAccountId) || 0) + 1)
          const eligible = rows.filter(row => [true, 1, '1'].includes(row.enabled) && row.scenarios.includes(input.scenario) && row.models.includes(input.model))
          if (!eligible.length)
            throw failure('没有启用且支持该模型的媒体账号，请联系管理员配置账号池。', 'accounts/unavailable')
          const available = eligible.filter(row => (loads.get(row._id) || 0) < row.maxConcurrent)
          if (!available.length)
            throw failure('媒体账号并发已满，请等待当前任务完成后重试。', 'accounts/busy')
          const minimum = Math.min(...available.map(row => (loads.get(row._id) || 0) / row.maxConcurrent))
          const candidates = available.filter(row => (loads.get(row._id) || 0) / row.maxConcurrent === minimum)
          const account = candidates[Math.floor(Math.random() * candidates.length)]
          const user = await auth.requestAuthenticated({ path: '/api/oauth/currentUser', method: 'GET' }, AbortSignal.timeout(30_000))
          if (user.userInfo?.corpId !== config.tenantId || !user.userInfo?.id)
            throw failure('媒体调用的操作者身份无效。', 'accounts/invalid-caller')
          if (queueStopped)
            throw failure('媒体账号队列正在停止，排队任务已保留。', 'accounts/queue-stopped')
          const receipt = {
            providerLeaseId: digest([kind, input.spaceId, input.projectId, input.planId, input.requestId, randomUUID()]),
            providerAccountId: account._id, providerAccountRef: account.accountCode, provider: kind,
            scenario: input.scenario, model: input.model, requestId: input.requestId,
            projectId: input.projectId, planId: input.planId, spaceId: input.spaceId,
            initiatedByUserId: user.userInfo.id, createdAt: new Date().toISOString(), status: 'reserved',
          }
          await persist(receipt)
          return { account, receipt }
        })
      }
      catch (error) {
        if (!waitForCapacity || error.code !== 'accounts/busy')
          throw error
        await changed
      }
      finally {
        if (wake) capacityWaiters.delete(wake)
      }
    }
  }
  return {
    /** Reserve immediately; full accounts reject without submitting a provider request. */
    acquire: (kind, input) => acquire(kind, input, false),
    /** Wait for a released slot; missing accounts and stopped queues reject explicitly. */
    waitForAccount: (kind, input) => acquire(kind, input, true),
    /** Stop unreserved work without cancelling already-submitted provider requests. */
    stopQueue() {
      queueStopped = true
      for (const wake of capacityWaiters) wake()
    },
    /** Disabled accounts remain usable for their original async task; another key never replaces a missing account. */
    async resolve(kind, receipt) {
      const row = receipt.providerAccountId === `env-${kind}`
        ? await environmentAccount(kind)
        : (await accounts(kind)).find(item => item._id === receipt.providerAccountId)
      if (!row) throw failure('原任务账号已移除或无法读取，请恢复原账号后继续查询。', 'accounts/original-account-missing')
      return row
    },
    /** Persist only task status and provider request identity, never credentials or raw provider diagnostics. */
    settle(receipt, status, providerRequestId) {
      if (!receipt.providerLeaseId) return Promise.resolve()
      return serial(async () => {
        const previous = JSON.parse(await readFile(join(directory, `${receipt.providerLeaseId}.json`), 'utf8'))
        await persist({ ...previous, status, providerRequestId, updatedAt: new Date().toISOString() })
        if (!open.has(status))
          for (const wake of capacityWaiters) wake()
      })
    },
    async configured(kind, scenario, model) {
      return (await accounts(kind)).some(row => [true, 1, '1'].includes(row.enabled) && row.scenarios.includes(scenario)
        && (model ? row.models.includes(model) : row.models.some(value => scenario === 'video' ? value.includes('seedance') : !value.includes('seedance'))))
    },
  }
}
