import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { createBillingRecorder } = await import(new URL('../src/billing-recorder.mjs', import.meta.url).href)

/** Low-code request shape the recorder sends through the injected auth service. */
interface PlatformRequest {
  path: string
  method?: string
  body?: {
    menuId: string
    _id?: string
    data?: string
    filter: { enCode: string; value: unknown }[]
  }
}
/** The writer fetcher receives raw URL and request options. */
interface WriterInit { method?: string; headers: Record<string, string>; body: string }

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'shadow-billing-'))
  roots.push(stateDirectory)
  const spaceId = 'a'.repeat(24)
  const projectId = 'b'.repeat(24)
  const tenantId = 'c'.repeat(24)
  const provider = 'model-provider'
  const prices = [{ _id: 'd'.repeat(24), pricingStatus: 'published', currency: 'CNY', provider, modelKey: 'model',
    scenario: 'agent', billingUnit: 'million_tokens', inputPerMillionYuan: '10', outputPerMillionYuan: '20' }]
  const remoteRows: Record<string, unknown>[] = []
  let allowWrites = false
  const auth = {
    currentScopeKey: async () => 'user-scope',
    owns: async () => true,
    status: async () => ({ authenticated: true, corpId: tenantId, baseUrl: 'https://platform.example' }),
    requestAuthenticated: vi.fn(async ({ path, body }: PlatformRequest) => {
      if (path.endsWith('currentUser')) return { userInfo: { id: 'actor', corpId: tenantId } }
      if (path.endsWith('/info')) return body?.menuId === '6adb0fbec3ca9f3dcdaf499a'
        ? { _id: spaceId, ownerUserId: 'actor', status: 'active' } : { _id: projectId, spaceId }
      if (body?.menuId === '6ad81c871f280486bb45ac5b') {
        if (path.endsWith('/list')) return { list: remoteRows.filter(row =>
          body.filter.every(item => row[item.enCode] === item.value)) }
        if (!allowWrites) throw Object.assign(new Error('当前账号没有用量表写入权限'), { code: 403 })
        const payload = JSON.parse(String(body.data)) as Record<string, unknown>
        const row = { _id: String(body._id || String(remoteRows.length).padStart(24, 'f')), ...payload }
        if (path.endsWith('/create')) remoteRows.push(row)
        else Object.assign(remoteRows.find(item => item._id === body._id)!, row)
        return row._id
      }
      return { list: prices }
    }),
  }
  const config = { stateDirectory, tenantId, imageModel: 'gpt-image-2.5', platformURL: 'https://platform.example', billingWriterKeyRef: 'WRITER' }
  const input = { spaceId, projectId }
  const events: Record<string, unknown>[] = []
  const session = { id: 'session', header: { createdAt: 10 }, snapshotEvents: () => events }
  const message = { source: { kind: 'user' }, content: [{ type: 'text',
    text: `/creation-studio-creative-plans\n${JSON.stringify({ context: { tenantId, spaceId, projectId, billingRequestId: 'request' } })}` }] }
  const recorder = createBillingRecorder(config, auth, async () => '', vi.fn())
  return { recorder, config, auth, input, session, events, message, prices, provider, remoteRows,
    allowUsageWrites() { allowWrites = true } }
}
it('captures final usage once, survives replay and never writes money tables or model messages', async () => {
  const f = await setup()
  await f.recorder.bind(f.session, [f.message])
  const event = { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    message: { source: { provider: f.provider, model: 'model' } },
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1200 },
    stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } } }] } }
  f.events.push(event)
  await Promise.all([f.recorder.capture(f.session, event), f.recorder.capture(f.session, event)])
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  await replay.capture(f.session, event)
  const result = await replay.list(f.input)
  expect(result.total).toBe(1)
  expect(result.rows[0]).toMatchObject({ customerCharge: '0.01', chargeStatus: 'ready', syncStatus: 'pending', initiatedByUserId: 'actor', requestId: 'request' })
  expect(result.rows[0]).not.toHaveProperty('customerChargeMicros')
  expect(f.auth.requestAuthenticated.mock.calls.every(([request]) => !request.body?.menuId
    || ['6ad81c871f280486bb45ac59', '6ad81c871f280486bb45ac5b', '6adb0fbec3ca9f3dcdaf499a', '6ad81c131f280486bb45ac3f'].includes(request.body.menuId))).toBe(true)
  expect(f.events).toHaveLength(1)
})

