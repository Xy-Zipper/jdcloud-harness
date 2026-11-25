/** Inline knowledge citations, their result cards, and the original file preview. */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, MarkdownText, Modal, StateDot, markdownProseRuns, useClipboardCopy, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PdfExcerptLocator } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OntologyKnowledgeSource } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import { knowledgeRequest } from './knowledge-api.ts'
import css from './Knowledge.module.css'

type Localized = PropsLocale<'ontology.login'>
type PreviewLocation = { readonly locatePage?: PdfExcerptLocator | undefined }
const rememberedPagesKey = 'dsh.ontology.citation-pages.v1'

/** Sources are ordered by their first citation, and index selects one of them. */
export interface KnowledgeSelection {
  readonly sources: readonly OntologyKnowledgeSource[]
  readonly index: number
  readonly answerText?: string | undefined
}

/** Open the native results tab, or its dialog in views without the application shell. */
export function KnowledgeCitation({ selection, onOpen, locatePage, t }: Localized & PreviewLocation & {
  selection: KnowledgeSelection
  onOpen?: ((selection: KnowledgeSelection) => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const source = selection.sources[selection.index]
  if (source === undefined) return null
  return (
    <>
      <Button size="sm" className={css.citation} title={source.fileName}
        aria-haspopup={onOpen === undefined ? 'dialog' : undefined}
        onClick={() => {
          if (onOpen === undefined) setOpen(true)
          else onOpen(selection)
        }}>
        {t('knowledgeFragment', { number: String(selection.index + 1) })}
      </Button>
      {open && <Modal open title={t('knowledgeSources')} closeLabel={t('knowledgeClose')} onClose={() => { setOpen(false) }}
        className={css.drawer ?? ''} contentClassName={css.scroll ?? ''} backdropBlur={false}>
        <KnowledgeResults selection={selection} locatePage={locatePage} t={t} />
      </Modal>}
    </>
  )
}

/** Open a verified document link with the same authorized preview as a fragment. */
export function KnowledgeFileLink({ source, children, answerText, locatePage, t }: Localized & PreviewLocation & {
  source: OntologyKnowledgeSource
  children: readonly ReactNode[]
  answerText?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={css.originalLink} aria-haspopup="dialog" onClick={() => { setOpen(true) }}>
      {children}
    </button>
    {open && <SourcePreview source={source} answerText={answerText} locatePage={locatePage} close={() => { setOpen(false) }} t={t} />}
  </>
}

/** The standalone Skill returns ordered sources separately from its answer text. */
export function KnowledgeSources({ sources, answerText, locatePage, t }: Localized & PreviewLocation & {
  sources: readonly OntologyKnowledgeSource[]
  answerText?: string | undefined
}) {
  if (sources.length === 0) return null
  return (
    <section className={css.sources} aria-label={t('knowledgeSources')}>
      {sources.map((source, index) => <KnowledgeCitation key={source.citationId}
        selection={{ sources, index, answerText }} locatePage={locatePage} t={t} />)}
    </section>
  )
}

/** Show all references in this reply and keep the currently cited card in view. */
export function KnowledgeResults({ selection, revision = 0, visible = true, locatePage, t }: Localized & PreviewLocation & {
  selection: KnowledgeSelection
  revision?: number
  visible?: boolean
}) {
  const [localSelection, setLocalSelection] = useState<{ index: number; revision: number }>()
  const selected = localSelection?.revision === revision ? localSelection.index : selection.index
  const [preview, setPreview] = useState<{ source: OntologyKnowledgeSource; page: number | undefined; answerText: string | undefined }>()
  const [located, setLocated] = useState<{ source: OntologyKnowledgeSource; page: number; answerText: string | undefined }>()
  const onLocated = useCallback((page: number) => {
    if (preview !== undefined) setLocated({ ...preview, page })
  }, [preview])
  const results = useRef<HTMLElement>(null)
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('knowledgeCopyValue'), copiedLabel: t('knowledgeCopied') },
    footnotes: t('knowledgeFootnotes'),
  }), [t])
  useLayoutEffect(() => {
    const panel = results.current
    if (panel === null || !visible) return
    // A navigation revision also refocuses a citation the user clicked before.
    // Align the heading inside this list after the new cards have been laid out.
    const frame = requestAnimationFrame(() => {
      const card = panel.querySelector('[data-active]')
      if (card === null) return
      const inset = Number.parseFloat(getComputedStyle(panel).paddingBlockStart) || 0
      panel.scrollTop += card.getBoundingClientRect().top - panel.getBoundingClientRect().top - inset
    })
    return () => { cancelAnimationFrame(frame) }
  }, [localSelection, revision, selected, selection.sources, visible])

  return (
    <section ref={results} className={css.results} aria-label={t('knowledgeSources')}>
      {selection.sources.map((source, index) => {
        const page = located?.source === source && located.answerText === selection.answerText ? located.page : source.page
        return <KnowledgeResult key={source.citationId} source={source} index={index} selected={index === selected} page={page}
          labels={labels} select={() => { setLocalSelection({ index, revision }) }} open={() => {
            setLocalSelection({ index, revision })
            setPreview({ source, page, answerText: selection.answerText })
          }} t={t} />
      })}
      {preview !== undefined && <SourcePreview key={preview.source.citationId} source={preview.source} answerText={preview.answerText}
        initialPage={preview.page} onLocated={onLocated} locatePage={locatePage}
        close={() => { setPreview(undefined) }} t={t} />}
    </section>
  )
}

