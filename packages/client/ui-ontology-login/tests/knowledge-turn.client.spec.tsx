// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { OntologyKnowledgeSource } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ConversationNodeAssembler, type ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeResults } from '../src/client/KnowledgeSources.tsx'
import { knowledgeRequest } from '../src/client/knowledge-api.ts'
import { createKnowledgeProse, knowledgeTurn } from '../src/client/knowledge-turn.tsx'
import { zh, type OntologyLoginKey } from '../src/client/locales.ts'

vi.mock('../src/client/knowledge-api.ts', () => ({ knowledgeRequest: vi.fn() }))

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

const t: PropsLocale<'ontology.login'>['t'] = (key, values) =>
  (zh[key as OntologyLoginKey] ?? key).replace(/\{(\w+)\}/gu, (token: string, name: string) => {
    const value = values?.[name]
    return typeof value === 'string' ? value : token
  })

const labels: MarkdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const first: OntologyKnowledgeSource = {
  citationId: 'R-0102030405', projectId: 'project-training', fileId: 'file-1', fileName: '操作手册.pdf',
  documentId: 'remote-document', knowledgeBaseId: 'training', chunkId: 'remote-chunk',
  mediaType: 'application/pdf', nodeIds: ['0000'], page: 4, text: '操作培训在会议室举行。'.repeat(24),
}
const second = { ...first, citationId: 'R-1112131415', fileId: 'file-2', fileName: '会议记录.pdf', text: '会议记录片段。' }
const uncited = { ...first, citationId: 'R-0000000000', fileName: '未引用.pdf' }

it('recovers a follow-up citation after the interrupted retrieval turn is prepended', () => {
  let current: ConversationTimelineSnapshot | undefined
  const target = 'citation-test'
  const assembler = new ConversationNodeAssembler(
    { entries: () => [knowledgeTurn], fallbackEntry: () => undefined },
    { entries: () => [{ target, create: () => ({
      empty: null,
      replace: ({ timeline }) => { current = timeline; return null },
      apply: ({ timeline }) => { current = timeline; return null },
    }) }] },
  )
  const entry = (seq: number, type: SessionEvent['type'], data: object, append = false) => ({
    type: 'event' as const,
    event: { seq: SessionSeq(seq), time: seq, type, data, ...(append ? { surfaceOp: 'append' } : {}) } as SessionEvent,
  })
  const earlier = [
    entry(1, 'turn/start', { turn: 1 }),
    entry(2, 'tool/result', { turn: 1, step: 1, message: { isError: false }, meta: { knowledgeSources: [first] } }, true),
    entry(3, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]
  const later = [
    entry(4, 'turn/start', { turn: 2 }),
    entry(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  assembler.activateTarget(target)
  assembler.replaceWindow(later, true)
  assembler.flush()
  const references = (turn: number) => current?.turns.get(turn)?.data.get('ontology-knowledge')
  expect(references(2)).toBeUndefined()
  assembler.prepend(earlier, false)
  assembler.flush()
  expect(references(2)?.earlier?.sources).toEqual([first])
  expect(references(1)?.earlier).toBeUndefined()
  assembler.replaceWindow([...earlier, ...later], false)
  assembler.flush()
  expect(references(2)?.earlier?.sources).toEqual([first])
})

it('numbers exact sources where they appear in the answer and reuses the label across Markdown blocks', () => {
  const answer = [
    '`[R-0000000000]` [查看 [R-0102030405]](https://example.com)\n\n'
      + '培训在会议室举行。[引用 R-1112131415][R-0102030405] 未知编号 [R-aaaaaaaaaa]',
    '| 事项 | 来源 |\n| --- | --- |\n| 培训 | [来源：r-1112131415] |',
  ]
  const open = vi.fn()
  const renderProse = createKnowledgeProse(answer, [first, second, uncited], t, open)
  render(<>{answer.map(text => <MarkdownText key={text} text={text} labels={labels} renderProse={renderProse} />)}</>)
  const tags = screen.getAllByRole('button', { name: /^片段 [12]$/u })
  expect(tags.map(tag => [tag.textContent, tag.parentElement?.tagName])).toMatchInlineSnapshot(`
    [
      [
        "片段 1",
        "P",
      ],
      [
        "片段 2",
        "P",
      ],
      [
        "片段 1",
        "TD",
      ],
    ]
  `)
  expect(screen.getByRole('link', { name: '查看 [R-0102030405]' }).querySelector('button')).toBeNull()
  expect(screen.getByText('[R-0000000000]').closest('code')).not.toBeNull()
  expect(screen.getByText(/未知编号 \[R-aaaaaaaaaa\]/u)).toBeDefined()
  // Existing answer text selection must not swallow a deliberate citation click.
  document.getSelection()?.selectAllChildren(tags[0]!.parentElement!)
  fireEvent.click(screen.getByRole('button', { name: '片段 2' }), { detail: 1 })
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ sources: [second, first], index: 1 }))
})