it('persists the provider video task ID with formal metered billing and restores it after restart', async () => {
  const f = await setup()
  f.allowUsageWrites()
  const model = 'doubao-seedance-2-5-260628'
  f.prices.push({ ...f.prices[0]!, _id: 'e'.repeat(24), provider: 'ark', modelKey: model,
    scenario: 'video', videoPerMillionYuan: '70' } as typeof f.prices[number])
  const input = { ...f.input, planId: 'f'.repeat(24), requestId: 'video-request' }
  const binding = await f.recorder.beginMedia(input)
  const task = { id: 'cgt-20261106104442-test', model, status: 'succeeded', createdAt: new Date().toISOString(),
    usage: { completion_tokens: 100000, total_tokens: 100000 }, videoRefId: '1'.repeat(24) }
  await f.recorder.media(input, binding, 'video', task, { resolution: '720p', inputVideoMode: 'none' })
  expect(f.remoteRows[0]).toMatchObject({ billingMode: 'metered', providerRequestId: task.id, customerCharge: '7.00', chargeStatus: 'settled' })
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  expect(await replay.list(input)).toMatchObject({ mode: 'metered', rows: [{ providerRequestId: task.id, billingMode: 'metered' }] })
  await replay.media(input, binding, 'video', task, { resolution: '720p', inputVideoMode: 'none' })
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/update'))).toHaveLength(0)
})

it('does not update a settled usage row when the same model receipt is recovered again', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  const event = { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    message: { source: { provider: f.provider, model: 'model' } },
    usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } } }
  await f.recorder.capture(f.session, event)
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  await replay.capture(f.session, event)
  expect(f.remoteRows).toHaveLength(1)
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/update'))).toHaveLength(0)
})

it('retains the original provider task ID when an intermediate receipt has no new ID', async () => {
  const f = await setup()
  f.allowUsageWrites()
  const input = { ...f.input, planId: 'f'.repeat(24), requestId: 'video-request' }
  const binding = await f.recorder.beginMedia(input)
  const task = { id: 'cgt-20261106104442-test', status: 'running', createdAt: new Date().toISOString() }
  await f.recorder.media(input, binding, 'video', task, {})
  await f.recorder.media(input, binding, 'video', { status: 'running', createdAt: task.createdAt }, {})
  expect(f.remoteRows[0]).toMatchObject({ providerRequestId: task.id, billingMode: 'metered' })
})

