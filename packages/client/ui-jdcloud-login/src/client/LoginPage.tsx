/** JDCloud login form shown while the Host has no usable token. */

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JdcloudLoginRequest } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import { NS } from './locales.ts'
import css from './LoginPage.module.css'

/** Status result used to initialize the guarded root without exposing a token. */
export type JdcloudLoginBootstrap =
  | { readonly ok: true; readonly authenticated: boolean; readonly baseUrl: string }
  | { readonly ok: false; readonly error: string }

/** Form submission result presented by the page. */
export type JdcloudLoginAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Registration-owned callbacks used by the pure login page. */
export interface JdcloudLoginInjected {
  /** Read redacted Host authentication state when the page mounts. */
  initialize: () => Promise<JdcloudLoginBootstrap>
  /** Submit credentials to the Host; the password is not retained after success. */
  login: (request: JdcloudLoginRequest) => Promise<JdcloudLoginAttempt>
}

/** Full composed props for the built-in root slot. */
export type JdcloudLoginPageProps =
  PropsRuntime<'root'> & PropsLocale<typeof NS> & InjectFace<JdcloudLoginInjected>

/** Render the full-page JDCloud credential gate. */
export function LoginPage({ initialize, login, t }: JdcloudLoginPageProps) {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void initialize().then((result) => {
      if (!active) return
      if (result.ok) setBaseUrl(result.baseUrl)
      else setError(result.error)
      setLoading(false)
    })
    return () => { active = false }
  }, [initialize])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (baseUrl.trim() === '' || username.trim() === '' || password === '') {
      setError(t('required'))
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await login({ baseUrl, username, password })
    if (result.ok) setPassword('')
    else setError(result.error || t('defaultError'))
    setSubmitting(false)
  }

  return (
    <main className={css.page}>
      <section className={css.brandPanel} aria-label={t('markLabel')}>
        <div className={css.brandContent}>
          <div className={css.mark} aria-hidden="true">{t('markLabel')}</div>
          <p className={css.eyebrow}>{t('eyebrow')}</p>
          <h1 className={css.brandTitle}>{t('description')}</h1>
        </div>
      </section>
      <section className={css.formPanel}>
        <form className={css.card} onSubmit={(event) => { void submit(event) }} noValidate>
          <div className={css.heading}>
            <h2>{t('title')}</h2>
            <p>{t('description')}</p>
          </div>

          <label className={css.field}>
            <span>{t('serviceLabel')}</span>
            <input
              type="url"
              value={baseUrl}
              placeholder={t('servicePlaceholder')}
              autoComplete="url"
              disabled={loading || submitting}
              onChange={(event) => { setBaseUrl(event.currentTarget.value) }}
            />
          </label>

          <label className={css.field}>
            <span>{t('usernameLabel')}</span>
            <input
              value={username}
              placeholder={t('usernamePlaceholder')}
              autoComplete="username"
              disabled={loading || submitting}
              onChange={(event) => { setUsername(event.currentTarget.value) }}
            />
          </label>

          <label className={css.field}>
            <span>{t('passwordLabel')}</span>
            <input
              type="password"
              value={password}
              placeholder={t('passwordPlaceholder')}
              autoComplete="current-password"
              disabled={loading || submitting}
              onChange={(event) => { setPassword(event.currentTarget.value) }}
            />
          </label>

          {loading && <p className={css.status} role="status">{t('loading')}</p>}
          {error !== null && <p className={css.error} role="alert">{error}</p>}

          <Button className={css.submit} variant="primary" type="submit" disabled={loading || submitting}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </form>
      </section>
    </main>
  )
}
