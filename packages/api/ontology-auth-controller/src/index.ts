/** Host owner of browser-scoped Ontology Runtime login state. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, GrantRecord } from '@deepseek-ai/dsh-credentials/types'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  normalizeOntologyBaseUrl,
  OntologyApiError,
  OntologyClient,
  type OntologyTokenPair,
} from './client.ts'
import type {
  OntologyAuthStatus,
  OntologyAuthenticatedRequest,
  OntologyLoginRequest,
  OntologyRuntimeIdentity,
} from './types.ts'

export type * from './types.ts'
export {
  normalizeOntologyBaseUrl,
  OntologyApiError,
  OntologyClient,
} from './client.ts'

interface BrowserSessionIdentity {
  currentIdRequired(): string
}

interface AuthPayload extends OntologyTokenPair {
  readonly version: 1
  readonly baseUrl: string
}

type AuthenticationState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'authenticated'; readonly auth: AuthPayload }

/** Ontology authentication controller configuration. */
export interface Config {
  /** Deployment-owned Ontology Runtime service address. */
  readonly ontologyBaseUrl: string
  /** Network deadline for login, refresh, validation, and logout requests. */
  readonly requestTimeoutMs?: number
  /** Permit explicit HTTP only for loopback development addresses. */
  readonly allowInsecureLoopback?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser-scoped Ontology Runtime authentication state. */
    ontologyAuthController: OntologyAuthController
  }
}

/** Authenticate each browser independently and validate every submitted prompt. */
export class OntologyAuthController extends TypertRemoteService {
  static inject = ['credentials', 'browserSession']

  static Config: z<Config> = z.object({
    ontologyBaseUrl: z.string().required(),
    requestTimeoutMs: z.number().step(1).min(1).default(15_000),
    allowInsecureLoopback: z.boolean().default(false),
  })

  private readonly baseUrl: string
  private readonly requestTimeoutMs: number
  private readonly fetcher: typeof fetch

  /** @param ctx - Host context carrying browser sessions and durable credentials. @param config - Runtime connection policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'ontologyAuthController', { namespace: 'ontologyAuth' })
    this.baseUrl = normalizeOntologyBaseUrl(config.ontologyBaseUrl, config.allowInsecureLoopback ?? false)
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000
    this.fetcher = globalThis.fetch
    ctx.on('api-session/prompt-admission', async (request, next) => {
      const state = await this.authentication(request.signal)
      if (state.kind !== 'authenticated') {
        throw new RemoteError(
          'ontology/auth-required',
          state.kind === 'expired' ? 'Ontology login has expired' : 'Ontology login is required',
          { reason: state.kind },
        )
      }
      await next()
    })
  }

  /**
   * Read and validate redacted authentication state for the current browser.
   * @returns Current redacted authentication state.
   */
  @Remote
  async status(): Promise<OntologyAuthStatus> {
    const state = await this.authentication(AbortSignal.timeout(this.requestTimeoutMs))
    return state.kind === 'authenticated'
      ? authenticatedStatus(state.auth)
      : { authenticated: false, baseUrl: this.baseUrl }
  }

  /**
   * Create, validate, and store one Runtime Session for the current browser.
   * @param request - Ontology account credentials.
   * @param signal - Caller cancellation combined with the configured request timeout.
   * @returns Redacted authenticated state.
   */
  @Remote
  async login(request: OntologyLoginRequest, signal: AbortSignal): Promise<OntologyAuthStatus> {
    const username = request.username.trim()
    if (username === '' || request.password === '') {
      throw new RemoteError('gateway/bad-request', 'Ontology account and password are required', {})
    }
    const client = this.client()
    const operationSignal = this.operationSignal(signal)
    let tokens: OntologyTokenPair
    let identity: OntologyRuntimeIdentity
    try {
      tokens = await client.login(username, request.password, operationSignal)
      identity = await client.current(tokens.accessToken, operationSignal)
      if (identity.userId !== tokens.user.userId) {
        throw new Error('Ontology login returned inconsistent users')
      }
    } catch (error) {
      throw this.remoteError('login', error)
    }
    const auth: AuthPayload = { version: 1, baseUrl: this.baseUrl, ...tokens, user: identity }
    let replaced: AuthPayload | undefined
    await this.ctx.credentials.modifyRecord(this.authKey(), (current) => {
      replaced = current === undefined ? undefined : parseAuthRecord(current, this.baseUrl)
      return Promise.resolve(authRecord(auth))
    })
    if (replaced !== undefined && replaced.accessToken !== auth.accessToken) {
      // A replacement login owns the previous Runtime Session cleanup, but cleanup failure must not discard the new login.
      void client.logout(replaced.accessToken, AbortSignal.timeout(this.requestTimeoutMs)).catch((error: unknown) => {
        this.ctx.logger.warn('ontology-auth-controller: replaced Runtime Session logout failed')
        this.ctx.logger.warn(error)
      })
    }
    return authenticatedStatus(auth)
  }

