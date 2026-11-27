/** Exercise the authenticated upload route through the assembled Web Loader. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const tenantId = '6ad80f2f1f280486bb45ac3a'
const jdcloudToken = 'bearer fixture-token'
const platform = 'https://video-remake.example'
const path = '/api/external/v1/creation-studio/video-remake/'
const spaceId = '0123456789abcdef01234567'
const viewerSpace = 'abcdef0123456789abcdef01'
const usageId = '123456789abcdef012345678'
const assistantId = '6aec39e14ecc1c457a578b36'
const bundleManifest = fileURLToPath(new URL('../../../packages/bundle/jdcloud-login/package.json', import.meta.url))

function fixtureObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') throw new Error('Expected JSON request data')
  const value: unknown = JSON.parse(body)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

it('quotes measured usage and releases cuts and dialogue after a single matching ledger debit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-remake-e2e-'))
  const workerRequests: string[] = []
  let charged = 0
  let points = '0.05'
  let ledgerState: 'pending' | 'settled' | 'duplicate' | 'unavailable' | 'empty' = 'pending'
  let assistantState: 'unrelated' | 'failed' | 'wrong-amount' | 'settled' | 'unavailable' = 'unrelated'
  const ledgerPages: number[] = []
  let usage: Record<string, unknown> | undefined
  let receivedAuthorization: string | undefined
  const dialogue = [{ start: 0.6, end: 1.8, original: '早上好。', shotNumber: 1 }, { start: 2, end: 4, original: '欢迎来做客。', shotNumber: 2 }]
  let speech: 'old-worker' | 'failure' | 'unassigned' | 'invalid' | 'ready' = 'old-worker'
  let workerConcurrency: string | undefined
  let pauseProbe: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined
  const worker = createServer((req, res) => {
    workerRequests.push(req.url ?? '')
    receivedAuthorization = req.headers.authorization
    req.once('end', async () => {
      if (req.url === '/probe' && pauseProbe) {
        const paused = pauseProbe
        pauseProbe = undefined
        paused.entered.resolve(undefined)
        await paused.release.promise
      }
      if (req.url === '/prepare-source') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' })
        res.end('0000ftypisom')
        return
      }
      if (req.url === '/analyze' && speech === 'failure') {
        res.writeHead(503, { 'X-Remake-Error': 'speech-recognition' })
        res.end('{}')
        return
      }
      if (req.url === '/probe' && workerConcurrency !== undefined) res.setHeader('X-Remake-Worker-Concurrency', workerConcurrency)
      res.end(JSON.stringify({ duration: 6.1, shots: [{ start: 0, end: 2 }, { start: 2, end: 6.1 }], privatePath: '/tmp/worker',
        ...(req.url === '/analyze' && speech === 'invalid' && { dialogue: [{ start: 1, end: 3, original: '超出镜头', shotNumber: 1 }] }),
        ...(req.url === '/analyze' && speech === 'unassigned' && { dialogue: [{ start: 1, end: 3, original: '旧版转写' }] }),
        ...(req.url === '/analyze' && speech === 'ready' && { dialogue: [...dialogue].reverse().map(line => ({ ...line, privatePath: '/tmp/worker' })) }),
      }))
    })
    req.resume()
  })
  try {
    const listening = once(worker, 'listening')
    worker.listen(0, '127.0.0.1')
    await listening
    const address = worker.address()
    if (address === null || typeof address === 'string') throw new Error('No analysis worker port')
    const overlay = join(root, 'video-remake.overlay.yml')
    await writeFile(overlay, `- insert:
    - id: jdcloud-auth-controller
      name: '@deepseek-ai/dsh-api-jdcloud-auth-controller'
    - id: creation-studio-media
      name: '@deepseek-ai/dsh-creation-studio-media'
      config:
        platformURL: ${platform}
        tenantId: ${tenantId}
        stateDirectory: ${JSON.stringify(join(root, 'media'))}
        videoRemake:
          workerURL: http://127.0.0.1:${address.port}/analyze
          secondCents: 2
          mibCents: 1
          maxBytes: 64
          maxQueued: 1
          balanceDebitAssistant:
            id: ${assistantId}
            nodeId: update2
`)
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.origin !== platform) return realFetch(input, init)
      if (new Headers(init?.headers).get('authorization') !== jdcloudToken) {
        return Response.json({ code: 600, msg: 'Unauthorized' })
      }
      const payload = init?.body ? fixtureObject(init.body) : {}
      const reply = (data: unknown) => Response.json({ code: 200, data })
      switch (url.pathname) {
        case `/api/visualdev/dataAssistant/log/${assistantId}`: {
          expect(init?.method).toBe('POST')
          if (assistantState === 'unavailable') return Response.json({ code: 503 }, { status: 503 })
          const trigger = {
            _id: assistantState === 'unrelated' ? viewerSpace : usageId,
            spaceId, customerCharge: assistantState === 'wrong-amount' ? '0.16' : '0.15', chargeStatus: 'settled',
          }
          return reply({ list: [{
            id: '456789abcdef0123456789ab', triggerType: 'add', result: 'success', triggerData: trigger,
            nodeLogs: [{ triggerNodeId: 'start0', result: 'success' }, {
              triggerNodeId: 'update2', result: assistantState === 'failed' ? 'failed' : 'success',
              dataInfos: JSON.stringify([{ _id: spaceId, points: 2 }]),
            }],
          }] })
        }
        case '/api/oauth/currentUser': return reply({ userInfo: { id: 'video-user', userName: 'video-user', corpId: tenantId } })
        case '/api/visualdev/form/info': {
          return reply({ _id: payload._id, ownerUserId: payload._id === viewerSpace ? 'other-user' : 'video-user', status: 'active', points })
        }
        case '/api/visualdev/form/list': {
          if (payload.menuId === '6adb0fbec3ca9f3dcdaf499d') return reply({ list: [
            { status: 'active', role: 'viewer', userId: 'video-user', spaceId: viewerSpace },
          ] })
          if (payload.menuId === '6ad81c871f280486bb45ac5b') return reply({ list: usage ? [usage] : [] })
          if (payload.menuId === '6ad81c871f280486bb45ac5f') {
            if (ledgerState === 'unavailable') return Response.json({ code: 403 }, { status: 403 })
            expect(payload.filter).toContainEqual({ enCode: 'spaceId', method: 'eq', type: 'custom', value: spaceId })
            if (ledgerState === 'empty') return reply({ list: [], pagination: { total: 0 } })
            if (Array.isArray(payload.filter) && payload.filter.some(filter => filter.enCode === 'callId')) {
              if (ledgerState === 'settled') return Response.json({ code: 400 }, { status: 400 })
              return reply({ list: [], pagination: { total: 0 } })
            }
            const page = Number(payload.currentPage)
            ledgerPages.push(page)
            const debit = { _id: '23456789abcdef0123456789', callId: usageId, spaceId, kind: 'settle', pointsDelta: '-0.10' }
            const foreign = { ...debit, _id: '456789abcdef0123456789ab', spaceId: viewerSpace, pointsDelta: '-0.15' }
            if (ledgerState === 'pending') return reply({ list: [debit, foreign] })
            if (ledgerState === 'duplicate') return reply({ list: [debit, debit] })
            return reply({ list: page === 1 ? [debit] : [
              { ...debit, _id: '3456789abcdef0123456789a', pointsDelta: '-0.05' }, foreign,
            ], pagination: { total: 3 } })
          }
          throw new Error('Unexpected platform list')
        }
        case '/api/visualdev/form/create': {
          expect(payload.menuId).toBe('6ad81c871f280486bb45ac5b')
          usage = { ...fixtureObject(payload.data), _id: usageId }
          charged++
          return reply(usageId)
        }
        default: return reply({ corpId: tenantId, corpList: [{ corpId: tenantId, corpName: 'Video Studio' }], joinCorpList: [] })
      }
    })
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, extraInstallAnchors: [bundleManifest] })
    try {
      const headers = { 'Authorization': `Bearer ${jdcloudToken}`, 'X-Tenant-Id': tenantId, 'Content-Type': 'application/octet-stream' }
      const confirm = { ...headers, 'X-Studio-Space-Id': spaceId, 'X-Studio-Request-Id': '3941c4f0-456c-429e-a351-06660671d7a5', 'X-Studio-Remake-Max-Cents': '15' }
      const submit = (action: 'quote' | 'analyze' | 'status' | 'prepare-source', body: string | Uint8Array<ArrayBuffer> | undefined, auth: HeadersInit = headers) =>
        fetch(new URL(path + action, scaffold.authenticatedUrl), { method: 'POST', headers: auth, body: body ?? null, signal: AbortSignal.timeout(5000) })
      const video = new TextEncoder().encode('0000ftypqt  ')
      expect((await submit('quote', video, { ...headers, Authorization: 'Bearer' })).status).toBe(401)
      expect((await submit('quote', video, { ...headers, Authorization: 'Bearer bearer invalid-token' })).status).toBe(401)
      expect((await submit('quote', video, { ...headers, 'X-Tenant-Id': 'another-tenant' })).status).toBe(401)
      expect((await submit('quote', 'not video')).status).toBe(422)
      expect((await submit('quote', new Uint8Array(65))).status).toBe(413)
      expect((await submit('analyze', video)).status).toBe(400)
      expect((await submit('prepare-source', video)).status).toBe(400)
      expect((await submit('analyze', video, { ...confirm, 'X-Studio-Space-Id': viewerSpace })).status).toBe(403)
      expect((await submit('status', undefined, confirm)).status).toBe(404)
      expect((await submit('prepare-source', video, confirm)).status).toBe(404)
      expect(charged).toBe(0)
      expect(workerRequests).toEqual([])
      const rates = { secondCents: 2, mibCents: 1 }
      const measured = { duration: 6.1, bytes: video.byteLength, cents: 15, rates }
      const quote = await submit('quote', video)
      expect(quote.status).toBe(200)
      expect(await quote.json()).toEqual({ code: 200, data: measured })
      expect((await submit('analyze', video, { ...confirm, 'X-Studio-Remake-Max-Cents': '14' })).status).toBe(409)
      expect((await submit('analyze', video, confirm)).status).toBe(402)
      expect(workerRequests).toEqual(['/probe', '/probe', '/probe'])
      points = '2.00'
      for (const state of ['old-worker', 'failure', 'unassigned', 'invalid'] as const) {
        speech = state
        const incomplete = await submit('analyze', video, confirm)
        expect(incomplete.status).toBe(503)
        expect(await incomplete.json()).toMatchObject({ errorCode: 'video-remake/transcript-unavailable' })
        expect((await submit('status', undefined, confirm)).status).toBe(404)
        expect(charged).toBe(0)
      }
      speech = 'ready'
      const pending = await submit('analyze', video, confirm)
      expect(pending.status).toBe(503)
      expect(await pending.json()).toMatchObject({ errorCode: 'video-remake/settlement-pending' })
      expect(await (await submit('prepare-source', video, confirm)).json()).toMatchObject({ errorCode: 'video-remake/settlement-pending' })
      expect(charged).toBe(1)
      expect(usage).toMatchObject({ chargeStatus: 'settled', customerCharge: '0.15', usageSource: 'harness-video-remake' })
      expect((await submit('status', undefined, { ...confirm, 'X-Studio-Space-Id': viewerSpace })).status).toBe(403)
      ledgerState = 'unavailable'
      expect(await (await submit('status', undefined, confirm)).json()).toMatchObject({ code: 503, errorCode: 'video-remake/settlement-check-unavailable' })
      ledgerState = 'duplicate'
      expect(await (await submit('status', undefined, confirm)).json()).toMatchObject({ code: 409, errorCode: 'video-remake/settlement-conflict' })
      ledgerState = 'empty'
      points = '0.00'
      expect(await (await submit('status', undefined, confirm)).json()).toMatchObject({ code: 503, errorCode: 'video-remake/settlement-pending' })
      assistantState = 'failed'
      expect(await (await submit('status', undefined, confirm)).json()).toMatchObject({ code: 503, errorCode: 'video-remake/settlement-pending' })
      assistantState = 'wrong-amount'
      expect(await (await submit('status', undefined, confirm)).json()).toMatchObject({ code: 409, errorCode: 'video-remake/settlement-conflict' })
      assistantState = 'settled'
      const accepted = await submit('status', undefined, confirm)
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({
        code: 200, data: { ...measured, shots: [{ start: 0, end: 2 }, { start: 2, end: 6.1 }], dialogue },
      })
      assistantState = 'unavailable'
      expect((await submit('status', undefined, confirm)).status).toBe(200)
      ledgerState = 'settled'
      expect((await submit('status', undefined, confirm)).status).toBe(200)
      expect(ledgerPages.slice(-2)).toEqual([1, 2])
      expect((await submit('analyze', video, confirm)).status).toBe(200)
      expect((await submit('analyze', '0000ftypmp42', confirm)).status).toBe(409)
      expect((await submit('prepare-source', '0000ftypmp42', confirm)).status).toBe(409)
      expect((await submit('prepare-source', video, { ...confirm, 'X-Studio-Space-Id': viewerSpace })).status).toBe(403)
      const prepared = await submit('prepare-source', video, confirm)
      expect(prepared.status).toBe(200)
      expect(prepared.headers.get('content-type')).toBe('video/mp4')
      expect(await prepared.text()).toBe('0000ftypisom')
      expect(charged).toBe(1)
      expect(workerRequests).toEqual(['/probe', '/probe', '/probe',
        ...Array.from({ length: 5 }, () => ['/probe', '/analyze']).flat(), '/prepare-source'])
      expect(receivedAuthorization).toBeUndefined()

      const firstProbe = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
      pauseProbe = firstProbe
      const beforeBurst = workerRequests.length
      const firstQuote = submit('quote', video)
      const queued: Promise<Response>[] = []
      try {
        await Promise.race([firstProbe.entered.promise, firstQuote.then((response) => {
          throw new Error(`First quote returned ${response.status} before reaching the worker.`)
        })])
        queued.push(submit('quote', video), submit('quote', video))
        const overflow = await Promise.race(queued)
        expect(overflow.status).toBe(503)
        expect(await overflow.clone().json()).toMatchObject({ errorCode: 'video-remake/queue-full' })
        expect(workerRequests.slice(beforeBurst)).toEqual(['/probe'])
        expect((await submit('status', undefined, confirm)).status).toBe(200)
        expect(charged).toBe(1)
      } finally {
        firstProbe.release.resolve(undefined)
        await Promise.allSettled([firstQuote, ...queued])
      }
      expect((await firstQuote).status).toBe(200)
      expect((await Promise.all(queued)).map(result => result.status).sort()).toEqual([200, 503])
      expect(workerRequests.slice(beforeBurst)).toEqual(['/probe', '/probe'])
      expect(charged).toBe(1)

      workerConcurrency = '8'
      const invalidCapacity = await submit('quote', video)
      expect(invalidCapacity.status).toBe(502)
      expect(await invalidCapacity.json()).toMatchObject({ errorCode: 'video-remake/worker-result' })
      workerConcurrency = '2'
      expect((await submit('quote', video)).status).toBe(200)
      const parallelProbe = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
      pauseProbe = parallelProbe
      const earlier = submit('quote', video)
      try {
        await Promise.race([parallelProbe.entered.promise, earlier.then((response) => {
          throw new Error(`First parallel quote returned ${response.status} before reaching the worker.`)
        })])
        expect((await submit('quote', video)).status).toBe(200)
      } finally {
        parallelProbe.release.resolve(undefined)
        await earlier
      }
      expect((await earlier).status).toBe(200)
    } finally {
      await scaffold.close()
    }
  } finally {
    vi.unstubAllGlobals()
    if (worker.listening) {
      const closed = once(worker, 'close')
      worker.close()
      await closed
    }
    await rm(root, { recursive: true, force: true })
  }
})
