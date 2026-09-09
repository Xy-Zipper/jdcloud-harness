/** Minimal JDCloud HTTP client for password login and tenant selection. */

import { createHash } from 'node:crypto'
import type { JdcloudAuthenticatedRequest, JdcloudCorp } from './types.ts'

const AUTH_ERROR_CODES = new Set([600, 601, 602])

interface ActionResult<T> {
  readonly code: number
  readonly msg: string
  readonly data: T
}

/** Available JDCloud tenants and the current selection. */
export interface JdcloudCorpState {
  /** Current tenant identity. */
  readonly corpId: string
  /** Current tenant display name. */
  readonly corpName: string
  /** All tenants available to the account. */
  readonly corps: readonly JdcloudCorp[]
}

/** Account and tenant identity returned by `/api/oauth/currentUser`. */
export interface JdcloudCurrentUserIdentity {
  /** Account label shown in the Harness sidebar. */
  readonly username: string
  /** Current tenant selected by the transferred token. */
  readonly corpId: string
}

/** JDCloud business response failure. */
export class JdcloudApiError extends Error {
  /** @param code - JDCloud response code. @param message - backend message. */
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'JdcloudApiError'
  }
}

/**
 * Whether one JDCloud code invalidates the stored login.
 * @param code - JDCloud business response code.
 * @returns Whether the code requires a new login.
 */
export function isJdcloudAuthError(code: number): boolean {
  return AUTH_ERROR_CODES.has(code)
}

/**
 * Normalize a user-supplied JDCloud service address.
 * @param value - Service address entered by the user or supplied by configuration.
 * @returns Absolute HTTP or HTTPS address without a trailing slash.
 */
export function normalizeJdcloudBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new TypeError('JDCloud service address must be an absolute HTTP or HTTPS URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('JDCloud service address must use HTTP or HTTPS')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('JDCloud service address must not contain credentials, a query, or a fragment')
  }
  return parsed.href.replace(/\/$/, '')
}

