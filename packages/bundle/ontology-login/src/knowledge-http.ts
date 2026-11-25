/** Same-origin browser access to Ontology knowledge Skills and protected original files. */

import type { Context } from '@deepseek-ai/cordis'
import { OntologyApiError } from '@deepseek-ai/dsh-api-ontology-auth-controller'
import { bridgeFetchRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

const prefix = '/api/ontology-knowledge'
const skill = /^skills\/ks_[a-zA-Z0-9-]+$/u
const skillAsk = /^skills\/ks_[a-zA-Z0-9-]+\/ask$/u
const managed = /^projects\/([a-zA-Z0-9_.-]{1,128})\/skills(?:\/(ks_[a-zA-Z0-9-]+)(?:\/(publish|delivery))?)?$/u
const file = /^files\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/(preview|content)$/u
const pageLocation = /^files\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/page-location$/u

/**
 * Register the browser proxy on the tab's authenticated connection peer.
 * @param ctx - Host services for browser admission, Runtime tokens, and streaming.
 */
export function installKnowledgeHttp(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: prefix, auth: 'required',
    handler(req, res, peer) {
      if (peer === undefined) { res.writeHead(401).end(); return }
      return ctx.waterfall('connection/request', req, res, () => bridgeFetchRequest(req, res, {
        requestBodyMode: () => 'buffered',
        fetch: request => relay(ctx, request),
      }, peer, 32 * 1024))
    },
  }), 'ontology: knowledge browser proxy')
}

async function relay(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const endpoint = url.pathname.slice(prefix.length + 1)
  const method = request.method
  const management = managed.exec(endpoint)
  const allowed = method === 'GET'
    ? endpoint === 'catalog' || endpoint === 'projects' || skill.test(endpoint) || file.test(endpoint)
      || (management !== null && management[2] === undefined)
    : method === 'POST' ? skillAsk.test(endpoint) || pageLocation.test(endpoint) || management !== null
      : method === 'DELETE' && management?.[2] !== undefined && management[3] === undefined
  if (url.search !== '' || !allowed || (method !== 'GET' && method !== 'POST' && method !== 'DELETE')) {
    return failure(404, 'knowledge_not_found')
  }
  let body: Record<string, unknown> | undefined
  if (method === 'POST') {
    if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') return failure(415, 'invalid_request')
    let value: unknown
    try {
      value = await request.json()
    } catch (_error) {
      return failure(400, 'invalid_request')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return failure(400, 'invalid_request')
    body = value as Record<string, unknown>
  }
  let upstream: Response
  try {
    upstream = await ctx.ontologyAuthController.fetchKnowledge({
      method, path: `/api/runtime/knowledge/${endpoint}`, ...(body === undefined ? {} : { body }),
    }, request.signal, management?.[1])
  } catch (error) {
    if (error instanceof OntologyApiError) return failure(error.status, error.code ?? 'knowledge_failed', error.message)
    if (error instanceof Error && error.name === 'TimeoutError') return failure(504, 'knowledge_timeout')
    if (error instanceof Error && Reflect.get(error, 'code') === 'ontology/auth-required') return failure(403, 'knowledge_auth_required')
    return failure(502, 'knowledge_failed')
  }
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  for (const name of ['content-type', 'content-disposition']) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

function failure(status: number, code: string, message?: string): Response {
  return Response.json({ code, message }, { status, headers: { 'cache-control': 'no-store' } })
}
