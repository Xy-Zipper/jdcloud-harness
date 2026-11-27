/** Render the closing answer's persisted RAGFlow references as inline citations. */

import { Fragment, useLayoutEffect, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { markdownBodyRuns, type MarkdownProseRenderer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PdfExcerptLocator } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { readOntologyKnowledgeSources, type OntologyKnowledgeSource } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { KnowledgeCitation, KnowledgeFileLink, KnowledgeResults, type KnowledgeSelection } from './KnowledgeSources.tsx'
import { NS } from './locales.ts'

const tabKind = 'ontologyKnowledge'
const tabId = '@deepseek-ai/dsh-client-ui-ontology-login/knowledge-results'
const turnDataKey = 'ontology-knowledge'
// Models may include the tool field name or a citation label inside the brackets.
const citation = /\[\s*(?:(?:引用|来源|出处|citation(?:Id)?|source)\s*[:：]?\s*)?(R-[a-f0-9]{10})\s*\]/giu
const titledDocument = /《[^《》\r\n]+》(?=[^《》\r\n]*?\bdocument[ \t]*id\b[ \t]*(?:[:：=][ \t]*)?(?:([a-z0-9_-]+)|$))/giu

type Reference = { kind: 'citation' | 'document' | 'link'; value: string }
type ProseReference = Reference & { index: number; text: string }

/** Match the title to the document ID printed alongside it, including in inline code. */
function proseReferences(value: string, followingCode?: string): ProseReference[] {
  const references: ProseReference[] = [...value.matchAll(citation)].map(match => ({
    kind: 'citation', value: (match[1] as string).toLowerCase(), index: match.index, text: match[0],
  }))
  for (const match of value.matchAll(titledDocument)) {
    const documentId = match[1] ?? followingCode
    if (documentId !== undefined) references.push({ kind: 'document', value: documentId, index: match.index, text: match[0] })
  }
  return references.sort((a, b) => a.index - b.index)
}

interface KnowledgeTurn {
  readonly turn: number
  readonly sources: readonly OntologyKnowledgeSource[]
  readonly earlier?: Readonly<KnowledgeTurn> | undefined
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Sources from this turn and earlier retrievals in the same session. */
    'ontology-knowledge': KnowledgeTurn
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The selected fragment and the other citations in the same reply. */
    ontologyKnowledge: { ontologyKnowledge: KnowledgeSelection }
  }
}

/** Project recorded document search results for reuse in follow-up answers. */
export const knowledgeTurn: ConversationNodeDefinition<KnowledgeTurn> = {
  kind: turnDataKey,
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)
      && event.data.meta !== null && typeof event.data.meta === 'object'
      && 'knowledgeSources' in event.data.meta) return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start(_context, { event }, reader) {
    if (event.type !== 'turn/start') throw new Error('ontology-knowledge requires turn/start')
    const previous = reader.previous<KnowledgeTurn>(turnDataKey)?.state
    // Share the earlier retrievals without copying their excerpts at each turn.
    const earlier = previous?.sources.length ? previous : previous?.earlier
    return { turn: event.data.turn, sources: [], earlier }
  },
  update({ state }, { event }) {
    if (event.type !== 'tool/result' || event.data.message.isError === true) return state
    const meta = event.data.meta
    const hits = typeof meta === 'object' && meta !== null ? readOntologyKnowledgeSources(Reflect.get(meta, 'knowledgeSources')) : undefined
    if (hits === undefined || hits.length === 0) return state
    const names = new Set(state.sources.map(source => source.citationId))
    return { ...state, sources: [...state.sources, ...hits.filter(source => !names.has(source.citationId))] }
  },
  buildLocationData({ state }, scope, previous) {
    if (scope !== 'turn' || state === undefined || (state.sources.length === 0 && state.earlier === undefined)) return null
    if (previous?.kind === 'turn' && previous.key === turnDataKey && previous.value === state) return previous
    return { kind: 'turn', turn: state.turn, key: turnDataKey, value: state }
  },
}

