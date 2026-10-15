/** Ontology Remote mount and root-slot login lifecycle. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-ontology-auth-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  OntologyAuthStatus,
  OntologyRuntimeIdentity,
  OntologyRuntimeSessionTransfer,
} from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import { AccountSeat, type OntologyAccountInjected } from './AccountSeat.tsx'
import { OntologyBrandMark, OntologyBrandName } from './Brand.tsx'
import { EmbeddedSessionPage } from './EmbeddedSessionPage.tsx'
import { LoginPage, type OntologyLoginInjected } from './LoginPage.tsx'
import { en, NS, zh } from './locales.ts'

const AUTH_LOGIN_RECORD_PREFIX = 'ontology-auth-controller/login-'
const BRAND_PRIORITY = -10
const SESSION_MESSAGE_VERSION = 1

interface RuntimeSessionMessage {
  readonly type: 'ontology/runtime-session'
  readonly version: 1
  readonly nonce: string
  readonly session: OntologyRuntimeSessionTransfer
}

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

/** Import one Runtime Session only from the exact page that embedded this Harness document. */
function installRuntimeSessionBridge(
  ctx: ClientContext,
  applyStatus: (status: OntologyAuthStatus) => void,
  resetIdentityView: () => void,
  parentOrigin: string | undefined,
): () => void {
  if (parentOrigin === undefined) return () => undefined
  let active = true
  let handledNonce: string | undefined
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (!active || event.source !== window.parent || event.origin !== parentOrigin) return
    const message = readRuntimeSessionMessage(event.data)
    if (message === undefined || message.nonce === handledNonce) return
    handledNonce = message.nonce
    void ctx.remote.ontologyAuth.importSession(message.session).then((result) => {
      if (!active) return
      if (result.ok) {
        resetIdentityView()
        applyStatus(result.value)
      }
      window.parent.postMessage({
        type: 'ontology/runtime-session-result',
        version: SESSION_MESSAGE_VERSION,
        nonce: message.nonce,
        ok: result.ok,
      }, parentOrigin)
    })
  }
  window.addEventListener('message', handleMessage)
  window.parent.postMessage({
    type: 'ontology/runtime-session-ready',
    version: SESSION_MESSAGE_VERSION,
  }, parentOrigin)
  return () => {
    active = false
    window.removeEventListener('message', handleMessage)
  }
}

/** Resolve the exact embedding origin used by the Runtime Session bridge. */
function resolveParentOrigin(): string | undefined {
  if (window.parent === window || document.referrer === '') return undefined
  try {
    return new URL(document.referrer).origin
  } catch {
    return undefined
  }
}

/** Validate the token-bearing payload at the browser message boundary. */
function readRuntimeSessionMessage(value: unknown): RuntimeSessionMessage | undefined {
  if (!isRecord(value)
    || value.type !== 'ontology/runtime-session'
    || value.version !== SESSION_MESSAGE_VERSION) return undefined
  const nonce = nonEmptyString(value.nonce)
  const session = readRuntimeSession(value.session)
  if (nonce === undefined || session === undefined) return undefined
  return { type: 'ontology/runtime-session', version: SESSION_MESSAGE_VERSION, nonce, session }
}

/** Validate Runtime tokens and identity without retaining the incoming message object. */
function readRuntimeSession(value: unknown): OntologyRuntimeSessionTransfer | undefined {
  if (!isRecord(value)) return undefined
  const accessToken = nonEmptyString(value.accessToken)
  const accessTokenExpiresAt = timestamp(value.accessTokenExpiresAt)
  const refreshToken = nonEmptyString(value.refreshToken)
  const refreshTokenExpiresAt = timestamp(value.refreshTokenExpiresAt)
  const user = readRuntimeIdentity(value.user)
  if (accessToken === undefined || accessTokenExpiresAt === undefined
    || refreshToken === undefined || refreshTokenExpiresAt === undefined || user === undefined) return undefined
  return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, user }
}

/** Validate the identity snapshot paired with transferred Runtime tokens. */
function readRuntimeIdentity(value: unknown): OntologyRuntimeIdentity | undefined {
  if (!isRecord(value)) return undefined
  const userId = nonEmptyString(value.userId)
  const username = nonEmptyString(value.username)
  const displayName = nonEmptyString(value.displayName)
  const accountType = value.accountType
  const authorizationVersion = nonEmptyString(value.authorizationVersion)
  if (userId === undefined || username === undefined || displayName === undefined
    || (accountType !== 'admin' && accountType !== 'member') || authorizationVersion === undefined) return undefined
  return { userId, username, displayName, accountType, authorizationVersion }
}

/** Identify one non-array message record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one required non-empty string. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one required RFC 3339-compatible timestamp. */
function timestamp(value: unknown): string | undefined {
  const text = nonEmptyString(value)
  return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined
}

/**
 * Install the guarded root and react to current-browser credential changes.
 * @param ctx - Client context carrying Remote, slot, locale, and Workspace services.
 */
export function installOntologyLoginUi(ctx: ClientContext): void {
  let active = true
  let disposeGate: (() => void) | undefined
  let disposeAccount: (() => void) | undefined
  const embedded = window.parent !== window
  const parentOrigin = resolveParentOrigin()

  const resetIdentityView = (): void => {
    if (active) ctx.uiWorkspace.clearSelection()
  }

  const hideGate = (): void => {
    disposeGate?.()
    disposeGate = undefined
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
      hideGate()
      showAccount(status)
      return
    }
    hideAccount()
    showGate()
  }

  const showGate = (): void => {
    if (!active || disposeGate !== undefined) return
    const registration = {
      name: 'root' as const,
      priority: -100,
      locale: NS,
    } as const
    if (embedded) {
      disposeGate = ctx.slots.register(registration, EmbeddedSessionPage)
      return
    }
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
    disposeGate = ctx.slots.register({
      ...registration,
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
    showGate()
    return () => {
      active = false
      offRecord()
      hideGate()
      hideAccount()
    }
  }, 'ui-ontology-login: authentication gate')
  ctx.effect(
    () => installRuntimeSessionBridge(ctx, applyStatus, resetIdentityView, parentOrigin),
    'ui-ontology-login: embedded Runtime Session bridge',
  )
}
