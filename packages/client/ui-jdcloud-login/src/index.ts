/** Host half for the browser-discovered JDCloud login and transfer pages. */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'ui-jdcloud-login'

/** Host route service required for the transfer entry point. */
export const inject = ['webServer']

/** Public route accepted from a JDCloud source page. */
const JDCLOUD_TRANSFER_PATH = '/login/transfer'

/** Escape one same-origin target for an inline script without permitting a closing script tag. */
function scriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

/** Build the no-store document that turns a cross-site entry into a same-site index navigation. */
function transferBootstrap(target: string): { readonly body: string; readonly policy: string } {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(18)), byte =>
    byte.toString(16).padStart(2, '0')).join('')
  const body = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="referrer" content="no-referrer"></head><body>'
    + `<script nonce="${nonce}">window.location.replace(${scriptString(target)})</script>`
    + '</body></html>'
  return {
    body,
    policy: `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'`,
  }
}

/** Host plugin body; establishes a same-site navigation to the authenticated Web shell. */
export function apply(ctx: Context): void {
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
      const bootstrap = transferBootstrap(`/#${target.toString()}`)
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
