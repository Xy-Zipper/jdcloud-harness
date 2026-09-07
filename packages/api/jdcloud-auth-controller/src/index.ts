/** Host owner of JDCloud login state and prompt admission validation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, GrantRecord } from '@deepseek-ai/dsh-credentials/types'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isJdcloudAuthError, JdcloudApiError, JdcloudClient, normalizeJdcloudBaseUrl } from './client.ts'
import type { JdcloudAuthStatus, JdcloudCorp, JdcloudLoginRequest } from './types.ts'

export type * from './types.ts'
export { isJdcloudAuthError, JdcloudApiError, JdcloudClient, normalizeJdcloudBaseUrl } from './client.ts'

const AUTH_KEY = credentialKey('jdcloud-auth-controller', 'login')

interface AuthPayload {
  readonly version: 3
  readonly baseUrl: string
  readonly token: string
  readonly username: string
  readonly corpId: string
  readonly corpName: string
  readonly corps: readonly JdcloudCorp[]
}

/** JDCloud authentication controller configuration. */
export interface Config {
  /** Service address shown before the user has saved a login. */
  readonly defaultBaseUrl?: string
  /** Network deadline for login and prompt validation requests. */
  readonly requestTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host JDCloud authentication state and Remote namespace owner. */
    jdcloudAuthController: JdcloudAuthController
  }
}

/** Store credentials, expose login commands, and validate each browser prompt. */
export class JdcloudAuthController extends TypertRemoteService {
  static inject = ['credentials']

  static Config: z<Config> = z.object({
    defaultBaseUrl: z.string().default(''),
    requestTimeoutMs: z.number().step(1).min(1).default(15_000),
  })

  private readonly defaultBaseUrl: string
  private readonly requestTimeoutMs: number
  private readonly fetcher: typeof fetch

  /** @param ctx - Host context carrying durable credentials. @param config - service address and timeout policy. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jdcloudAuthController', { namespace: 'jdcloudAuth' })
    this.defaultBaseUrl = config.defaultBaseUrl === undefined || config.defaultBaseUrl.trim() === ''
      ? ''
      : normalizeJdcloudBaseUrl(config.defaultBaseUrl)
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000
    this.fetcher = globalThis.fetch
    ctx.on('api-session/prompt-admission', async (request, next) => {
      await this.validateStoredLogin(request.signal)
      await next()
    })
  }

  /**
   * Read redacted stored authentication state.
   * @returns Current redacted authentication state.
   */
  @Remote
  async status(): Promise<JdcloudAuthStatus> {
    const auth = await this.readAuth()
    return auth === undefined
      ? { authenticated: false, baseUrl: this.defaultBaseUrl }
      : {
        authenticated: true,
        baseUrl: auth.baseUrl,
        username: auth.username,
        corpId: auth.corpId,
        corpName: auth.corpName,
        corps: auth.corps,
      }
  }

  /**
   * Authenticate, validate the resulting token, and commit it to Host credentials.
   * @param request - Service address and password credentials.
   * @param signal - Caller cancellation for login and validation requests.
   * @returns Redacted authenticated state.
   */
  @Remote
  async login(request: JdcloudLoginRequest, signal: AbortSignal): Promise<JdcloudAuthStatus> {
    if (request.username.trim() === '' || request.password === '') {
      throw new RemoteError('gateway/bad-request', 'JDCloud account and password are required', {})
    }
    let baseUrl: string
    try {
      baseUrl = normalizeJdcloudBaseUrl(request.baseUrl)
    } catch (error) {
      throw new RemoteError('gateway/bad-request', (error as Error).message, {})
    }
    const operationSignal = this.operationSignal(signal)
    const client = new JdcloudClient(baseUrl, this.fetcher)
    let token: string
    let corp: Awaited<ReturnType<JdcloudClient['getCorpList']>>
    try {
      token = await client.loginPassword(request.username.trim(), request.password, operationSignal)
      corp = await client.getCorpList(token, operationSignal)
    } catch (error) {
      throw this.requestError('login', error)
    }
    const record: GrantRecord = {
      kind: 'grant',
      payload: {
        version: 3,
        baseUrl,
        token,
        username: request.username.trim(),
        corpId: corp.corpId,
        corpName: corp.corpName,
        corps: corp.corps,
      } satisfies AuthPayload,
    }
    await this.ctx.credentials.modifyRecord(AUTH_KEY, () => Promise.resolve(record))
    return {
      authenticated: true,
      baseUrl,
      username: request.username.trim(),
      corpId: corp.corpId,
      corpName: corp.corpName,
      corps: corp.corps,
    }
  }

