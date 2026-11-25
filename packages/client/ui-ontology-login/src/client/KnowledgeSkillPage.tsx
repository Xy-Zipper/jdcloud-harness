/** Manage draft roles and the channels attached to their current release. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  knowledgeRequest, type KnowledgeCatalog, type KnowledgeOption, type KnowledgeSkill, type SkillDeliveryAction, type SkillDeliveryUpdate,
} from './knowledge-api.ts'
import { SkillRelease } from './SkillRelease.tsx'
import css from './Knowledge.module.css'

type Task = 'save' | 'publish' | 'delete' | SkillDeliveryAction
type Copy = PropsLocale<'ontology.login'>
type PageProps = Copy & InjectFace<{ close: () => void; project?: KnowledgeOption | undefined }>

/** Choose a project only when running outside the Ontology workbench. */
export function KnowledgeSkillPage({ t, close, project }: PageProps) {
  const [projects, setProjects] = useState<readonly KnowledgeOption[]>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [choice, setChoice] = useState('')
  const embedded = project !== undefined
  useEffect(() => {
    if (embedded) return
    const controller = new AbortController()
    void knowledgeRequest('projects', controller.signal).then(async (response) => {
      const data = await response.json() as Pick<KnowledgeCatalog, 'projects'>
      if (!controller.signal.aborted) setProjects(data.projects)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '')
    })
    return () => { controller.abort() }
  }, [embedded, attempt])
  const current = project ?? projects?.find(item => item.id === choice)
  return <main className={css.skillPage} aria-label={t('knowledgeSkills')}>
    <header className={css.skillHeader}>
      <h1>{t('knowledgeSkills')}</h1>
      <Button size="sm" onClick={close}>{t('knowledgeBackToChat')}</Button>
    </header>
    {!embedded && <div className={css.skillProject}>
      <label className={css.field}>{t('knowledgeProject')}
        <select value={choice} disabled={projects === undefined} onChange={(event) => { setChoice(event.target.value) }}>
          <option value="">{t('knowledgeChooseProject')}</option>
          {projects?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {error !== undefined && <div className={css.skillActions}>
        <span role="alert" className={css.error}>{error || t('knowledgeError')}</span>
        <Button onClick={() => { setError(undefined); setAttempt(value => value + 1) }}>{t('knowledgeRetry')}</Button>
      </div>}
      {error === undefined && projects === undefined && <StateDot state="ongoing" size={20} />}
    </div>}
    {current !== undefined && <ProjectSkills key={current.id} project={current} t={t} />}
  </main>
}