it('holds a conflicting settled amount for review without triggering another deduction update', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  const event = { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    message: { source: { provider: f.provider, model: 'model' } },
    usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } } }
  await f.recorder.capture(f.session, event)
  f.remoteRows[0]!.customerCharge = '9.00'
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  await replay.capture(f.session, event)
  expect((await replay.list(f.input)).rows[0].syncMessage).toContain('人工核对')
  expect(f.remoteRows[0]!.customerCharge).toBe('9.00')
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/update'))).toHaveLength(0)
})
it('counts cumulative-looking per-call usage directly and keeps missing usage pending', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  const usages = [
    [1, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    [2, { inputTokens: 1400, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    [3, undefined],
  ] as const
  for (const [seq, usage] of usages) {
    await f.recorder.capture(f.session, { type: 'assistant/message', seq, time: 100, data: { turn: 1, step: seq,
      message: { source: { provider: f.provider, model: 'model' } }, usage } })
  }
  const { rows } = await f.recorder.list(f.input)
  const sumTokens = (row: { inputTokens?: number; outputTokens?: number }) => (row.inputTokens || 0) + (row.outputTokens || 0)
  expect(rows.reduce((total: number, row: { inputTokens?: number; outputTokens?: number }) => total + sumTokens(row), 0)).toBe(2900)
  expect(rows.find((row: { eventSeq: number }) => row.eventSeq === 3).usageStatus).toBe('pending')
  expect(f.remoteRows.find(row => row.eventSeq === 3)).toMatchObject({ status: 'succeeded', chargeStatus: 'pending' })
})
it('reads retained micro receipts as decimal amounts without resynchronizing settled history', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  await f.recorder.capture(f.session, { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    message: { source: { provider: f.provider, model: 'model' } } } })
  const filename = (await readdir(join(f.config.stateDirectory, 'billing'))).find(name => /^[a-f0-9]{64}\.json$/u.test(name))!
  const path = join(f.config.stateDirectory, 'billing', filename)
  const record = JSON.parse(await readFile(path, 'utf8'))
  delete record.row.customerCharge
  delete record.row.billingMode
  Object.assign(record.row, { schemaVersion: 'shadow-billing-1', customerChargeMicros: '14000' })
  await writeFile(path, JSON.stringify(record))
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  const result = await replay.list(f.input)
  expect(result.rows[0]).toMatchObject({ customerCharge: '0.01', schemaVersion: 'usage-decimal-2', billingMode: 'shadow' })
  expect(result.rows[0]).not.toHaveProperty('customerChargeMicros')
  expect(f.remoteRows).toHaveLength(1)
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/update'))).toHaveLength(0)
})
it('keeps an already synchronized legacy ready row unchanged when its event is replayed', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  const event = { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    message: { source: { provider: f.provider, model: 'model' } } } }
  await f.recorder.capture(f.session, event)
  Object.assign(f.remoteRows[0]!, { billingMode: 'shadow', chargeStatus: 'ready' })
  const file = (await readdir(join(f.config.stateDirectory, 'billing'))).find(name => /^[a-f0-9]{64}\.json$/u.test(name))!
  const path = join(f.config.stateDirectory, 'billing', file)
  const record = JSON.parse(await readFile(path, 'utf8'))
  delete record.row.billingMode
  await writeFile(path, JSON.stringify(record))
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  await replay.capture(f.session, event)
  expect(f.remoteRows[0]).toMatchObject({ billingMode: 'shadow', chargeStatus: 'ready' })
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/update'))).toHaveLength(0)
})
it('charges stage recommendations to their authenticated submitter and captures each usage event once', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [{ ...f.message, content: [{ type: 'text', text: f.message.content[0]!.text.replace('creation-studio-creative-plans', 'creation-studio-stage-recommender') }] }], undefined, 1)
  const event = { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    message: { source: { provider: f.provider, model: 'model' } },
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1200 } } }
  await f.recorder.capture(f.session, event)
  await f.recorder.capture(f.session, event)
  const result = await f.recorder.list(f.input)
  expect(result.total).toBe(1)
  expect(result.rows[0]).toMatchObject({ payer: 'customer', chargeStatus: 'ready', customerCharge: '0.01',
    initiatedByUserId: 'actor', requestId: 'request', syncStatus: 'synced', skillNames: '["creation-studio-stage-recommender"]' })
  expect(f.remoteRows).toHaveLength(1)
  expect(f.remoteRows[0]).toMatchObject({ payer: 'customer', customerCharge: '0.01', status: 'succeeded', chargeStatus: 'settled' })
})
it('keeps failed recommendation attempts platform-funded while preserving their token counts', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [{ ...f.message, content: [{ type: 'text', text: f.message.content[0]!.text.replace('creation-studio-creative-plans', 'creation-studio-stage-recommender') }] }])
  await f.recorder.capture(f.session, { type: 'assistant/attempt', seq: 2, time: 100, data: { turn: 1, step: 1, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 50 } } },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } },
  ] } })
  expect((await f.recorder.list(f.input)).rows[0]).toMatchObject({ payer: 'platform', chargeStatus: 'waived', customerCharge: '0.00', inputTokens: 1000 })
  expect(f.remoteRows[0]).toMatchObject({ status: 'failed', chargeStatus: 'waived', customerCharge: '0.00' })
})
it('preserves a retained platform-funded recommendation binding while billing the next recommendation', async () => {
  const f = await setup()
  f.events.push({ seq: 0 }, { seq: 1 })
  const recommendation = { ...f.message, content: [{ type: 'text', text: f.message.content[0]!.text.replace('creation-studio-creative-plans', 'creation-studio-stage-recommender') }] }
  await f.recorder.bind(f.session, [recommendation], undefined, 1)
  const bindingName = (await readdir(join(f.config.stateDirectory, 'billing'))).find(name => name.endsWith('.bindings.json'))!
  const bindingPath = join(f.config.stateDirectory, 'billing', bindingName)
  const history = JSON.parse(await readFile(bindingPath, 'utf8'))
  // Existing receipts and bindings use their persisted payer rather than the new-operation policy.
  history[0].payer = 'platform'
  await writeFile(bindingPath, JSON.stringify(history))
  const recorder = createBillingRecorder(f.config, f.auth, async () => '')
  const data = { turn: 1, step: 1, message: { source: { provider: f.provider, model: 'model' } },
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const previous = { type: 'assistant/message', seq: 2, time: 100, data }
  await recorder.capture(f.session, previous)
  f.events.push(previous)
  await recorder.bind(f.session, [recommendation], undefined, 2)
  await recorder.capture(f.session, { type: 'assistant/message', seq: 3, time: 200, data: { ...data, turn: 2 } })
  const result = await recorder.list(f.input)
  expect(result.rows.find((row: { eventSeq: number }) => row.eventSeq === 2)).toMatchObject({ payer: 'platform', customerCharge: '0.00' })
  expect(result.rows.find((row: { eventSeq: number }) => row.eventSeq === 3)).toMatchObject({ payer: 'customer', customerCharge: '0.01' })
})
it('does not replace the original submitter during media recovery or change a delivered charge back to pending', async () => {
  const f = await setup()
  const binding = await f.recorder.beginMedia(f.input)
  const request = { ...f.input, planId: 'p', requestId: 'image-original' }
  await f.recorder.media(request, binding, 'image', { status: 'succeeded', result: { relationId: 'saved' }, createdAt: '2026-11-02T00:00:00Z' }, {})
  await f.recorder.media(request, { ...binding, initiatedByUserId: 'other' }, 'image', { status: 'submitting' }, {})
  expect((await f.recorder.list(f.input)).rows[0]).toMatchObject({ initiatedByUserId: 'actor', delivered: true, imageCount: 1 })
  await expect(f.recorder.list({ spaceId: 'e'.repeat(24) })).rejects.toThrow('空间')
})
it('attributes trusted subagent work to its parent operation and does not bill inherited events', async () => {
  const f = await setup()
  await f.recorder.bind(f.session, [f.message])
  const child = { id: 'child', header: { createdAt: 20, origin: 'subagent', parentSession: 'session' },
    snapshotEvents: () => [{ seq: 0 }, { seq: 1 }] }
  await f.recorder.bind(child, [], f.session)
  const data = { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    message: { source: { provider: f.provider, model: 'model' } } }
  await f.recorder.capture(child, { type: 'assistant/message', seq: 1, time: 30, data })
  await f.recorder.capture(child, { type: 'assistant/message', seq: 2, time: 30, data })
  const result = await f.recorder.list(f.input)
  expect(result.total).toBe(1)
  expect(result.rows[0]).toMatchObject({ sessionId: 'child', requestId: 'request', initiatedByUserId: 'actor' })
})
it('recovers a lost create acknowledgement by its original event key without creating another low-code row', async () => {
  const f = await setup()
  let saved: { _id: string } | undefined
  let creates = 0
  const writer = vi.fn(async (url: string, init: WriterInit) => {
    expect(init.headers.Authorization).toBe('service-token')
    if (url.endsWith('/currentUser')) return Response.json({ code: 200, data: { userInfo: { corpId: f.config.tenantId } } })
    const body = JSON.parse(init.body)
    expect(body.menuId).toBe('6ad81c871f280486bb45ac5b')
    if (url.endsWith('/list')) return Response.json({ code: 200, data: { list: saved ? [saved] : [] } })
    if (url.endsWith('/create')) {
      expect(init.method).toBe('POST')
      creates++
      saved = { _id: 'f'.repeat(24), ...JSON.parse(body.data) }
      throw new Error('connection lost after create')
    }
    expect(init.method).toBe('PUT')
    return Response.json({ code: 200, data: saved!._id })
  })
  const recorder = createBillingRecorder(f.config, f.auth, async () => 'service-token', writer)
  await recorder.bind(f.session, [f.message])
  const event = { type: 'assistant/message', seq: 2, time: 100, data: { turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    message: { source: { provider: f.provider, model: 'model' } } } }
  await recorder.capture(f.session, event)
  const receipt = (await readdir(join(f.config.stateDirectory, 'billing'))).find(name => /^[a-f0-9]{64}\.json$/u.test(name))!
  expect(JSON.parse(await readFile(join(f.config.stateDirectory, 'billing', receipt), 'utf8')).syncStatus).toBe('unknown')
  await recorder.reconcile(f.input)
  expect((await recorder.list(f.input)).rows[0].syncStatus).toBe('synced')
  expect(creates).toBe(1)
  expect(saved).toMatchObject({ billingMode: 'metered', customerCharge: '0.01', status: 'succeeded', chargeStatus: 'settled' })
})
it('never sends usage to a service credential belonging to a different tenant', async () => {
  const f = await setup()
  const writer = vi.fn(async () => Response.json({ code: 200, data: { userInfo: { corpId: 'other-tenant' } } }))
  const recorder = createBillingRecorder(f.config, f.auth, async () => 'service-token', writer)
  await recorder.bind(f.session, [f.message])
  await recorder.capture(f.session, { type: 'assistant/message', seq: 2, time: 100,
    data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 200 },
      message: { source: { provider: f.provider, model: 'model' } } } })
  expect(writer).toHaveBeenCalledTimes(1)
  expect((await recorder.list(f.input)).rows[0].syncMessage).toContain('租户不匹配')
})
it('never charges a later automatic turn to the previous user operation', async () => {
  const f = await setup()
  await f.recorder.bind(f.session, [f.message], undefined, 1)
  await f.recorder.capture(f.session, { type: 'assistant/message', seq: 2, time: 100,
    data: { turn: 2, step: 1, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      message: { source: { provider: f.provider, model: 'model' } } } })
  expect((await f.recorder.list(f.input)).rows[0]).toMatchObject({ payer: 'platform', requestId: 'background:session:2', chargeStatus: 'waived' })
})

