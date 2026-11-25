// Published conversations render the one released Skill selected by the entry link.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PdfExcerptLocator } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { askKnowledge, knowledgeRequest, type KnowledgeReply } from './knowledge-api.ts'
import { KnowledgeSources } from './KnowledgeSources.tsx'
import css from './Knowledge.module.css'

interface PublishedProps extends PropsLocale<'ontology.login'> {
  readonly id: string
  readonly logout: () => Promise<void>
  readonly locatePage: PdfExcerptLocator
}

/**
 * Run the selected published Skill as the page's only question-answering capability.
 * @param props - Released role, sign-out action, and locale.
 * @returns The signed-in conversation for testing a released Skill.
 */
export function PublishedKnowledgeSkill({ id, logout, locatePage, t }: PublishedProps) {
  const [title, setTitle] = useState<string>()
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState<Array<KnowledgeReply & { question: string }>>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailure] = useState<string>()
  const [signingOut, setSigningOut] = useState(false)
  const request = useRef<AbortController>()
  const replies = useRef<HTMLElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    void knowledgeRequest(`skills/${id}`, controller.signal).then(async (response) => {
      const result: unknown = await response.json()
      const name: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'name') : undefined
      if (typeof name !== 'string') throw new Error()
      if (!controller.signal.aborted) setTitle(name)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '')
    })
    return () => { request.current?.abort() }
  }, [id])
  useEffect(() => {
    if (replies.current !== null) replies.current.scrollTop = replies.current.scrollHeight
  }, [history])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = question.trim()
    if (busy || title === undefined || text === '') return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await askKnowledge(id, text, controller.signal)
      if (controller.signal.aborted) return
      setHistory(current => [...current, { ...result, question: text }])
      setQuestion('')
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <main className={css.published}>
      <header className={css.publishedHeader}>
        <h1>{title ?? t('knowledgeSkills')}</h1>
        <Button variant="outline" disabled={signingOut} onClick={() => {
          setSigningOut(true)
          void logout().catch((error: unknown) => {
            setFailure(error instanceof Error ? error.message : '')
            setSigningOut(false)
          })
        }}>{signingOut ? t('loggingOut') : t('logout')}</Button>
      </header>
      {title === undefined && failed === undefined && <p role="status">{t('knowledgeLoading')}</p>}
      <section className={css.replies} ref={replies} aria-live="polite">
        {history.map((reply, index) => <article key={index} className={css.reply}>
          <p className={css.question}>{reply.question}</p>
          <p className={css.answer}>{reply.answer}</p>
          <KnowledgeSources sources={reply.sources} answerText={reply.answer} locatePage={locatePage} t={t} />
        </article>)}
      </section>
      {failed !== undefined && <p className={css.error} role="alert">{failed || t('knowledgeError')}</p>}
      {title !== undefined && <form className={css.ask} onSubmit={(event) => { void submit(event) }}>
        <label className={css.field}>
          <span>{t('knowledgeQuestion')}</span>
          <textarea rows={2} maxLength={2000} value={question} disabled={busy} onChange={(event) => { setQuestion(event.target.value) }} />
        </label>
        <Button variant="primary" type="submit" disabled={busy || question.trim() === ''} aria-busy={busy}>
          {busy ? t('knowledgeAnswering') : t('knowledgeAsk')}
        </Button>
      </form>}
    </main>
  )
}