  /**
   * Revoke and delete only the current browser's Runtime Session.
   * @returns Redacted unauthenticated state.
   */
  @Remote
  async logout(): Promise<OntologyAuthStatus> {
    const state = await this.authentication(AbortSignal.timeout(this.requestTimeoutMs))
    if (state.kind !== 'authenticated') {
      await this.ctx.credentials.deleteRecord(this.authKey())
      return { authenticated: false, baseUrl: this.baseUrl }
    }
    try {
      await this.client().logout(state.auth.accessToken, AbortSignal.timeout(this.requestTimeoutMs))
    } catch (error) {
      if (!(error instanceof OntologyApiError && isUnauthenticated(error))) {
        throw this.remoteError('logout', error)
      }
    }
    await this.ctx.credentials.deleteRecord(this.authKey())
    return { authenticated: false, baseUrl: this.baseUrl }
  }

  /**
   * Return the stable user owner key for the current browser login.
   * @returns SHA-256 of service address and stable Ontology user id, or undefined while logged out.
   */
  async currentScopeKey(): Promise<string | undefined> {
    const state = await this.authentication(AbortSignal.timeout(this.requestTimeoutMs))
    if (state.kind !== 'authenticated') return undefined
    return createHash('sha256').update(this.baseUrl).update(state.auth.user.userId).digest('hex')
  }

  /**
   * Send one Runtime request with the current browser's stored login.
   * @param request - Fixed Runtime API path, method, and optional JSON body.
   * @param signal - Caller cancellation combined with the configured request timeout.
   * @returns Untrusted JSON for the owning consumer to validate at the wire boundary.
   */
  async requestAuthenticated(request: OntologyAuthenticatedRequest, signal: AbortSignal): Promise<unknown> {
    const operationSignal = this.operationSignal(signal)
    let state = await this.authentication(operationSignal)
    if (state.kind !== 'authenticated') throw authRequired(state.kind)
    try {
      return await this.client().requestAuthenticated(state.auth.accessToken, request, operationSignal)
    } catch (error) {
      if (!(error instanceof OntologyApiError && isUnauthenticated(error))) throw error
    }
    state = await this.authentication(operationSignal)
    if (state.kind !== 'authenticated') throw authRequired(state.kind)
    return this.client().requestAuthenticated(state.auth.accessToken, request, operationSignal)
  }

  private client(): OntologyClient {
    return new OntologyClient(this.baseUrl, this.fetcher)
  }

  private operationSignal(callerSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([callerSignal, AbortSignal.timeout(this.requestTimeoutMs)])
  }

  /** Resolve a stored login, rotating tokens once after Access Token expiry. */
  private async authentication(callerSignal: AbortSignal): Promise<AuthenticationState> {
    const record = await this.ctx.credentials.readRecord(this.authKey())
    if (record === undefined) return { kind: 'missing' }
    const auth = parseAuthRecord(record, this.baseUrl)
    const signal = this.operationSignal(callerSignal)
    try {
      const identity = await this.client().current(auth.accessToken, signal)
      return { kind: 'authenticated', auth: await this.commitIdentity(auth, identity) }
    } catch (error) {
      if (!(error instanceof OntologyApiError && isUnauthenticated(error))) {
        throw this.remoteError('validate', error)
      }
    }
    try {
      const refreshed = await this.refresh(auth, signal)
      const identity = await this.client().current(refreshed.accessToken, signal)
      return { kind: 'authenticated', auth: await this.commitIdentity(refreshed, identity) }
    } catch (error) {
      if (error instanceof OntologyApiError
        && (isUnauthenticated(error) || error.code === 'runtime_refresh_rejected')) {
        await this.ctx.credentials.deleteRecord(this.authKey())
        return { kind: 'expired' }
      }
      throw this.remoteError('validate', error)
    }
  }

  /** Rotate a still-current stored refresh token under the credential provider's record lock. */
  private async refresh(stale: AuthPayload, signal: AbortSignal): Promise<AuthPayload> {
    const record = await this.ctx.credentials.modifyRecord(this.authKey(), async (current) => {
      if (current === undefined) return undefined
      const latest = parseAuthRecord(current, this.baseUrl)
      if (!sameRuntimeSession(latest, stale)) return undefined
      const tokens = await this.client().refresh(latest.refreshToken, signal)
      if (tokens.user.userId !== latest.user.userId) {
        throw new Error('Ontology refresh returned a different user')
      }
      return authRecord({ version: 1, baseUrl: this.baseUrl, ...tokens })
    })
    if (record === undefined) throw new OntologyApiError(401, 'runtime_refresh_rejected', null, 'Ontology login has expired')
    return parseAuthRecord(record, this.baseUrl)
  }