  /**
   * Select another tenant for the stored JDCloud login.
   * @param corpId - Tenant identity from the current authenticated status.
   * @param signal - Caller cancellation for the switch and confirmation requests.
   * @returns Redacted authenticated state with the confirmed current tenant.
   */
  @Remote
  async switchCorp(corpId: string, signal: AbortSignal): Promise<JdcloudAuthStatus> {
    const auth = await this.readAuth()
    if (auth === undefined) {
      throw new RemoteError('jdcloud/auth-required', 'JDCloud login is required', { reason: 'missing' })
    }
    if (!auth.corps.some(corp => corp.corpId === corpId)) {
      throw new RemoteError('gateway/bad-request', 'JDCloud tenant is not available to this account', {})
    }
    if (auth.corpId === corpId) return authenticatedStatus(auth)

    const client = new JdcloudClient(auth.baseUrl, this.fetcher)
    const operationSignal = this.operationSignal(signal)
    let corp: Awaited<ReturnType<JdcloudClient['getCorpList']>>
    try {
      await client.switchCorp(auth.token, corpId, operationSignal)
      corp = await client.getCorpList(auth.token, operationSignal)
      if (corp.corpId !== corpId) {
        throw new Error('JDCloud tenant-list response did not confirm the requested tenant')
      }
    } catch (error) {
      if (error instanceof JdcloudApiError && isJdcloudAuthError(error.code)) {
        await this.ctx.credentials.deleteRecord(AUTH_KEY)
        throw new RemoteError('jdcloud/auth-required', error.message, { reason: 'expired' })
      }
      throw this.requestError('switch', error)
    }

    const updated = await this.ctx.credentials.modifyRecord(AUTH_KEY, (current) => {
      if (current === undefined) return Promise.resolve(undefined)
      const latest = parseAuthRecord(current)
      if (latest.baseUrl !== auth.baseUrl || latest.token !== auth.token || latest.username !== auth.username) {
        return Promise.resolve(undefined)
      }
      return Promise.resolve(authRecord({
        ...latest,
        corpId: corp.corpId,
        corpName: corp.corpName,
        corps: corp.corps,
      }))
    })
    if (updated === undefined) {
      throw new RemoteError('jdcloud/switch-failed', 'JDCloud login changed while switching tenant', { code: null })
    }
    const committed = parseAuthRecord(updated)
    if (committed.baseUrl !== auth.baseUrl
      || committed.token !== auth.token
      || committed.username !== auth.username
      || !sameCorpState(committed, corp)) {
      throw new RemoteError('jdcloud/switch-failed', 'JDCloud login changed while switching tenant', { code: null })
    }
    return authenticatedStatus(committed)
  }

  /**
   * Delete the stored JDCloud token.
   * @returns Redacted unauthenticated state.
   */
  @Remote
  async logout(): Promise<JdcloudAuthStatus> {
    await this.ctx.credentials.deleteRecord(AUTH_KEY)
    return { authenticated: false, baseUrl: this.defaultBaseUrl }
  }

  private async validateStoredLogin(callerSignal: AbortSignal): Promise<void> {
    const auth = await this.readAuth()
    if (auth === undefined) {
      throw new RemoteError('jdcloud/auth-required', 'JDCloud login is required', { reason: 'missing' })
    }
    try {
      const corp = await new JdcloudClient(auth.baseUrl, this.fetcher)
        .getCorpList(auth.token, this.operationSignal(callerSignal))
      if (!sameCorpState(auth, corp)) {
        await this.ctx.credentials.modifyRecord(AUTH_KEY, (current) => {
          if (current === undefined) return Promise.resolve(undefined)
          const latest = parseAuthRecord(current)
          if (latest.baseUrl !== auth.baseUrl || latest.token !== auth.token || latest.username !== auth.username) {
            return Promise.resolve(undefined)
          }
          return Promise.resolve(authRecord({
            ...latest,
            corpId: corp.corpId,
            corpName: corp.corpName,
            corps: corp.corps,
          }))
        })
      }
    } catch (error) {
      if (error instanceof JdcloudApiError && isJdcloudAuthError(error.code)) {
        await this.ctx.credentials.deleteRecord(AUTH_KEY)
        throw new RemoteError('jdcloud/auth-required', error.message, { reason: 'expired' })
      }
      throw this.requestError('validate', error)
    }
  }

