import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionService } from '../../../client/connection/src/browser-session.ts'
import { credentialKey } from '../../../credentials/credentials/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OntologyAuthController, {
  normalizeOntologyBaseUrl,
  type OntologyRuntimeIdentity,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface RuntimeSession {
  accessToken: string
  refreshToken: string
  user: OntologyRuntimeIdentity
  active: boolean
  accessValid: boolean
}

/** Build a deterministic in-memory implementation of the four Runtime identity endpoints. */
function runtimeServer() {
  let sequence = 0
  const sessions = new Map<string, RuntimeSession>()
  const users = new Map<string, OntologyRuntimeIdentity>()

  const identity = (username: string): OntologyRuntimeIdentity => {
    const current = users.get(username)
    if (current !== undefined) return current
    const created = {
      userId: `user-${username}`,
      username,
      displayName: username === 'alice' ? 'Alice' : 'Bob',
      accountType: username === 'alice' ? 'admin' as const : 'member' as const,
      authorizationVersion: '1',
    }
    users.set(username, created)
    return created
  }

  const issue = (user: OntologyRuntimeIdentity): RuntimeSession => {
    sequence += 1
    const session = {
      accessToken: `access-${user.username}-${String(sequence)}`,
      refreshToken: `refresh-${user.username}-${String(sequence)}`,
      user,
      active: true,
      accessValid: true,
    }
    sessions.set(session.accessToken, session)
    return session
  }

  const tokenBody = (session: RuntimeSession) => ({
    accessToken: session.accessToken,
    accessTokenExpiresAt: '2026-10-09T10:15:00Z',
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: '2026-11-08T10:00:00Z',
    user: session.user,
  })

  const error = (status: number, code: string, message: string): Response => Response.json({
    code,
    message,
    requestId: `request-${String(sequence)}`,
  }, { status })

  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.pathname.endsWith('/api/runtime/auth/login')) {
      if (typeof init?.body !== 'string') throw new Error('login request did not contain a JSON body')
      const body = JSON.parse(init.body) as { username: string; password: string }
      if (body.password !== 'password123') return error(401, 'runtime_invalid_credentials', '账号或密码错误')
      return Response.json(tokenBody(issue(identity(body.username))))
    }
    if (url.pathname.endsWith('/api/runtime/auth/refresh')) {
      if (typeof init?.body !== 'string') throw new Error('refresh request did not contain a JSON body')
      const body = JSON.parse(init.body) as { refreshToken: string }
      const previous = [...sessions.values()].find(session => session.refreshToken === body.refreshToken && session.active)
      if (previous === undefined) return error(401, 'runtime_refresh_rejected', '刷新凭证已失效')
      previous.active = false
      return Response.json(tokenBody(issue(previous.user)))
    }
    const authorization = new Headers(init?.headers).get('authorization')
    const token = authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : ''
    const session = sessions.get(token)
    if (session === undefined || !session.active || !session.accessValid) {
      return error(401, 'runtime_unauthenticated', '登录状态已失效')
    }
    if (url.pathname.endsWith('/api/runtime/auth/current')) return Response.json(session.user)
    if (url.pathname.endsWith('/api/runtime/auth/logout')) {
      session.active = false
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/api/runtime/projects')) {
      return Response.json({ projects: [{ id: 'project-sales', name: 'Sales' }] })
    }
    return error(404, 'runtime_not_found', '不存在')
  })

  return {
    fetcher,
    expireAccessToken(token: string) {
      const session = sessions.get(token)
      if (session !== undefined) session.accessValid = false
    },
    sessionFor(username: string) {
      return [...sessions.values()].find(session => session.user.username === username && session.active)
    },
  }
}

/** Mount persistent credentials, the real browser-session service, and the controller. */
async function boot(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  let browserSession: BrowserSessionService | undefined
  const sessionFiber = ctx.plugin({
    inject: ['credentials'],
    apply: async (sessionCtx: Context) => {
      browserSession = await BrowserSessionService.create(sessionCtx, sessionCtx.credentials)
    },
  })
  await sessionFiber.await()
  const authFiber = ctx.plugin(OntologyAuthController, {
    ontologyBaseUrl: 'https://ontology.example.com',
    requestTimeoutMs: 1_000,
  })
  await authFiber.await()
  if (browserSession === undefined) throw new Error('browser session service was not created')
  return { ctx, browserSession, authFiber }
}