  /** Update changed identity fields only while the validated Runtime Session is still current. */
  private async commitIdentity(auth: AuthPayload, identity: OntologyRuntimeIdentity): Promise<AuthPayload> {
    if (identity.userId !== auth.user.userId) throw new Error('Ontology current-user response changed Runtime Session user')
    const record = await this.ctx.credentials.modifyRecord(this.authKey(), (current) => {
      if (current === undefined) return Promise.resolve(undefined)
      const latest = parseAuthRecord(current, this.baseUrl)
      if (!sameRuntimeSession(latest, auth)) return Promise.resolve(undefined)
      if (sameIdentity(latest.user, identity)) return Promise.resolve(undefined)
      return Promise.resolve(authRecord({ ...latest, user: identity }))
    })
    if (record === undefined) throw new Error('Ontology login changed during validation')
    const committed = parseAuthRecord(record, this.baseUrl)
    if (!sameRuntimeSession(committed, auth)) throw new Error('Ontology login changed during validation')
    return committed
  }

  /** Select the current browser's exact deployment-scoped credential record. */
  private authKey(): ReturnType<typeof credentialKey> {
    const browserSession = this.ctx.get('browserSession') as BrowserSessionIdentity | undefined
    if (browserSession === undefined) throw new Error('Ontology authentication requires the browser-session service')
    let browserId: string
    try {
      browserId = browserSession.currentIdRequired()
    } catch (error) {
      throw new Error('Ontology authentication requires a browser request', { cause: error })
    }
    const digest = createHash('sha256').update(this.baseUrl).update(browserId).digest('hex')
    return credentialKey('ontology-auth-controller', `login-${digest}`)
  }

  private remoteError(operation: 'login' | 'validate' | 'logout', error: unknown): RemoteError {
    const code = error instanceof OntologyApiError ? error.code : null
    const status = error instanceof OntologyApiError ? error.status : null
    const message = error instanceof Error ? error.message : String(error)
    if (operation === 'login') return new RemoteError('ontology/auth-failed', message, { code, status })
    if (operation === 'logout') return new RemoteError('ontology/logout-failed', message, { code, status })
    return new RemoteError('ontology/validation-failed', message, { code, status })
  }
}

function isUnauthenticated(error: OntologyApiError): boolean {
  return error.status === 401 && error.code === 'runtime_unauthenticated'
}

function authRequired(reason: 'missing' | 'expired'): RemoteError {
  return new RemoteError(
    'ontology/auth-required',
    reason === 'expired' ? 'Ontology login has expired' : 'Ontology login is required',
    { reason },
  )
}

/** Validate the owner-defined durable grant before using either token. */
function parseAuthRecord(record: CredentialRecord, expectedBaseUrl: string): AuthPayload {
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('stored Ontology authentication record is invalid')
  }
  const payload = record.payload
  const version: unknown = Reflect.get(payload, 'version')
  const baseUrl: unknown = Reflect.get(payload, 'baseUrl')
  const accessToken: unknown = Reflect.get(payload, 'accessToken')
  const accessTokenExpiresAt: unknown = Reflect.get(payload, 'accessTokenExpiresAt')
  const refreshToken: unknown = Reflect.get(payload, 'refreshToken')
  const refreshTokenExpiresAt: unknown = Reflect.get(payload, 'refreshTokenExpiresAt')
  const user = parseIdentity(Reflect.get(payload, 'user'))
  if (version !== 1
    || baseUrl !== expectedBaseUrl
    || typeof accessToken !== 'string' || accessToken.length === 0
    || typeof refreshToken !== 'string' || refreshToken.length === 0
    || !isTimestamp(accessTokenExpiresAt)
    || !isTimestamp(refreshTokenExpiresAt)) {
    throw new Error('stored Ontology authentication record is invalid')
  }
  return {
    version,
    baseUrl,
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    user,
  }
}

function parseIdentity(value: unknown): OntologyRuntimeIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('stored Ontology authentication record is invalid')
  }
  const userId: unknown = Reflect.get(value, 'userId')
  const username: unknown = Reflect.get(value, 'username')
  const displayName: unknown = Reflect.get(value, 'displayName')
  const accountType: unknown = Reflect.get(value, 'accountType')
  const authorizationVersion: unknown = Reflect.get(value, 'authorizationVersion')
  if (typeof userId !== 'string' || userId.length === 0
    || typeof username !== 'string' || username.length === 0
    || typeof displayName !== 'string' || displayName.length === 0
    || (accountType !== 'admin' && accountType !== 'member')
    || typeof authorizationVersion !== 'string' || authorizationVersion.length === 0) {
    throw new Error('stored Ontology authentication record is invalid')
  }
  return { userId, username, displayName, accountType, authorizationVersion }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function authRecord(payload: AuthPayload): GrantRecord {
  return { kind: 'grant', payload }
}

function authenticatedStatus(auth: AuthPayload): Extract<OntologyAuthStatus, { readonly authenticated: true }> {
  return { authenticated: true, baseUrl: auth.baseUrl, user: auth.user }
}

function sameRuntimeSession(left: AuthPayload, right: AuthPayload): boolean {
  return left.baseUrl === right.baseUrl
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.user.userId === right.user.userId
}

function sameIdentity(left: OntologyRuntimeIdentity, right: OntologyRuntimeIdentity): boolean {
  return left.userId === right.userId
    && left.username === right.username
    && left.displayName === right.displayName
    && left.accountType === right.accountType
    && left.authorizationVersion === right.authorizationVersion
}

export default OntologyAuthController
