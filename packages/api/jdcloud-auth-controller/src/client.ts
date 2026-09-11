/** Minimal JDCloud HTTP client for password login and tenant selection. */

import { createHash } from 'node:crypto'
import type {
  JdcloudAuthenticatedRequest,
  JdcloudCorp,
  JdcloudLowcodeCapabilityState,
  JdcloudLowcodeMenuType,
  JdcloudLowcodeWritePermission,
  JdcloudWritableMenu,
  JdcloudWritableMenuState,
} from './types.ts'

const AUTH_ERROR_CODES = new Set([600, 601, 602])
const WRITE_PERMISSIONS = new Set<JdcloudLowcodeWritePermission>([
  'addData',
  'editData',
  'deleteData',
])

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
  /** Whether the current tenant grants system-administrator controls. */
  readonly systemAdministrator: boolean
}

interface JdcloudMenuNode {
  readonly id: string
  readonly parentId: string | undefined
  readonly fullName: string
  readonly type: number
  readonly permissions: readonly JdcloudLowcodeWritePermission[]
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

/**
 * Parse the Host low-code capability projection from `/api/oauth/currentUser`.
 * @param value - Unwrapped JDCloud current-user response data.
 * @returns Administrator permission and all type 3/4 menu capabilities.
 */
export function readJdcloudLowcodeCapabilities(value: unknown): JdcloudLowcodeCapabilityState {
  const root = requireRecord(value, 'JDCloud current-user response')
  requireRecord(Reflect.get(root, 'userInfo'), 'JDCloud current-user profile')
  const menuList = Reflect.get(root, 'menuList')
  if (!Array.isArray(menuList)) throw new Error('JDCloud current-user response has no menu list')
  const userPermission = Reflect.get(root, 'userPermission')
  const systemAdministrator = typeof userPermission === 'object'
    && userPermission !== null
    && !Array.isArray(userPermission)
    && Reflect.get(userPermission, 'systemAdministrator') === true
  const nodes = collectMenuNodes(menuList)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const menus: JdcloudWritableMenu[] = nodes
    .filter((node): node is JdcloudMenuNode & { readonly type: JdcloudLowcodeMenuType } => (
      node.type === 3 || node.type === 4
    ))
    .map(node => ({
      menuId: node.id,
      fullName: node.fullName,
      path: resolveMenuPath(node, byId),
      type: node.type,
      agentPermissions: node.permissions,
    }))
  return { systemAdministrator, menus }
}

/**
 * Parse the browser-safe writable-menu projection from `/api/oauth/currentUser`.
 * @param value - Unwrapped JDCloud current-user response data.
 * @returns Current tenant id and type 3/4 menus carrying at least one supported write permission.
 */
export function readJdcloudWritableMenus(value: unknown): JdcloudWritableMenuState {
  const root = requireRecord(value, 'JDCloud current-user response')
  const userInfo = requireRecord(Reflect.get(root, 'userInfo'), 'JDCloud current-user profile')
  const corpId = requireNonEmptyString(
    Reflect.get(userInfo, 'corpId'),
    'JDCloud current-user response current tenant',
  )
  const capabilities = readJdcloudLowcodeCapabilities(value)
  return {
    corpId,
    menus: capabilities.menus.filter(menu => menu.agentPermissions.length > 0),
  }
}

/** Flatten nested JDCloud menus while preserving their source order. */
function collectMenuNodes(menuList: readonly unknown[]): JdcloudMenuNode[] {
  const result: JdcloudMenuNode[] = []
  const seen = new Set<string>()
  const pending = menuList.toReversed()
    .map(value => ({ value, nestedParentId: undefined as string | undefined }))
  while (pending.length > 0) {
    const entry = pending.pop() as (typeof pending)[number]
    const menu = requireRecord(entry.value, 'JDCloud current-user menu item')
    const id = requireNonEmptyString(Reflect.get(menu, 'id'), 'JDCloud menu id')
    if (seen.has(id)) throw new Error(`JDCloud current-user response repeats menu ${JSON.stringify(id)}`)
    seen.add(id)
    const fullName = requireNonEmptyString(
      Reflect.get(menu, 'fullName'),
      `JDCloud menu ${JSON.stringify(id)} name`,
    )
    const type = Reflect.get(menu, 'type')
    if (typeof type !== 'number' || !Number.isInteger(type)) {
      throw new Error(`JDCloud menu ${JSON.stringify(id)} has an invalid type`)
    }
    const parentValue = Reflect.get(menu, 'parentId')
    const parentId = parentValue === undefined || parentValue === null || parentValue === ''
      ? entry.nestedParentId
      : requireNonEmptyString(parentValue, `JDCloud menu ${JSON.stringify(id)} parent id`)
    result.push({
      id,
      parentId,
      fullName,
      type,
      permissions: readWritePermissions(Reflect.get(menu, 'agentPermissions')),
    })
    const children = Reflect.get(menu, 'children')
    if (children === undefined || children === null) continue
    if (!Array.isArray(children)) {
      throw new Error(`JDCloud menu ${JSON.stringify(id)} has an invalid child list`)
    }
    for (const child of children.toReversed()) pending.push({ value: child, nestedParentId: id })
  }
  return result
}

/** Resolve the display path without trusting a cyclic parent graph. */
function resolveMenuPath(
  node: JdcloudMenuNode,
  byId: ReadonlyMap<string, JdcloudMenuNode>,
): string {
  const names = [node.fullName]
  const visited = new Set([node.id])
  let parentId = node.parentId
  while (parentId !== undefined && parentId !== '-1') {
    if (visited.has(parentId)) {
      throw new Error(`JDCloud current-user response contains a menu-parent cycle at ${JSON.stringify(parentId)}`)
    }
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) break
    names.unshift(parent.fullName)
    parentId = parent.parentId
  }
  return names.join(' / ')
}

/** Keep only the three data-write permissions supported by the low-code tools. */
function readWritePermissions(value: unknown): JdcloudLowcodeWritePermission[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('JDCloud menu agentPermissions must be an array')
  const permissions: JdcloudLowcodeWritePermission[] = []
  for (const permission of value) {
    if (typeof permission === 'string'
      && WRITE_PERMISSIONS.has(permission as JdcloudLowcodeWritePermission)) {
      permissions.push(permission as JdcloudLowcodeWritePermission)
    }
  }
  return [...new Set(permissions)]
}

/** Require one external JSON object. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

/** Require one non-empty external string. */
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is invalid`)
  return value.trim()
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
  const userPermission: unknown = Reflect.get(value, 'userPermission')
  const systemAdministrator = typeof userPermission === 'object'
    && userPermission !== null
    && !Array.isArray(userPermission)
    && Reflect.get(userPermission, 'systemAdministrator') === true
  return { username: username.trim(), corpId: corpId.trim(), systemAdministrator }
}
