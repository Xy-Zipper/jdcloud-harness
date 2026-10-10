// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AccountSeat, type OntologyAccountSeatProps, type OntologyAuthenticatedStatus,
} from '../src/client/AccountSeat.tsx'
import { zh, type OntologyLoginKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const status: OntologyAuthenticatedStatus = {
  authenticated: true,
  baseUrl: 'https://ontology.example.com',
  user: {
    userId: 'user-alice',
    username: 'alice',
    displayName: 'Alice',
    accountType: 'admin',
    authorizationVersion: '5',
  },
}

const t: OntologyAccountSeatProps['t'] = (key, params) => {
  let value: string = zh[key as OntologyLoginKey]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

/** Render one authenticated sidebar account. */
function mount(overrides: Partial<OntologyAccountSeatProps> = {}) {
  const logout = vi.fn(() => Promise.resolve({ ok: true as const }))
  render(<AccountSeat {...({ wide: true, status, logout, t, ...overrides } as OntologyAccountSeatProps)} />)
  return { logout }
}

describe('Ontology sidebar account seat', () => {
  it('shows identity, deployment address, and invokes logout', async () => {
    const { logout } = mount()
    expect(screen.getByTestId('ontology-sidebar-display-name').textContent).toBe('Alice')
    expect(screen.getByTestId('ontology-sidebar-account-type').textContent).toBe('管理员')
    fireEvent.click(screen.getByRole('button', { name: '当前账号 Alice' }))
    expect(screen.getByText('https://ontology.example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    expect(logout).toHaveBeenCalledOnce()
  })

  it('keeps logout available after a failed request', async () => {
    mount({ logout: vi.fn(() => Promise.resolve({ ok: false as const, error: '注销失败' })) })
    fireEvent.click(screen.getByTestId('ontology-sidebar-account-trigger'))
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    expect(await screen.findByText('注销失败')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '退出登录' }).disabled).toBe(false)
    })
  })

  it('collapses to an accessible account icon', () => {
    mount({ wide: false })
    expect(screen.queryByTestId('ontology-sidebar-display-name')).toBeNull()
    expect(screen.getByRole('button', { name: '当前账号 Alice' })).toBeTruthy()
  })
})
