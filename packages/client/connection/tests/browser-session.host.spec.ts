import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { BrowserSessionService } from '../src/browser-session.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
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
    await firstService.run(request, () => {
      expect(firstService.currentIdRequired()).toBeTypeOf('string')
    })
  })
})
