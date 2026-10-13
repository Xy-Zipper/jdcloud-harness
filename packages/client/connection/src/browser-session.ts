/** Independent browser identity used by deployments that do not use Harness launch authentication. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'
import type { BrowserSessionTransport } from './browser-session-protocol.ts'

export type { BrowserSessionTransport } from './browser-session-protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Request-local independent browser session, when enabled by the deployment. */
    browserSession?: BrowserSessionService
  }
}

const SECRET_KEY = credentialKey('client-connection', 'browser-user-session-secret')
const COOKIE_NAME = 'dsh-user-session'
const SECRET_BYTES = 32
const COOKIE_VERSION = 1
const BEARER_VERSION = 1
const SECRET_VERSION = 1
const MAX_AGE_DAYS = 30
const WEBSOCKET_TICKET_MAX_AGE_MS = 30_000

/** Browser cookie policy supported by the independent session service. */
export type BrowserSessionCookieSameSite = 'strict' | 'none'

interface CookiePayload {
  readonly version: typeof COOKIE_VERSION
  readonly browserId: string
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

interface BearerPayload {
  readonly version: typeof BEARER_VERSION
  readonly kind: 'bearer'
  readonly browserId: string
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

interface WebSocketTicket {
  readonly browserId: string
  readonly authority: string
  readonly expiresAt: number
}

/** Carries one opaque browser id through HTTP, RPC, and Fetch handlers. */
export class BrowserSessionService extends Service {
  static inject = ['credentials']
  private readonly requests = new AsyncLocalStorage<string>()
  private readonly admittedWebSockets = new WeakMap<ConnectionTrustRequest, string>()
  private readonly webSocketTickets = new Map<string, WebSocketTicket>()

  private constructor(
    ctx: Context,
    private readonly secret: Buffer,
    private readonly maxAgeMilliseconds: number,
    private readonly cookieSameSite: BrowserSessionCookieSameSite,
    readonly transport: BrowserSessionTransport,
  ) {
    super(ctx, 'browserSession')
  }

  /**
   * Create the durable browser-identity signing owner.
   * @param ctx - Context that owns the service.
   * @param credentials - Credential store for the signing secret.
   * @param maxAgeDays - Independent browser-session lifetime in days.
   * @param cookieSameSite - Strict first-party policy, or None with Secure for cross-site iframe use.
   * @param transport - Cookie carrier, or a browser-managed Bearer header.
   * @returns The initialized browser-session service.
   */
  static async create(
    ctx: Context,
    credentials: CredentialProvider,
    maxAgeDays = MAX_AGE_DAYS,
    cookieSameSite: BrowserSessionCookieSameSite = 'strict',
    transport: BrowserSessionTransport = 'cookie',
  ): Promise<BrowserSessionService> {
    return new BrowserSessionService(
      ctx,
      await loadSecret(credentials),
      maxAgeDays * 24 * 60 * 60 * 1000,
      cookieSameSite,
      transport,
    )
  }

  /**
   * Mint one browser cookie before the first index response.
   * @param request - Incoming connection index request.
   * @param response - Response writer used for the redirect and cookie.
   * @returns Whether the request already has a valid browser session.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    if (this.transport === 'bearer') {
      return (request.method === 'GET' || request.method === 'HEAD')
        && requestAuthority(request.headers) !== undefined
    }
    if (this.browserId(request) !== undefined) return true
    if (request.method !== 'GET' && request.method !== 'HEAD') return false
    const authority = requestAuthority(request.headers)
    if (authority === undefined) return false
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({ version: COOKIE_VERSION, browserId: randomUUID(), authority, issuedAt, expiresAt }, this.secret)
    response.writeHead(303, {
      'cache-control': 'no-store',
      location: '/',
      'set-cookie': `${COOKIE_NAME}=${value}; Max-Age=${String(Math.floor(this.maxAgeMilliseconds / 1000))}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; ${this.cookieSameSite === 'none' ? 'SameSite=None; Secure' : 'SameSite=Strict'}`,
    })
    response.end()
    return false
  }

  /**
   * Return whether the request carries the configured browser identity.
   * @param request - Incoming connection trust request.
   * @returns Whether the request carries a valid browser session.
   */
  accepts(request: ConnectionTrustRequest): boolean {
    return this.browserId(request) !== undefined
  }

  /**
   * Mint one authority-bound Bearer session for a same-origin browser bootstrap.
   * @param request - trusted bootstrap request.
   * @returns opaque token and absolute expiry.
   */
  issueBearer(request: ConnectionTrustRequest): { readonly token: string; readonly expiresAt: number } {
    if (this.transport !== 'bearer') throw new Error('browser Bearer sessions are not enabled')
    const authority = requestAuthority(request.headers)
    if (authority === undefined) throw new Error('browser session authority is invalid')
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const token = encodeSigned({
      version: BEARER_VERSION,
      kind: 'bearer',
      browserId: randomUUID(),
      authority,
      issuedAt,
      expiresAt,
    }, this.secret)
    return { token, expiresAt }
  }

  /**
   * Mint a short-lived, single-use WebSocket ticket for an authenticated Bearer request.
   * @param request - request carrying the browser session Bearer token.
   * @returns opaque ticket accepted by one upgrade.
   */
  issueWebSocketTicket(request: ConnectionTrustRequest): string {
    if (this.transport !== 'bearer') throw new Error('browser Bearer sessions are not enabled')
    const browserId = this.browserId(request)
    const authority = requestAuthority(request.headers)
    if (browserId === undefined || authority === undefined) throw new Error('browser user session is required')
    this.pruneWebSocketTickets()
    const ticket = randomBytes(32).toString('base64url')
    this.webSocketTickets.set(ticket, {
      browserId,
      authority,
      expiresAt: Date.now() + WEBSOCKET_TICKET_MAX_AGE_MS,
    })
    return ticket
  }

