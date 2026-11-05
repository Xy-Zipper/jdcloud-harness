import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createAccountPoolReader } from '../src/account-pool-reader.mjs'

function setup() {
  const config = { platformURL: 'https://platform.example', tenantId: 'a'.repeat(24) }
  const secrets = {
    CREATION_STUDIO_ACCOUNT_POOL_USERNAME: 'service-user',
    CREATION_STUDIO_ACCOUNT_POOL_PASSWORD: 'service-password',
    CREATION_STUDIO_ACCOUNT_POOL_TOKEN: 'legacy-token',
  }
  let logins = 0
  const fetcher = vi.fn(async (url, init) => {
    if (url.includes('/api/oauth/login?')) {
      expect(new URL(url).searchParams.get('corpId')).toBe(config.tenantId)
      expect(new URL(url).searchParams.get('grant_type')).toBe('password')
      expect(JSON.parse(init.body)).toEqual({
        username: 'service-user', password: createHash('md5').update(secrets.CREATION_STUDIO_ACCOUNT_POOL_PASSWORD).digest('hex'),
      })
      expect(init.headers.Authorization).toBeUndefined()
      return Response.json({ code: 200, data: { token: `token-${++logins}` } })
    }
    expect(init.headers.Authorization).toBe(`token-${logins}`)
    return Response.json({ code: 200, data: { ok: true } })
  })
  const reader = createAccountPoolReader(config, async key => secrets[key] || '', fetcher)
  return { config, secrets, fetcher, reader, logins: () => logins }
}

it('logs in once for concurrent reads, keeps tokens in memory, and prefers passwords over a legacy token', async () => {
  const f = setup()
  await Promise.all(Array.from({ length: 4 }, async () => (await f.reader())('/api/oauth/currentUser')))
  expect(f.logins()).toBe(1)
  expect(f.fetcher).toHaveBeenCalledTimes(5)
  await (await f.reader())('/api/visualdev/form/list', { menuId: 'private-table' })
  expect(f.logins()).toBe(1)
  expect(f.fetcher.mock.calls.at(-1)[1].body).toBe('{"menuId":"private-table"}')
})

it.each([600, 601, 602, 401])('refreshes once on expiration %s and retries only the failed read', async code => {
  const f = setup()
  const call = await f.reader()
  f.fetcher.mockResolvedValueOnce(Response.json({ code }, { status: code === 401 ? 401 : 200 }))
  expect(await call('/api/visualdev/form/list', { page: 2 })).toEqual({ ok: true })
  expect(f.logins()).toBe(2)
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/form/list')).map(([, init]) => init.headers.Authorization))
    .toEqual(['token-1', 'token-2'])
})

it('shares one new login when several requests report the same expired token', async () => {
  const f = setup()
  const calls = await Promise.all([f.reader(), f.reader(), f.reader()])
  const original = f.fetcher.getMockImplementation()
  f.fetcher.mockImplementation(async (url, init) => {
    if (init.headers.Authorization === 'token-1')
      return Response.json({ code: 600 })
    return original(url, init)
  })
  await Promise.all(calls.map(call => call('/api/oauth/currentUser')))
  expect(f.logins()).toBe(2)
})

it('stops after one refresh if the new token is also rejected', async () => {
  const f = setup()
  const call = await f.reader()
  const original = f.fetcher.getMockImplementation()
  f.fetcher.mockImplementation((url, init) => url.includes('/login?')
    ? original(url, init) : Promise.resolve(Response.json({ code: 602 })))
  await expect(call('/api/oauth/currentUser')).rejects.toMatchObject({ code: 'accounts/read-failed' })
  expect(f.logins()).toBe(2)
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/currentUser'))).toHaveLength(2)
})

it('does not relogin for a permission failure and does not return the backend diagnostic', async () => {
  const f = setup()
  const call = await f.reader()
  f.fetcher.mockResolvedValueOnce(Response.json({ code: 403, msg: 'sensitive backend diagnostic' }, { status: 403 }))
  await expect(call('/api/visualdev/form/list', {})).rejects.toMatchObject({
    code: 'accounts/read-failed', message: expect.not.stringContaining('sensitive'),
  })
  expect(f.logins()).toBe(1)
})

it('rejects incomplete or invalid login credentials without falling back to a legacy token', async () => {
  const f = setup()
  f.secrets.CREATION_STUDIO_ACCOUNT_POOL_PASSWORD = ''
  await expect(f.reader()).rejects.toMatchObject({ code: 'accounts/login-incomplete' })
  expect(f.fetcher).not.toHaveBeenCalled()
  f.secrets.CREATION_STUDIO_ACCOUNT_POOL_PASSWORD = 'service-password'
  f.fetcher.mockResolvedValueOnce(Response.json({ code: 400, msg: 'wrong password' }))
  await expect(f.reader()).rejects.toMatchObject({ code: 'accounts/login-failed' })
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})

it('replaces the cached login when the configured password changes', async () => {
  const f = setup()
  await (await f.reader())('/api/oauth/currentUser')
  f.secrets.CREATION_STUDIO_ACCOUNT_POOL_PASSWORD = 'rotated-password'
  await (await f.reader())('/api/oauth/currentUser')
  expect(f.logins()).toBe(2)
})
