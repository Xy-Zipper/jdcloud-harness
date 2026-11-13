/** Compact project conversation using the native transcript, composer, and attachment flow. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OntologyModelingContext } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModelingConversation.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Native conversation scoped to the modeling panel's selected Session. */
    'ontology.modeling.conversation': { kind: 'single'; scope: 'session-maybe' }
  }
}

/** Registration-owned navigation and startup state for one imported Project. */
export interface ModelingConversationInjected {
  readonly context: OntologyModelingContext
  readonly newSession: () => Promise<void>
  readonly openSession: (id: string) => void
  readonly retry: () => void
  readonly hooks: {
    readonly modeling: {
      getSnapshot(): {
        readonly loading: boolean
        readonly error: string | null
        readonly workspaceId: string | undefined
      }
      subscribe(listener: () => void): () => void
    }
  }
}

type ModelingRootProps = PropsRuntime<'root'>
  & PropsRenderSlots<'ontology.modeling.conversation'>
  & PropsLocale<'ontology.login'>
  & InjectFace<ModelingConversationInjected>

/** Render project history and actions without the standalone application navigation. */
export function ModelingConversation(props: ModelingRootProps) {
  const { context, newSession, openSession, retry, useModeling, useSessions, useWorkspaces, renderSlot, t } = props
  const state = useModeling(value => value)
  const sessions = useSessions(value => value)
  const workspaces = useWorkspaces(value => value)
  const workspace = workspaces.items.find(item => item.workspaceId === state.workspaceId)
  const ids = sessions.ids.filter(id => workspace?.sessionIds.includes(id)
    && !workspaces.archivedSessionIds.includes(id))
  const selected = ids.find(id => (sessions.byId[id]?.retainedBy.mainView ?? 0) > 0)
  // Blank sessions stay available to the composer without becoming duplicate history entries.
  const history = ids.filter(id => !sessions.byId[id]?.blank)
  return (
    <main className={css.root} aria-label={t('modelingTitle')}>
      <header className={css.header}>
        <div className={css.project}>
          <strong>{t('modelingTitle')}</strong>
          <span title={context.projectName}>{context.projectName}</span>
        </div>
        <select
          className={css.history}
          aria-label={t('modelingHistory')}
          value={selected !== undefined && history.includes(selected) ? selected : ''}
          onChange={(event) => { openSession(event.target.value) }}
          disabled={state.loading}
        >
          <option value="" disabled>{t('modelingHistory')}</option>
          {history.map(id => (
            <option key={id} value={id}>
              {sessions.byId[id]?.displayTitle ?? id}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          disabled={state.loading}
          onClick={() => { void newSession() }}
        >
          {t('modelingNew')}
        </Button>
      </header>
      {state.error === null ? null : (
        <div className={css.notice} role="alert">
          <span>{state.error}</span>
          <Button variant="ghost" onClick={retry}>{t('modelingRetry')}</Button>
        </div>
      )}
      {state.loading
        ? <div className={css.loading} role="status">{t('modelingLoading')}</div>
        : renderSlot('ontology.modeling.conversation', {})}
    </main>
  )
}

function ModelingViews({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', { view: 'chat' })
}

type ModelingContentProps = PropsRuntime<'ontology.modeling.conversation'> & PropsRenderFactories

/** Keep the native composer docked below a Chat view, including a blank new conversation. */
export function ModelingConversationContent({ renderFactorySlot }: ModelingContentProps) {
  return renderFactorySlot('conversation.content', {
    variant: 'embedded', phase: 'active', hero: false,
  }, { slots: { views: ModelingViews } })
}
