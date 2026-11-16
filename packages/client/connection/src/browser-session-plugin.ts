/** JDCloud browser identities and public login documents over Connection authentication. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserSessionService } from './browser-session.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { BROWSER_SESSION_BOOTSTRAP_PATH, BROWSER_SESSION_DOWNLOAD_TICKET_PATH, BROWSER_SESSION_WEBSOCKET_TICKET_PATH } from './browser-session-protocol.ts'
import type {} from './index.ts'

/** Loader name for the browser identity provider. */
export const name = 'browser-session'
/** Services required before registering browser identity and its routes. */
export const inject = ['connection', 'connection.authentication', 'credentials', 'webServer']
/** Signed identity lifetime and deployment authorities accepted for public login documents. */
export const Config = z.object({ cookieMaxAgeDays: z.natural().min(1).default(30), trustedHosts: z.array(String).default([]) })

/** Register browser identities, public login entries, and single-use transport tickets.
 * @param ctx - Provider scope owning registrations and browser Peers.
 * @param config - Validated lifetime and login-document authorities.
 */
export async function apply(ctx: Context, config: { cookieMaxAgeDays: number; trustedHosts: string[] }): Promise<void> {
  const sessions = await BrowserSessionService.create(ctx, ctx.credentials, config.cookieMaxAgeDays, 'strict', 'bearer')
  const pagePeer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  ctx.connection.authentication.register({ authenticate: request => sessions.authenticate(request) })
  // Login documents carry no account identity; cross-site token-transfer navigation retains the Host fence.
  ctx.on('webserver/authorize', (request) => {
    if (request.transport !== 'http' || (request.method !== 'GET' && request.method !== 'HEAD')
      || !['/', '/index.html', '/login/transfer'].includes(request.url.pathname)) return
    const host = request.headers instanceof Headers ? request.headers.get('host') ?? undefined : request.headers.host
    if (!isTrustedApiRequest({ headers: { host } }, config.trustedHosts, ctx.webServer.host, ctx.webServer.protocol)) {
      return { kind: 'deny', status: 403 }
    }
    return { kind: 'allow', peer: pagePeer }
  }, true)
  ctx.on('connection/request', (request, _response, next) => sessions.run(request, next))
  ctx.on('webserver/entry-url', (baseUrl, entries) => { entries.push({ label: 'dsh web', url: baseUrl, open: true }) })
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_BROWSER_SESSION_TRANSPORT__', value: 'bearer' })
  })
  for (const path of [BROWSER_SESSION_BOOTSTRAP_PATH, BROWSER_SESSION_WEBSOCKET_TICKET_PATH, BROWSER_SESSION_DOWNLOAD_TICKET_PATH]) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path, auth: path === BROWSER_SESSION_BOOTSTRAP_PATH ? 'anonymous' : 'required',
      handler(request, response) {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
        let value: object
        if (path === BROWSER_SESSION_BOOTSTRAP_PATH) value = sessions.issueBearer(request)
        else if (path === BROWSER_SESSION_WEBSOCKET_TICKET_PATH) value = { ticket: sessions.issueWebSocketTicket(request) }
        else {
          const target = new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.get('target') ?? ''
          try { value = { ticket: sessions.issueDownloadTicket(request, target) } }
          catch (error) {
            if (!(error instanceof TypeError)) throw error
            response.writeHead(400); response.end(); return
          }
        }
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(value))
      },
    }), `browser-session: ${path}`)
  }
}