/** Minimal instance-bound JDCloud client with no global token or environment state. */
export class JdcloudClient {
  /** @param baseUrl - normalized service address. @param fetcher - request implementation. */
  constructor(
    readonly baseUrl: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Password-login using the query parameters and MD5 behavior of `@jdcloud/api`.
   * @param username - JDCloud account name.
   * @param password - Plaintext password to hash for the login request.
   * @param signal - Request cancellation signal.
   * @returns Raw token returned by JDCloud.
   */
  async loginPassword(username: string, password: string, signal: AbortSignal): Promise<string> {
    const query = new URLSearchParams({
      client_id: 'admin',
      client_secret: '123456',
      scope: 'all',
      grant_type: 'password',
    })
    const result = await this.request<unknown>(`${this.baseUrl}/api/oauth/login?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        password: createHash('md5').update(password).digest('hex'),
      }),
      signal,
    })
    if (typeof result.data !== 'object' || result.data === null) {
      throw new Error('JDCloud login response did not contain a token')
    }
    const token: unknown = Reflect.get(result.data, 'token')
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('JDCloud login response did not contain a token')
    }
    return token
  }

  /**
   * Validate a token and refresh the backend's current tenant context.
   * @param token - Raw JDCloud authorization header value.
   * @param signal - Request cancellation signal.
   * @returns Current tenant identity and display name.
   */
  async getCorpList(token: string, signal: AbortSignal): Promise<JdcloudCorpState> {
    const query = new URLSearchParams({ n: String(Date.now()) })
    const result = await this.request<unknown>(`${this.baseUrl}/api/system/corp/getCorpList?${query}`, {
      method: 'GET',
      headers: { authorization: token },
      cache: 'no-store',
      signal,
    })
    return readCorpState(result.data)
  }

  /**
   * Validate a transferred token and read its account and current tenant.
   * @param token - Raw JDCloud authorization header value.
   * @param signal - Request cancellation signal.
   * @returns Account label and current tenant identity.
   */
  async getCurrentUser(token: string, signal: AbortSignal): Promise<JdcloudCurrentUserIdentity> {
    const query = new URLSearchParams({ n: String(Date.now()) })
    const result = await this.request<unknown>(`${this.baseUrl}/api/oauth/currentUser?${query}`, {
      method: 'GET',
      headers: { authorization: token },
      cache: 'no-store',
      signal,
    })
    return readCurrentUserIdentity(result.data)
  }

  /**
   * Select one tenant for the authenticated backend session.
   * @param token - Raw JDCloud authorization header value.
   * @param corpId - Tenant identity returned by {@link getCorpList}.
   * @param signal - Request cancellation signal.
   * @returns The selected tenant identity confirmed by JDCloud.
   */
  async switchCorp(token: string, corpId: string, signal: AbortSignal): Promise<string> {
    const result = await this.request<unknown>(
      `${this.baseUrl}/api/system/corp/switchCorp/${encodeURIComponent(corpId)}`,
      {
        method: 'GET',
        headers: { authorization: token },
        cache: 'no-store',
        signal,
      },
    )
    let confirmedCorpId: unknown = result.data
    if (typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)) {
      confirmedCorpId = Reflect.get(result.data, 'corpId') as unknown
    }
    if (confirmedCorpId !== corpId) {
      throw new Error('JDCloud tenant-switch response did not confirm the requested tenant')
    }
    return confirmedCorpId
  }

  /**
   * Send one authenticated request to a fixed JDCloud API path.
   * @param token - Raw JDCloud authorization header value.
   * @param request - API path, method, and optional JSON body.
   * @param signal - Request cancellation signal.
   * @returns JDCloud response data.
   */
  async requestAuthenticated<T>(
    token: string,
    request: JdcloudAuthenticatedRequest,
    signal: AbortSignal,
  ): Promise<T> {
    const url = this.resolveApiUrl(request.path)
    const headers: Record<string, string> = { authorization: token }
    const init: RequestInit = { method: request.method, headers, signal }
    if (request.method === 'GET') {
      url.searchParams.set('n', String(Date.now()))
      init.cache = 'no-store'
    }
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(request.body)
    }
    const result = await this.request<T>(url.href, init)
    return result.data
  }

  private resolveApiUrl(path: string): URL {
    const baseUrl = new URL(this.baseUrl)
    const url = new URL(`${this.baseUrl}${path}`)
    const apiPrefix = `${baseUrl.pathname.replace(/\/$/, '')}/api/`
    if (!path.startsWith('/api/') || url.origin !== baseUrl.origin || !url.pathname.startsWith(apiPrefix)) {
      throw new TypeError('JDCloud authenticated request path must start with /api/')
    }
    return url
  }

  private async request<T>(url: string, init: RequestInit): Promise<ActionResult<T>> {
    const response = await this.fetcher(url, init)
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error(`JDCloud returned a non-JSON response with HTTP ${String(response.status)}`)
    }
    if (typeof value !== 'object' || value === null) {
      throw new Error('JDCloud returned an invalid response')
    }
    const codeValue: unknown = Reflect.get(value, 'code')
    if (typeof codeValue !== 'number') throw new Error('JDCloud returned an invalid response')
    const code = codeValue
    const messageValue: unknown = Reflect.get(value, 'msg')
    const msg = typeof messageValue === 'string' && messageValue.length > 0
      ? messageValue
      : `JDCloud request failed with code ${String(code)}`
    if (code !== 200) throw new JdcloudApiError(code, msg)
    const data: unknown = Reflect.get(value, 'data')
    return { code, msg, data: data as T }
  }
}

function readCorpState(value: unknown): JdcloudCorpState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('JDCloud tenant-list response is invalid')
  }
  const corpId: unknown = Reflect.get(value, 'corpId')
  if (typeof corpId !== 'string' || corpId.length === 0) {
    throw new Error('JDCloud tenant-list response has no current tenant')
  }
  const corps: JdcloudCorp[] = []
  const seen = new Set<string>()
  for (const valueList of [Reflect.get(value, 'corpList'), Reflect.get(value, 'joinCorpList')]) {
    if (valueList === undefined) continue
    if (!Array.isArray(valueList)) throw new Error('JDCloud tenant-list response contains an invalid tenant list')
    for (const entry of valueList) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error('JDCloud tenant-list response contains an invalid tenant')
      }
      const entryCorpId: unknown = Reflect.get(entry, 'corpId')
      const entryCorpName: unknown = Reflect.get(entry, 'corpName')
      if (typeof entryCorpId !== 'string' || entryCorpId.length === 0
        || typeof entryCorpName !== 'string' || entryCorpName.length === 0) {
        throw new Error('JDCloud tenant-list response contains an invalid tenant')
      }
      if (seen.has(entryCorpId)) continue
      seen.add(entryCorpId)
      corps.push({ corpId: entryCorpId, corpName: entryCorpName })
    }
  }
  const current = corps.find(corp => corp.corpId === corpId)
  if (current === undefined) {
    throw new Error('JDCloud tenant-list response has no name for the current tenant')
  }
  return { corpId, corpName: current.corpName, corps }
}

/** Read the minimum identity retained from the external current-user response. */
function readCurrentUserIdentity(value: unknown): JdcloudCurrentUserIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('JDCloud current-user response is invalid')
  }
  const userInfo: unknown = Reflect.get(value, 'userInfo')
  if (typeof userInfo !== 'object' || userInfo === null || Array.isArray(userInfo)) {
    throw new Error('JDCloud current-user response has no user profile')
  }
  const corpId: unknown = Reflect.get(userInfo, 'corpId')
  if (typeof corpId !== 'string' || corpId.trim() === '') {
    throw new Error('JDCloud current-user response has no current tenant')
  }
  const labels = [
    Reflect.get(userInfo, 'userName'),
    Reflect.get(userInfo, 'realName'),
    Reflect.get(userInfo, 'id'),
  ]
  const username = labels.find((label): label is string => typeof label === 'string' && label.trim() !== '')
  if (username === undefined) throw new Error('JDCloud current-user response has no account name')
  return { username: username.trim(), corpId: corpId.trim() }
}
