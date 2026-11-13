/** Native Session navigation and committed draft-save notifications for one embedded Project. */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OntologyModelingContext } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  ModelingConversation, ModelingConversationContent, type ModelingConversationInjected,
} from './ModelingConversation.tsx'
import { NS } from './locales.ts'

/**
 * Mount one Project's private native conversation and release its listeners on teardown.
 * @param ctx - Client services for Session, Workspace, navigation, and slot composition.
 * @param context - Host-validated modeling Project selected by the management page.
 * @param parentOrigin - Exact parent origin that receives committed draft-save notifications.
 * @returns Disposer for the compact root and its selection and event listeners.
 */
export function installModelingConversation(
  ctx: Context,
  context: OntologyModelingContext,
  parentOrigin: string,
): () => void {
  const lifetime = new AbortController()
  let preparing: Promise<void> | undefined
  let workspaceId: Awaited<ReturnType<typeof ctx.workspaces.create>>['workspaceId'] | undefined
  const state = createSnapshotStore({
    loading: true, error: null as string | null, workspaceId: undefined as string | undefined,
  })
  const t = ctx.locale.bind(NS)
  const prepare = (fresh: boolean): Promise<void> => {
    if (preparing !== undefined) return preparing
    state.set({ loading: true, error: null, workspaceId })
    preparing = (async () => {
      try {
        const directory = await ctx.uiWorkspace.listDirectory(undefined, lifetime.signal)
        lifetime.signal.throwIfAborted()
        const workspace = await ctx.workspaces.create({ path: directory.path })
        lifetime.signal.throwIfAborted()
        workspaceId = workspace.workspaceId
        await ctx.sessions.refresh()
        lifetime.signal.throwIfAborted()
        const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds
        const existing = fresh ? undefined : ctx.sessions.list.getSnapshot().ids.find(id =>
          workspace.sessionIds.includes(id) && !archived.includes(id))
        // Native Workspace navigation reuses its blank Session instead of accumulating empty conversations.
        const id = existing ?? await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)
        lifetime.signal.throwIfAborted()
        ctx.uiWorkspace.openSession(id)
        state.set({ loading: false, error: null, workspaceId })
      } catch (error) {
        if (lifetime.signal.aborted) return
        state.set({
          loading: false, error: error instanceof Error ? error.message : t('modelingError'), workspaceId,
        })
      } finally {
        preparing = undefined
      }
    })()
    return preparing
  }
  const injected: ModelingConversationInjected = {
    context,
    hooks: { modeling: state },
    newSession: () => prepare(true),
    retry: () => { void prepare(false) },
    openSession: (id) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      const target = workspace?.sessionIds.find(candidate => String(candidate) === id)
      if (target !== undefined) ctx.uiWorkspace.openSession(target)
    },
  }
  const disposeRoot = ctx.slots.register({
    name: 'root',
    priority: -50,
    children: { 'ontology.modeling.conversation': { kind: 'single', scope: 'session-maybe' } },
    inject: () => injected,
    locale: NS,
  }, ModelingConversation)
  const disposeContent = ctx.slots.register({
    name: 'ontology.modeling.conversation',
  }, ModelingConversationContent)
  let selected: SessionId | undefined
  let disposeFeed = (): void => {}
  const observeSelection = (): void => {
    const sessions = ctx.sessions.list.getSnapshot()
    const next = sessions.ids.find(id => (sessions.byId[id]?.retainedBy.mainView ?? 0) > 0)
    if (selected === next) return
    disposeFeed()
    selected = next
    const feed = next === undefined ? undefined : ctx.sessions.binding(next)?.eventSource
    if (feed === undefined) return
    const calls = new Set<string>()
    let lastSeq = -1
    const consume = (entries: readonly SessionEventLikeEntry[], notify: boolean): void => {
      for (const entry of entries) {
        if (entry.type !== 'event') continue
        const event = entry.event
        const fresh = event.seq > lastSeq
        lastSeq = Math.max(lastSeq, event.seq)
        if (event.type === 'tool/call' && (event.data.name === 'ontology_add_draft_resources' || event.data.name === 'ontology_update_draft_bindings')) {
          calls.add(event.data.callId)
        }
        if (event.type !== 'tool/result'
          || !calls.delete(event.data.message.toolCallId)
          || event.data.message.isError === true || !notify || !fresh) continue
        window.parent.postMessage({
          type: 'ontology/draft-updated', version: 1, projectId: context.projectId,
        }, parentOrigin)
      }
    }
    consume(feed.getSnapshot().entries, false)
    disposeFeed = feed.subscribe(() => {
      if (lifetime.signal.aborted) return
      const window = feed.getSnapshot()
      if (window.change.kind === 'settle-assistant' || window.change.kind === 'prepend') return
      consume(window.change.entries, true)
    })
  }
  const disposeSelection = ctx.sessions.list.subscribe(observeSelection)
  observeSelection()
  void prepare(false)
  return () => {
    lifetime.abort()
    disposeSelection()
    disposeFeed()
    disposeContent()
    disposeRoot()
  }
}