it('renders adjacent citationId markers with recorded sources as clickable fragments', () => {
  const text = '两份资料支持这项结论。[citationId:R-1112131415][citationId:R-0102030405] 未知编号 [citationId:R-aaaaaaaaaa]'
  const open = vi.fn()
  render(<MarkdownText text={text} labels={labels} renderProse={createKnowledgeProse([text], [first, second], t, open)} />)
  const tags = screen.getAllByRole('button', { name: /^片段 [12]$/u })
  expect(tags.map(tag => tag.textContent)).toEqual(['片段 1', '片段 2'])
  expect(screen.getByText(/未知编号 \[citationId:R-aaaaaaaaaa\]/u)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '片段 2' }))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ sources: [second, first], index: 1 }))
})

it('renders a verified document link as a fragment and opens its authenticated original', async () => {
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = () => 'blob:http://localhost/document-link'
    static override revokeObjectURL = () => {}
  })
  vi.mocked(knowledgeRequest).mockResolvedValue(new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }))
  const text = '来源：[操作手册.pdf](file-1) [网站](https://example.com/file-1)'
  const open = vi.fn()
  render(<MarkdownText text={text} labels={labels} renderProse={createKnowledgeProse([text], [first], t, open)} />)
  fireEvent.click(screen.getByRole('button', { name: '片段 1' }))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ sources: [first], index: 0 }))
  expect(screen.getByRole('link', { name: '网站' }).getAttribute('href')).toBe('https://example.com/file-1')
  fireEvent.click(screen.getByRole('button', { name: first.fileName }))
  const dialog = screen.getByRole('dialog', { name: first.fileName })
  expect((await within(dialog).findByTitle(first.fileName)).getAttribute('src')).toBe('blob:http://localhost/document-link#page=4')
  expect(knowledgeRequest).toHaveBeenCalledWith('files/project-training/file-1/preview', expect.any(AbortSignal))
})


it('opens the exact cited document when the source line names its ID as inline code', async () => {
  const source = { ...first, documentId: '74edf7c9c1684ec385840dd719d9a82a', page: 22 }
  const sameFile = { ...second, fileId: source.fileId, documentId: 'other-document', page: 6 }
  const sameDocument = { ...uncited, fileId: source.fileId, documentId: source.documentId, chunkId: 'other-chunk', page: 8 }
  const title = '《房产测量规范 第一单元 GB/T 17986.1-2000》'
  const text = '分户图用于表示房屋权属范围。[R-0102030405]\n\n'
    + '来源：' + title + '7.3.1、7.3.2（项目知识库，documentId ' + '\x60' + source.documentId + '\x60）。'
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = () => 'blob:http://localhost/document-id'
    static override revokeObjectURL = () => {}
  })
  vi.mocked(knowledgeRequest).mockResolvedValue(new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }))
  const open = vi.fn()
  render(<MarkdownText text={text} labels={labels} renderProse={createKnowledgeProse([text], [sameFile, sameDocument, source], t, open)} />)
  expect(screen.getAllByRole('button', { name: '片段 1' })).toHaveLength(1)
  expect(screen.getByText(source.documentId).tagName).toBe('CODE')
  fireEvent.click(screen.getByRole('button', { name: title }))
  const dialog = screen.getByRole('dialog', { name: source.fileName })
  expect((await within(dialog).findByTitle(source.fileName)).getAttribute('src')).toBe('blob:http://localhost/document-id#page=22')
  expect(knowledgeRequest).toHaveBeenCalledWith('files/project-training/file-1/preview', expect.any(AbortSignal))
})

it('numbers a verified document-only source and leaves unrecognized or fenced IDs inert', () => {
  const title = '《操作手册》'
  const text = [
    '来源：' + title + '（documentId remote-document）。',
    '来源：《其他文档》（documentId unknown-document）。',
    '\x60\x60\x60\n来源：《代码示例》（documentId remote-document）。\n\x60\x60\x60',
  ].join('\n\n')
  const open = vi.fn()
  render(<MarkdownText text={text} labels={labels} renderProse={createKnowledgeProse([text], [first], t, open)} />)
  expect(screen.getByRole('button', { name: title })).toBeDefined()
  expect(screen.queryByRole('button', { name: '《其他文档》' })).toBeNull()
  expect(screen.queryByRole('button', { name: '《代码示例》' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '片段 1' }))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ sources: [first], index: 0 }))
})

