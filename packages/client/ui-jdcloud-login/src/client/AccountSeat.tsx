/** JDCloud account summary rendered in the sidebar account seat. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JdcloudAuthStatus } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  IconChevronDownOutline14, IconUserOutline16, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import css from './AccountSeat.module.css'

const LOGOUT_ID = 'logout'
const CORP_ID_PREFIX = 'corp:'

/** Authenticated status displayed by the sidebar account summary. */
export type JdcloudAuthenticatedStatus = Extract<JdcloudAuthStatus, { readonly authenticated: true }>

/** Logout result presented by the account menu. */
export type JdcloudLogoutAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Tenant-switch result presented by the account menu. */
export type JdcloudSwitchAttempt = JdcloudLogoutAttempt

/** Registration-owned account state and logout action. */
export interface JdcloudAccountInjected {
  /** Redacted account and current-tenant state. */
  readonly status: JdcloudAuthenticatedStatus
  /** Delete the Host login and restore the login gate. */
  logout: () => Promise<JdcloudLogoutAttempt>
  /** Select another tenant without returning to the login page. */
  switchCorp: (corpId: string) => Promise<JdcloudSwitchAttempt>
}

/** Full composed props for the sidebar account seat. */
export type JdcloudAccountSeatProps =
  PropsRuntime<'sidebar.account'> & PropsLocale<typeof NS> & InjectFace<JdcloudAccountInjected>

/**
 * Render the authenticated account summary and logout menu.
 * @param props - Composed sidebar owner, locale, and account props.
 * @returns Account trigger and its menu.
 */
export function AccountSeat({ wide, status, logout, switchCorp, t }: JdcloudAccountSeatProps) {
  const [open, setOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [switchingCorpId, setSwitchingCorpId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = loggingOut || switchingCorpId !== null

  const runLogout = async (): Promise<void> => {
    setLoggingOut(true)
    setError(null)
    const result = await logout()
    if (result.ok) return
    setError(result.error || t('defaultError'))
    setLoggingOut(false)
  }

  const runSwitch = async (corpId: string): Promise<void> => {
    setSwitchingCorpId(corpId)
    setError(null)
    const result = await switchCorp(corpId)
    if (result.ok) return
    setError(result.error || t('switchTenantFailed'))
    setSwitchingCorpId(null)
  }

  const items: MenuEntry[] = [
    ...(error === null ? [] : [{ type: 'label' as const, id: 'error', text: error }]),
    { type: 'label', id: 'tenant-list', text: t('tenantList') },
    ...status.corps.map(corp => ({
      id: `${CORP_ID_PREFIX}${corp.corpId}`,
      label: switchingCorpId === corp.corpId
        ? t('switchingTenant', { corpName: corp.corpName })
        : corp.corpName,
      disabled: busy || corp.corpId === status.corpId,
    })),
  ]

  const footer: MenuEntry[] = [{
    id: LOGOUT_ID,
    label: loggingOut ? t('loggingOut') : t('logout'),
    disabled: busy,
    danger: true,
  }]

  const onSelect = (id: string): void => {
    if (id === LOGOUT_ID) {
      void runLogout()
      return
    }
    void runSwitch(id.slice(CORP_ID_PREFIX.length))
  }

  return (
    <div className={css.root}>
      <Menu
        className={css.menu as string}
        open={open}
        onClose={() => { setOpen(false) }}
        items={items}
        footer={footer}
        viewportClassName={css.tenantViewport as string}
        selectedId={`${CORP_ID_PREFIX}${status.corpId}`}
        onSelect={onSelect}
        portal
        anchor={(
          <button
            type="button"
            data-testid="jdcloud-sidebar-account-trigger"
            className={wide ? css.trigger : `${css.trigger} ${css.collapsed}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('accountAria', { username: status.username, corpName: status.corpName })}
            onClick={() => { setOpen(value => !value) }}
          >
            <span className={css.icon} aria-hidden="true"><IconUserOutline16 size={wide ? 18 : 20} /></span>
            {wide && (
              <>
                <span className={css.identity}>
                  <span className={css.username} data-testid="jdcloud-sidebar-user-name">{status.username}</span>
                  <span className={css.corpName} data-testid="jdcloud-sidebar-corp-name">{status.corpName}</span>
                </span>
                <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
              </>
            )}
          </button>
        )}
      />
    </div>
  )
}