  private operationSignal(callerSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([callerSignal, AbortSignal.timeout(this.requestTimeoutMs)])
  }

  private requestError(operation: 'login' | 'switch' | 'validate', error: unknown): RemoteError {
    const code = error instanceof JdcloudApiError ? error.code : null
    const message = error instanceof Error ? error.message : String(error)
    if (operation === 'login') return new RemoteError('jdcloud/auth-failed', message, { code })
    if (operation === 'switch') return new RemoteError('jdcloud/switch-failed', message, { code })
    return new RemoteError('jdcloud/validation-failed', message, { code })
  }

  private async readAuth(): Promise<AuthPayload | undefined> {
    const record = await this.ctx.credentials.readRecord(AUTH_KEY)
    if (record === undefined) return undefined
    return parseAuthRecord(record)
  }
}

/** Validate the durable owner-defined grant payload before use. */
function parseAuthRecord(record: CredentialRecord): AuthPayload {
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('stored JDCloud authentication record is invalid')
  }
  const version: unknown = Reflect.get(record.payload, 'version')
  const baseUrl: unknown = Reflect.get(record.payload, 'baseUrl')
  const token: unknown = Reflect.get(record.payload, 'token')
  const username: unknown = Reflect.get(record.payload, 'username')
  const corpId: unknown = Reflect.get(record.payload, 'corpId')
  const corpName: unknown = Reflect.get(record.payload, 'corpName')
  const corps: unknown = Reflect.get(record.payload, 'corps')
  if (version !== 3
    || typeof baseUrl !== 'string'
    || typeof token !== 'string'
    || token.length === 0
    || typeof username !== 'string'
    || username.length === 0
    || typeof corpId !== 'string'
    || corpId.length === 0
    || typeof corpName !== 'string'
    || corpName.length === 0
    || !isCorpList(corps)
    || !corps.some(corp => corp.corpId === corpId && corp.corpName === corpName)) {
    throw new Error('stored JDCloud authentication record is invalid')
  }
  return { version, baseUrl: normalizeJdcloudBaseUrl(baseUrl), token, username, corpId, corpName, corps }
}

function isCorpList(value: unknown): value is readonly JdcloudCorp[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const seen = new Set<string>()
  return value.every((corp) => {
    if (typeof corp !== 'object' || corp === null || Array.isArray(corp)) return false
    const corpId: unknown = Reflect.get(corp, 'corpId')
    const corpName: unknown = Reflect.get(corp, 'corpName')
    if (typeof corpId !== 'string' || corpId.length === 0
      || typeof corpName !== 'string' || corpName.length === 0
      || seen.has(corpId)) return false
    seen.add(corpId)
    return true
  })
}

function authRecord(payload: AuthPayload): GrantRecord {
  return { kind: 'grant', payload }
}

function authenticatedStatus(auth: AuthPayload): Extract<JdcloudAuthStatus, { readonly authenticated: true }> {
  return {
    authenticated: true,
    baseUrl: auth.baseUrl,
    username: auth.username,
    corpId: auth.corpId,
    corpName: auth.corpName,
    corps: auth.corps,
  }
}

function sameCorpState(auth: AuthPayload, corp: Awaited<ReturnType<JdcloudClient['getCorpList']>>): boolean {
  return auth.corpId === corp.corpId
    && auth.corpName === corp.corpName
    && auth.corps.length === corp.corps.length
    && auth.corps.every((entry, index) => {
      const other = corp.corps[index]
      return other !== undefined && entry.corpId === other.corpId && entry.corpName === other.corpName
    })
}

export default JdcloudAuthController
