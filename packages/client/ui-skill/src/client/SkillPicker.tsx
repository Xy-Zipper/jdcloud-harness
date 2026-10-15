import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { SkillEntry, SkillInstallInvalidReason } from '@deepseek-ai/dsh-api-session-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSkillOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
  Tooltip,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillKey } from './locales.ts'
import { NS } from './locales.ts'
import css from './SkillPicker.module.css'

/** Browser-safe result of installing one workspace skill. */
export type SkillInstallOutcome =
  | { readonly ok: true; readonly skill: SkillEntry }
  | {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly reason?: SkillInstallInvalidReason
    }
  }

/** Business operations injected by the ui-skill slot registration. */
export interface SkillPickerInjected {
  /** Whether the addressed Session supports direct human skill invocation. */
  readonly available: boolean
  /** Load the user-invocable catalog for the current Session. */
  readonly loadCatalog: () => Promise<readonly SkillEntry[]>
  /** Install one complete SKILL.md in the current Session project. */
  readonly installSkill: (content: string) => Promise<SkillInstallOutcome>
}

/** Complete props supplied by the Conversation slot, ui-skill, and locale registry. */
export type SkillPickerProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<SkillPickerInjected>
  & PropsLocale<typeof NS>

/** Props used by the visual skill picker independently of Slot runtime metadata. */
export interface SkillPickerViewProps extends SkillPickerInjected {
  readonly inputActions: SkillPickerProps['inputActions']
  readonly t: SkillPickerProps['t']
}

type ManagerMode = 'create' | 'import'

// Browser preflight mirrors the Host's protocol limit; skills/create remains authoritative.
const SKILL_FILE_MAX_BYTES = 256 * 1024

function mergeSkill(catalog: readonly SkillEntry[], installed: SkillEntry): readonly SkillEntry[] {
  return [...catalog.filter(skill => skill.name !== installed.name), installed]
    .sort((left, right) => left.name.localeCompare(right.name))
}

function createSkillDocument(name: string, description: string, instructions: string): string {
  return [
    '---',
    `name: ${name.trim()}`,
    `description: ${JSON.stringify(description.trim())}`,
    '---',
    '',
    instructions.trim(),
    '',
  ].join('\n')
}

function invalidReasonKey(reason: SkillInstallInvalidReason | undefined): SkillKey {
  switch (reason) {
    case 'content-too-large': return 'error.contentTooLarge'
    case 'description': return 'error.description'
    case 'frontmatter': return 'error.frontmatter'
    case 'name': return 'error.name'
    case 'path': return 'error.path'
    case 'project-cwd': return 'error.projectCwd'
    case 'user-invocable': return 'error.userInvocable'
    case undefined: return 'error.invalid'
  }
}

function installError(outcome: Extract<SkillInstallOutcome, { readonly ok: false }>, t: SkillPickerProps['t']): string {
  if (outcome.error.code === 'skill/already-exists') return t('error.exists')
  if (outcome.error.code === 'skill/invalid') return t(invalidReasonKey(outcome.error.reason))
  if (outcome.error.code === 'session/not-found') return t('error.sessionUnavailable')
  return t('error.installFailed')
}