  /**
   * Consume the ticket carried by one WebSocket upgrade.
   * @param request - trusted upgrade request carrying a `ticket` query parameter.
   * @returns whether the ticket authorized this exact request.
   */
  admitWebSocket(request: ConnectionTrustRequest): boolean {
    if (this.transport !== 'bearer') return this.accepts(request)
    this.pruneWebSocketTickets()
    const ticket = requestTicket(request.url)
    if (ticket === undefined) return false
    const session = this.webSocketTickets.get(ticket)
    if (session === undefined) return false
    this.webSocketTickets.delete(ticket)
    if (session.expiresAt <= Date.now() || session.authority !== requestAuthority(request.headers)) return false
    this.admittedWebSockets.set(request, session.browserId)
    return true
  }

  /**
   * Run one request with its browser id available to Host services.
   * @param request - Incoming connection trust request.
   * @param operation - Operation that reads the request-local browser id.
   * @returns The operation result.
   */
  run<Value>(request: ConnectionTrustRequest, operation: () => Value): Value {
    const browserId = this.admittedWebSockets.get(request) ?? this.browserId(request)
    if (browserId === undefined) throw new Error('browser user session is required')
    return this.requests.run(browserId, operation)
  }

  /**
   * Read the current browser id inside a request handler.
   * @returns The current opaque browser id.
   */
  currentIdRequired(): string {
    const browserId = this.requests.getStore()
    if (browserId === undefined) throw new Error('browser user session is unavailable outside a request')
    return browserId
  }

  private browserId(request: ConnectionTrustRequest): string | undefined {
    if (this.transport === 'bearer') return this.bearerBrowserId(request)
    const cookie = header(request.headers, 'cookie')
    const value = cookie === undefined ? undefined : cookieValue(cookie, COOKIE_NAME)
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== requestAuthority(request.headers)) return undefined
    const now = Date.now()
    return payload.issuedAt <= now && payload.expiresAt > now && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
      ? payload.browserId
      : undefined
  }

  private bearerBrowserId(request: ConnectionTrustRequest): string | undefined {
    const authorization = header(request.headers, 'authorization')
    const match = authorization === undefined
      ? undefined
      : /^Bearer ([a-z0-9_-]+\.[a-z0-9_-]+)$/iu.exec(authorization)
    const payload = match?.[1] === undefined ? undefined : decodeBearer(match[1], this.secret)
    if (payload === undefined || payload.authority !== requestAuthority(request.headers)) return undefined
    const now = Date.now()
    return payload.issuedAt <= now && payload.expiresAt > now
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
      ? payload.browserId
      : undefined
  }

  private pruneWebSocketTickets(): void {
    const now = Date.now()
    for (const [ticket, session] of this.webSocketTickets) {
      if (session.expiresAt <= now) this.webSocketTickets.delete(ticket)
    }
  }
}

function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try { return new URL(`http://${host}`).host } catch { return undefined }
}

function header(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function cookieValue(value: string, name: string): string | undefined {
  for (const segment of value.split(';')) {
    const at = segment.indexOf('=')
    if (at >= 0 && segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function encodeSigned(payload: CookiePayload | BearerPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  return encodeSigned(payload, secret)
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const payload = decodeSigned(value, secret)
  if (payload === undefined) return undefined
  return payload.version === COOKIE_VERSION
    && payload.kind === undefined
    && typeof payload.browserId === 'string' && payload.browserId.length > 0
    && typeof payload.authority === 'string'
    && typeof payload.issuedAt === 'number' && Number.isSafeInteger(payload.issuedAt)
    && typeof payload.expiresAt === 'number' && Number.isSafeInteger(payload.expiresAt)
    ? {
      version: COOKIE_VERSION,
      browserId: payload.browserId,
      authority: payload.authority,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    }
    : undefined
}

function decodeBearer(value: string, secret: Buffer): BearerPayload | undefined {
  const payload = decodeSigned(value, secret)
  if (payload === undefined) return undefined
  return payload.version === BEARER_VERSION
    && payload.kind === 'bearer'
    && typeof payload.browserId === 'string' && payload.browserId.length > 0
    && typeof payload.authority === 'string'
    && typeof payload.issuedAt === 'number' && Number.isSafeInteger(payload.issuedAt)
    && typeof payload.expiresAt === 'number' && Number.isSafeInteger(payload.expiresAt)
    ? {
      version: BEARER_VERSION,
      kind: 'bearer',
      browserId: payload.browserId,
      authority: payload.authority,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    }
    : undefined
}

function decodeSigned(value: string, secret: Buffer): Record<string, unknown> | undefined {
  const [body, encoded, extra] = value.split('.')
  if (body === undefined || encoded === undefined || extra !== undefined) return undefined
  const expected = createHmac('sha256', secret).update(body).digest()
  const actual = Buffer.from(encoded, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined
  } catch { return undefined }
}

function requestTicket(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try { return new URL(url, 'http://dsh.invalid').searchParams.get('ticket') ?? undefined } catch { return undefined }
}

async function loadSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated = { version: SECRET_VERSION, secret: randomBytes(SECRET_BYTES).toString('base64url') }
  const record = await credentials.modifyRecord(SECRET_KEY, current => Promise.resolve(current ?? { kind: 'grant', payload: generated }))
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) throw new Error('browser session secret is invalid')
  const value: unknown = Reflect.get(record.payload, 'secret')
  if (typeof value !== 'string') throw new Error('browser session secret is invalid')
  const secret = Buffer.from(value, 'base64url')
  if (secret.length !== SECRET_BYTES) throw new Error('browser session secret is invalid')
  return secret
}
