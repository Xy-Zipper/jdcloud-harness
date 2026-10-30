/** Browser owner for sessionStorage-backed Bearer identity and same-origin request authentication. */

import {
  BROWSER_SESSION_BOOTSTRAP_PATH,
  BROWSER_SESSION_DOWNLOAD_TICKET_PATH,
  BROWSER_SESSION_DOWNLOAD_TICKET_QUERY,
  BROWSER_SESSION_STORAGE_KEY,
  BROWSER_SESSION_WEBSOCKET_TICKET_PATH,
} from '../browser-session-protocol.ts'

interface StoredBrowserSession {
  readonly version: 1
  readonly token: string
  readonly expiresAt: number
}

/** Browser operations needed by the Connection and background carriers. */
export interface BrowserBearerSession {
  readonly fetch: typeof globalThis.fetch
  authorizationHeader(): Promise<string>
  authorizeDownloadUrl(url: string): Promise<string>
  authorizeWebSocketUrl(url: string): Promise<string>
}

/**
 * Create one tab-scoped Bearer session owner over the unwrapped browser Fetch.
 * @param baseFetch - Browser Fetch implementation before authentication wrapping.
 * @param storage - Current tab's session storage.
 * @param baseUrl - Document URL used to restrict Authorization to the same origin.
 * @returns The Fetch, header, and WebSocket authentication operations.
 */
export function createBrowserBearerSession(
  baseFetch: typeof globalThis.fetch,
  storage: Storage,
  baseUrl: string,
): BrowserBearerSession {
  let pending: Promise<StoredBrowserSession> | undefined

  const read = (): StoredBrowserSession | undefined => {
    const raw = storage.getItem(BROWSER_SESSION_STORAGE_KEY)
    if (raw === null) return undefined
    try {
      const value: unknown = JSON.parse(raw)
      if (!isRecord(value) || value.version !== 1 || typeof value.token !== 'string'
        || value.token.length === 0 || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= Date.now()) {
        storage.removeItem(BROWSER_SESSION_STORAGE_KEY)
        return undefined
      }
      return { version: 1, token: value.token, expiresAt: value.expiresAt }
    } catch {
      storage.removeItem(BROWSER_SESSION_STORAGE_KEY)
      return undefined
    }
  }

  const acquire = async (): Promise<StoredBrowserSession> => {
    const current = read()
    if (current !== undefined) return current
    pending ??= (async () => {
      const response = await baseFetch(BROWSER_SESSION_BOOTSTRAP_PATH.slice(1), {
        method: 'POST',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        throw new Error(`browser session bootstrap failed with HTTP ${String(response.status)}`)
      }
      const value: unknown = await response.json()
      if (!isRecord(value) || typeof value.token !== 'string' || value.token.length === 0
        || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= Date.now()) {
        throw new TypeError('browser session bootstrap returned an invalid response')
      }
      const session: StoredBrowserSession = { version: 1, token: value.token, expiresAt: value.expiresAt }
      storage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(session))
      return session
    })()
    try { return await pending }
    finally { pending = undefined }
  }

  const authorizationHeader = async (): Promise<string> => `Bearer ${(await acquire()).token}`
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!isSameOrigin(input, baseUrl)) return baseFetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('authorization', await authorizationHeader())
    const response = await baseFetch(input, { ...init, headers })
    if (response.status === 401) storage.removeItem(BROWSER_SESSION_STORAGE_KEY)
    return response
  }
  const requestTicket = async (path: string, kind: 'download' | 'WebSocket', retry: boolean): Promise<string> => {
    const response = await baseFetch(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: await authorizationHeader(),
      },
    })
    if (response.status === 401 && retry) {
      storage.removeItem(BROWSER_SESSION_STORAGE_KEY)
      return requestTicket(path, kind, false)
    }
    if (!response.ok) {
      throw new Error(`browser ${kind} ticket failed with HTTP ${String(response.status)}`)
    }
    const value: unknown = await response.json()
    if (!isRecord(value) || typeof value.ticket !== 'string' || value.ticket.length === 0) {
      throw new TypeError(`browser ${kind} ticket returned an invalid response`)
    }
    return value.ticket
  }

  return {
    fetch,
    authorizationHeader,
    async authorizeDownloadUrl(url) {
      const base = new URL(baseUrl)
      const target = new URL(url, base)
      if (target.origin !== base.origin) throw new Error('browser download target must be same-origin')
      const mount = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
      if (!target.pathname.startsWith(mount)) throw new Error('browser download target must be under the application mount')
      const hostTarget = `/${target.pathname.slice(mount.length)}${target.search}`
      const request = new URL(BROWSER_SESSION_DOWNLOAD_TICKET_PATH.slice(1), baseUrl)
      request.searchParams.set('target', hostTarget)
      target.searchParams.set(
        BROWSER_SESSION_DOWNLOAD_TICKET_QUERY,
        await requestTicket(request.href, 'download', true),
      )
      return target.href
    },
    async authorizeWebSocketUrl(url) {
      const target = new URL(url)
      target.searchParams.set('ticket', await requestTicket(
        BROWSER_SESSION_WEBSOCKET_TICKET_PATH.slice(1), 'WebSocket', true,
      ))
      return target.href
    },
  }
}

function isSameOrigin(input: RequestInfo | URL, baseUrl: string): boolean {
  const value = input instanceof Request ? input.url : input instanceof URL ? input.href : input
  try { return new URL(value, baseUrl).origin === new URL(baseUrl).origin } catch { return false }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
