/** Public transport for published Skills. Runtime owns credential validation and knowledge scope. */
import type { Context } from '@deepseek-ai/cordis'
import { bridgeFetchRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { skillChatPage, skillChatScript, skillChatStyle } from './skill-chat.ts'
import { skillWidgetScript } from './skill-widget.ts'

const prefix = '/api/ontology-skill/v1'
const skillPath = /^skills\/(ks_[a-zA-Z0-9-]{1,80})\/(chat|sessions)(?:\/(ss_[a-zA-Z0-9-]{1,80}))?$/u

/**
 * Expose exactly the versioned delivery routes and the embeddable widget script.
 * @param ctx - Host HTTP, connection and configured Ontology services.
 */
export function installSkillDeliveryHttp(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: prefix, auth: 'embed',
    handler: (req, res) => bridgeFetchRequest(req, res, {
      requestBodyMode: () => 'buffered',
      fetch: request => deliver(ctx, request),
    }, ctx.connection.browserPeer, 16 * 1024),
  }), 'ontology: public skill delivery')
}

async function deliver(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.slice(prefix.length + 1)
  if (url.search === '' && (request.method === 'GET' || request.method === 'HEAD')) {
    const asset = path === 'chat' ? { body: skillChatPage, type: 'text/html' }
      : path === 'chat.css' ? { body: skillChatStyle, type: 'text/css' }
        : path === 'chat.js' ? { body: skillChatScript, type: 'text/javascript' }
          : path === 'widget.js' ? { body: skillWidgetScript, type: 'text/javascript' } : undefined
    if (asset !== undefined) return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
      'content-type': `${asset.type}; charset=utf-8`,
      'cache-control': path === 'chat' ? 'no-store' : 'public, max-age=300',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(path === 'chat' ? { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" } : {}),
    } })
  }
  const method = request.method
  const match = skillPath.exec(path)
  const id = match?.[1]
  const session = match?.[3]
  const sessions = id !== undefined && match?.[2] === 'sessions'
  const endpoint = method === 'GET' && path === 'embed' ? 'embed'
    : method === 'POST' && path === 'embed/chat' ? 'embed/chat'
      : method === 'POST' && id !== undefined && match?.[2] === 'chat' && session === undefined ? `skills/${id}/chat` as const
        : sessions && session === undefined && (method === 'GET' || method === 'POST') ? `skills/${id}/sessions` as const
          : sessions && session !== undefined && (method === 'GET' || method === 'DELETE') ? `skills/${id}/sessions/${session}` as const : undefined
  if (endpoint === undefined || (url.search !== '' && !(sessions && method === 'GET'))) return failure(404, 'skill_delivery_not_found')
  if (request.method === 'POST' && request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return failure(415, 'invalid_content_type')
  }
  try {
    const upstream = await ctx.ontologyAuthController.fetchSkillDelivery(endpoint, request)
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    for (const name of ['content-type', 'cache-control', 'x-accel-buffering', 'retry-after', 'www-authenticate', 'x-request-id']) {
      const value = upstream.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (error) {
    return error instanceof Error && error.name === 'TimeoutError'
      ? failure(504, 'knowledge_timeout') : failure(502, 'knowledge_unavailable')
  }
}

function failure(status: number, code: string): Response {
  return Response.json({ code }, { status, headers: { 'cache-control': 'no-store' } })
}