it('automatically writes each settled model call with current caller permissions when no service key is configured', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message], undefined, 1)
  for (const seq of [2, 3]) await f.recorder.capture(f.session, { type: 'assistant/message', seq, time: 100,
    data: { turn: 1, step: seq, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      message: { source: { provider: f.provider, model: 'model' } } } })
  expect(f.remoteRows).toHaveLength(2)
  expect(f.remoteRows[0]).toMatchObject({ inputTokens: 1000, outputTokens: 200, customerCharge: '0.01',
    status: 'succeeded', chargeStatus: 'settled', billingMode: 'metered', requestId: 'request', initiatedByUserId: 'actor', spaceId: f.input.spaceId })
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/create'))).toHaveLength(2)
  const files = await readdir(join(f.config.stateDirectory, 'billing'))
  for (const file of files) {
    const text = await readFile(join(f.config.stateDirectory, 'billing', file), 'utf8')
    expect(text).not.toMatch(/authorization|password|service-token/iu)
  }
})

it('recovers unsynchronized usage on the next authenticated read without rerunning the model', async () => {
  const f = await setup()
  await f.recorder.bind(f.session, [f.message])
  const event = { type: 'assistant/message', seq: 2, time: 100,
    data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      message: { source: { provider: f.provider, model: 'model' } } } }
  await f.recorder.capture(f.session, event)
  expect(f.remoteRows).toHaveLength(0)
  f.allowUsageWrites()
  const replay = createBillingRecorder(f.config, f.auth, async () => '')
  expect((await replay.list(f.input)).rows[0].syncStatus).toBe('synced')
  expect(f.remoteRows).toHaveLength(1)
  await replay.capture(f.session, event)
  expect(f.remoteRows).toHaveLength(1)
  expect(f.remoteRows[0]).toMatchObject({ status: 'succeeded', chargeStatus: 'settled', customerCharge: '0.01' })
  expect(f.auth.requestAuthenticated.mock.calls.filter(([request]) => request.path.endsWith('/update'))).toHaveLength(0)
})

