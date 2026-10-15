/** Minimal server-side client for the Ontology Runtime identity endpoints. */

import type {
  OntologyAuthenticatedRequest,
  OntologyRuntimeIdentity,
  OntologyRuntimeSessionTransfer,
} from './types.ts'

/** Rotating token pair returned by login and refresh. */
export type OntologyTokenPair = OntologyRuntimeSessionTransfer

interface RuntimeErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId: string
}

/** Structured failure returned by an Ontology Runtime endpoint. */
export class OntologyApiError extends Error {
  /**
   * @param status - HTTP status returned by Ontology.
   * @param code - Stable Runtime error code when the response supplied one.
   * @param requestId - Ontology request id when the response supplied one.
   * @param message - Safe response message or transport summary.
   */
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'OntologyApiError'
  }
}

/**
 * Normalize the deployment-owned Ontology service address.
 * @param value - Configured service address.
 * @param allowInsecureLoopback - Whether explicit HTTP loopback development is allowed.
 * @returns Absolute service address without a trailing slash.
 */
export function normalizeOntologyBaseUrl(value: string, allowInsecureLoopback: boolean): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new TypeError('Ontology service address must be an absolute URL')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:'
    && allowInsecureLoopback && isLoopbackHost(parsed.hostname))) {
    throw new TypeError('Ontology service address must use HTTPS unless loopback HTTP is explicitly enabled')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('Ontology service address must not contain credentials, a query, or a fragment')
  }
  return parsed.href.replace(/\/$/, '')
}

/** Instance-bound Ontology Runtime client with no process-global authentication state. */
export class OntologyClient {
  /** @param baseUrl - Normalized service address. @param fetcher - HTTP request implementation. */
  constructor(
    readonly baseUrl: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Create one independently revocable Runtime Session.
   * @param username - Ontology account name.
   * @param password - Plaintext password retained only for this request.
   * @param signal - Request cancellation signal.
   * @returns Rotating tokens and the login identity snapshot.
   */
  async login(username: string, password: string, signal: AbortSignal): Promise<OntologyTokenPair> {
    const value = await this.requestJSON(`${this.baseUrl}/api/runtime/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal,
    })
    return readTokenPair(value)
  }

  /**
   * Rotate both tokens for one Runtime Session.
   * @param refreshToken - Current one-use refresh token.
   * @param signal - Request cancellation signal.
   * @returns Replacement tokens and the current identity snapshot.
   */
  async refresh(refreshToken: string, signal: AbortSignal): Promise<OntologyTokenPair> {
    const value = await this.requestJSON(`${this.baseUrl}/api/runtime/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal,
    })
    return readTokenPair(value)
  }

  /**
   * Resolve one active Access Token into its current identity.
   * @param accessToken - Runtime Access Token.
   * @param signal - Request cancellation signal.
   * @returns Current stable identity and authorization version.
   */
  async current(accessToken: string, signal: AbortSignal): Promise<OntologyRuntimeIdentity> {
    const value = await this.requestJSON(`${this.baseUrl}/api/runtime/auth/current`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal,
    })
    return readIdentity(value)
  }

  /**
   * Revoke the Runtime Session selected by one Access Token.
   * @param accessToken - Runtime Access Token.
   * @param signal - Request cancellation signal.
   */
  async logout(accessToken: string, signal: AbortSignal): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/api/runtime/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    })
    if (response.status === 204) return
    throw await responseError(response)
  }

  /**
   * Send one Host-only request to the configured Runtime API.
   * @param accessToken - Runtime Access Token retained by the Host.
   * @param request - Fixed Runtime path, method, and optional JSON body.
   * @param signal - Request cancellation signal.
   * @returns Parsed JSON response for validation by the owning consumer.
   */
  async requestAuthenticated(
    accessToken: string,
    request: OntologyAuthenticatedRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!request.path.startsWith('/api/runtime/')
      || request.path.includes('?')
      || request.path.includes('#')) {
      throw new TypeError('Ontology authenticated requests require a fixed Runtime API path')
    }
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    return this.requestJSON(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers,
      ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
      cache: 'no-store',
      signal,
    })
  }

  private async requestJSON(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(url, init)
    if (!response.ok) throw await responseError(response)
    try {
      return await response.json() as unknown
    } catch {
      throw new OntologyApiError(response.status, null, null, 'Ontology returned a non-JSON response')
    }
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

async function responseError(response: Response): Promise<OntologyApiError> {
  let value: unknown
  try {
    value = await response.json() as unknown
  } catch {
    return new OntologyApiError(
      response.status,
      null,
      response.headers.get('x-request-id'),
      `Ontology request failed with HTTP ${String(response.status)}`,
    )
  }
  const body = readRuntimeError(value)
  return new OntologyApiError(response.status, body.code, body.requestId, body.message)
}

function readRuntimeError(value: unknown): RuntimeErrorBody {
  const record = requireRecord(value, 'Ontology Runtime error')
  return {
    code: requireNonEmptyString(Reflect.get(record, 'code'), 'Ontology Runtime error code'),
    message: requireNonEmptyString(Reflect.get(record, 'message'), 'Ontology Runtime error message'),
    requestId: requireNonEmptyString(Reflect.get(record, 'requestId'), 'Ontology Runtime request id'),
  }
}

function readTokenPair(value: unknown): OntologyTokenPair {
  const record = requireRecord(value, 'Ontology token response')
  const accessTokenExpiresAt = requireTimestamp(
    Reflect.get(record, 'accessTokenExpiresAt'), 'Ontology Access Token expiry',
  )
  const refreshTokenExpiresAt = requireTimestamp(
    Reflect.get(record, 'refreshTokenExpiresAt'), 'Ontology Refresh Token expiry',
  )
  return {
    accessToken: requireNonEmptyString(Reflect.get(record, 'accessToken'), 'Ontology Access Token'),
    accessTokenExpiresAt,
    refreshToken: requireNonEmptyString(Reflect.get(record, 'refreshToken'), 'Ontology Refresh Token'),
    refreshTokenExpiresAt,
    user: readIdentity(Reflect.get(record, 'user')),
  }
}

function readIdentity(value: unknown): OntologyRuntimeIdentity {
  const record = requireRecord(value, 'Ontology Runtime identity')
  const accountType: unknown = Reflect.get(record, 'accountType')
  if (accountType !== 'admin' && accountType !== 'member') {
    throw new Error('Ontology Runtime identity has an invalid account type')
  }
  return {
    userId: requireNonEmptyString(Reflect.get(record, 'userId'), 'Ontology user id'),
    username: requireNonEmptyString(Reflect.get(record, 'username'), 'Ontology username'),
    displayName: requireNonEmptyString(Reflect.get(record, 'displayName'), 'Ontology display name'),
    accountType,
    authorizationVersion: requireNonEmptyString(
      Reflect.get(record, 'authorizationVersion'), 'Ontology authorization version',
    ),
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is invalid`)
  return value
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireNonEmptyString(value, name)
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} is invalid`)
  return timestamp
}
