import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProviderAccountPool } from '../src/provider-accounts.mjs'
import { requestSeedreamImage, SEEDREAM_MODELS } from '../src/seedream.mjs'
import { SEEDANCE_MODELS } from '../src/seedance-request.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'provider-pool-'))
  roots.push(root)
  const tenantId = 'a'.repeat(24)
  const rows = [1, 2].map(index => ({
    _id: String(index).repeat(24), accountCode: `ARK-${index}`, provider: 'ark', models: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', 'doubao-seedance-2-5-260628'], scenarios: ['image', 'video'], enabled: 1,
    maxConcurrent: 1, apiKey: `secret-${index}`,
  }))
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.headers.Authorization).toBe('private-reader')
    return Response.json({ code: 200, data: init.method === 'GET'
      ? { userInfo: { corpId: tenantId } } : { list: rows } })
  })
  const auth = { currentScopeKey: async () => 'user', requestAuthenticated: async ({ path, body }) => path.endsWith('/info')
    ? { _id: body._id, points: '20', status: 'active' } : { userInfo: { id: 'user', corpId: tenantId } } }
  const config = { platformURL: 'https://platform.example', tenantId, stateDirectory: root }
  const keys = async key => key === 'CREATION_STUDIO_ACCOUNT_POOL_TOKEN' ? 'private-reader' : ''
  const create = () => createProviderAccountPool(config, auth, keys, fetcher)
  const input = { spaceId: 'a'.repeat(24), projectId: 'project', planId: 'plan', requestId: 'request', scenario: 'image', model: SEEDREAM_MODELS[0] }
  return { root, rows, config, auth, fetcher, create, input }
}
it('reserves different least-loaded accounts for concurrent image/video calls, caps capacity, and records the caller without secrets', async () => {
  const f = await setup()
  const pool = f.create()
  const selected = await Promise.all([pool.acquire('ark', f.input), pool.acquire('ark', { ...f.input, scenario: 'video', requestId: 'video' })])
  expect(new Set(selected.map(item => item.receipt.providerAccountRef)).size).toBe(2)
  await expect(pool.acquire('ark', { ...f.input, requestId: 'full' })).rejects.toMatchObject({ code: 'accounts/busy' })
  const receipts = await Promise.all((await readdir(join(f.root, 'provider-calls'))).map(name => readFile(join(f.root, 'provider-calls', name), 'utf8')))
  expect(receipts.join()).not.toContain('secret-')
  expect(JSON.parse(receipts[0])).toMatchObject({ initiatedByUserId: 'user', status: 'reserved', projectId: 'project' })
  await pool.settle(selected[0].receipt, 'succeeded', 'provider-task')
  expect((await pool.acquire('ark', { ...f.input, requestId: 'next' })).receipt.providerAccountRef).toBe(selected[0].receipt.providerAccountRef)
})
it('restores reservations after restart, keeps disabled original accounts for polling, and refuses removed original credentials', async () => {
  const f = await setup()
  const first = await f.create().acquire('ark', f.input)
  await f.create().settle(first.receipt, 'unknown')
  f.rows.find(row => row._id === first.account._id).enabled = 0
  const restarted = f.create()
  expect((await restarted.resolve('ark', first.receipt)).apiKey).toBe(first.account.apiKey)
  expect((await restarted.acquire('ark', { ...f.input, requestId: 'next' })).account._id).not.toBe(first.account._id)
  f.rows.splice(f.rows.findIndex(row => row._id === first.account._id), 1)
  await expect(restarted.resolve('ark', first.receipt)).rejects.toMatchObject({ code: 'accounts/original-account-missing' })
})
it('waits for a confirmed slot release and does not release unknown paid outcomes', async () => {
  const f = await setup()
  const pool = f.create()
  const selected = await Promise.all([pool.acquire('ark', f.input), pool.acquire('ark', { ...f.input, requestId: 'second' })])
  let acquired = false
  const waiting = pool.waitForAccount('ark', { ...f.input, requestId: 'waiting' }).then(value => { acquired = true; return value })
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(6))
  await pool.settle(selected[0].receipt, 'unknown')
  expect(acquired).toBe(false)
  await pool.settle(selected[1].receipt, 'succeeded')
  expect((await waiting).account._id).toBe(selected[1].account._id)
  expect(acquired).toBe(true)
})
it('stops waiting acquisition without reserving another account and rejects an unconfigured model immediately', async () => {
  const f = await setup()
  const pool = f.create()
  await expect(pool.waitForAccount('ark', { ...f.input, model: 'missing-model' })).rejects.toMatchObject({ code: 'accounts/unavailable' })
  await pool.acquire('ark', f.input)
  await pool.acquire('ark', { ...f.input, requestId: 'second' })
  const waiting = pool.waitForAccount('ark', { ...f.input, requestId: 'waiting' })
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'accounts/queue-stopped' })
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(8))
  pool.stopQueue()
  await rejected
  expect(await readdir(join(f.root, 'provider-calls'))).toHaveLength(2)
})
it('rejects duplicate keys and a wrong service tenant instead of increasing apparent capacity', async () => {
  const f = await setup()
  f.rows[1].apiKey = f.rows[0].apiKey
  await expect(f.create().acquire('ark', f.input)).rejects.toMatchObject({ code: 'accounts/invalid-account' })
  f.fetcher.mockResolvedValueOnce(Response.json({ code: 200, data: { userInfo: { corpId: 'another-tenant' } } }))
  await expect(f.create().acquire('ark', f.input)).rejects.toMatchObject({ code: 'accounts/tenant-mismatch' })
})
it('selects only accounts enabled for the requested generation service', async () => {
  const f = await setup()
  f.rows[0].scenarios = ['image']
  f.rows[1].scenarios = ['video']
  expect((await f.create().acquire('ark', { ...f.input, scenario: 'video' })).receipt.providerAccountRef).toBe('ARK-2')
  expect((await f.create().acquire('ark', f.input)).receipt.providerAccountRef).toBe('ARK-1')
})
it('selects accounts by exact model instead of treating every model under a provider as enabled', async () => {
  const f = await setup()
  f.rows[0].models = [SEEDREAM_MODELS[0]]
  f.rows[1].models = [SEEDREAM_MODELS[1]]
  const pool = f.create()
  expect((await pool.acquire('ark', { ...f.input, model: SEEDREAM_MODELS[1] })).receipt.providerAccountRef).toBe('ARK-2')
  expect((await pool.acquire('ark', f.input)).receipt.providerAccountRef).toBe('ARK-1')
  expect(await pool.configured('ark', 'video', 'doubao-seedance-2-5-260628')).toBe(false)
  await expect(pool.acquire('ark', { ...f.input, model: 'doubao-seedance-2-5-260628', scenario: 'video' }))
    .rejects.toMatchObject({ code: 'accounts/unavailable' })
})
it.each(SEEDANCE_MODELS)('allocates only an account explicitly enabled for $label', async ({ value }) => {
  const f = await setup()
  f.rows[0].models = ['doubao-seedream-5-0-pro-260628']
  f.rows[1].models = [value]
  const pool = f.create()
  expect((await pool.acquire('ark', { ...f.input, model: value, scenario: 'video' })).receipt.providerAccountRef).toBe('ARK-2')
})
it('retains the original environment key for an existing task after enabling the private pool', async () => {
  const f = await setup()
  let enabled = false
  const pool = createProviderAccountPool(f.config, f.auth, async ref =>
    ref === 'ARK_API_KEY' ? 'original-key' : enabled && ref === 'CREATION_STUDIO_ACCOUNT_POOL_TOKEN' ? 'private-reader' : '', f.fetcher)
  const original = await pool.acquire('ark', f.input)
  enabled = true
  expect((await pool.resolve('ark', original.receipt)).apiKey).toBe('original-key')
  expect((await pool.acquire('ark', { ...f.input, requestId: 'new-pool-task' })).receipt.providerAccountRef).not.toBe('ENV-ARK')
})
it('uses a service password login to read numbered accounts without changing caller attribution', async () => {
  const f = await setup()
  const login = vi.fn(async () => Response.json({ code: 200, data: { token: 'private-reader' } }))
  const keys = async ref => ({
    CREATION_STUDIO_ACCOUNT_POOL_USERNAME: 'pool-service',
    CREATION_STUDIO_ACCOUNT_POOL_PASSWORD: 'pool-password',
  })[ref] || ''
  const pool = createProviderAccountPool(f.config, f.auth, keys, (url, init) =>
    url.includes('/api/oauth/login?') ? login(url, init) : f.fetcher(url, init))
  const selected = await pool.acquire('ark', f.input)
  expect(selected.receipt).toMatchObject({ initiatedByUserId: 'user', providerAccountRef: expect.stringMatching(/^ARK-/u) })
  expect(await pool.configured('ark', 'video')).toBe(true)
  expect(login).toHaveBeenCalledTimes(1)
  const receipt = await readFile(join(f.root, 'provider-calls', `${selected.receipt.providerLeaseId}.json`), 'utf8')
  expect(receipt).not.toMatch(/pool-password|private-reader|pool-service/u)
})
it.each(SEEDREAM_MODELS)('sends the selected model %s with one Ark Bearer key and image references', async model => {
  const transport = vi.fn(async (_url, init) => {
    expect(init.headers).toEqual({ Authorization: 'Bearer key', 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toMatchObject({ model, size: '1024x1536', output_format: 'png', response_format: 'b64_json', image: ['https://platform.example/reference'] })
    expect(JSON.parse(init.body)).not.toHaveProperty('async')
    return Response.json({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }] })
  })
  await requestSeedreamImage('Bearer key', model, { prompt: 'product', size: '1024x1536' }, [{ url: 'https://platform.example/reference' }], transport)
  expect(transport.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
})