function browserCookie(browserSession: BrowserSessionService, authority = 'harness.example'): string {
  const response: {
    headers: Record<string, string>
    writeHead: (_status: number, headers?: Readonly<Record<string, string>>) => void
    end: () => void
  } = {
    headers: {},
    writeHead: (_status, headers) => { if (headers !== undefined) Object.assign(response.headers, headers) },
    end: () => undefined,
  }
  browserSession.authorizeIndex({ headers: { host: authority }, method: 'GET', url: '/' }, response)
  const cookie = response.headers['set-cookie']?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('browser session cookie was not created')
  return cookie
}

function browserRequest(cookie: string, authority = 'harness.example') {
  return { headers: { host: authority, cookie } }
}

describe('Ontology Runtime HTTP client', () => {
  it('requires HTTPS unless loopback HTTP is explicitly enabled', () => {
    expect(normalizeOntologyBaseUrl('https://ontology.example.com/', false)).toBe('https://ontology.example.com')
    expect(() => normalizeOntologyBaseUrl('http://ontology.example.com', true)).toThrow('must use HTTPS')
    expect(() => normalizeOntologyBaseUrl('http://127.0.0.1:8080', false)).toThrow('must use HTTPS')
    expect(normalizeOntologyBaseUrl('http://127.0.0.1:8080/', true)).toBe('http://127.0.0.1:8080')
  })
})