function KnowledgeResult({ source, index, selected, page, labels, select, open, t }: Localized & {
  source: OntologyKnowledgeSource
  index: number
  selected: boolean
  page: number | undefined
  labels: MarkdownLabels
  select: () => void
  open: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const [empty, setEmpty] = useState(false)
  const excerptId = useId()
  const excerpt = useRef<HTMLDivElement>(null)
  const { copied, onCopy } = useClipboardCopy(source.text)
  useLayoutEffect(() => {
    const box = excerpt.current
    const markdown = box?.firstElementChild
    if (box === null || markdown == null) return
    // Measure the rendered Markdown so narrow panels and short tables can expand too.
    const measure = () => {
      // Some extracts hold only an image path that is available in the original file.
      setEmpty(!markdown.textContent?.trim() && markdown.querySelector('img') === null)
      if (!expanded) setClipped(box.scrollHeight > box.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    observer.observe(markdown)
    return () => { observer.disconnect() }
  }, [expanded, source.text])
  return (
    <article className={css.result} aria-label={source.fileName} data-active={selected || undefined}>
      <header className={css.sourceLocation}>
        <Button size="sm" className={css.citation} aria-pressed={selected} onClick={select}>
          {t('knowledgeFragment', { number: String(index + 1) })}
        </Button>
        {page !== undefined && <span>{t('knowledgePage', { page: String(page) })}</span>}
      </header>
      <h3 className={css.fileName}>{source.fileName}</h3>
      <div id={excerptId} ref={excerpt} className={css.quote} data-clipped={!expanded && clipped || undefined}
        data-collapsed={!expanded || undefined}>
        <MarkdownText text={source.text} labels={labels} variant="compact" omitHtml />
        {empty && <p className={css.emptyQuote}>{t('knowledgeExcerptEmpty')}</p>}
      </div>
      {(clipped || expanded) && <Button size="sm" className={css.expand} aria-controls={excerptId}
        aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>
        {t(expanded ? 'knowledgeCollapse' : 'knowledgeExpand')}
      </Button>}
      <div className={css.resultActions}>
        <Button size="sm" variant="outline" onClick={open}>{t('knowledgeOpenFile')}</Button>
        <Button size="sm" variant="outline" onClick={onCopy} disabled={copied}>
          {t(copied ? 'knowledgeCopied' : 'knowledgeCopy')}
        </Button>
      </div>
      <details className={css.referenceDetails}>
        <summary>{t('knowledgeReferenceDetails')}</summary>
        <dl className={css.sourceKeys}>
          <dt>{t('knowledgeBaseKey')}</dt><dd>{source.knowledgeBaseId}</dd>
          <dt>{t('knowledgeDocumentKey')}</dt><dd>{source.documentId}</dd>
          {source.nodeIds.length > 0 && <><dt>{t('knowledgeNodes')}</dt><dd>{source.nodeIds.join(' · ')}</dd></>}
        </dl>
      </details>
    </article>
  )
}

/** Pick source passages quoted in the reply when the retrieved fragment spans multiple pages. */
function locationProse(text: string, answerText?: string): string[] {
  const runs = [...markdownProseRuns(text)]
  if (answerText === undefined) return runs
  const fold = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')
  const answer = fold([...markdownProseRuns(answerText)].join(''))
  const matched = runs.filter((run) => {
    const value = fold(run)
    for (let start = 0; start + 12 <= value.length; start += 3) {
      if (answer.includes(value.slice(start, start + 12))) return true
    }
    return false
  })
  return matched.length === 0 ? runs : matched
}

/** Identify the matched passage in an immutable PDF without storing its text. */
async function pdfPassageKey(source: OntologyKnowledgeSource, prose: readonly string[]): Promise<string | undefined> {
  const value = JSON.stringify([source.projectId, source.fileId, source.knowledgeBaseId, source.documentId, source.chunkId, prose])
  const hash = await globalThis.crypto?.subtle?.digest('SHA-256', new TextEncoder().encode(value))
  return hash === undefined ? undefined : Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Keep confirmed pages for this browser tab, including reloads. */
function rememberedPdfPage(key: string | undefined, page?: number): number | undefined {
  if (key === undefined) return
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(rememberedPagesKey) ?? '{}')
    const entries = typeof value === 'object' && value !== null ? Object.entries(value) : []
    if (page !== undefined) {
      const recent = entries.filter(([id]) => id !== key).slice(-63)
      sessionStorage.setItem(rememberedPagesKey, JSON.stringify(Object.fromEntries([...recent, [key, page]])))
      return page
    }
    const candidate: unknown = entries.find(([id]) => id === key)?.[1]
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return candidate
  } catch (_storageUnavailable) {
    return undefined
  }
}

/** Resolve a page for the indexed PDF or a search position for an older slice. */
async function originalLocation(
  source: OntologyKnowledgeSource, prose: readonly string[], signal: AbortSignal,
): Promise<{ page?: number; position?: number }> {
  const response = await knowledgeRequest(`files/${source.projectId}/${source.fileId}/page-location`, signal, {
    knowledgeBaseId: source.knowledgeBaseId, documentId: source.documentId, chunkId: source.chunkId,
    excerpts: prose.slice(0, 12).map(value => [...value].slice(0, 300).join('')), nodeIds: source.nodeIds.slice(0, 128),
  })
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null) return {}
  const page: unknown = Reflect.get(value, 'page')
  const position: unknown = Reflect.get(value, 'position')
  return {
    ...(typeof page === 'number' && Number.isSafeInteger(page) && page > 0 ? { page } : {}),
    ...(typeof position === 'number' && position >= 0 && position <= 1 ? { position } : {}),
  }
}

/** Open at the stored page and search the authorized original when the citation has no page. */
function SourcePreview({ source, close, answerText, initialPage = source.page, onLocated, locatePage, t }: Localized & PreviewLocation & {
  source: OntologyKnowledgeSource
  close: () => void
  answerText?: string | undefined
  initialPage?: number | undefined
  onLocated?: ((page: number) => void) | undefined
}) {
  const [file, setFile] = useState<{ url: string; page: number | undefined; locating: boolean }>()
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const csv = source.mediaType === 'text/csv'
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    void (async () => {
      try {
        const missingPage = !csv && initialPage === undefined
        const originalPDF = source.mediaType === 'application/pdf'
        const prose = missingPage && (originalPDF || locatePage !== undefined) ? locationProse(source.text, answerText) : []
        const passageKey = missingPage && originalPDF && locatePage !== undefined && prose.length > 0
          ? await pdfPassageKey(source, prose).catch(() => undefined) : undefined
        controller.signal.throwIfAborted()
        const knownPage = initialPage ?? rememberedPdfPage(passageKey)
        // Resolve the stored page in parallel with the preview bytes before mounting the PDF frame.
        const location = knownPage === undefined && originalPDF
          ? originalLocation(source, prose, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])).catch(() => undefined)
          : undefined
        const response = await knowledgeRequest(
          `files/${source.projectId}/${source.fileId}/${csv ? 'content' : 'preview'}`, controller.signal,
        )
        const data = await response.blob()
        const { page: storedPage, position } = await location ?? {}
        controller.signal.throwIfAborted()
        if (data.type.split(';', 1)[0] !== (csv ? 'text/csv' : 'application/pdf')) throw new Error('Unexpected preview media type')
        objectUrl = URL.createObjectURL(data)
        const page = knownPage ?? storedPage
        const locating = missingPage && page === undefined && locatePage !== undefined
        setFile({ url: objectUrl, page, locating })
        if (page !== undefined && missingPage) onLocated?.(page)
        if (locating) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
          const foundPage = await locatePage(new Uint8Array(await data.arrayBuffer()), prose, signal, position).catch(() => undefined)
          controller.signal.throwIfAborted()
          setFile({ url: objectUrl, page: foundPage, locating: false })
          if (foundPage !== undefined) {
            rememberedPdfPage(passageKey, foundPage)
            onLocated?.(foundPage)
          }
        }
      } catch (_error) {
        if (!controller.signal.aborted) setError(true)
      }
    })()
    return () => {
      controller.abort()
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [source, csv, answerText, initialPage, attempt, locatePage, onLocated])

  // Use the citation destination in both the embedded viewer and the footer action.
  const destination = file === undefined ? '' : file.url + (file.page === undefined || csv ? '' : `#page=${String(file.page)}`)

  return (
    <Modal open title={source.fileName} closeLabel={t('knowledgeClose')} onClose={close}
      className={csv ? css.editor ?? '' : css.preview ?? ''} contentClassName={css.scroll ?? ''}
      footer={!csv && file !== undefined && !error ? (
        <Button size="sm" variant="primary" onClick={() => { window.open(destination, '_blank', 'noopener,noreferrer') }}>
          {t('knowledgeNewTab')}
        </Button>
      ) : undefined}>
      {error ? <div className={css.previewNotice}>
        <p role="alert" className={css.error}>{t('knowledgeFileError')}</p>
        <Button size="sm" variant="outline" onClick={() => {
          setError(false)
          setAttempt(attempt + 1)
        }}>{t('knowledgeRetry')}</Button>
      </div>
        : file === undefined ? <div className={css.previewNotice} role="status" aria-label={t('knowledgeLoading')}>
          <StateDot state="ongoing" size={28} />
        </div>
          : csv ? <div>
            <a className={css.link} href={file.url} target="_blank" rel="noreferrer" download={source.fileName}>
              {t('knowledgeDownload')}
            </a>
          </div>
            : <div className={css.previewContent}>
              <span className={css.previewPage} aria-live="polite">{file.locating ? t('knowledgeLocatingPage')
                : file.page === undefined ? t('knowledgePageUnavailable') : t('knowledgePage', { page: String(file.page) })}</span>
              <iframe key={destination} className={css.document} title={source.fileName} src={destination} />
            </div>}
    </Modal>
  )
}
