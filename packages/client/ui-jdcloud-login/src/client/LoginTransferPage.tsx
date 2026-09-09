/** JDCloud token-transfer progress and failure page. */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { JdcloudBrandMark } from './Brand.tsx'
import { NS } from './locales.ts'
import css from './LoginTransferPage.module.css'

/** One-shot transfer result presented by the page. */
export type JdcloudLoginTransferResult = { readonly ok: true } | { readonly ok: false }

/** Registration-owned callbacks used by the transfer page. */
export interface JdcloudLoginTransferInjected {
  /** Validate and store the credentials removed from the browser address bar. */
  transfer: () => Promise<JdcloudLoginTransferResult>
  /** Leave the failed transfer and reveal account/password login. */
  goLogin: () => void
}

/** Full composed props for the transfer root contribution. */
export type JdcloudLoginTransferPageProps =
  PropsRuntime<'root'> & PropsLocale<typeof NS> & InjectFace<JdcloudLoginTransferInjected>

/** Render transfer progress and a recovery action after validation failure. */
export function LoginTransferPage({ transfer, goLogin, t }: JdcloudLoginTransferPageProps) {
  const started = useRef(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let active = true
    void transfer().then((result) => {
      if (active && !result.ok) setError(true)
    })
    return () => { active = false }
  }, [transfer])

  if (error) {
    return (
      <main className={css.page} data-testid="jdcloud-login-transfer-error">
        <section className={css.card}>
          <JdcloudBrandMark size={52} />
          <h1>{t('transferErrorTitle')}</h1>
          <p>{t('transferErrorDescription')}</p>
          <Button
            type="button"
            variant="primary"
            data-testid="jdcloud-login-transfer-go-login"
            onClick={goLogin}
          >
            {t('transferGoLogin')}
          </Button>
        </section>
      </main>
    )
  }

  return (
    <main className={css.page} data-testid="jdcloud-login-transfer" aria-busy="true">
      <section className={css.card}>
        <JdcloudBrandMark size={52} />
        <span className={css.spinner} aria-hidden="true" />
        <p role="status">{t('transferLoading')}</p>
      </section>
    </main>
  )
}