/** The keyed editor keeps list, drafts, and one-time secrets within one project. */
function ProjectSkills({ t, project }: Copy & { project: KnowledgeOption }) {
  const collection = `projects/${encodeURIComponent(project.id)}/skills`
  const [catalog, setCatalog] = useState<KnowledgeCatalog>()
  const [catalogFailure, setCatalogFailure] = useState<string>()
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [listAttempt, setListAttempt] = useState(0)
  const [records, setRecords] = useState<KnowledgeSkill[]>()
  const [selected, select] = useState<KnowledgeSkill>()
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [datasetIds, setDatasets] = useState<readonly string[]>([])
  const [task, setTask] = useState<Task>()
  const [issuedKey, setIssuedKey] = useState<{ id: string; value: string }>()
  const [failure, setFailure] = useState<string>()
  const [keyFailure, setKeyFailure] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<'knowledgeSaved' | 'knowledgeReleaseSaved' | 'knowledgeSkillDeleted'>()
  const request = useRef<AbortController>()
  const busy = task !== undefined
  const canWrite = !busy && catalog !== undefined && name.trim() !== ''

  // A failed RAGFlow catalog does not hide the saved roles or their releases.
  useEffect(() => {
    const controller = new AbortController()
    void knowledgeRequest('catalog', controller.signal).then(async (response) => {
      const items = await response.json() as KnowledgeCatalog
      if (!controller.signal.aborted) setCatalog(items)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setCatalogFailure(error instanceof Error ? error.message : '')
    })
    return () => { controller.abort() }
  }, [catalogAttempt])

  useEffect(() => {
    const controller = new AbortController()
    void knowledgeRequest(collection, controller.signal).then(async (response) => {
      const list = await response.json() as { skills: KnowledgeSkill[] }
      if (!controller.signal.aborted) setRecords(list.skills.filter(item => item.projectId === project.id))
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : '')
    })
    return () => { controller.abort(); request.current?.abort() }
  }, [collection, project.id, listAttempt])

  const choose = (item?: KnowledgeSkill): void => {
    select(item)
    setName(item?.draft.name ?? '')
    setInstructions(item?.draft.instructions ?? '')
    setDatasets(item?.draft.datasetIds ?? [])
    setNotice(undefined)
    setFailure(undefined)
    setKeyFailure(undefined)
    setIssuedKey(undefined)
  }

  const remember = (item: KnowledgeSkill): void => {
    select(item)
    setRecords((current = []) => current.some(record => record.id === item.id)
      ? current.map(record => record.id === item.id ? item : record) : [...current, item])
  }

  // Serialize editor and release changes so a save cannot restore stale credential state.
  const run = async (action: Task, keyId?: string): Promise<void> => {
    if (request.current !== undefined || ((action === 'save' || action === 'publish') && !canWrite)) return
    const controller = new AbortController()
    request.current = controller
    setTask(action)
    setNotice(undefined)
    setFailure(undefined)
    setKeyFailure(undefined)
    try {
      if (action === 'save' || action === 'publish') {
        const response = await knowledgeRequest(selected === undefined ? collection : `${collection}/${selected.id}`, controller.signal, {
          revision: selected?.revision, name, instructions, datasetIds,
        })
        const item = await response.json() as KnowledgeSkill
        controller.signal.throwIfAborted()
        remember(item)
        if (action === 'publish') {
          const published = await knowledgeRequest(`${collection}/${item.id}/publish`, controller.signal, { revision: item.revision })
          const release = await published.json() as KnowledgeSkill
          controller.signal.throwIfAborted()
          remember(release)
        }
      } else if (action === 'delete' && selected !== undefined) {
        await knowledgeRequest(`${collection}/${selected.id}`, controller.signal, undefined, 'DELETE')
        controller.signal.throwIfAborted()
        setRecords(current => current?.filter(item => item.id !== selected.id))
        choose()
        setConfirmDelete(false)
        setNotice('knowledgeSkillDeleted')
        return
      } else if (selected !== undefined) {
        const response = await knowledgeRequest(`${collection}/${selected.id}/delivery`, controller.signal, { action, keyId })
        const change = await response.json() as SkillDeliveryUpdate
        if (controller.signal.aborted) return
        remember({ ...selected, delivery: change.delivery })
        if (change.apiKey !== undefined && change.apiKeyId !== undefined) setIssuedKey({ id: change.apiKeyId, value: change.apiKey })
        else if (action === 'revoke-key') setIssuedKey(current => current?.id === keyId ? undefined : current)
      }
      setNotice(action === 'save' ? 'knowledgeSaved' : 'knowledgeReleaseSaved')
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : ''
        if (action === 'issue-key' || action === 'revoke-key') setKeyFailure(message)
        else setFailure(message)
      }
    } finally {
      if (request.current === controller) request.current = undefined
      if (!controller.signal.aborted) setTask(undefined)
    }
  }

  return (
    <>
      {records === undefined && failure === undefined && <div role="status" aria-label={t('knowledgeLoading')} className={css.previewNotice}>
        <StateDot state="ongoing" size={28} />
      </div>}
      {failure !== undefined && !confirmDelete && <div className={css.skillActions}>
        <span className={css.error} role="alert">{failure || t('knowledgeError')}</span>
        {records === undefined && <Button onClick={() => { setFailure(undefined); setListAttempt(value => value + 1) }}>{t('knowledgeRetry')}</Button>}
      </div>}
      {records !== undefined && <div className={css.skillLayout}>
        <nav className={css.skillList} aria-label={t('knowledgeSkillList')}>
          <Button variant="outline" size="sm" onClick={() => { choose() }} disabled={busy}>{t('knowledgeNewSkill')}</Button>
          {records.length === 0 && <p className={css.releaseHint}>{t('knowledgeNoSkills')}</p>}
          {records.map(item => <Button key={item.id} className={css.skillRow} aria-pressed={selected?.id === item.id}
            onClick={() => { choose(item) }} disabled={busy}>
            <span>{item.draft.name}</span>
            <small>{t(item.published === undefined ? 'knowledgeDraftStatus' : 'knowledgePublishedStatus')}</small>
          </Button>)}
        </nav>
        <div className={css.skillDetail}>
          <section className={css.skillCard} aria-label={t('knowledgeRoleSettings')}>
            <h2>{t('knowledgeRoleSettings')}</h2>
            <div className={css.roleFields}>
              <label className={css.field}>{t('knowledgeSkillName')}
                <input value={name} onChange={(event) => { setName(event.target.value) }} disabled={busy} maxLength={120} />
              </label>
              <label className={css.field}>{t('knowledgeProject')}
                <input value={project.name} readOnly />
              </label>
            </div>
            <label className={css.field}>{t('knowledgeInstructions')}
              <textarea rows={4} value={instructions} onChange={(event) => { setInstructions(event.target.value) }}
                disabled={busy} maxLength={3000} />
            </label>
            {catalog === undefined && catalogFailure === undefined && <p role="status">{t('knowledgeLoading')}</p>}
            {catalogFailure !== undefined && <div className={css.skillActions}>
              <span className={css.error} role="alert">{catalogFailure || t('knowledgeError')}</span>
              <Button size="sm" variant="outline" onClick={() => {
                setCatalogFailure(undefined)
                setCatalogAttempt(value => value + 1)
              }}>{t('knowledgeRetry')}</Button>
            </div>}
            {catalog !== undefined && <fieldset className={css.datasets} disabled={busy}>
              <legend>{t('knowledgeBases')}</legend>
              <p>{t('knowledgeAllHint')}</p>
              {catalog.datasets.map(dataset => <label key={dataset.id} className={css.option}>
                <input type="checkbox" checked={datasetIds.includes(dataset.id)} onChange={(event) => {
                  setDatasets(event.target.checked ? [...datasetIds, dataset.id] : datasetIds.filter(id => id !== dataset.id))
                }} />
                <span>{dataset.name}</span>
              </label>)}
              {datasetIds.filter(id => !catalog.datasets.some(dataset => dataset.id === id)).map(id => (
                <label key={id} className={css.option}>
                  <input type="checkbox" checked onChange={() => { setDatasets(datasetIds.filter(value => value !== id)) }} />
                  <span>{id} · {t('knowledgeUnavailable')}</span>
                </label>
              ))}
            </fieldset>}
            <div className={css.skillActions}>
              <Button variant="outline" disabled={!canWrite} onClick={() => { void run('save') }}>
                {t(task === 'save' ? 'knowledgeSaving' : 'knowledgeSave')}
              </Button>
              <Button variant="primary" disabled={!canWrite} onClick={() => { void run('publish') }}>
                {t(task === 'publish' ? 'knowledgePublishing' : 'knowledgePublish')}
              </Button>
              {selected !== undefined && <Button className={css.danger} disabled={busy}
                onClick={() => { setFailure(undefined); setConfirmDelete(true) }}>
                {t('knowledgeDeleteSkill')}
              </Button>}
              {notice !== undefined && <span role="status">{t(notice)}</span>}
            </div>
          </section>
          {selected?.published !== undefined && <SkillRelease key={selected.id} skill={selected} busy={busy}
            issuedKey={issuedKey} keyFailure={keyFailure} pendingKey={task === 'issue-key' || task === 'revoke-key' ? task : undefined}
            onClearKey={() => { setIssuedKey(undefined); setKeyFailure(undefined) }}
            onAction={(action, keyId) => { void run(action, keyId) }} t={t} />}
        </div>
      </div>}
      {selected !== undefined && <Modal open={confirmDelete} tone="warning" title={t('knowledgeDeleteSkill')} closeLabel={t('knowledgeClose')}
        onClose={() => { if (!busy) { setConfirmDelete(false); setFailure(undefined) } }}
        footer={<>
          <Button variant="outline" data-modal-autofocus disabled={busy} onClick={() => { setConfirmDelete(false); setFailure(undefined) }}>{t('knowledgeCancel')}</Button>
          <Button className={css.danger} variant="outline" disabled={busy} onClick={() => { void run('delete') }}>
            {t(task === 'delete' ? 'knowledgeDeleting' : 'knowledgeConfirmDelete')}
          </Button>
        </>}>
        <p>{t(selected.published === undefined ? 'knowledgeDeleteDraftHint' : 'knowledgeDeleteSkillHint', { name: selected.draft.name })}</p>
        {failure !== undefined && <p className={css.error} role="alert">{failure || t('knowledgeError')}</p>}
      </Modal>}
    </>
  )
}
