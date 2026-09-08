import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import JdcloudAuthController, {
  JdcloudApiError,
  JdcloudClient,
  normalizeJdcloudBaseUrl,
} from '../src/index.ts'
import type { JdcloudAuthenticatedRequest, JdcloudLoginRequest } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function corpData(
  corpId = 'corp-current',
  corpName = 'Current Tenant',
  joined = false,
  extraOwned: Array<{ corpId: string; corpName: string }> = [],
  extraJoined: Array<{ corpId: string; corpName: string }> = [],
) {
  const current = { corpId, corpName }
  return {
    corpId,
    corpList: joined ? extraOwned : [current, ...extraOwned],
    joinCorpList: joined ? [current, ...extraJoined] : extraJoined,
  }
}

async function boot(fetcher: typeof fetch, config: { defaultBaseUrl?: string; requestTimeoutMs?: number } = {
  defaultBaseUrl: 'https://kindoucloud.com',
}) {
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(JdcloudAuthController, config)
  return ctx
}

describe('minimal JDCloud HTTP client', () => {
  it.each([
    ['not a url', 'absolute HTTP or HTTPS URL'],
    ['ftp://kindoucloud.com', 'must use HTTP or HTTPS'],
    ['https://user@kindoucloud.com', 'must not contain credentials'],
    ['https://:secret@kindoucloud.com', 'must not contain credentials'],
    ['https://kindoucloud.com?tenant=x', 'must not contain credentials'],
    ['https://kindoucloud.com#login', 'must not contain credentials'],
  ])('rejects unsupported service address %s', (value, message) => {
    expect(() => normalizeJdcloudBaseUrl(value)).toThrow(message)
  })

  it('normalizes HTTP and HTTPS service addresses', () => {
    expect(normalizeJdcloudBaseUrl(' http://kindoucloud.com/ ')).toBe('http://kindoucloud.com')
    expect(normalizeJdcloudBaseUrl('https://kindoucloud.com/')).toBe('https://kindoucloud.com')
  })

  it('copies password-login query and MD5 semantics without a tenant parameter', async () => {
    const fetcher = vi.fn(() => Promise.resolve(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } })))
    const client = new JdcloudClient('https://kindoucloud.com', fetcher)
    await expect(client.loginPassword('user', 'secret', AbortSignal.timeout(1000))).resolves.toBe('bearer token')
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/oauth/login')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      client_id: 'admin', client_secret: '123456', scope: 'all', grant_type: 'password',
    })
    expect(parsed.searchParams.has('corpId')).toBe(false)
    expect(typeof init.body).toBe('string')
    if (typeof init.body !== 'string') throw new Error('login request body must be a string')
    expect(JSON.parse(init.body)).toEqual({
      username: 'user',
      password: createHash('md5').update('secret').digest('hex'),
    })
  })

  it.each([
    [null, 'did not contain a token'],
    [{}, 'did not contain a token'],
    [{ token: 42 }, 'did not contain a token'],
    [{ token: '' }, 'did not contain a token'],
  ])('rejects a login response without a usable token', async (data, message) => {
    const client = new JdcloudClient('https://kindoucloud.com', vi.fn(() => Promise.resolve(json({
      code: 200, msg: 'ok', data,
    }))))
    await expect(client.loginPassword('user', 'secret', AbortSignal.timeout(1000))).rejects.toThrow(message)
  })

  it('returns all owned and joined tenants with stable duplicate removal', async () => {
    const duplicate = { corpId: 'owned', corpName: 'Ignored Duplicate' }
    const joined = { corpId: 'joined', corpName: 'Joined Tenant' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        code: 200,
        msg: 'ok',
        data: corpData('owned', 'Owned Tenant', false, [], [duplicate, joined]),
      }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData('joined', 'Joined Tenant', true) }))
    const client = new JdcloudClient('https://kindoucloud.com', fetcher as typeof fetch)
    const signal = AbortSignal.timeout(1000)
    await expect(client.getCorpList('token', signal)).resolves.toEqual({
      corpId: 'owned',
      corpName: 'Owned Tenant',
      corps: [
        { corpId: 'owned', corpName: 'Owned Tenant' },
        { corpId: 'joined', corpName: 'Joined Tenant' },
      ],
    })
    await expect(client.getCorpList('token', signal)).resolves.toEqual({
      corpId: 'joined',
      corpName: 'Joined Tenant',
      corps: [{ corpId: 'joined', corpName: 'Joined Tenant' }],
    })
  })

  it.each([
    [null, 'tenant-list response is invalid'],
    [[], 'tenant-list response is invalid'],
    [{}, 'has no current tenant'],
    [{ corpId: '' }, 'has no current tenant'],
    [{ corpId: 'current', corpList: [] }, 'has no name for the current tenant'],
    [{ corpId: 'current', corpList: [{ corpId: 'current', corpName: '' }] }, 'contains an invalid tenant'],
    [{ corpId: 'current', corpList: {} }, 'contains an invalid tenant list'],
    [{ corpId: 'current', corpList: [null] }, 'contains an invalid tenant'],
    [{ corpId: 'current', corpList: [[]] }, 'contains an invalid tenant'],
    [{ corpId: 'current', corpList: [{ corpId: '', corpName: 'Tenant' }] }, 'contains an invalid tenant'],
    [{ corpId: 'current', corpList: [{ corpId: 'current', corpName: 42 }] }, 'contains an invalid tenant'],
  ])('rejects an unusable tenant-list payload', async (data, message) => {
    const client = new JdcloudClient('https://kindoucloud.com', vi.fn(() => Promise.resolve(json({
      code: 200, msg: 'ok', data,
    }))))
    await expect(client.getCorpList('token', AbortSignal.timeout(1000))).rejects.toThrow(message)
  })

  it.each([
    ['string', 'corp/next'],
    ['object', { corpId: 'corp/next' }],
  ])('switches tenants when the backend confirms the encoded path identity as a %s', async (_format, data) => {
    const fetcher = vi.fn(() => Promise.resolve(json({ code: 200, msg: 'ok', data })))
    const client = new JdcloudClient('https://kindoucloud.com', fetcher)
    await expect(client.switchCorp('token', 'corp/next', AbortSignal.timeout(1000))).resolves.toBe('corp/next')
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://kindoucloud.com/api/system/corp/switchCorp/corp%2Fnext')
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: 'token' }, cache: 'no-store' })
  })

  it.each([null, '', 'another-corp', {}, { corpId: '' }, { corpId: 'another-corp' }])(
    'rejects an unconfirmed tenant switch result %j',
    async (data) => {
      const client = new JdcloudClient('https://kindoucloud.com', vi.fn(() => Promise.resolve(json({
        code: 200, msg: 'ok', data,
      }))))
      await expect(client.switchCorp('token', 'corp-next', AbortSignal.timeout(1000)))
        .rejects.toThrow('did not confirm the requested tenant')
    },
  )

  it('rejects non-JSON, invalid, and message-less business responses', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('not-json', { status: 502 }))
      .mockResolvedValueOnce(json('invalid'))
      .mockResolvedValueOnce(json(null))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ code: '200' }))
      .mockResolvedValueOnce(json({ code: 500, data: null }))
      .mockResolvedValueOnce(json({ code: 400, msg: '', data: null }))
    const client = new JdcloudClient('https://kindoucloud.com', fetcher as typeof fetch)
    const signal = AbortSignal.timeout(1000)
    await expect(client.getCorpList('token', signal)).rejects.toThrow('non-JSON response with HTTP 502')
    for (let index = 0; index < 4; index += 1) {
      await expect(client.getCorpList('token', signal)).rejects.toThrow('invalid response')
    }
    await expect(client.getCorpList('token', signal)).rejects.toEqual(expect.objectContaining({
      name: 'JdcloudApiError', code: 500, message: 'JDCloud request failed with code 500',
    }))
    await expect(client.getCorpList('token', signal)).rejects.toEqual(expect.objectContaining({
      name: 'JdcloudApiError', code: 400, message: 'JDCloud request failed with code 400',
    }))
  })
})

