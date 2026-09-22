/** JDCloud Remote mount and root-slot login lifecycle. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller/remote'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
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
const ADMIN_CONTROL_PRIORITY = -100
const ORDINARY_USER_PERMISSION_PRESET = 'workspace-write'

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
export const uiInject = [
  'remote', 'remote.jdcloudAuth', 'slots', 'locale', 'commandUi', 'sidebarRightTabs',
  'sidebarPanels', 'sessions', 'uiWorkspace',
]

/** Null occupant that shadows one administrator-only single slot. */
function HiddenAdministratorControl(): null {
  return null
}

/** Install administrator-only slot shadows as one lifecycle. */
function installAdministratorControlShadows(ctx: ClientContext): () => void {
  const disposers = [
    ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
      name: 'sidebar.settings', priority: ADMIN_CONTROL_PRIORITY,
    }, HiddenAdministratorControl)),
    ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
      name: 'conversation.input.model', priority: ADMIN_CONTROL_PRIORITY,
    }, HiddenAdministratorControl)),
    ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
      name: 'conversation.input.permission', priority: ADMIN_CONTROL_PRIORITY,
    }, HiddenAdministratorControl)),
    ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register({
      name: 'conversation.hero.agentPreset', priority: ADMIN_CONTROL_PRIORITY,
    }, HiddenAdministratorControl)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** Force each ordinary-user new conversation onto the restricted permission preset before navigation. */
function installOrdinaryUserSessionInitializer(ctx: ClientContext): () => void {
  return ctx.uiWorkspace.registerNewSessionInitializer(async (sessionId) => {
    const session = ctx.sessions.binding(sessionId)?.session
    if (session === undefined) throw new Error(`JDCloud permission initialization cannot resolve Session "${sessionId}"`)
    const result = await session.command(`/permission ${ORDINARY_USER_PERMISSION_PRESET}`)
    if (!result.ok) {
      throw new Error(`JDCloud permission initialization failed: ${result.error.code}: ${result.error.message}`)
    }
    if (!result.value.matched) throw new Error('JDCloud permission initialization requires the /permission command')
  })
}

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
  let disposeAdministratorShadows: (() => void) | undefined
  let disposeTerminalFilter: (() => void) | undefined
  let disposePluginPanelFilter: (() => void) | undefined
  let disposeNewSessionInitializer: (() => void) | undefined
  let systemAdministrator = false
  const isActive = (): boolean => active

  /** Clear a selected Session before presenting a different JDCloud identity. */
  const resetIdentityView = (): void => {
    if (!active) return
    ctx.uiWorkspace.clearSelection()
  }

  /** Apply the current tenant's administrator-only client controls. */
  const applyAdministratorAccess = (allowed: boolean, initializeNewSessions: boolean): void => {
    systemAdministrator = allowed
    if (allowed) {
      disposeAdministratorShadows?.()
      disposeAdministratorShadows = undefined
      disposeTerminalFilter?.()
      disposeTerminalFilter = undefined
      disposePluginPanelFilter?.()
      disposePluginPanelFilter = undefined
      disposeNewSessionInitializer?.()
      disposeNewSessionInitializer = undefined
      return
    }
    // A popup opened by an administrator must not survive a tenant-role downgrade.
    if (disposeAdministratorShadows === undefined) {
      const commandUi = ctx.get('commandUi') as CommandUiContract
      commandUi.dismiss('permission')
    }
    disposeAdministratorShadows ??= installAdministratorControlShadows(ctx)
    disposeTerminalFilter ??= ctx.sidebarRightTabs.registerAvailabilityFilter(kind => kind !== 'terminal')
    disposePluginPanelFilter ??= ctx.sidebarPanels.registerAvailabilityFilter(id => id !== 'plugins')
    if (initializeNewSessions) {
      disposeNewSessionInitializer ??= installOrdinaryUserSessionInitializer(ctx)
    } else {
      disposeNewSessionInitializer?.()
      disposeNewSessionInitializer = undefined
    }
  }

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
        resetIdentityView()
        applyStatus(result.value)
        return { ok: true }
      },
      switchCorp: async (corpId) => {
        const result = await ctx.remote.jdcloudAuth.switchCorp(corpId)
        if (!result.ok) return { ok: false, error: result.error.message }
        resetIdentityView()
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
    if (!active) return
    if (status.authenticated) {
      applyAdministratorAccess(status.systemAdministrator, !status.systemAdministrator)
      hideLogin()
      hideTransfer()
      showAccount(status)
      return
    }
    applyAdministratorAccess(false, false)
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
        if (!active) return { ok: true }
        resetIdentityView()
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
          resetIdentityView()
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
    const commandUi = ctx.get('commandUi') as CommandUiContract
    return commandUi.registerAvailabilityFilter(name =>
      (name !== 'model' && name !== 'permission') || systemAdministrator)
  }, 'ui-jdcloud-login: administrator command policy')
  ctx.effect(() => {
    disposeTerminalFilter = ctx.sidebarRightTabs.registerAvailabilityFilter(kind => kind !== 'terminal')
    disposePluginPanelFilter = ctx.sidebarPanels.registerAvailabilityFilter(id => id !== 'plugins')
    return () => {
      disposeTerminalFilter?.()
      disposeTerminalFilter = undefined
      disposePluginPanelFilter?.()
      disposePluginPanelFilter = undefined
      disposeNewSessionInitializer?.()
      disposeNewSessionInitializer = undefined
    }
  }, 'ui-jdcloud-login: ordinary-user Session policy')
  ctx.effect(() => {
    const offRecord = ctx.remote.$on('credentials/record-updated', (key) => {
      if (!active || !String(key).startsWith(AUTH_RECORD_KEY)) return
      resetIdentityView()
      void refresh()
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
      disposeAdministratorShadows?.()
      disposeAdministratorShadows = undefined
    }
  }, 'ui-jdcloud-login: authentication gate')
}