it('keeps another user from supplying an automatic fallback writer for the original submitter', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  f.auth.requestAuthenticated.mockImplementation(async ({ path, body }: PlatformRequest) => {
    if (path.endsWith('currentUser')) return { userInfo: { id: 'other', corpId: f.config.tenantId } }
    if (path.endsWith('/info')) return body?.menuId === '6adb0fbec3ca9f3dcdaf499a'
      ? { _id: f.input.spaceId, ownerUserId: 'other', status: 'active' }
      : { _id: f.input.projectId, spaceId: f.input.spaceId }
    return { list: body?.menuId === '6ad81c871f280486bb45ac59' ? f.prices : [] }
  })
  await f.recorder.capture(f.session, { type: 'assistant/message', seq: 2, time: 100,
    data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      message: { source: { provider: f.provider, model: 'model' } } } })
  expect((await f.recorder.list(f.input)).rows[0]).toMatchObject({ syncStatus: 'pending' })
  expect(f.auth.requestAuthenticated.mock.calls.some(([request]) => /\/(create|update)$/u.test(request.path))).toBe(false)
})

it('stops a changed account before create and safely resumes with the original account', async () => {
  const f = await setup()
  f.allowUsageWrites()
  await f.recorder.bind(f.session, [f.message])
  let changed = false
  const request = f.auth.requestAuthenticated.getMockImplementation()!
  f.auth.currentScopeKey = async () => changed ? 'other-scope' : 'user-scope'
  f.auth.requestAuthenticated.mockImplementation(async (value: PlatformRequest) => {
    const result = await request(value)
    if (value.path.endsWith('/list') && value.body?.menuId === '6ad81c871f280486bb45ac5b') changed = true
    return result
  })
  await f.recorder.capture(f.session, { type: 'assistant/message', seq: 2, time: 100,
    data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      message: { source: { provider: f.provider, model: 'model' } } } })
  expect(f.remoteRows).toHaveLength(0)
  changed = false
  f.auth.requestAuthenticated.mockImplementation(request)
  expect((await f.recorder.list(f.input)).rows[0].syncStatus).toBe('synced')
  expect(f.remoteRows).toHaveLength(1)
})
