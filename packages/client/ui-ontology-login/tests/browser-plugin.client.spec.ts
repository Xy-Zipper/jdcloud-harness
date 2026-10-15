// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LoginPage, type OntologyLoginInjected } from '../src/client/LoginPage.tsx'
import { AccountSeat, type OntologyAccountInjected } from '../src/client/AccountSeat.tsx'
import { EmbeddedSessionPage } from '../src/client/EmbeddedSessionPage.tsx'
import { installOntologyLoginUi, uiInject } from '../src/client/mount.ts'

/** Assemble real slots around a controllable Ontology Remote double. */
async function bench(authenticated = false) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.account': { kind: 'single', scope: 'root' },
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
  let loggedIn = authenticated
  const authenticatedValue = {
    authenticated: true as const,
    baseUrl: 'https://ontology.example.com',
    user: {
      userId: 'user-alice', username: 'alice', displayName: 'Alice',
      accountType: 'admin' as const, authorizationVersion: '1',
    },
  }
  const status = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: loggedIn ? authenticatedValue : {
      authenticated: false as const, baseUrl: 'https://ontology.example.com',
    },
  }))
  const login = vi.fn(() => {
    loggedIn = true
    return Promise.resolve({ ok: true as const, value: authenticatedValue })
  })
  const importSession = vi.fn(() => {
    loggedIn = true
    return Promise.resolve({ ok: true as const, value: authenticatedValue })
  })
  const logout = vi.fn(() => {
    loggedIn = false
    return Promise.resolve({
      ok: true as const,
      value: { authenticated: false as const, baseUrl: 'https://ontology.example.com' },
    })
  })
  let recordListener: ((key: string) => void) | undefined
  const remote = {
    ontologyAuth: { status, login, importSession, logout },
    $on: vi.fn((_event: string, listener: (key: string) => void) => {
      recordListener = listener
      return () => { recordListener = undefined }
    }),
  }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.ontologyAuth', remote.ontologyAuth as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const clearSelection = vi.fn()
  ctx.provide('uiWorkspace', { clearSelection } as never)
  return {
    ctx, slots, status, login, importSession, logout, clearSelection,
    emitRecord(key: string) { recordListener?.(key) },
  }
}

describe('Ontology login browser plugin', () => {
  it('declares only its required browser services', () => {
    expect(uiInject).toEqual(['remote', 'remote.ontologyAuth', 'slots', 'locale', 'uiWorkspace'])
  })

  it('moves from login gate to account seat and back without exposing tokens', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installOntologyLoginUi })
    await fiber.await()
    const loginEntry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    const loginInjected = (loginEntry?.inject as (() => OntologyLoginInjected) | undefined)?.()
    expect(await loginInjected?.initialize()).toEqual({ ok: true, authenticated: false })
    expect(loginInjected).toBeDefined()
    await loginInjected?.login({ username: 'alice', password: 'password123' })
    expect(b.clearSelection).toHaveBeenCalledOnce()
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
    const accountEntry = b.slots.entries('sidebar.account').find(candidate => candidate.component === AccountSeat)
    const accountInjected = (accountEntry?.inject as (() => OntologyAccountInjected) | undefined)?.()
    expect(accountInjected?.status.user).toMatchObject({ userId: 'user-alice', displayName: 'Alice' })
    await accountInjected?.logout()
    expect(b.logout).toHaveBeenCalledOnce()
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(true)
    await fiber.dispose()
  })

  it('imports a Runtime Session only from the embedding page origin', async () => {
    const originalParent = Object.getOwnPropertyDescriptor(window, 'parent')
    const parent = { postMessage: vi.fn() }
    Object.defineProperty(window, 'parent', { configurable: true, value: parent })
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://admin.example.com/assistant',
    })
    try {
      const b = await bench()
      const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installOntologyLoginUi })
      await fiber.await()
      expect(parent.postMessage).toHaveBeenCalledWith({
        type: 'ontology/runtime-session-ready',
        version: 1,
      }, 'https://admin.example.com')
      expect(b.slots.entries('root').some(candidate => candidate.component === EmbeddedSessionPage)).toBe(true)
      expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)

      const session = {
        accessToken: 'access-alice',
        accessTokenExpiresAt: '2026-10-15T12:15:00Z',
        refreshToken: 'refresh-alice',
        refreshTokenExpiresAt: '2026-11-14T12:00:00Z',
        user: {
          userId: 'user-alice', username: 'alice', displayName: 'Alice',
          accountType: 'admin' as const, authorizationVersion: '1',
        },
      }
      const message = {
        type: 'ontology/runtime-session', version: 1, nonce: 'nonce-1', session,
      }
      window.dispatchEvent(new MessageEvent('message', {
        data: message, origin: 'https://attacker.example.com', source: parent as never,
      }))
      await Promise.resolve()
      expect(b.importSession).not.toHaveBeenCalled()

      window.dispatchEvent(new MessageEvent('message', {
        data: message, origin: 'https://admin.example.com', source: parent as never,
      }))
      await vi.waitFor(() => { expect(b.importSession).toHaveBeenCalledWith(session) })
      expect(b.clearSelection).toHaveBeenCalledOnce()
      expect(b.slots.entries('root').some(candidate => candidate.component === EmbeddedSessionPage)).toBe(false)
      expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
      expect(parent.postMessage).toHaveBeenCalledWith({
        type: 'ontology/runtime-session-result', version: 1, nonce: 'nonce-1', ok: true,
      }, 'https://admin.example.com')
      await fiber.dispose()
    } finally {
      if (originalParent !== undefined) Object.defineProperty(window, 'parent', originalParent)
      Reflect.deleteProperty(document, 'referrer')
    }
  })

  it('refreshes only login credential notifications and ignores resource owner grants', async () => {
    const b = await bench(true)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installOntologyLoginUi })
    await fiber.await()
    b.emitRecord('unrelated-auth-controller/login')
    expect(b.status).not.toHaveBeenCalled()
    b.emitRecord('ontology-auth-controller/owner-session-resource')
    expect(b.status).not.toHaveBeenCalled()
    expect(b.clearSelection).not.toHaveBeenCalled()
    b.emitRecord('ontology-auth-controller/login-browser')
    await vi.waitFor(() => { expect(b.status).toHaveBeenCalledOnce() })
    expect(b.clearSelection).toHaveBeenCalledOnce()
    await fiber.dispose()
  })
})
