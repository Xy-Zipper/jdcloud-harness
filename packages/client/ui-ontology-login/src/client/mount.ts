/** Ontology Remote mount and root-slot login lifecycle. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-ontology-auth-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { OntologyAuthStatus } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import { AccountSeat, type OntologyAccountInjected } from './AccountSeat.tsx'
import { OntologyBrandMark, OntologyBrandName } from './Brand.tsx'
import { LoginPage, type OntologyLoginInjected } from './LoginPage.tsx'
import { en, NS, zh } from './locales.ts'

const AUTH_LOGIN_RECORD_PREFIX = 'ontology-auth-controller/login-'
const BRAND_PRIORITY = -10

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Ontology authentication-page copy. */
    'ontology.login': import('./locales.ts').OntologyLoginKey
  }
}

/** Services required after the generated Ontology Remote namespace is mounted. */
export const uiInject = ['remote', 'remote.ontologyAuth', 'slots', 'locale', 'uiWorkspace']

/** Install Ontology occupants ahead of generic and official brand fallbacks. */
function installOntologyBrand(ctx: ClientContext): () => void {
  const disposeSidebar = ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: BRAND_PRIORITY }, OntologyBrandMark)
      yield ctx.slots.register({
        name: 'sidebar.brand.name',
        priority: BRAND_PRIORITY,
        locale: NS,
      }, OntologyBrandName)
    }))
  const disposeHero = ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
    priority: BRAND_PRIORITY,
  }, OntologyBrandMark))
  return () => {
    disposeHero()
    disposeSidebar()
  }
}

/**
 * Install the guarded root and react to current-browser credential changes.
 * @param ctx - Client context carrying Remote, slot, locale, and Workspace services.
 */
export function installOntologyLoginUi(ctx: ClientContext): void {
  let active = true
  let disposeLogin: (() => void) | undefined
  let disposeAccount: (() => void) | undefined

  const resetIdentityView = (): void => {
    if (active) ctx.uiWorkspace.clearSelection()
  }

  const hideLogin = (): void => {
    disposeLogin?.()
    disposeLogin = undefined
  }

  const hideAccount = (): void => {
    disposeAccount?.()
    disposeAccount = undefined
  }

  const showAccount = (status: Extract<OntologyAuthStatus, { readonly authenticated: true }>): void => {
    if (!active) return
    hideAccount()
    const injected: OntologyAccountInjected = {
      status,
      logout: async () => {
        const result = await ctx.remote.ontologyAuth.logout()
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

  const applyStatus = (status: OntologyAuthStatus): void => {
    if (!active) return
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
    const injected: OntologyLoginInjected = {
      initialize: async () => {
        const result = await ctx.remote.ontologyAuth.status()
        if (!result.ok) return { ok: false, error: result.error.message }
        if (active) applyStatus(result.value)
        return { ok: true, authenticated: result.value.authenticated }
      },
      login: async (request) => {
        const result = await ctx.remote.ontologyAuth.login(request)
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

  const refresh = async (): Promise<void> => {
    if (!active) return
    const result = await ctx.remote.ontologyAuth.status()
    if (result.ok) applyStatus(result.value)
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ontology-login: dictionaries')
  ctx.effect(() => installOntologyBrand(ctx), 'ui-ontology-login: Ontology brand')
  ctx.effect(() => {
    const offRecord = ctx.remote.$on('credentials/record-updated', (key) => {
      // Resource ownership grants share the controller namespace but do not
      // change the current browser login or invalidate its selected Session.
      if (!active || !String(key).startsWith(AUTH_LOGIN_RECORD_PREFIX)) return
      resetIdentityView()
      void refresh()
    })
    showLogin()
    return () => {
      active = false
      offRecord()
      hideLogin()
      hideAccount()
    }
  }, 'ui-ontology-login: authentication gate')
}
