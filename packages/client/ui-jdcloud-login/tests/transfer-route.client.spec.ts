import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('JDCloud login Host routes', () => {
  it('blocks framing by default', async () => {
    const register = vi.fn((_route: WebRoute) => vi.fn())
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', { register } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const route = register.mock.calls[0]?.[0]
    const writeHead = vi.fn((_status: number, _headers: Record<string, string>) => {})
    await route?.handler({ method: 'GET', url: '/login/transfer' } as never, {
      writeHead,
      end: vi.fn(),
    } as never)
    expect(writeHead.mock.calls[0]?.[1]['content-security-policy']).toMatch(
      /^default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-[a-f0-9]{36}'$/u,
    )
  })

  it('allows one configured parent origin to frame the transfer bootstrap', async () => {
    const register = vi.fn((_route: WebRoute) => vi.fn())
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', { register } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, {
      transferFrameAncestorOrigin: 'https://portal.example/',
    })
    await fiber.await()
    const route = register.mock.calls[0]?.[0]
    const writeHead = vi.fn((_status: number, _headers: Record<string, string>) => {})
    await route?.handler({ method: 'GET', url: '/login/transfer' } as never, {
      writeHead,
      end: vi.fn(),
    } as never)
    expect(writeHead.mock.calls[0]?.[1]['content-security-policy']).toMatch(
      /^default-src 'none'; base-uri 'none'; frame-ancestors https:\/\/portal\.example; script-src 'nonce-[a-f0-9]{36}'$/u,
    )
  })

  it('allows any parent only when configured with a wildcard', async () => {
    const register = vi.fn((_route: WebRoute) => vi.fn())
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', { register } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, {
      transferFrameAncestorOrigin: '*',
    })
    await fiber.await()
    const route = register.mock.calls[0]?.[0]
    const writeHead = vi.fn((_status: number, _headers: Record<string, string>) => {})
    await route?.handler({ method: 'GET', url: '/login/transfer' } as never, {
      writeHead,
      end: vi.fn(),
    } as never)
    expect(writeHead.mock.calls[0]?.[1]['content-security-policy']).toMatch(
      /^default-src 'none'; base-uri 'none'; frame-ancestors \*; script-src 'nonce-[a-f0-9]{36}'$/u,
    )
  })

  it.each([
    'not a URL',
    'ftp://portal.example',
    'https://user:secret@portal.example',
    'https://portal.example/path',
    'https://portal.example/?query=1',
    'https://portal.example/#fragment',
  ])('rejects invalid transfer frame ancestor origin %s', (transferFrameAncestorOrigin) => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', { register: vi.fn() } as never)
    expect(() => { apply(ctx, { transferFrameAncestorOrigin }) }).toThrow(
      'ui-jdcloud-login: transferFrameAncestorOrigin must be "*" or an HTTP(S) origin without credentials, path, query or fragment',
    )
  })
})