/** Composer skill button, searchable picker, and current-workspace skill manager. */
export function SkillPickerView({
  available,
  inputActions,
  installSkill,
  loadCatalog,
  t,
}: SkillPickerViewProps) {
  const [open, setOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [mode, setMode] = useState<ManagerMode>('create')
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<readonly SkillEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [importName, setImportName] = useState<string | null>(null)
  const [importContent, setImportContent] = useState<string | null>(null)
  const [managerError, setManagerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const insertionRef = useRef<ReturnType<typeof inputActions.captureInsertion> | null>(null)
  const formId = useId()
  const nameId = `${formId}-name`
  const descriptionId = `${formId}-description`
  const instructionsId = `${formId}-instructions`
  const position = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true)
    setPickerError(null)
    void loadCatalog().then((skills) => {
      if (!current) return
      setCatalog(skills)
      setLoading(false)
    }, () => {
      if (!current) return
      setLoading(false)
      setPickerError(t('picker.loadFailed'))
    })
    return () => { current = false }
  }, [loadCatalog, open, t])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(
    () => normalizedQuery === ''
      ? catalog
      : catalog.filter(skill => `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(normalizedQuery)),
    [catalog, normalizedQuery],
  )
  const canCreate = name.trim() !== '' && description.trim() !== '' && instructions.trim() !== ''
  const canInstall = mode === 'create' ? canCreate : importContent !== null

  if (!available) return null

  const toggle = (): void => {
    if (!open) {
      insertionRef.current = inputActions.captureInsertion()
      setQuery('')
      setStatus(null)
    }
    setOpen(!open)
  }

  const pick = (skill: SkillEntry): void => {
    const span = insertionRef.current ?? inputActions.captureInsertion()
    if (!inputActions.insertText(`/${skill.name} `, span)) {
      setPickerError(t('picker.insertFailed'))
      return
    }
    setOpen(false)
  }

  const openManager = (): void => {
    setOpen(false)
    setManagerError(null)
    setManagerOpen(true)
  }

  const resetManager = (): void => {
    setName('')
    setDescription('')
    setInstructions('')
    setImportName(null)
    setImportContent(null)
    setManagerError(null)
    setSaving(false)
  }

  const closeManager = (): void => {
    setManagerOpen(false)
    resetManager()
  }

  const selectFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setManagerError(null)
    setImportName(file.name)
    if (file.size > SKILL_FILE_MAX_BYTES) {
      setImportContent(null)
      setManagerError(t('error.contentTooLarge'))
      return
    }
    void file.text().then((content) => {
      setImportContent(content)
    }, () => {
      setImportContent(null)
      setManagerError(t('manager.readFailed'))
    })
  }

  const save = (): void => {
    if (!canInstall || saving) return
    const content = mode === 'create'
      ? createSkillDocument(name, description, instructions)
      : importContent
    if (content === null) return
    setSaving(true)
    setManagerError(null)
    void installSkill(content).then((outcome) => {
      if (!outcome.ok) {
        setSaving(false)
        setManagerError(installError(outcome, t))
        return
      }
      setCatalog(current => mergeSkill(current, outcome.skill))
      setStatus(t('manager.success', { name: outcome.skill.name }))
      closeManager()
    }, (error: unknown) => {
      // Preserve unexpected adapter failures for operators while keeping UI copy localized.
      console.error('[ui-skill] skill installation adapter failed:', error)
      setSaving(false)
      setManagerError(t('error.installFailed'))
    })
  }

  const tabs = [
    { value: 'create' as const, label: t('manager.create'), disabled: saving },
    { value: 'import' as const, label: t('manager.import'), disabled: saving },
  ]

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('picker.button')} side="top" delayMs={300} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('picker.button')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={toggle}
        >
          <IconSkillOutlineRegular size={16} />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('picker.title')}
        >
          <div className={css.panelHeader}>
            <h2>{t('picker.title')}</h2>
            <Input
              className={css.search ?? ''}
              icon={<IconSearchOutlineRegular size={16} />}
              value={query}
              autoFocus
              aria-label={t('picker.search')}
              placeholder={t('picker.search')}
              onChange={(event) => { setQuery(event.target.value) }}
            />
          </div>
          <div className={css.list} role="listbox" aria-label={t('picker.results')}>
            {loading && <div className={css.empty}>{t('picker.loading')}</div>}
            {!loading && pickerError !== null && <div className={css.error} role="alert">{pickerError}</div>}
            {!loading && pickerError === null && filtered.length === 0 && (
              <div className={css.empty}>
                <IconSkillOutlineRegular size={24} />
                <span>{t('picker.empty')}</span>
              </div>
            )}
            {!loading && pickerError === null && filtered.map(skill => (
              <button
                key={skill.name}
                type="button"
                className={css.skill}
                role="option"
                aria-selected="false"
                onClick={() => { pick(skill) }}
              >
                <span className={css.skillIcon} aria-hidden><IconSkillOutlineRegular size={16} /></span>
                <span className={css.skillCopy}>
                  <span className={css.skillName}>{skill.name}</span>
                  <span className={css.skillDescription}>{skill.description}</span>
                </span>
                {!skill.modelInvocable && <span className={css.badge}>{t('menu.userOnly')}</span>}
              </button>
            ))}
          </div>
          <div className={css.panelFooter}>
            <span className={css.status} role="status">{status}</span>
            <button type="button" className={css.manage} onClick={openManager}>
              <IconPlusOutlineRegular size={14} />
              {t('picker.manage')}
            </button>
          </div>
        </div>
      )}
      <Modal
        open={managerOpen}
        onClose={closeManager}
        title={t('manager.title')}
        description={t('manager.description')}
        closeLabel={t('manager.close')}
        className={css.manager ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={closeManager} disabled={saving}>{t('manager.cancel')}</Button>
            <Button variant="primary" onClick={save} disabled={!canInstall || saving}>
              {saving ? t('manager.saving') : t('manager.save')}
            </Button>
          </>
        )}
      >
        <SegmentedControl
          id={`${formId}-mode`}
          value={mode}
          options={tabs}
          onChange={(next) => { setMode(next); setManagerError(null) }}
          label={t('manager.mode')}
          disabled={saving}
          className={css.mode}
        />
        {mode === 'create' ? (
          <div
            id={`${formId}-mode-create-panel`}
            role="tabpanel"
            aria-labelledby={`${formId}-mode-create`}
            className={css.form}
          >
            <div className={css.field}>
              <label htmlFor={nameId}>{t('manager.name')}</label>
              <Input
                id={nameId}
                value={name}
                disabled={saving}
                placeholder={t('manager.namePlaceholder')}
                onChange={(event) => { setName(event.target.value) }}
              />
              <small>{t('manager.nameHint')}</small>
            </div>
            <div className={css.field}>
              <label htmlFor={descriptionId}>{t('manager.skillDescription')}</label>
              <Input
                id={descriptionId}
                value={description}
                disabled={saving}
                placeholder={t('manager.descriptionPlaceholder')}
                onChange={(event) => { setDescription(event.target.value) }}
              />
            </div>
            <div className={css.field}>
              <label htmlFor={instructionsId}>{t('manager.instructions')}</label>
              <textarea
                id={instructionsId}
                value={instructions}
                disabled={saving}
                rows={7}
                placeholder={t('manager.instructionsPlaceholder')}
                onChange={(event) => { setInstructions(event.target.value) }}
              />
            </div>
          </div>
        ) : (
          <div
            id={`${formId}-mode-import-panel`}
            role="tabpanel"
            aria-labelledby={`${formId}-mode-import`}
            className={css.importPanel}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              hidden
              onChange={selectFile}
            />
            <div className={css.dropHint}>
              <IconSkillOutlineRegular size={24} />
              <strong>{importName ?? t('manager.importPrompt')}</strong>
              <span>{t('manager.importHint')}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => { fileInputRef.current?.click() }}
              >
                {t('manager.chooseFile')}
              </Button>
            </div>
          </div>
        )}
        {managerError !== null && <p className={css.managerError} role="alert">{managerError}</p>}
      </Modal>
    </span>
  )
}

/** Slot-facing adapter that keeps framework standard props outside the visual component. */
export function SkillPicker(props: SkillPickerProps) {
  return <SkillPickerView
    available={props.available}
    inputActions={props.inputActions}
    installSkill={props.installSkill}
    loadCatalog={props.loadCatalog}
    t={props.t}
  />
}
