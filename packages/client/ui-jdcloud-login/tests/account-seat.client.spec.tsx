// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AccountSeat, type JdcloudAccountSeatProps, type JdcloudAuthenticatedStatus,
} from '../src/client/AccountSeat.tsx'
import { zh, type JdcloudLoginKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

const status: JdcloudAuthenticatedStatus = {
  authenticated: true,
  baseUrl: 'https://kindoucloud.com',
  username: 'lowcode-user',
  corpId: 'corp-current',
  corpName: 'Current Tenant',
  corps: [
    { corpId: 'corp-current', corpName: 'Current Tenant' },
    { corpId: 'corp-next', corpName: 'Next Tenant' },
    { corpId: 'corp-joined', corpName: 'Joined Tenant' },
  ],
}

const t: JdcloudAccountSeatProps['t'] = (key, params) => {
  let value: string = zh[key as JdcloudLoginKey]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

function mount(overrides: Partial<JdcloudAccountSeatProps> = {}) {
  const logout = vi.fn(() => Promise.resolve({ ok: true as const }))
  const switchCorp = vi.fn(() => Promise.resolve({ ok: true as const }))
  render(<AccountSeat {...({ wide: true, status, logout, switchCorp, t, ...overrides } as JdcloudAccountSeatProps)} />)
  return { logout, switchCorp }
}

describe('JDCloud sidebar account seat', () => {
  it('shows account and tenant names and invokes logout from its menu', async () => {
    let resolveLogout: ((value: { ok: true }) => void) | undefined
    const logout = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveLogout = resolve }))
    mount({ logout })

    expect(screen.getByTestId('jdcloud-sidebar-user-name').textContent).toBe('lowcode-user')
    expect(screen.getByTestId('jdcloud-sidebar-corp-name').textContent).toBe('Current Tenant')
    const trigger = screen.getByRole('button', { name: '当前账号 lowcode-user，租户 Current Tenant' })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu')
    const tenantViewport = menu.firstElementChild
    expect(tenantViewport).toBeInstanceOf(HTMLElement)
    expect(tenantViewport?.className).toMatch(/tenantViewport/)
    expect(screen.getByText('租户')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Current Tenant' }).disabled).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Current Tenant' }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Next Tenant' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Joined Tenant' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    expect(logout).toHaveBeenCalledOnce()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '正在退出…' }).disabled).toBe(true)
    resolveLogout?.({ ok: true })
    await Promise.resolve()
  })

  it('switches to another tenant and disables menu actions while waiting', async () => {
    let resolveSwitch: ((value: { ok: true }) => void) | undefined
    const switchCorp = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveSwitch = resolve }))
    mount({ switchCorp })
    fireEvent.click(screen.getByTestId('jdcloud-sidebar-account-trigger'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Next Tenant' }))
    expect(switchCorp).toHaveBeenCalledWith('corp-next')
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '正在切换到 Next Tenant…' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '退出登录' }).disabled).toBe(true)
    resolveSwitch?.({ ok: true })
    await Promise.resolve()
  })

  it.each([
    ['切换失败', '切换失败'],
    ['', zh.switchTenantFailed],
  ])('keeps the tenant menu usable after switch failure %j', async (message, expected) => {
    const switchCorp = vi.fn(() => Promise.resolve({ ok: false as const, error: message }))
    mount({ switchCorp })
    fireEvent.click(screen.getByTestId('jdcloud-sidebar-account-trigger'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Next Tenant' }))
    expect(await screen.findByText(expected)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Next Tenant' }).disabled).toBe(false)
    })
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Current Tenant' }).disabled).toBe(true)
  })

  it.each([
    ['退出失败', '退出失败'],
    ['', zh.defaultError],
  ])('keeps the menu usable after logout failure %j', async (message, expected) => {
    mount({ logout: vi.fn(() => Promise.resolve({ ok: false as const, error: message })) })
    fireEvent.click(screen.getByTestId('jdcloud-sidebar-account-trigger'))
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    expect(await screen.findByText(expected)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '退出登录' }).disabled).toBe(false)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('collapses to an accessible account icon in the sidebar rail', () => {
    mount({ wide: false })
    expect(screen.queryByTestId('jdcloud-sidebar-user-name')).toBeNull()
    expect(screen.getByRole('button', { name: '当前账号 lowcode-user，租户 Current Tenant' })).toBeTruthy()
  })
})