describe('Ontology authentication controller', () => {
  it('isolates different browsers and deletes only the browser that logs out', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const firstCookie = browserCookie(browserSession)
    const secondCookie = browserCookie(browserSession)
    const firstRequest = browserRequest(firstCookie)
    const secondRequest = browserRequest(secondCookie)

    await browserSession.run(firstRequest, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))
    await browserSession.run(secondRequest, () => ctx.ontologyAuthController.login({
      username: 'bob', password: 'password123',
    }, AbortSignal.timeout(1_000)))

    await expect(browserSession.run(firstRequest, () => ctx.ontologyAuthController.status()))
      .resolves.toMatchObject({ authenticated: true, user: { userId: 'user-alice' } })
    await expect(browserSession.run(secondRequest, () => ctx.ontologyAuthController.status()))
      .resolves.toMatchObject({ authenticated: true, user: { userId: 'user-bob' } })

    await browserSession.run(firstRequest, () => ctx.ontologyAuthController.logout())
    await expect(browserSession.run(firstRequest, () => ctx.ontologyAuthController.status()))
      .resolves.toEqual({ authenticated: false, baseUrl: 'https://ontology.example.com' })
    await expect(browserSession.run(secondRequest, () => ctx.ontologyAuthController.status()))
      .resolves.toMatchObject({ authenticated: true, user: { userId: 'user-bob' } })
  })

  it('uses deployment and browser identity in credential keys but stable user identity in owner scopes', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const firstRequest = browserRequest(browserCookie(browserSession))
    const secondRequest = browserRequest(browserCookie(browserSession))
    let firstBrowserId = ''
    let secondBrowserId = ''

    const firstScope = await browserSession.run(firstRequest, async () => {
      firstBrowserId = browserSession.currentIdRequired()
      await ctx.ontologyAuthController.login({ username: 'alice', password: 'password123' }, AbortSignal.timeout(1_000))
      return ctx.ontologyAuthController.currentScopeKey()
    })
    const secondScope = await browserSession.run(secondRequest, async () => {
      secondBrowserId = browserSession.currentIdRequired()
      await ctx.ontologyAuthController.login({ username: 'alice', password: 'password123' }, AbortSignal.timeout(1_000))
      return ctx.ontologyAuthController.currentScopeKey()
    })

    expect(firstBrowserId).not.toBe(secondBrowserId)
    expect(firstScope).toBe(secondScope)
    expect(firstScope).toBe(createHash('sha256').update('https://ontology.example.com').update('user-alice').digest('hex'))
    const firstKey = credentialKey('ontology-auth-controller', `login-${createHash('sha256')
      .update('https://ontology.example.com').update(firstBrowserId).digest('hex')}`)
    const secondKey = credentialKey('ontology-auth-controller', `login-${createHash('sha256')
      .update('https://ontology.example.com').update(secondBrowserId).digest('hex')}`)
    expect(firstKey).not.toBe(secondKey)
    expect(await ctx.credentials.readRecord(firstKey)).toBeDefined()
    expect(await ctx.credentials.readRecord(secondKey)).toBeDefined()
  })

  it('rotates tokens after Access Token expiry and persists the replacement', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const request = browserRequest(browserCookie(browserSession))
    await browserSession.run(request, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))
    const first = server.sessionFor('alice')
    if (first === undefined) throw new Error('login session was not created')
    server.expireAccessToken(first.accessToken)

    await expect(browserSession.run(request, () => ctx.ontologyAuthController.status()))
      .resolves.toMatchObject({ authenticated: true, user: { username: 'alice' } })
    expect(server.sessionFor('alice')?.accessToken).not.toBe(first.accessToken)
  })

  it('sends authenticated Runtime requests and retries after Access Token expiry', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const request = browserRequest(browserCookie(browserSession))
    await browserSession.run(request, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))
    const first = server.sessionFor('alice')
    if (first === undefined) throw new Error('login session was not created')
    server.expireAccessToken(first.accessToken)

    await expect(browserSession.run(request, () => ctx.ontologyAuthController.requestAuthenticated({
      method: 'GET', path: '/api/runtime/projects',
    }, AbortSignal.timeout(1_000)))).resolves.toEqual({
      projects: [{ id: 'project-sales', name: 'Sales' }],
    })
    expect(server.sessionFor('alice')?.accessToken).not.toBe(first.accessToken)
  })

  it('does not rewrite an unchanged identity during status validation', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const request = browserRequest(browserCookie(browserSession))
    await browserSession.run(request, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))
    const updated = vi.fn()
    ctx.on('credentials/record-updated', updated)

    await expect(browserSession.run(request, () => ctx.ontologyAuthController.status()))
      .resolves.toMatchObject({ authenticated: true, user: { username: 'alice' } })
    expect(updated).not.toHaveBeenCalled()
  })

  it('restores a browser login after the controller is reloaded', async () => {
    const server = runtimeServer()
    const { ctx, browserSession, authFiber } = await boot(server.fetcher)
    const request = browserRequest(browserCookie(browserSession))
    await browserSession.run(request, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))
    await authFiber.dispose()
    const replacement = ctx.plugin(OntologyAuthController, {
      ontologyBaseUrl: 'https://ontology.example.com', requestTimeoutMs: 1_000,
    })
    await replacement.await()

    await expect(browserSession.run(request, () => ctx.ontologyAuthController.status()))
      .resolves.toMatchObject({ authenticated: true, user: { userId: 'user-alice' } })
  })

  it('rejects prompt admission for an unauthenticated browser and admits it after login', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const request = browserRequest(browserCookie(browserSession))
    const admission = { sessionId: 'session-test' as never, signal: AbortSignal.timeout(1_000) }
    await expect(browserSession.run(request, () => ctx.waterfall(
      'api-session/prompt-admission', admission, () => Promise.resolve(),
    ))).rejects.toMatchObject({ code: 'ontology/auth-required', details: { reason: 'missing' } })

    await browserSession.run(request, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))
    const next = vi.fn(() => Promise.resolve())
    await browserSession.run(request, () => ctx.waterfall('api-session/prompt-admission', admission, next))
    expect(next).toHaveBeenCalledOnce()
  })

  it('never stores a failed password and requires a browser request', async () => {
    const server = runtimeServer()
    const { ctx, browserSession } = await boot(server.fetcher)
    const request = browserRequest(browserCookie(browserSession))
    await expect(browserSession.run(request, () => ctx.ontologyAuthController.login({
      username: 'alice', password: 'wrong',
    }, AbortSignal.timeout(1_000)))).rejects.toMatchObject({
      code: 'ontology/auth-failed', details: { code: 'runtime_invalid_credentials', status: 401 },
    })
    await expect(ctx.ontologyAuthController.status()).rejects.toThrow('requires a browser request')
  })
})
