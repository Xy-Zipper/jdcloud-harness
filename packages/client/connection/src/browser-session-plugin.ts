/** Ontology's tab-isolated browser identity registered through Connection authentication. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserSessionService } from './browser-session.ts'
import { BROWSER_SESSION_BOOTSTRAP_PATH, BROWSER_SESSION_WEBSOCKET_TICKET_PATH } from './browser-session-protocol.ts'
import type {} from './index.ts'

/** Loader name of the optional Ontology browser identity provider. */
export const name = 'browser-session'
/** Connection authentication, signing credentials, and HTTP carrier required at activation. */
export const inject = ['connection', 'connection.authentication', 'credentials', 'webServer']
/** Lifetime of signed tab identities in days. */
export const Config = z.object({ cookieMaxAgeDays: z.natural().min(1).default(30) })

/**
 * Register signed browser identities, the login entry URL, bootstrap, and one-use WebSocket tickets.
 * @param ctx - Host context containing Connection, credentials, and WebServer.
 * @param config - Validated lifetime of signed browser identities.
 */
export async function apply(ctx: Context, config: { cookieMaxAgeDays: number }): Promise<void> {
  const sessions = await BrowserSessionService.create(ctx, ctx.credentials, config.cookieMaxAgeDays, 'strict', 'bearer')
  const pagePeer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  ctx.connection.authentication.register({
    authenticate(request) {
      // The public login document bootstraps a separate authenticated identity for every tab.
      const path = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
      if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/' || path === '/index.html')) return pagePeer
      return sessions.authenticate(request)
    },
  })
  ctx.on('connection/request', (request, _response, next) => sessions.run(request, next))
  ctx.on('webserver/entry-url', (baseUrl, entries) => {
    entries.push({ label: 'dsh web', url: baseUrl, open: true })
  })
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_BROWSER_SESSION_TRANSPORT__', value: 'bearer' })
  })
  for (const path of [BROWSER_SESSION_BOOTSTRAP_PATH, BROWSER_SESSION_WEBSOCKET_TICKET_PATH]) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path, auth: path === BROWSER_SESSION_BOOTSTRAP_PATH ? 'anonymous' : 'required',
      handler(request, response) {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
        const value = path === BROWSER_SESSION_BOOTSTRAP_PATH
          ? sessions.issueBearer(request)
          : { ticket: sessions.issueWebSocketTicket(request) }
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(value))
      },
    }), `browser-session: ${path}`)
  }
}