it('renders structured Markdown in a result before and after expanding it', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(140)
  const text = '## 招标状态\n\n- **招标中**\n- 已开标\n\n| 状态 | 数量 |\n| --- | --- |\n| 已开标 | 2 |\n\n![](images/local.png)\n\n<script>不可渲染</script>'
  render(<KnowledgeResults selection={{ sources: [{ ...first, text }], index: 0 }} t={t} />)
  expect(screen.getByRole('heading', { name: '招标状态' })).toBeDefined()
  expect(screen.getByText('招标中').tagName).toBe('STRONG')
  expect(screen.getByRole('table')).toBeDefined()
  expect(screen.queryByText(/images\/local|不可渲染/u)).toBeNull()
  const expand = screen.getByRole('button', { name: '展开片段' })
  const excerpt = document.getElementById(expand.getAttribute('aria-controls')!)
  expect(excerpt?.hasAttribute('data-collapsed')).toBe(true)
  fireEvent.click(expand)
  expect(screen.getByRole('button', { name: '收起片段' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('table')).toBeDefined()
  expect(excerpt?.hasAttribute('data-collapsed')).toBe(false)
})

it('points to the original when an excerpt contains only an unavailable document image', () => {
  const sources = [{ ...first, text: '![](images/local.png)' }]
  render(<KnowledgeResults selection={{ sources, index: 0 }} t={t} />)
  expect(screen.getByText('这段内容可在原文中查看')).toBeDefined()
  expect(screen.getByRole('button', { name: '查看原文' })).toBeDefined()
})

it('returns to the cited heading on each navigation while keeping the existing cards', async () => {
  const sources = [first, second]
  const renderResults = (revision: number, index: number) =>
    <KnowledgeResults selection={{ sources, index }} revision={revision} t={t} />
  const view = render(renderResults(1, 0))
  const results = screen.getByRole('region', { name: '检索结果' })
  const firstCard = screen.getByRole('article', { name: first.fileName })
  const secondCard = screen.getByRole('article', { name: second.fileName })
  vi.spyOn(results, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 320, 200))
  vi.spyOn(firstCard, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 10 - results.scrollTop, 320, 280))
  vi.spyOn(secondCard, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 300 - results.scrollTop, 320, 400))
  fireEvent.click(within(firstCard).getByText('引用信息'))

  view.rerender(renderResults(2, 1))
  await waitFor(() => { expect(results.scrollTop).toBe(290) })
  expect(within(secondCard).getByRole('button', { name: '片段 2', pressed: true })).toBeDefined()
  results.scrollTop = 495
  view.rerender(renderResults(3, 1))
  await waitFor(() => { expect(results.scrollTop).toBe(290) })
  view.rerender(renderResults(4, 0))
  await waitFor(() => { expect(results.scrollTop).toBe(0) })
  expect(within(firstCard).getByText('引用信息').parentElement?.hasAttribute('open')).toBe(true)
})

it('selects the matching result and opens the authenticated original at the cited page', async () => {
  const createObjectURL = vi.fn(() => 'blob:http://localhost/test-document')
  const revokeObjectURL = vi.fn()
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL
    static override revokeObjectURL = revokeObjectURL
  })
  vi.mocked(knowledgeRequest).mockResolvedValue(new Response('%PDF-1.4', {
    headers: { 'content-type': 'application/pdf' },
  }))
  render(<KnowledgeResults selection={{ sources: [second, first], index: 1 }} t={t} />)
  const results = screen.getByRole('region', { name: '检索结果' })
  const card = within(results).getByRole('article', { name: '操作手册.pdf' })
  expect(within(card).getByRole('button', { name: '片段 2' }).getAttribute('aria-pressed')).toBe('true')
  expect(within(card).getByText('第 4 页')).toBeDefined()
  expect(knowledgeRequest).not.toHaveBeenCalled()
  fireEvent.click(within(card).getByText('引用信息'))
  expect(within(card).getByText(first.documentId)).toBeDefined()
  expect(within(card).getByText(first.text)).toBeDefined()
  fireEvent.click(within(card).getByRole('button', { name: '查看原文' }))
  const preview = screen.getByRole('dialog', { name: first.fileName })
  const frame = await within(preview).findByTitle(first.fileName)
  expect(frame.getAttribute('src')).toBe('blob:http://localhost/test-document#page=4')
  const fullDocument = within(preview).getByRole('button', { name: '在新窗口打开全文' })
  expect(frame.compareDocumentPosition(fullDocument)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  fireEvent.click(fullDocument)
  expect(open).toHaveBeenCalledWith(frame.getAttribute('src'), '_blank', 'noopener,noreferrer')
  expect(knowledgeRequest).toHaveBeenCalledWith('files/project-training/file-1/preview', expect.any(AbortSignal))
  fireEvent.click(within(preview).getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/test-document')
})

