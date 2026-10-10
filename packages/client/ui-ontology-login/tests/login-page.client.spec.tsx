// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LoginPage, type OntologyLoginPageProps } from '../src/client/LoginPage.tsx'
import { zh, type OntologyLoginKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const t = (key: OntologyLoginKey): string => zh[key]

/** Render the pure form with registration-owned callbacks. */
function renderPage(overrides: Partial<OntologyLoginPageProps> = {}) {
  const initialize = vi.fn(() => Promise.resolve({ ok: true as const, authenticated: false }))
  const login = vi.fn(() => Promise.resolve({ ok: true as const }))
  render(<LoginPage {...({ initialize, login, t, ...overrides } as OntologyLoginPageProps)} />)
  return { initialize, login }
}

describe('Ontology login page', () => {
  it('renders the configured brand and submits only account credentials', async () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Configured Ontology')
    const { login } = renderPage()
    expect(screen.getByText('Configured Ontology')).toBeTruthy()
    expect(document.querySelector('[data-ontology-brand-mark="true"]')).not.toBeNull()
    await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('账号').disabled).toBe(false) })

    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => { expect(login).toHaveBeenCalledWith({ username: 'alice', password: 'password123' }) })
    await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('') })
    expect(screen.queryByLabelText('服务地址')).toBeNull()
  })

  it('keeps the password after a Host rejection and reports the message', async () => {
    renderPage({ login: vi.fn(() => Promise.resolve({ ok: false as const, error: '账号或密码错误' })) })
    await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('账号').disabled).toBe(false) })
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe('账号或密码错误')
    expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('wrong')
  })

  it('rejects incomplete input without calling the Host', async () => {
    const { login } = renderPage()
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: '登录' }).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.required)
    expect(login).not.toHaveBeenCalled()
  })
})
