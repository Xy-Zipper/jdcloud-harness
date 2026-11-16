import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { BrowserSessionService } from '../src/browser-session.ts'
import * as BrowserSession from '../src/browser-session-plugin.ts'
import * as Connection from '../src/index.ts'
import WebServer, { type WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

it('publishes the browser login entry until its provider is unloaded', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection)
  const provider = ctx.plugin(BrowserSession, { cookieMaxAgeDays: 30 })
  await provider.await()
  const entries: WebEntryUrl[] = []
  ctx.emit(ctx.webServer, 'webserver/entry-url', 'https://public.test/ui/', entries)
  expect(entries).toEqual([{ label: 'dsh web', url: 'https://public.test/ui/', open: true }])

  await provider.dispose()
  const after: WebEntryUrl[] = []
  ctx.emit(ctx.webServer, 'webserver/entry-url', 'https://public.test/ui/', after)
  expect(after).toEqual([])
})

function response() {
  const headers: Record<string, string> = {}
  return {
    headers,
    writeHead: (_status: number, values?: Readonly<Record<string, string>>) => Object.assign(headers, values),
    end: () => undefined,
  }
}

describe('BrowserSessionService', () => {
  it('mints independent cookies and carries each browser id through a request', async () => {
    const first = new Context()
    const second = new Context()
    contexts.push(first, second)
    await first.plugin(MemoryCredentials)
    await second.plugin(MemoryCredentials)
    const firstService = await BrowserSessionService.create(first, first.credentials)
    const secondService = await BrowserSessionService.create(second, second.credentials)
    const firstResponse = response()
    expect(firstService.authorizeIndex({ headers: { host: 'example.test' }, method: 'GET', url: '/' }, firstResponse)).toBe(false)
    const secondResponse = response()
    expect(secondService.authorizeIndex({ headers: { host: 'example.test' }, method: 'GET', url: '/' }, secondResponse)).toBe(false)
    expect(firstResponse.headers['set-cookie']).not.toBe(secondResponse.headers['set-cookie'])
    const firstCookie = firstResponse.headers['set-cookie']!.split(';', 1)[0]!
    const request = { headers: { host: 'example.test', cookie: firstCookie } }
    expect(firstService.accepts(request)).toBe(true)
    expect(secondService.accepts(request)).toBe(false)
    firstService.run(request, () => {
      expect(firstService.currentIdRequired()).toBeTypeOf('string')
    })
  })

  it('uses a Secure SameSite=None cookie only when configured for cross-site embedding', async () => {
    const strictContext = new Context()
    const crossSiteContext = new Context()
    contexts.push(strictContext, crossSiteContext)
    await strictContext.plugin(MemoryCredentials)
    await crossSiteContext.plugin(MemoryCredentials)
    const strict = await BrowserSessionService.create(strictContext, strictContext.credentials)
    const strictResponse = response()
    strict.authorizeIndex({ headers: { host: 'example.test' }, method: 'GET', url: '/' }, strictResponse)
    expect(strictResponse.headers['set-cookie']).toMatch(/; HttpOnly; SameSite=Strict$/u)

    const crossSite = await BrowserSessionService.create(crossSiteContext, crossSiteContext.credentials, 30, 'none')
    const crossSiteResponse = response()
    crossSite.authorizeIndex({ headers: { host: 'example.test' }, method: 'GET', url: '/' }, crossSiteResponse)
    expect(crossSiteResponse.headers['set-cookie']).toMatch(/; HttpOnly; SameSite=None; Secure$/u)
  })

  it('mints authority-bound Bearer sessions without redirecting the index', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    const service = await BrowserSessionService.create(ctx, ctx.credentials, 30, 'strict', 'bearer')
    const indexResponse = response()
    expect(service.authorizeIndex({ headers: { host: 'harness.example' }, method: 'GET', url: '/' }, indexResponse)).toBe(true)
    expect(indexResponse.headers).toEqual({})

    const session = service.issueBearer({ headers: { host: 'harness.example' } })
    const request = { headers: { host: 'harness.example', authorization: `Bearer ${session.token}` } }
    expect(service.accepts(request)).toBe(true)
    expect(service.accepts({ headers: { host: 'other.example', authorization: `Bearer ${session.token}` } })).toBe(false)
    expect(service.run(request, () => service.currentIdRequired())).toBeTypeOf('string')
  })

  it('consumes each WebSocket ticket once for its issuing Bearer session', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    const service = await BrowserSessionService.create(ctx, ctx.credentials, 30, 'strict', 'bearer')
    const session = service.issueBearer({ headers: { host: 'harness.example' } })
    const request = { headers: { host: 'harness.example', authorization: `Bearer ${session.token}` } }
    const ticket = service.issueWebSocketTicket(request)
    const upgrade = { headers: { host: 'harness.example' }, url: `/api/remote.mux?ticket=${ticket}` }

    expect(service.admitWebSocket(upgrade)).toBe(true)
    expect(service.run(upgrade, () => service.currentIdRequired())).toBe(
      service.run(request, () => service.currentIdRequired()),
    )
    expect(service.run(upgrade, () => service.currentIdRequired())).toBe(
      service.run(request, () => service.currentIdRequired()),
    )
    expect(service.admitWebSocket(upgrade)).toBe(false)

    vi.useFakeTimers()
    const expired = service.issueWebSocketTicket(request)
    vi.advanceTimersByTime(30_001)
    expect(service.admitWebSocket({
      headers: { host: 'harness.example' },
      url: `/api/remote.mux?ticket=${expired}`,
    })).toBe(false)
  })
})
