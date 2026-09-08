// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LoginPage, type JdcloudLoginPageProps } from '../src/client/LoginPage.tsx'
import { zh, type JdcloudLoginKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

const t = (key: JdcloudLoginKey): string => zh[key]

/** Render the pure form with only its registration-owned callbacks. */
function renderPage(overrides: Partial<JdcloudLoginPageProps> = {}) {
  const initialize = vi.fn(() => Promise.resolve({
    ok: true as const,
    authenticated: false,
    baseUrl: 'https://kindoucloud.com',
  }))
  const login = vi.fn(() => Promise.resolve({ ok: true as const }))
  render(<LoginPage {...({ initialize, login, t, ...overrides } as JdcloudLoginPageProps)} />)
  return { initialize, login }
}

describe('JDCloud login page', () => {
  it('uses the shared JDCloud mark in the brand panel', () => {
    const rendered = renderPage()
    expect(document.querySelector('[data-jdcloud-brand-mark="true"]')).not.toBeNull()
    expect(rendered.initialize).toHaveBeenCalledOnce()
  })

  it('loads the default service address and submits account/password fields', async () => {
    const { login } = renderPage()
    const service = await screen.findByLabelText<HTMLInputElement>('服务地址')
    expect(service.value).toBe('https://kindoucloud.com')

    fireEvent.change(service, { target: { value: 'https://beta.kindoucloud.com' } })
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'lowcode-user' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        baseUrl: 'https://beta.kindoucloud.com',
        username: 'lowcode-user',
        password: 'secret',
      })
    })
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('')
    })
  })

  it('keeps the form open and presents a Host login failure', async () => {
    renderPage({
      login: vi.fn(() => Promise.resolve({ ok: false as const, error: '账号或密码错误' })),
    })
    await screen.findByDisplayValue('https://kindoucloud.com')
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe('账号或密码错误')
    expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('wrong')
  })

  it('uses the localized fallback for an empty Host failure message', async () => {
    renderPage({ login: vi.fn(() => Promise.resolve({ ok: false as const, error: '' })) })
    await screen.findByDisplayValue('https://kindoucloud.com')
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.defaultError)
  })

  it('presents initialization failure and ignores completion after unmount', async () => {
    const pending: { resolve?: (value: { ok: true; authenticated: false; baseUrl: string }) => void } = {}
    const initialize = vi.fn(() => new Promise<{ ok: true; authenticated: false; baseUrl: string }>((resolve) => {
      pending.resolve = resolve
    }))
    const rendered = render(<LoginPage {...({
      initialize: vi.fn(() => Promise.resolve({ ok: false as const, error: '状态读取失败' })),
      login: vi.fn(),
      t,
    } as unknown as JdcloudLoginPageProps)} />)
    expect((await screen.findByRole('alert')).textContent).toBe('状态读取失败')
    rendered.unmount()

    const late = render(<LoginPage {...({ initialize, login: vi.fn(), t } as unknown as JdcloudLoginPageProps)} />)
    late.unmount()
    pending.resolve?.({ ok: true, authenticated: false, baseUrl: 'https://late.example.com' })
    await Promise.resolve()
  })

  it('disables the form and shows progress while login is pending', async () => {
    let resolveLogin: (() => void) | undefined
    renderPage({
      login: vi.fn(() => new Promise<{ ok: true }>((resolve) => {
        resolveLogin = () => { resolve({ ok: true }) }
      })),
    })
    await screen.findByDisplayValue('https://kindoucloud.com')
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: zh.submitting })).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('服务地址').disabled).toBe(true)
    resolveLogin?.()
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.submit }).disabled).toBe(false)
    })
  })

  it('rejects an incomplete local submission without calling the Host', async () => {
    const { login } = renderPage()
    await screen.findByDisplayValue('https://kindoucloud.com')
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe('请填写服务地址、账号和密码。')
    expect(login).not.toHaveBeenCalled()
  })
})
