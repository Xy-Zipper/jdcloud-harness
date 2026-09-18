/** Independent browser identity used by deployments that do not use Harness launch authentication. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'

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
const SECRET_VERSION = 1
const MAX_AGE_DAYS = 30

interface CookiePayload {
  readonly version: typeof COOKIE_VERSION
  readonly browserId: string
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Carries one opaque browser id through HTTP, RPC, and Fetch handlers. */
export class BrowserSessionService extends Service {
  static inject = ['credentials']
  private readonly requests = new AsyncLocalStorage<string>()

  private constructor(ctx: Context, private readonly secret: Buffer, private readonly maxAgeMilliseconds: number) {
    super(ctx, 'browserSession')
  }

  /**
   * Create the durable cookie-signing owner.
   * @param ctx - Context that owns the service.
   * @param credentials - Credential store for the signing secret.
   * @param maxAgeDays - Cookie lifetime in days.
   * @returns The initialized browser-session service.
   */
  static async create(ctx: Context, credentials: CredentialProvider, maxAgeDays = MAX_AGE_DAYS): Promise<BrowserSessionService> {
    return new BrowserSessionService(ctx, await loadSecret(credentials), maxAgeDays * 24 * 60 * 60 * 1000)
  }

  /**
   * Mint one browser cookie before the first index response.
   * @param request - Incoming connection index request.
   * @param response - Response writer used for the redirect and cookie.
   * @returns Whether the request already has a valid browser session.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
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
      'set-cookie': `${COOKIE_NAME}=${value}; Max-Age=${String(Math.floor(this.maxAgeMilliseconds / 1000))}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`,
    })
    response.end()
    return false
  }

  /**
   * Return whether the request has a valid browser cookie.
   * @param request - Incoming connection trust request.
   * @returns Whether the request carries a valid browser session.
   */
  accepts(request: ConnectionTrustRequest): boolean {
    return this.browserId(request) !== undefined
  }

  /**
   * Run one request with its browser id available to Host services.
   * @param request - Incoming connection trust request.
   * @param operation - Operation that reads the request-local browser id.
   * @returns The operation result.
   */
  run<Value>(request: ConnectionTrustRequest, operation: () => Value): Value {
    const browserId = this.browserId(request)
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

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const [body, encoded, extra] = value.split('.')
  if (body === undefined || encoded === undefined || extra !== undefined) return undefined
  const expected = createHmac('sha256', secret).update(body).digest()
  const actual = Buffer.from(encoded, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const value = payload as Record<string, unknown>
    return value.version === COOKIE_VERSION
      && typeof value.browserId === 'string' && value.browserId.length > 0
      && typeof value.authority === 'string'
      && Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt)
      ? payload as CookiePayload
      : undefined
  } catch { return undefined }
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
