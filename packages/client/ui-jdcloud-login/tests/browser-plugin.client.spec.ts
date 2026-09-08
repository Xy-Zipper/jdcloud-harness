import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LoginPage, type JdcloudLoginInjected } from '../src/client/LoginPage.tsx'
import { AccountSeat, type JdcloudAccountInjected } from '../src/client/AccountSeat.tsx'
import { JdcloudBrandMark, JdcloudBrandName } from '../src/client/Brand.tsx'
import { installJdcloudLoginUi, uiInject } from '../src/client/mount.ts'
import { apply as applyClient, inject as clientInject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'

/** Assemble the real slot registry around a controllable JDCloud Remote double. */
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
  let currentAuthenticated = authenticated
  let currentCorpId = 'corp-current'
  let currentCorpName = 'Current Tenant'
  const authenticatedValue = () => ({
    authenticated: true as const,
    baseUrl: 'https://kindoucloud.com',
    username: 'user',
    corpId: currentCorpId,
    corpName: currentCorpName,
    corps: [
      { corpId: 'corp-current', corpName: 'Current Tenant' },
      { corpId: 'corp-next', corpName: 'Next Tenant' },
    ],
  })
  const status = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: currentAuthenticated
      ? authenticatedValue()
      : { authenticated: false as const, baseUrl: 'https://kindoucloud.com' },
  }))
  const login = vi.fn(() => {
    currentAuthenticated = true
    return Promise.resolve({
      ok: true as const,
      value: authenticatedValue(),
    })
  })
  const logout = vi.fn(() => {
    currentAuthenticated = false
    return Promise.resolve({
      ok: true as const,
      value: { authenticated: false as const, baseUrl: 'https://kindoucloud.com' },
    })
  })
  const switchCorp = vi.fn((corpId: string) => {
    currentCorpId = corpId
    currentCorpName = corpId === 'corp-next' ? 'Next Tenant' : 'Current Tenant'
    return Promise.resolve({ ok: true as const, value: authenticatedValue() })
  })
  let recordListener: ((key: string) => void) | undefined
  const remote = {
    jdcloudAuth: { status, login, logout, switchCorp },
    $on: vi.fn((_event: string, listener: (key: string) => void) => {
      recordListener = listener
      return () => { recordListener = undefined }
    }),
  }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.jdcloudAuth', remote.jdcloudAuth as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return {
    ctx,
    slots,
    status,
    login,
    logout,
    switchCorp,
    expire() {
      currentAuthenticated = false
      recordListener?.('jdcloud-auth-controller/login')
    },
    emitRecord(key: string) {
      recordListener?.(key)
    },
    captureRecordListener() {
      return recordListener
    },
  }
}

