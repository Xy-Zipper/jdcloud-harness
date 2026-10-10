// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LoginPage, type OntologyLoginInjected } from '../src/client/LoginPage.tsx'
import { AccountSeat, type OntologyAccountInjected } from '../src/client/AccountSeat.tsx'
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
  const logout = vi.fn(() => {
    loggedIn = false
    return Promise.resolve({
      ok: true as const,
      value: { authenticated: false as const, baseUrl: 'https://ontology.example.com' },
    })
  })
  let recordListener: ((key: string) => void) | undefined
  const remote = {
    ontologyAuth: { status, login, logout },
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
    ctx, slots, status, login, logout, clearSelection,
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

  it('ignores unrelated credential notifications and refreshes its own record', async () => {
    const b = await bench(true)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installOntologyLoginUi })
    await fiber.await()
    b.emitRecord('unrelated-auth-controller/login')
    expect(b.status).not.toHaveBeenCalled()
    b.emitRecord('ontology-auth-controller/record')
    await vi.waitFor(() => { expect(b.status).toHaveBeenCalledOnce() })
    await fiber.dispose()
  })
})
