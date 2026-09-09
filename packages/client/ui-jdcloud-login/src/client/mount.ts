/** JDCloud Remote mount and root-slot login lifecycle. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { JdcloudAuthStatus } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import { AccountSeat, type JdcloudAccountInjected } from './AccountSeat.tsx'
import { JdcloudBrandMark, JdcloudBrandName } from './Brand.tsx'
import { LoginPage, type JdcloudLoginInjected } from './LoginPage.tsx'
import { LoginTransferPage, type JdcloudLoginTransferInjected } from './LoginTransferPage.tsx'
import { en, NS, zh } from './locales.ts'

const AUTH_RECORD_KEY = 'jdcloud-auth-controller/login'
const BRAND_PRIORITY = -10
const TRANSFER_PRIORITY = -110
const TRANSFER_PATH = '/login/transfer'

interface LoginTransferCredentials {
  readonly token: string
  readonly baseUrl: string
}

/** Read the direct route query or Host-bootstrap fragment once at plugin activation. */
function readTransferCredentials(): LoginTransferCredentials | undefined {
  const query = new URLSearchParams(window.location.search)
  if (window.location.pathname === TRANSFER_PATH) {
    return {
      token: query.get('token')?.trim() ?? '',
      baseUrl: query.get('baseUrl')?.trim() ?? '',
    }
  }
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  if (window.location.pathname !== '/' || fragment.get('jdcloudTransfer') !== '1') return undefined
  return {
    token: fragment.get('jdcloudToken')?.trim() ?? '',
    baseUrl: fragment.get('baseUrl')?.trim() ?? '',
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** JDCloud authentication-page copy. */
    'jdcloud.login': import('./locales.ts').JdcloudLoginKey
  }
}

/** Services required after the generated JDCloud Remote namespace is mounted. */
export const uiInject = ['remote', 'remote.jdcloudAuth', 'slots', 'locale']

/** Install JDCloud occupants ahead of generic and official brand fallbacks. */
function installJdcloudBrand(ctx: ClientContext): () => void {
  const disposeSidebar = ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: BRAND_PRIORITY }, JdcloudBrandMark)
      yield ctx.slots.register({
        name: 'sidebar.brand.name',
        priority: BRAND_PRIORITY,
        locale: NS,
      }, JdcloudBrandName)
    }))
  const disposeHero = ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
    priority: BRAND_PRIORITY,
  }, JdcloudBrandMark))
  return () => {
    disposeHero()
    disposeSidebar()
  }
}

/**
 * Install the guarded root and react to Host credential-record changes.
 * @param ctx - Client context carrying Remote, slot, and locale services.
 */
export function installJdcloudLoginUi(ctx: ClientContext): void {
  let active = true
  let disposeLogin: (() => void) | undefined
  let disposeTransfer: (() => void) | undefined
  let disposeAccount: (() => void) | undefined
  const isActive = (): boolean => active

  const hideLogin = (): void => {
    disposeLogin?.()
    disposeLogin = undefined
  }

  const hideAccount = (): void => {
    disposeAccount?.()
    disposeAccount = undefined
  }

  const hideTransfer = (): void => {
    disposeTransfer?.()
    disposeTransfer = undefined
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
      hideTransfer()
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

  const showTransfer = (credentials: LoginTransferCredentials): void => {
    let oneShotCredentials: LoginTransferCredentials | undefined = credentials
    const injected: JdcloudLoginTransferInjected = {
      transfer: async () => {
        const request = oneShotCredentials
        oneShotCredentials = undefined
        if (request === undefined) return { ok: false }
        const result = await ctx.remote.jdcloudAuth.loginWithToken(request)
        if (!result.ok) return { ok: false }
        if (active) {
          window.history.replaceState(null, '', '/')
          applyStatus(result.value)
        }
        return { ok: true }
      },
      goLogin: () => {
        if (!active) return
        window.history.replaceState(null, '', '/')
        hideTransfer()
        showLogin()
      },
    }
    disposeTransfer = ctx.slots.register({
      name: 'root',
      priority: TRANSFER_PRIORITY,
      locale: NS,
      inject: () => injected,
    }, LoginTransferPage)
  }

  const refresh = async (): Promise<void> => {
    if (!isActive() || disposeTransfer !== undefined) return
    const result = await ctx.remote.jdcloudAuth.status()
    if (!isActive() || !result.ok) return
    applyStatus(result.value)
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jdcloud-login: dictionaries')
  ctx.effect(() => installJdcloudBrand(ctx), 'ui-jdcloud-login: JDCloud brand')
  ctx.effect(() => {
    const offRecord = ctx.remote.$on('credentials/record-updated', (key) => {
      if (String(key) === AUTH_RECORD_KEY) void refresh()
    })
    const transfer = readTransferCredentials()
    if (transfer === undefined) {
      showLogin()
    } else {
      // Scrub the token before the Host validates it or the page loads subresources.
      window.history.replaceState(null, '', TRANSFER_PATH)
      showTransfer(transfer)
    }
    return () => {
      active = false
      offRecord()
      hideLogin()
      hideTransfer()
      hideAccount()
    }
  }, 'ui-jdcloud-login: authentication gate')
}
