// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  LoginTransferPage,
  type JdcloudLoginTransferPageProps,
} from '../src/client/LoginTransferPage.tsx'
import { zh, type JdcloudLoginKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: JdcloudLoginKey): string => zh[key]

/** Render the pure transfer page with registration-owned callbacks. */
function renderPage(transfer: JdcloudLoginTransferPageProps['transfer']) {
  const goLogin = vi.fn()
  render(<LoginTransferPage {...({ transfer, goLogin, t } as JdcloudLoginTransferPageProps)} />)
  return { goLogin }
}

describe('JDCloud login transfer page', () => {
  it('shows validation progress and starts the transfer once', () => {
    const transfer = vi.fn(() => new Promise<{ ok: true }>(() => {}))
    const goLogin = vi.fn()
    render(
      <StrictMode>
        <LoginTransferPage {...({ transfer, goLogin, t } as JdcloudLoginTransferPageProps)} />
      </StrictMode>,
    )
    expect(screen.getByRole('status').textContent).toBe(zh.transferLoading)
    expect(screen.getByTestId('jdcloud-login-transfer').getAttribute('aria-busy')).toBe('true')
    expect(transfer).toHaveBeenCalledOnce()
  })

  it('shows a localized recovery action after validation fails', async () => {
    const { goLogin } = renderPage(vi.fn(() => Promise.resolve({ ok: false as const })))
    expect((await screen.findByRole('heading')).textContent).toBe(zh.transferErrorTitle)
    expect(screen.getByText(zh.transferErrorDescription)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh.transferGoLogin }))
    expect(goLogin).toHaveBeenCalledOnce()
  })

  it('ignores a late failed result after unmount', async () => {
    let resolve: ((value: { ok: false }) => void) | undefined
    const rendered = renderPage(() => new Promise((done) => { resolve = done }))
    cleanup()
    resolve?.({ ok: false })
    await Promise.resolve()
    expect(rendered.goLogin).not.toHaveBeenCalled()
  })
})