describe('JDCloud authentication controller', () => {
  it('uses an empty initial address for omitted or blank configuration', async () => {
    const omitted = await boot(vi.fn() as typeof fetch, {})
    expect(await omitted.jdcloudAuthController.status()).toEqual({ authenticated: false, baseUrl: '' })
    const blank = await boot(vi.fn() as typeof fetch, { defaultBaseUrl: '   ', requestTimeoutMs: 1000 })
    expect(await blank.jdcloudAuthController.status()).toEqual({ authenticated: false, baseUrl: '' })
  })

  it('retains the constructor timeout default for direct service assembly', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    const controller = new JdcloudAuthController(ctx, {})
    expect(await controller.status()).toEqual({ authenticated: false, baseUrl: '' })
  })

  it.each([
    [{ baseUrl: 'https://kindoucloud.com', username: ' ', password: 'secret' }],
    [{ baseUrl: 'https://kindoucloud.com', username: 'user', password: '' }],
  ])('rejects incomplete login credentials', async (request) => {
    const ctx = await boot(vi.fn() as typeof fetch)
    await expect(ctx.jdcloudAuthController.login(request, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('rejects an invalid login service address', async () => {
    const ctx = await boot(vi.fn() as typeof fetch)
    await expect(ctx.jdcloudAuthController.login({
      baseUrl: 'relative', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('stores only the validated Host login and reports redacted state', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData('corp-beta', 'Beta Tenant') }))
    const ctx = await boot(fetcher as typeof fetch)
    expect(await ctx.jdcloudAuthController.status()).toEqual({ authenticated: false, baseUrl: 'https://kindoucloud.com' })
    await expect(ctx.jdcloudAuthController.login({
      baseUrl: 'https://beta.kindoucloud.com/', username: 'user', password: 'secret',
    } satisfies JdcloudLoginRequest, AbortSignal.timeout(1000)))
      .resolves.toEqual({
        authenticated: true,
        baseUrl: 'https://beta.kindoucloud.com',
        username: 'user',
        corpId: 'corp-beta',
        corpName: 'Beta Tenant',
        corps: [{ corpId: 'corp-beta', corpName: 'Beta Tenant' }],
      })
    expect(await ctx.jdcloudAuthController.status())
      .toEqual({
        authenticated: true,
        baseUrl: 'https://beta.kindoucloud.com',
        username: 'user',
        corpId: 'corp-beta',
        corpName: 'Beta Tenant',
        corps: [{ corpId: 'corp-beta', corpName: 'Beta Tenant' }],
      })
    expect(await ctx.credentials.readRecord(credentialKey('jdcloud-auth-controller', 'login'))).toEqual({
      kind: 'grant',
      payload: {
        version: 3,
        baseUrl: 'https://beta.kindoucloud.com',
        token: 'bearer token',
        username: 'user',
        corpId: 'corp-beta',
        corpName: 'Beta Tenant',
        corps: [{ corpId: 'corp-beta', corpName: 'Beta Tenant' }],
      },
    })
    const [tenantUrl, tenantInit] = fetcher.mock.calls[1] as unknown as [string, RequestInit]
    expect(new URL(tenantUrl).pathname).toBe('/api/system/corp/getCorpList')
    expect(tenantInit.headers).toEqual({ authorization: 'bearer token' })
  })

  it('sends authenticated Host requests without exposing the stored token', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { menuList: ['menu'] } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { id: 'created' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { id: 'updated' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: true }))
    const ctx = await boot(fetcher as typeof fetch)
    const signal = AbortSignal.timeout(1000)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, signal)

    await expect(ctx.jdcloudAuthController.requestAuthenticated({
      path: '/api/oauth/currentUser?include=menu', method: 'GET',
    }, signal)).resolves.toEqual({ menuList: ['menu'] })
    for (const [method, body, expected] of [
      ['POST', { name: 'created' }, { id: 'created' }],
      ['PUT', { name: 'updated' }, { id: 'updated' }],
      ['DELETE', { id: 'deleted' }, true],
    ] as const) {
      await expect(ctx.jdcloudAuthController.requestAuthenticated({
        path: '/api/visualdev/form/action', method, body,
      }, signal)).resolves.toEqual(expected)
    }

    const [getUrl, getInit] = fetcher.mock.calls[2] as unknown as [string, RequestInit]
    const parsedGetUrl = new URL(getUrl)
    expect(parsedGetUrl.pathname).toBe('/api/oauth/currentUser')
    expect(parsedGetUrl.searchParams.get('include')).toBe('menu')
    expect(parsedGetUrl.searchParams.get('n')).toMatch(/^\d+$/)
    expect(getInit).toMatchObject({
      method: 'GET', headers: { authorization: 'bearer token' }, cache: 'no-store',
    })
    expect(getInit.body).toBeUndefined()
    for (const [index, method, body] of [
      [3, 'POST', { name: 'created' }],
      [4, 'PUT', { name: 'updated' }],
      [5, 'DELETE', { id: 'deleted' }],
    ] as const) {
      const [, init] = fetcher.mock.calls[index] as unknown as [string, RequestInit]
      expect(init).toMatchObject({
        method,
        headers: { authorization: 'bearer token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(init.cache).toBeUndefined()
    }
  })

  it('requires a stored login for authenticated Host requests', async () => {
    const fetcher = vi.fn()
    const ctx = await boot(fetcher as typeof fetch)
    await expect(ctx.jdcloudAuthController.requestAuthenticated({
      path: '/api/oauth/currentUser', method: 'GET',
    }, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'jdcloud/auth-required', details: { reason: 'missing' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects authenticated Host requests outside the JDCloud API path', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
    const ctx = await boot(fetcher as typeof fetch)
    const signal = AbortSignal.timeout(1000)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, signal)
    for (const path of ['/oauth/currentUser', 'https://example.com/api/currentUser', '/api/../oauth/currentUser']) {
      await expect(ctx.jdcloudAuthController.requestAuthenticated({
        path: path as JdcloudAuthenticatedRequest['path'], method: 'GET',
      }, signal)).rejects.toThrow('must start with /api/')
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([600, 601, 602])('deletes an expired login when an authenticated Host request returns code %i', async (code) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
      .mockResolvedValueOnce(json({ code, msg: 'token expired', data: null }))
    const ctx = await boot(fetcher as typeof fetch)
    const signal = AbortSignal.timeout(1000)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, signal)
    await expect(ctx.jdcloudAuthController.requestAuthenticated({
      path: '/api/oauth/currentUser', method: 'GET',
    }, signal)).rejects.toMatchObject({
      code: 'jdcloud/auth-required', details: { reason: 'expired' },
    })
    expect((await ctx.jdcloudAuthController.status()).authenticated).toBe(false)
  })

  it('keeps the login and preserves ordinary JDCloud business errors for Host callers', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
      .mockResolvedValueOnce(json({ code: 409, msg: 'operation denied', data: null }))
    const ctx = await boot(fetcher as typeof fetch)
    const signal = AbortSignal.timeout(1000)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, signal)
    const error = await ctx.jdcloudAuthController.requestAuthenticated({
      path: '/api/visualdev/form/action', method: 'POST', body: {},
    }, signal).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(JdcloudApiError)
    expect(error).toMatchObject({ code: 409, message: 'operation denied' })
    expect((await ctx.jdcloudAuthController.status()).authenticated).toBe(true)
  })

  it('switches to an available tenant, confirms it, and keeps the login page hidden', async () => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockResolvedValueOnce(json({ code: 200, msg: '切换成功', data: { corpId: next.corpId } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData(next.corpId, next.corpName, false, [
          { corpId: 'corp-current', corpName: 'Current Tenant' },
        ]),
      }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))

    await expect(ctx.jdcloudAuthController.switchCorp(next.corpId, AbortSignal.timeout(1000))).resolves.toEqual({
      authenticated: true,
      baseUrl: 'https://kindoucloud.com',
      username: 'user',
      corpId: next.corpId,
      corpName: next.corpName,
      corps: [next, { corpId: 'corp-current', corpName: 'Current Tenant' }],
    })
    const [switchUrl, switchInit] = fetcher.mock.calls[2] as unknown as [string, RequestInit]
    expect(new URL(switchUrl).pathname).toBe('/api/system/corp/switchCorp/corp-next')
    expect(switchInit.headers).toEqual({ authorization: 'bearer token' })
    expect((await ctx.jdcloudAuthController.status()).authenticated).toBe(true)
  })

  it('does not call JDCloud when selecting the current tenant and rejects unknown tenants', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    await expect(ctx.jdcloudAuthController.switchCorp('corp-current', AbortSignal.timeout(1000)))
      .resolves.toMatchObject({ authenticated: true, corpId: 'corp-current' })
    await expect(ctx.jdcloudAuthController.switchCorp('unknown', AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('requires a stored login before switching tenants', async () => {
    const ctx = await boot(vi.fn() as typeof fetch)
    await expect(ctx.jdcloudAuthController.switchCorp('corp-next', AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'jdcloud/auth-required', details: { reason: 'missing' } })
  })

  it.each([600, 601, 602])('deletes an expired login when tenant switch returns code %i', async (code) => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockResolvedValueOnce(json({ code, msg: 'token expired', data: null }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    await expect(ctx.jdcloudAuthController.switchCorp(next.corpId, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'jdcloud/auth-required', details: { reason: 'expired' } })
    expect((await ctx.jdcloudAuthController.status()).authenticated).toBe(false)
  })

  it('keeps the login and current tenant after an ordinary switch failure', async () => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockResolvedValueOnce(json({ code: 500, msg: 'switch failed', data: null }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    await expect(ctx.jdcloudAuthController.switchCorp(next.corpId, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'jdcloud/switch-failed', details: { code: 500 } })
    await expect(ctx.jdcloudAuthController.status()).resolves.toMatchObject({
      authenticated: true, corpId: 'corp-current',
    })
  })

  it('keeps the current tenant when confirmation reports another tenant', async () => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: next.corpId }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    await expect(ctx.jdcloudAuthController.switchCorp(next.corpId, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'jdcloud/switch-failed', details: { code: null } })
    await expect(ctx.jdcloudAuthController.status()).resolves.toMatchObject({ corpId: 'corp-current' })
  })

  it('does not recreate a login deleted while a tenant switch is in flight', async () => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    let resolveConfirmation: ((response: Response) => void) | undefined
    const confirmation = new Promise<Response>((resolve) => { resolveConfirmation = resolve })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: next.corpId }))
      .mockReturnValueOnce(confirmation)
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    const pending = ctx.jdcloudAuthController.switchCorp(next.corpId, AbortSignal.timeout(1000))
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(4) })
    await ctx.credentials.deleteRecord(credentialKey('jdcloud-auth-controller', 'login'))
    resolveConfirmation?.(json({ code: 200, msg: 'ok', data: corpData(next.corpId, next.corpName) }))
    await expect(pending).rejects.toMatchObject({ code: 'jdcloud/switch-failed' })
    expect(await ctx.credentials.readRecord(credentialKey('jdcloud-auth-controller', 'login'))).toBeUndefined()
  })

  it('does not overwrite another login committed while a tenant switch is in flight', async () => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    let resolveConfirmation: ((response: Response) => void) | undefined
    const confirmation = new Promise<Response>((resolve) => { resolveConfirmation = resolve })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: next.corpId }))
      .mockReturnValueOnce(confirmation)
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    const pending = ctx.jdcloudAuthController.switchCorp(next.corpId, AbortSignal.timeout(1000))
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(4) })
    await ctx.credentials.modifyRecord(credentialKey('jdcloud-auth-controller', 'login'), () => Promise.resolve({
      kind: 'grant',
      payload: {
        version: 3,
        baseUrl: 'https://kindoucloud.com',
        token: 'another token',
        username: 'other-user',
        corpId: 'other-corp',
        corpName: 'Other Tenant',
        corps: [{ corpId: 'other-corp', corpName: 'Other Tenant' }],
      },
    }))
    resolveConfirmation?.(json({ code: 200, msg: 'ok', data: corpData(next.corpId, next.corpName) }))
    await expect(pending).rejects.toMatchObject({ code: 'jdcloud/switch-failed' })
    await expect(ctx.jdcloudAuthController.status()).resolves.toMatchObject({
      username: 'other-user', corpId: 'other-corp',
    })
  })

  it('synchronizes tenant state during prompt admission when the backend selection changes', async () => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    const current = { corpId: 'corp-current', corpName: 'Current Tenant' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData(current.corpId, current.corpName, false, [next]),
      }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData(next.corpId, next.corpName, false, [current]),
      }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    const nextAdmission = vi.fn(() => Promise.resolve())
    await ctx.waterfall('api-session/prompt-admission', {
      sessionId: 'session-test' as never, signal: AbortSignal.timeout(1000),
    }, nextAdmission)
    expect(nextAdmission).toHaveBeenCalledOnce()
    await expect(ctx.jdcloudAuthController.status()).resolves.toMatchObject({
      corpId: next.corpId,
      corpName: next.corpName,
      corps: [next, current],
    })
  })

  it.each([
    ['deleted', undefined],
    ['replaced', {
      kind: 'grant' as const,
      payload: {
        version: 3,
        baseUrl: 'https://kindoucloud.com',
        token: 'another token',
        username: 'other-user',
        corpId: 'other-corp',
        corpName: 'Other Tenant',
        corps: [{ corpId: 'other-corp', corpName: 'Other Tenant' }],
      },
    }],
  ])('does not overwrite a %s login during prompt tenant synchronization', async (_name, replacement) => {
    const next = { corpId: 'corp-next', corpName: 'Next Tenant' }
    let resolveValidation: ((response: Response) => void) | undefined
    const validation = new Promise<Response>((resolve) => { resolveValidation = resolve })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({
        code: 200, msg: 'ok', data: corpData('corp-current', 'Current Tenant', false, [next]),
      }))
      .mockReturnValueOnce(validation)
    const ctx = await boot(fetcher as typeof fetch)
    const key = credentialKey('jdcloud-auth-controller', 'login')
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    const nextAdmission = vi.fn(() => Promise.resolve())
    const pending = ctx.waterfall('api-session/prompt-admission', {
      sessionId: 'session-test' as never, signal: AbortSignal.timeout(1000),
    }, nextAdmission)
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(3) })
    if (replacement === undefined) {
      await ctx.credentials.deleteRecord(key)
    } else {
      await ctx.credentials.modifyRecord(key, () => Promise.resolve(replacement))
    }
    resolveValidation?.(json({ code: 200, msg: 'ok', data: corpData(next.corpId, next.corpName) }))
    await pending
    expect(nextAdmission).toHaveBeenCalledOnce()
    expect(await ctx.credentials.readRecord(key)).toEqual(replacement)
  })

  it('admits a prompt after validation and deletes the login on logout', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
    const ctx = await boot(fetcher as typeof fetch, {
      defaultBaseUrl: 'https://kindoucloud.com', requestTimeoutMs: 1000,
    })
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: ' user ', password: 'secret',
    }, AbortSignal.timeout(1000))
    const next = vi.fn(() => Promise.resolve())
    await ctx.waterfall('api-session/prompt-admission', {
      sessionId: 'session-test' as never, signal: AbortSignal.timeout(1000),
    }, next)
    expect(next).toHaveBeenCalledOnce()
    await expect(ctx.jdcloudAuthController.logout()).resolves.toEqual({
      authenticated: false, baseUrl: 'https://kindoucloud.com',
    })
    expect(await ctx.credentials.readRecord(credentialKey('jdcloud-auth-controller', 'login'))).toBeUndefined()
  })

  it('rejects prompt admission while no login is stored', async () => {
    const ctx = await boot(vi.fn() as typeof fetch)
    await expect(ctx.waterfall('api-session/prompt-admission', {
      sessionId: 'session-test' as never, signal: AbortSignal.timeout(1000),
    }, () => Promise.resolve())).rejects.toMatchObject({
      code: 'jdcloud/auth-required', details: { reason: 'missing' },
    })
  })

  it('reports login business and transport failures without storing a token', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 500, msg: 'login failed', data: null }))
      .mockRejectedValueOnce('offline')
    const ctx = await boot(fetcher as typeof fetch)
    const request = { baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret' }
    await expect(ctx.jdcloudAuthController.login(request, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'jdcloud/auth-failed', details: { code: 500 } })
    await expect(ctx.jdcloudAuthController.login(request, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'jdcloud/auth-failed', message: 'offline', details: { code: null } })
    expect(await ctx.credentials.readRecord(credentialKey('jdcloud-auth-controller', 'login'))).toBeUndefined()
  })

  it.each([600, 601, 602])('deletes an expired token for JDCloud code %i before rejecting prompt admission', async (code) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
      .mockResolvedValueOnce(json({ code, msg: 'token expired', data: null }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    await expect(ctx.waterfall(
      'api-session/prompt-admission',
      { sessionId: 'session-test' as never, signal: AbortSignal.timeout(1000) },
      () => Promise.resolve(),
    )).rejects.toMatchObject({ code: 'jdcloud/auth-required', details: { reason: 'expired' } })
    expect(await ctx.jdcloudAuthController.status()).toEqual({ authenticated: false, baseUrl: 'https://kindoucloud.com' })
  })

  it.each([400, 500])('keeps the token for network and non-auth business code %i failures', async (code) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: { token: 'bearer token' } }))
      .mockResolvedValueOnce(json({ code: 200, msg: 'ok', data: corpData() }))
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(json({ code, msg: 'backend failed', data: null }))
    const ctx = await boot(fetcher as typeof fetch)
    await ctx.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    }, AbortSignal.timeout(1000))
    const request = { sessionId: 'session-test' as never, signal: AbortSignal.timeout(1000) }
    await expect(ctx.waterfall('api-session/prompt-admission', request, () => Promise.resolve()))
      .rejects.toMatchObject({ code: 'jdcloud/validation-failed', details: { code: null } })
    expect((await ctx.jdcloudAuthController.status()).authenticated).toBe(true)
    await expect(ctx.waterfall('api-session/prompt-admission', request, () => Promise.resolve()))
      .rejects.toMatchObject({ code: 'jdcloud/validation-failed', details: { code } })
    expect((await ctx.jdcloudAuthController.status()).authenticated).toBe(true)
  })

  it.each([
    { kind: 'api-key', payload: {} },
    { kind: 'grant', payload: 'invalid' },
    { kind: 'grant', payload: null },
    { kind: 'grant', payload: { version: 1, baseUrl: 'https://kindoucloud.com', token: 'token' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 42, token: 'token', username: 'u', corpId: 'c', corpName: 'n' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 'https://kindoucloud.com', token: 42, username: 'u', corpId: 'c', corpName: 'n' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 'https://kindoucloud.com', token: '', username: 'u', corpId: 'c', corpName: 'n' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 'https://kindoucloud.com', token: 'token', username: '', corpId: 'c', corpName: 'n' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: '', corpName: 'n' } },
    { kind: 'grant', payload: { version: 2, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: '' } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [] } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [null] } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [[]] } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [{ corpId: '', corpName: 'n' }] } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [{ corpId: 'c', corpName: '' }] } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [{ corpId: 'c', corpName: 'n' }, { corpId: 'c', corpName: 'n' }] } },
    { kind: 'grant', payload: { version: 3, baseUrl: 'https://kindoucloud.com', token: 'token', username: 'u', corpId: 'c', corpName: 'n', corps: [{ corpId: 'other', corpName: 'Other' }] } },
  ])('rejects an invalid stored authentication record', async (record) => {
    const ctx = await boot(vi.fn() as typeof fetch)
    await ctx.credentials.modifyRecord(
      credentialKey('jdcloud-auth-controller', 'login'),
      () => Promise.resolve(record as never),
    )
    await expect(ctx.jdcloudAuthController.status()).rejects.toThrow('stored JDCloud authentication record is invalid')
  })
})