it('opens the stored PDF page directly for a citation saved without page metadata', async () => {
  const { page: _oldPage, ...citation } = first
  const locatePage = vi.fn(async () => 1)
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = () => 'blob:http://localhost/stored-page'
    static override revokeObjectURL = () => {}
  })
  vi.mocked(knowledgeRequest).mockImplementation(async path => path.endsWith('/page-location') ? Response.json({ page: 39 })
    : new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }))
  render(<KnowledgeResults selection={{ sources: [citation], index: 0 }} locatePage={locatePage} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '查看原文' }))
  const dialog = screen.getByRole('dialog', { name: citation.fileName })
  const frame = await within(dialog).findByTitle(citation.fileName)
  expect(frame.getAttribute('src')).toBe('blob:http://localhost/stored-page#page=39')
  fireEvent.click(within(dialog).getByRole('button', { name: '在新窗口打开全文' }))
  expect(open).toHaveBeenCalledWith(frame.getAttribute('src'), '_blank', 'noopener,noreferrer')
  expect(screen.getAllByText('第 39 页')).toHaveLength(2)
  expect(knowledgeRequest).toHaveBeenCalledWith('files/project-training/file-1/page-location', expect.any(AbortSignal),
    expect.objectContaining({ knowledgeBaseId: citation.knowledgeBaseId, documentId: citation.documentId, chunkId: citation.chunkId }))
  expect(locatePage).not.toHaveBeenCalled()
})

it('remembers a located PDF page when a legacy citation opens again', async () => {
  const { page: _oldPage, ...legacy } = first
  const locatePage = vi.fn(async () => 7)
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = () => 'blob:http://localhost/legacy-document'
    static override revokeObjectURL = () => {}
  })
  const earlier = '这一段对应前一页，包含和当前回复无关的完整说明。'
  const target = '分户图是在分丘图基础上绘制的细部图，以一户产权人为单位。'
  vi.mocked(knowledgeRequest).mockImplementation(async path => path.endsWith('/page-location') ? Response.json({ position: 0.59 })
    : new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }))
  const source = { ...legacy, text: `${earlier}\n\n${target}` }
  const answerText = '分户图是在**分丘图基础上绘制的细部图**。'
  const view = render(<KnowledgeResults selection={{ sources: [source], index: 0, answerText }} locatePage={locatePage} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '查看原文' }))
  const dialog = screen.getByRole('dialog', { name: legacy.fileName })
  await within(dialog).findByText('第 7 页')
  const frame = within(dialog).getByTitle(legacy.fileName)
  expect(locatePage).toHaveBeenCalledWith(expect.any(Uint8Array), [target], expect.any(AbortSignal), 0.59)
  expect(frame.getAttribute('src')).toBe('blob:http://localhost/legacy-document#page=7')
  fireEvent.click(within(dialog).getByRole('button', { name: '在新窗口打开全文' }))
  expect(open).toHaveBeenCalledWith(frame.getAttribute('src'), '_blank', 'noopener,noreferrer')

  view.unmount()
  locatePage.mockClear()
  vi.mocked(knowledgeRequest).mockClear()
  const reopened = render(<KnowledgeResults selection={{ sources: [{ ...source }], index: 0, answerText }} locatePage={locatePage} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '查看原文' }))
  const reopenedDialog = screen.getByRole('dialog', { name: legacy.fileName })
  const reopenedFrame = await within(reopenedDialog).findByTitle(legacy.fileName)
  expect(reopenedFrame.getAttribute('src')).toBe(frame.getAttribute('src'))
  expect(knowledgeRequest).toHaveBeenCalledTimes(1)
  expect(locatePage).not.toHaveBeenCalled()

  reopened.unmount()
  locatePage.mockResolvedValueOnce(6)
  render(<KnowledgeResults selection={{ sources: [source], index: 0, answerText: earlier }} locatePage={locatePage} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '查看原文' }))
  await within(screen.getByRole('dialog', { name: legacy.fileName })).findByText('第 6 页')
  expect(locatePage).toHaveBeenCalledWith(expect.any(Uint8Array), [earlier], expect.any(AbortSignal), 0.59)
})