describe('JDCloud login browser plugin', () => {
  it('keeps the Host Loader entry inert', () => {
    expect(applyHost).not.toThrow()
  })

  it('declares its browser services', () => {
    expect(clientInject).toEqual(['remote'])
    expect(uiInject).toEqual(['remote', 'remote.jdcloudAuth', 'slots', 'locale'])
  })

  it('shadows the generic brand slots and removes every occupant on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()

    const sidebarMark = b.slots.entries('sidebar.brand.mark')
    const sidebarName = b.slots.entries('sidebar.brand.name')
    const heroMark = b.slots.entries('conversation.hero.brand.mark')
    expect(sidebarMark).toHaveLength(1)
    expect(sidebarMark[0]?.component).toBe(JdcloudBrandMark)
    expect(sidebarMark[0]?.options.priority).toBe(-10)
    expect(sidebarName).toHaveLength(1)
    expect(sidebarName[0]?.component).toBe(JdcloudBrandName)
    expect(sidebarName[0]?.options.priority).toBe(-10)
    expect(heroMark).toHaveLength(1)
    expect(heroMark[0]?.component).toBe(JdcloudBrandMark)
    expect(heroMark[0]?.options.priority).toBe(-10)

    await fiber.dispose()
    expect(b.slots.entries('sidebar.brand.mark')).toHaveLength(0)
    expect(b.slots.entries('sidebar.brand.name')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.brand.mark')).toHaveLength(0)
  })

  it('mounts and disposes the generated Remote namespace with its UI fiber', async () => {
    const disposeRemote = vi.fn(() => Promise.resolve())
    const disposeUi = vi.fn(() => Promise.resolve())
    const ui = Object.assign(Promise.resolve(), { dispose: disposeUi })
    const ctx = {
      remote: { $mount: vi.fn(() => Promise.resolve(disposeRemote)) },
      inject: vi.fn(() => ui),
    }
    const dispose = await applyClient(ctx as never)
    expect(ctx.remote.$mount).toHaveBeenCalledOnce()
    expect(ctx.inject).toHaveBeenCalledWith(uiInject, installJdcloudLoginUi)
    await dispose()
    expect(disposeUi).toHaveBeenCalledOnce()
    expect(disposeRemote).toHaveBeenCalledOnce()
  })

  it('rolls back the Remote namespace when UI activation fails', async () => {
    const disposeRemote = vi.fn(() => Promise.resolve())
    const disposeUi = vi.fn(() => Promise.resolve())
    const failure = new Error('UI activation failed')
    const ui = Object.assign(Promise.reject(failure), { dispose: disposeUi })
    const ctx = {
      remote: { $mount: vi.fn(() => Promise.resolve(disposeRemote)) },
      inject: vi.fn(() => ui),
    }
    await expect(applyClient(ctx as never)).rejects.toBe(failure)
    expect(disposeUi).toHaveBeenCalledOnce()
    expect(disposeRemote).toHaveBeenCalledOnce()
  })

  it('shadows root until login, restores it on success, and returns after expiration', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    b.emitRecord('jdcloud-auth-controller/login')
    await vi.waitFor(() => { expect(b.status).toHaveBeenCalledOnce() })
    const loginEntry = b.slots.entries('root').find(entry => entry.component === LoginPage)
    expect(loginEntry?.options.priority).toBe(-100)

    const injected = (loginEntry?.inject as (() => JdcloudLoginInjected) | undefined)?.()
    await expect(injected?.initialize()).resolves.toEqual({
      ok: true,
      authenticated: false,
      baseUrl: 'https://kindoucloud.com',
    })
    await expect(injected?.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    })).resolves.toEqual({ ok: true })
    expect(b.slots.entries('root').some(entry => entry.component === LoginPage)).toBe(false)
    expect(b.slots.entries('sidebar.account').some(entry => entry.component === AccountSeat)).toBe(true)

    b.expire()
    await vi.waitFor(() => {
      expect(b.slots.entries('root').some(entry => entry.component === LoginPage)).toBe(true)
    })
    expect(b.slots.entries('sidebar.account').some(entry => entry.component === AccountSeat)).toBe(false)

    await fiber.dispose()
    expect(b.slots.entries('root').some(entry => entry.component === LoginPage)).toBe(false)
  })

  it('removes an already-authenticated bootstrap gate and its event listener', async () => {
    const b = await bench(true)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const entry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    const injected = (entry?.inject as (() => JdcloudLoginInjected) | undefined)?.()
    await injected?.initialize()
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
    expect(b.slots.entries('sidebar.account').some(candidate => candidate.component === AccountSeat)).toBe(true)
    await fiber.dispose()
    expect(b.status).toHaveBeenCalledTimes(1)
  })

  it('passes redacted account state to the sidebar and restores login after logout', async () => {
    const b = await bench(true)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const loginEntry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    const loginInjected = (loginEntry?.inject as (() => JdcloudLoginInjected) | undefined)?.()
    await loginInjected?.initialize()
    const accountEntry = b.slots.entries('sidebar.account').find(candidate => candidate.component === AccountSeat)
    const accountInjected = (accountEntry?.inject as (() => JdcloudAccountInjected) | undefined)?.()
    expect(accountInjected?.status).toEqual({
      authenticated: true,
      baseUrl: 'https://kindoucloud.com',
      username: 'user',
      corpId: 'corp-current',
      corpName: 'Current Tenant',
      corps: [
        { corpId: 'corp-current', corpName: 'Current Tenant' },
        { corpId: 'corp-next', corpName: 'Next Tenant' },
      ],
    })
    await expect(accountInjected?.logout()).resolves.toEqual({ ok: true })
    expect(b.logout).toHaveBeenCalledOnce()
    expect(b.slots.entries('sidebar.account').some(candidate => candidate.component === AccountSeat)).toBe(false)
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(true)
    await fiber.dispose()
  })

  it('updates the sidebar account after switching tenants without restoring the login gate', async () => {
    const b = await bench(true)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const loginEntry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    await ((loginEntry?.inject as (() => JdcloudLoginInjected) | undefined)?.().initialize())
    const accountEntry = b.slots.entries('sidebar.account').find(candidate => candidate.component === AccountSeat)
    const accountInjected = (accountEntry?.inject as (() => JdcloudAccountInjected) | undefined)?.()
    await expect(accountInjected?.switchCorp('corp-next')).resolves.toEqual({ ok: true })
    expect(b.switchCorp).toHaveBeenCalledWith('corp-next')
    const updatedEntry = b.slots.entries('sidebar.account').find(candidate => candidate.component === AccountSeat)
    expect((updatedEntry?.inject as (() => JdcloudAccountInjected) | undefined)?.().status)
      .toMatchObject({ corpId: 'corp-next', corpName: 'Next Tenant' })
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
    await fiber.dispose()
  })

  it('keeps the sidebar account after a tenant switch failure', async () => {
    const b = await bench(true)
    b.switchCorp.mockResolvedValueOnce({ ok: false, error: { message: '切换失败' } } as never)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const loginEntry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    await ((loginEntry?.inject as (() => JdcloudLoginInjected) | undefined)?.().initialize())
    const accountEntry = b.slots.entries('sidebar.account').find(candidate => candidate.component === AccountSeat)
    const accountInjected = (accountEntry?.inject as (() => JdcloudAccountInjected) | undefined)?.()
    await expect(accountInjected?.switchCorp('corp-next')).resolves.toEqual({ ok: false, error: '切换失败' })
    expect(b.slots.entries('sidebar.account').some(candidate => candidate.component === AccountSeat)).toBe(true)
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
    await fiber.dispose()
  })

  it('keeps the account visible when Host logout fails', async () => {
    const b = await bench(true)
    b.logout.mockResolvedValueOnce({ ok: false, error: { message: '退出失败' } } as never)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const loginEntry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    await ((loginEntry?.inject as (() => JdcloudLoginInjected) | undefined)?.().initialize())
    const accountEntry = b.slots.entries('sidebar.account').find(candidate => candidate.component === AccountSeat)
    const accountInjected = (accountEntry?.inject as (() => JdcloudAccountInjected) | undefined)?.()
    await expect(accountInjected?.logout()).resolves.toEqual({ ok: false, error: '退出失败' })
    expect(b.slots.entries('sidebar.account').some(candidate => candidate.component === AccountSeat)).toBe(true)
    await fiber.dispose()
  })

  it('returns Remote failures from initialize and login without hiding the gate', async () => {
    const b = await bench()
    b.status.mockResolvedValueOnce({ ok: false, error: { message: '状态失败' } } as never)
    b.login.mockResolvedValueOnce({ ok: false, error: { message: '登录失败' } } as never)
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const entry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    const injected = (entry?.inject as (() => JdcloudLoginInjected) | undefined)?.()
    await expect(injected?.initialize()).resolves.toEqual({ ok: false, error: '状态失败' })
    await expect(injected?.login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    })).resolves.toEqual({ ok: false, error: '登录失败' })
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(true)
    await fiber.dispose()
  })

  it('ignores unrelated records and late status completion after disposal', async () => {
    const b = await bench()
    let resolveStatus: ((value: { ok: true; value: { authenticated: false; baseUrl: string } }) => void) | undefined
    b.status.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    b.emitRecord('another-plugin/login')
    const listener = b.captureRecordListener()
    b.emitRecord('jdcloud-auth-controller/login')
    await fiber.dispose()
    listener?.('jdcloud-auth-controller/login')
    resolveStatus?.({ ok: true, value: { authenticated: false, baseUrl: 'https://kindoucloud.com' } })
    await Promise.resolve()
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
  })

  it('does not apply a late initialization result after disposal', async () => {
    const b = await bench()
    let resolveStatus: ((value: {
      ok: true
      value: { authenticated: false; baseUrl: string }
    }) => void) | undefined
    b.status.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const entry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    const pending = (entry?.inject as (() => JdcloudLoginInjected) | undefined)?.().initialize()
    await fiber.dispose()
    resolveStatus?.({ ok: true, value: { authenticated: false, baseUrl: 'https://kindoucloud.com' } })
    await expect(pending).resolves.toEqual({
      ok: true,
      authenticated: false,
      baseUrl: 'https://kindoucloud.com',
    })
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
  })

  it('does not mount an account for a late login result after disposal', async () => {
    const b = await bench()
    let resolveLogin: ((value: {
      ok: true
      value: Extract<Awaited<ReturnType<typeof b.status>>['value'], { authenticated: true }>
    }) => void) | undefined
    b.login.mockImplementationOnce(() => new Promise((resolve) => { resolveLogin = resolve }))
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    const entry = b.slots.entries('root').find(candidate => candidate.component === LoginPage)
    const pending = (entry?.inject as (() => JdcloudLoginInjected) | undefined)?.().login({
      baseUrl: 'https://kindoucloud.com', username: 'user', password: 'secret',
    })
    await fiber.dispose()
    resolveLogin?.({
      ok: true,
      value: {
        authenticated: true,
        baseUrl: 'https://kindoucloud.com',
        username: 'user',
        corpId: 'corp-current',
        corpName: 'Current Tenant',
        corps: [
          { corpId: 'corp-current', corpName: 'Current Tenant' },
          { corpId: 'corp-next', corpName: 'Next Tenant' },
        ],
      },
    })
    await expect(pending).resolves.toEqual({ ok: true })
    expect(b.slots.entries('sidebar.account').some(candidate => candidate.component === AccountSeat)).toBe(false)
  })

  it('refreshes to both authenticated state and a recoverable status failure', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...uiInject], apply: installJdcloudLoginUi })
    await fiber.await()
    b.status.mockResolvedValueOnce({
      ok: true,
      value: {
        authenticated: true,
        baseUrl: 'https://kindoucloud.com',
        username: 'user',
        corpId: 'corp-current',
        corpName: 'Current Tenant',
        corps: [
          { corpId: 'corp-current', corpName: 'Current Tenant' },
          { corpId: 'corp-next', corpName: 'Next Tenant' },
        ],
      },
    })
    b.emitRecord('jdcloud-auth-controller/login')
    await vi.waitFor(() => {
      expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
    })

    b.status.mockResolvedValueOnce({ ok: false, error: { message: '暂时不可用' } } as never)
    b.emitRecord('jdcloud-auth-controller/login')
    await vi.waitFor(() => { expect(b.status).toHaveBeenCalledTimes(2) })
    expect(b.slots.entries('root').some(candidate => candidate.component === LoginPage)).toBe(false)
    await fiber.dispose()
  })
})