function KnowledgeResultsTab({ useTabInfo, locatePage, t }: PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS> & InjectFace<{ locatePage: PdfExcerptLocator }>) {
  const { tab: { actions, navigation, visible } } = useTabInfo()
  const { params } = navigation
  const selection = params !== undefined && 'ontologyKnowledge' in params ? params.ontologyKnowledge : undefined
  // A restored layout can contain this tab, but only a citation click supplies its selection.
  useLayoutEffect(() => {
    if (selection === undefined) actions.close()
  }, [actions, selection])
  if (selection === undefined) return null
  return <KnowledgeResults selection={selection} revision={navigation.revision}
    visible={visible} locatePage={locatePage} t={t} />
}

/**
 * Number verified references in the order they appear in the closing reply.
 * @param blocks - Closing assistant Markdown blocks in transcript order.
 * @param sources - Verified sources available to the answer, newest turn first.
 * @param t - Localized fragment labels.
 * @param onOpen - Native results navigation when the shell is present.
 * @param locatePage - Optional PDF locator for an embedded original-file preview.
 * @returns An inline renderer, or undefined when the reply cites none of these sources.
 */
export function createKnowledgeProse(
  blocks: readonly string[], sources: Iterable<OntologyKnowledgeSource>, t: PropsLocale<typeof NS>['t'],
  onOpen?: (selection: KnowledgeSelection) => void, locatePage?: PdfExcerptLocator,
): MarkdownProseRenderer | undefined {
  const references: Reference[] = []
  for (const block of blocks) {
    if (!block.includes('[') && !block.includes('《')) continue
    for (const run of markdownBodyRuns(block)) {
      if (run.kind === 'link') references.push({ kind: 'link', value: run.value })
      else references.push(...proseReferences(run.value, run.followingCode))
    }
  }
  if (references.length === 0) return undefined
  const byId = new Map<string, OntologyKnowledgeSource>()
  const byLink = new Map<string, OntologyKnowledgeSource>()
  for (const source of sources) {
    const id = source.citationId.toLowerCase()
    if (!byId.has(id)) byId.set(id, source)
    addFileLinks(byLink, source)
  }
  const explicit = new Set<OntologyKnowledgeSource>()
  const citedFiles = new Map<string, OntologyKnowledgeSource>()
  for (const reference of references) {
    if (reference.kind !== 'citation') continue
    const source = byId.get(reference.value)
    if (source === undefined) continue
    explicit.add(source)
    addFileLinks(citedFiles, source)
  }
  const sourceForLink = (url: string) => {
    const path = url.split(/[?#]/u, 1)[0] ?? ''
    return citedFiles.get(path) ?? byLink.get(path)
  }
  const byDocument = new Map<string, OntologyKnowledgeSource[]>()
  for (const source of byId.values()) {
    const matches = byDocument.get(source.documentId)
    if (matches === undefined) byDocument.set(source.documentId, [source])
    else matches.push(source)
  }
  // A document-level reference can select a chunk only when it is unique or explicitly cited.
  const resolve = ({ kind, value }: Reference): OntologyKnowledgeSource | undefined => {
    if (kind === 'citation') return byId.get(value)
    if (kind === 'link') return sourceForLink(value)
    const matches = byDocument.get(value) ?? []
    if (matches.length === 1) return matches[0]
    const marked = matches.filter(source => explicit.has(source))
    return marked.length === 1 ? marked[0] : undefined
  }
  const cited: OntologyKnowledgeSource[] = []
  const positions = new Map<OntologyKnowledgeSource, number>()
  for (const reference of references) {
    const source = resolve(reference)
    if (source === undefined || positions.has(source)) continue
    positions.set(source, cited.length)
    cited.push(source)
  }
  if (cited.length === 0) return undefined
  const answerText = blocks.join('\n\n')
  const fileReference = (source: OntologyKnowledgeSource, index: number, children: readonly ReactNode[], key?: number) => (
    <Fragment key={key}>
      <KnowledgeFileLink source={source} answerText={answerText} locatePage={locatePage} t={t}>{children}</KnowledgeFileLink>
      {!explicit.has(source) && <KnowledgeCitation selection={{ sources: cited, index, answerText }}
        onOpen={onOpen} locatePage={locatePage} t={t} />}
    </Fragment>
  )
  const decorate: MarkdownProseRenderer = (value, followingCode) => {
    const parts: ReactNode[] = []
    let cursor = 0
    for (const reference of proseReferences(value, followingCode)) {
      const source = resolve(reference)
      if (source === undefined || reference.index < cursor) continue
      const index = positions.get(source)
      if (index === undefined) continue
      parts.push(value.slice(cursor, reference.index), reference.kind === 'document'
        ? fileReference(source, index, [reference.text], reference.index)
        : <KnowledgeCitation key={reference.index}
          selection={{ sources: cited, index, answerText }} onOpen={onOpen} locatePage={locatePage} t={t} />)
      cursor = reference.index + reference.text.length
    }
    if (cursor === 0) return undefined
    parts.push(value.slice(cursor))
    return parts
  }
  decorate.link = (url, children) => {
    const source = sourceForLink(url)
    if (source === undefined) return undefined
    const index = positions.get(source)
    if (index === undefined) return undefined
    return fileReference(source, index, children)
  }
  return decorate
}

/** Match only file destinations carried by verified retrieval results. */
function addFileLinks(index: Map<string, OntologyKnowledgeSource>, source: OntologyKnowledgeSource): void {
  const path = '/api/projects/' + source.projectId + '/files/' + source.fileId
  for (const link of [source.fileId, path + '/content', path + '/preview']) {
    if (!index.has(link)) index.set(link, source)
  }
}

function* availableSources(state: Readonly<KnowledgeTurn>): Iterable<OntologyKnowledgeSource> {
  for (let turn: Readonly<KnowledgeTurn> | undefined = state; turn !== undefined; turn = turn.earlier) {
    yield* turn.sources
  }
}

/**
 * Register the Turn projection, inline renderer, and the native results tab.
 * @param ctx - Browser conversation, locale, and slot services.
 * @param compact - Whether the chat is embedded without the application shell.
 * @param locatePage - Reads the original PDF's text when a fragment has no recorded page.
 */
export function installKnowledgeCitations(ctx: Context, compact: boolean, locatePage: PdfExcerptLocator): void {
  ctx.effect(() => ctx.uiConversation.events.register(knowledgeTurn))
  const t = ctx.locale.bind(NS)
  if (!compact) ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs.register({ id: tabId, kind: tabKind, title: () => t('knowledgeSources') }))
    scope.effect(() => {
      const sidebar = scope.sidebarRight
      let sessionId = sidebar.mounted.getSnapshot()
      // Discard citation results when leaving their conversation so they cannot reopen on return.
      return sidebar.mounted.subscribe(() => {
        const previous = sessionId
        sessionId = sidebar.mounted.getSnapshot()
        if (previous === undefined) return
        for (const tab of sidebar.tabsIn(previous)) {
          if (tab.kind === tabKind) sidebar.closeIn(previous, tab.id)
        }
      })
    }, 'ontology: close citation results on Session navigation')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: tabId, locale: NS, inject: () => ({ locatePage }),
    }, KnowledgeResultsTab)))
  })

  ctx.provide('chatAssistantProse', {
    turnDataKey,
    forClosing({ turn }, sessionId) {
      const state = turn.data.get(turnDataKey)
      const closing = turn.data.get('turn-tail')?.closing
      if (state === undefined || closing == null) return undefined
      const blocks = closing.blocks.flatMap(block => block.kind === 'text' ? [block.text] : [])
      const sidebar = compact ? undefined : ctx.get('sidebarRight')
      return createKnowledgeProse(blocks, availableSources(state), t, sidebar === undefined ? undefined : (selection) => {
        sidebar.openTabIn(sessionId, tabKind, { params: { ontologyKnowledge: selection } })
      }, locatePage)
    },
  })
}
