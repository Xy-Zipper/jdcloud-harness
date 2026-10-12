/** Host half for the browser-discovered JDCloud login and transfer pages. */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'ui-jdcloud-login'

/** Host route service required for the transfer entry point. */
export const inject = ['webServer']

/** Deployment policy for the token-transfer bootstrap document. */
export interface Config {
  /** Exact HTTP(S) parent origin, or `*` to allow any parent; empty blocks framing. */
  readonly transferFrameAncestorOrigin?: string
}

/** Validated transfer-page embedding policy. */
export const Config: z<Config> = z.object({
  transferFrameAncestorOrigin: z.string().default(''),
})

/** Public route accepted from a JDCloud source page. */
const JDCLOUD_TRANSFER_PATH = '/login/transfer'

/** Escape one same-origin target for an inline script without permitting a closing script tag. */
function scriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

const FRAME_ANCESTOR_ERROR =
  'ui-jdcloud-login: transferFrameAncestorOrigin must be "*" or an HTTP(S) origin without credentials, path, query or fragment'

/** Resolve one CSP frame source while rejecting path and directive injection. */
function transferFrameAncestor(value: string | undefined): string {
  const candidate = value?.trim() ?? ''
  if (candidate === '') return "'none'"
  if (candidate === '*') return '*'
  let parsed: URL
  try { parsed = new URL(candidate) } catch {
    throw new Error(FRAME_ANCESTOR_ERROR)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== `${parsed.origin}/`) {
    throw new Error(FRAME_ANCESTOR_ERROR)
  }
  return parsed.origin
}

/** Build the no-store document that turns a cross-site entry into a same-site index navigation. */
function transferBootstrap(target: string, frameAncestor: string): { readonly body: string; readonly policy: string } {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(18)), byte =>
    byte.toString(16).padStart(2, '0')).join('')
  const body = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="referrer" content="no-referrer"></head><body>'
    + `<script nonce="${nonce}">window.location.replace(${scriptString(target)})</script>`
    + '</body></html>'
  return {
    body,
    policy: `default-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestor}; script-src 'nonce-${nonce}'`,
  }
}

/** Host plugin body; establishes a same-site navigation to the authenticated Web shell.
 * @param ctx Host plugin context carrying the Web route registry.
 * @param config Transfer-page embedding policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const frameAncestor = transferFrameAncestor(config.transferFrameAncestorOrigin)
  const route: WebRoute = {
    kind: 'exact',
    path: JDCLOUD_TRANSFER_PATH,
    handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      const source = new URL(req.url ?? JDCLOUD_TRANSFER_PATH, 'http://dsh.invalid')
      const target = new URLSearchParams()
      target.set('jdcloudTransfer', '1')
      target.set('jdcloudToken', source.searchParams.get('token') ?? '')
      target.set('baseUrl', source.searchParams.get('baseUrl') ?? '')
      const bootstrap = transferBootstrap(`/#${target.toString()}`, frameAncestor)
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-security-policy': bootstrap.policy,
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end(bootstrap.body)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'ui-jdcloud-login: transfer entry route')
}
