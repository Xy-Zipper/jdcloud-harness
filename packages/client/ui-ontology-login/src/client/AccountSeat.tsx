/** Ontology account summary rendered in the sidebar account seat. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OntologyAuthStatus } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  IconChevronDownOutlineRegular, IconUserOutlineRegular, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import css from './AccountSeat.module.css'

const LOGOUT_ID = 'logout'

/** Authenticated status displayed by the sidebar account summary. */
export type OntologyAuthenticatedStatus = Extract<OntologyAuthStatus, { readonly authenticated: true }>

/** Logout result presented by the account menu. */
export type OntologyLogoutAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Registration-owned account state and logout action. */
export interface OntologyAccountInjected {
  /** Redacted Runtime identity. */
  readonly status: OntologyAuthenticatedStatus
  /** Revoke and remove only the current browser login. */
  logout: () => Promise<OntologyLogoutAttempt>
}

/** Full composed props for the sidebar account seat. */
export type OntologyAccountSeatProps =
  PropsRuntime<'sidebar.account'> & PropsLocale<typeof NS> & InjectFace<OntologyAccountInjected>

/**
 * Render the authenticated Ontology account and logout action.
 * @param props - Composed sidebar owner, locale, and account props.
 * @returns Account trigger and its menu.
 */
export function AccountSeat({ wide, status, logout, t }: OntologyAccountSeatProps) {
  const [open, setOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runLogout = async (): Promise<void> => {
    setLoggingOut(true)
    setError(null)
    const result = await logout()
    if (result.ok) return
    setError(result.error || t('defaultError'))
    setLoggingOut(false)
  }

  const items: MenuEntry[] = [
    ...(error === null ? [] : [{ type: 'label' as const, id: 'error', text: error }]),
    { type: 'label', id: 'service', text: t('serviceLabel') },
    { type: 'label', id: 'base-url', text: status.baseUrl },
  ]
  const footer: MenuEntry[] = [{
    id: LOGOUT_ID,
    label: loggingOut ? t('loggingOut') : t('logout'),
    disabled: loggingOut,
    danger: true,
  }]

  return (
    <div className={css.root}>
      <Menu
        className={css.menu}
        open={open}
        onClose={() => { setOpen(false) }}
        items={items}
        footer={footer}
        onSelect={(id) => { if (id === LOGOUT_ID) void runLogout() }}
        portal
        anchor={(
          <button
            type="button"
            data-testid="ontology-sidebar-account-trigger"
            className={wide ? css.trigger : `${css.trigger} ${css.collapsed}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('accountAria', { displayName: status.user.displayName })}
            onClick={() => { setOpen(value => !value) }}
          >
            <span className={css.icon} aria-hidden="true"><IconUserOutlineRegular size={wide ? 18 : 20} /></span>
            {wide && (
              <>
                <span className={css.identity}>
                  <span className={css.displayName} data-testid="ontology-sidebar-display-name">
                    {status.user.displayName}
                  </span>
                  <span className={css.accountType} data-testid="ontology-sidebar-account-type">
                    {status.user.accountType === 'admin' ? t('accountTypeAdmin') : t('accountTypeMember')}
                  </span>
                </span>
                <IconChevronDownOutlineRegular className={open ? css.chevronOpen : css.chevron} />
              </>
            )}
          </button>
        )}
      />
    </div>
  )
}
