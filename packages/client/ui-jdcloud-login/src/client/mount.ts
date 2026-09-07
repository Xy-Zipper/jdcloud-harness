/** JDCloud Remote mount and root-slot login lifecycle. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { JdcloudAuthStatus } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import { AccountSeat, type JdcloudAccountInjected } from './AccountSeat.tsx'
import { LoginPage, type JdcloudLoginInjected } from './LoginPage.tsx'
import { en, NS, zh } from './locales.ts'

const AUTH_RECORD_KEY = 'jdcloud-auth-controller/login'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** JDCloud authentication-page copy. */
    'jdcloud.login': import('./locales.ts').JdcloudLoginKey
  }
}

/** Services required after the generated JDCloud Remote namespace is mounted. */
export const uiInject = ['remote', 'remote.jdcloudAuth', 'slots', 'locale']

/**
 * Install the guarded root and react to Host credential-record changes.
 * @param ctx - Client context carrying Remote, slot, and locale services.
 */
export function installJdcloudLoginUi(ctx: ClientContext): void {
  let active = true
  let disposeLogin: (() => void) | undefined
  let disposeAccount: (() => void) | undefined

  const hideLogin = (): void => {
    disposeLogin?.()
    disposeLogin = undefined
  }

  const hideAccount = (): void => {
    disposeAccount?.()
    disposeAccount = undefined
  }

  const showAccount = (status: Extract<JdcloudAuthStatus, { readonly authenticated: true }>): void => {
    if (!active) return
    hideAccount()
    const injected: JdcloudAccountInjected = {
      status,
      logout: async () => {
        const result = await ctx.remote.jdcloudAuth.logout()
        if (!result.ok) return { ok: false, error: result.error.message }
        applyStatus(result.value)
        return { ok: true }
      },
      switchCorp: async (corpId) => {
        const result = await ctx.remote.jdcloudAuth.switchCorp(corpId)
        if (!result.ok) return { ok: false, error: result.error.message }
        applyStatus(result.value)
        return { ok: true }
      },
    }
    disposeAccount = ctx.slots.inject('sidebar.account', () => ctx.slots.register({
      name: 'sidebar.account',
      locale: NS,
      inject: () => injected,
    }, AccountSeat))
  }

  const applyStatus = (status: JdcloudAuthStatus): void => {
    if (status.authenticated) {
      hideLogin()
      showAccount(status)
      return
    }
    hideAccount()
    showLogin()
  }

  const showLogin = (): void => {
    if (!active || disposeLogin !== undefined) return
    const injected: JdcloudLoginInjected = {
      initialize: async () => {
        const result = await ctx.remote.jdcloudAuth.status()
        if (!result.ok) return { ok: false, error: result.error.message }
        if (active) applyStatus(result.value)
        return { ok: true, ...result.value }
      },
      login: async (request) => {
        const result = await ctx.remote.jdcloudAuth.login(request)
        if (!result.ok) return { ok: false, error: result.error.message }
        applyStatus(result.value)
        return { ok: true }
      },
    }
    disposeLogin = ctx.slots.register({
      name: 'root',
      priority: -100,
      locale: NS,
      inject: () => injected,
    }, LoginPage)
  }

  const refresh = async (): Promise<void> => {
    if (!active) return
    const result = await ctx.remote.jdcloudAuth.status()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal may run while the Remote call is pending.
    if (!active || !result.ok) return
    applyStatus(result.value)
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jdcloud-login: dictionaries')
  ctx.effect(() => {
    const offRecord = ctx.remote.$on('credentials/record-updated', (key) => {
      if (String(key) === AUTH_RECORD_KEY) void refresh()
    })
    showLogin()
    return () => {
      active = false
      offRecord()
      hideLogin()
      hideAccount()
    }
  }, 'ui-jdcloud-login: authentication gate')
}
