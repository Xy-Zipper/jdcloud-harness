/** Browser plugin for selecting one writable JDCloud function before a new conversation. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller/remote'
import type {
  JdcloudWritableMenu,
} from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InputTriggerServiceContract,
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LowcodeActionPicker } from './LowcodeActionPicker.tsx'
import { en, NS, zh, type JdcloudLowcodeActionKey } from './locales.ts'
import type { WritableMenuPickerInjected, WritableMenuState } from './types.ts'

const AUTH_RECORD_KEY = 'jdcloud-auth-controller/login'
const SOURCE = 'jdcloud-lowcode-function'

interface FunctionReference {
  readonly corpId: string
  readonly menuId: string
  readonly label: string
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for JDCloud writable-menu selection and stale-tag errors. */
    'jdcloud.lowcodeActions': JdcloudLowcodeActionKey
  }
}

/** Services required by the menu Remote, input reference codec, and dock contribution. */
export const inject = [
  'inputTriggers',
  'sessions',
  'slots',
  'locale',
  'remote',
  'remote.jdcloudAuth',
]

/** Register the writable-menu loader, single-select dock, and structured reference codec. */
export function apply(ctx: ClientContext): void {
  const menuState = createSnapshotStore<WritableMenuState>({ phase: 'loading', menus: [] })
  const sessions = ctx.get('sessions') as ISessions
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const t = ctx.locale.bind(NS)
  let request = 0
  let abort: AbortController | undefined

  /** Refresh one authenticated menu projection while discarding superseded replies. */
  const refresh = async (): Promise<void> => {
    const current = ++request
    abort?.abort()
    const operation = new AbortController()
    abort = operation
    menuState.set({ phase: 'loading', menus: [] })
    const result = await ctx.remote.jdcloudAuth.writableMenus(operation.signal)
    if (current !== request || operation.signal.aborted) return
    menuState.set(result.ok
      ? {
        phase: 'ready',
        corpId: result.value.corpId,
        baseUrl: result.value.baseUrl,
        menus: result.value.menus,
      }
      : { phase: 'error', menus: [] })
  }

  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE,
    showGroupTitle: false,
    candidates: (_session, { query, quoted }) => {
      const snapshot = menuState.getSnapshot()
      if (quoted === true || snapshot.phase !== 'ready') return Promise.resolve([])
      const needle = query.toLocaleLowerCase()
      return Promise.resolve(snapshot.menus
        .filter(menu => needle === ''
          || menu.fullName.toLocaleLowerCase().includes(needle)
          || menu.path.toLocaleLowerCase().includes(needle))
        .map(menu => ({
          name: menu.fullName,
          description: menu.path,
          section: t('forms'),
          value: functionReference(snapshot.corpId, menu).ref,
        })))
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      const selected = parseReference(candidate.value, t)
      return {
        insert: {
          source: SOURCE,
          ref: candidate.value,
          label: selected.label,
          clipboardText: `@${selected.label}`,
        },
      }
    },
    codec: {
      clipboardText(ref) {
        return `@${parseReference(ref, t).label}`
      },
      async serialize(ref, signal) {
        const selected = parseReference(ref, t)
        const result = await ctx.remote.jdcloudAuth.writableMenus(signal)
        if (!result.ok || result.value.corpId !== selected.corpId) throw new Error(t('unavailable'))
        const menu = result.value.menus.find(candidate => candidate.menuId === selected.menuId)
        if (menu === undefined) throw new Error(t('unavailable'))
        return renderSelectedFunction(menu)
      },
    },
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jdcloud-lowcode-actions: dictionaries')
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-jdcloud-lowcode-actions: reference source')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'jdcloud-lowcode-actions',
    order: -10,
    locale: NS,
    inject: (sessionId: SessionId): WritableMenuPickerInjected => {
      // Each new Session gets a current-tenant menu projection even if login completed before event forwarding began.
      void refresh()
      return {
        hooks: { writableMenus: menuState },
        selectMenu: (menu, draftRev) => {
          const actx = sessions.scope(sessionId)
          if (actx === undefined) return false
          const snapshot = menuState.getSnapshot()
          if (snapshot.phase !== 'ready'
            || !snapshot.menus.some(candidate => candidate.menuId === menu.menuId)) return false
          const reference = functionReference(snapshot.corpId, menu)
          return actx.bail(actx, 'slash/input-insert-reference', {
            reference,
            span: { start: 0, end: 0, draftRev },
          }) === true
        },
      }
    },
  }, LowcodeActionPicker))
  ctx.on('connection/reset', () => { void refresh() })
  ctx.effect(() => {
    const offRecord = ctx.remote.$on('credentials/record-updated', (key) => {
      if (String(key).startsWith(AUTH_RECORD_KEY)) void refresh()
    })
    void refresh()
    return () => {
      request += 1
      abort?.abort()
      offRecord()
    }
  }, 'ui-jdcloud-lowcode-actions: menu refresh')
}

/** Build the reference payload cached by the editor chip. */
function functionReference(corpId: string, menu: JdcloudWritableMenu): ReferenceInsert {
  const ref = JSON.stringify({ corpId, menuId: menu.menuId, label: menu.fullName } satisfies FunctionReference)
  return {
    source: SOURCE,
    ref,
    label: menu.fullName,
    clipboardText: `@${menu.fullName}`,
  }
}

/** Parse the plugin-owned persisted reference before it reaches a Remote request. */
function parseReference(
  value: string,
  t: (key: JdcloudLowcodeActionKey) => string,
): FunctionReference {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(t('invalidReference'))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(t('invalidReference'))
  }
  const corpId: unknown = Reflect.get(parsed, 'corpId')
  const menuId: unknown = Reflect.get(parsed, 'menuId')
  const label: unknown = Reflect.get(parsed, 'label')
  if (typeof corpId !== 'string' || corpId === ''
    || typeof menuId !== 'string' || menuId === ''
    || typeof label !== 'string' || label === '') {
    throw new Error(t('invalidReference'))
  }
  return { corpId, menuId, label }
}

/** Render the Host-refreshed selection as a durable transcript reference. */
function renderSelectedFunction(menu: JdcloudWritableMenu): string {
  return `@[${menu.fullName}](dsh-reference:${SOURCE}/${menu.menuId})`
}
