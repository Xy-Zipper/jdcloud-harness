import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type {
  SkillEntry,
  SkillInstallFile,
  SkillInstallInvalidReason,
  SkillInstallScope,
  SkillManagedEntry,
  SkillManagedScope,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  Button,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSkillOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  Tooltip,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillKey } from './locales.ts'
import { NS } from './locales.ts'
import css from './SkillPicker.module.css'

// Browser preflight mirrors the Host limits; the installer remains authoritative.
const SKILL_INSTALL_MAX_FILES = 128
const SKILL_INSTALL_MAX_FILE_BYTES = 5 * 1024 * 1024
const SKILL_INSTALL_MAX_TOTAL_BYTES = 20 * 1024 * 1024

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

/** Browser-safe result of deleting one account-managed Skill. */
export type SkillDeleteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string } }

/** Catalog metadata and account-authorized install targets returned by the Host. */
export interface SkillPickerCatalog {
  readonly skills: readonly SkillEntry[]
  readonly installScopes: readonly SkillInstallScope[]
  readonly managedSkills: readonly SkillManagedEntry[]
}

/** Business operations injected by the ui-skill slot registration. */
export interface SkillPickerInjected {
  /** Whether the addressed Session supports direct human skill invocation. */
  readonly available: boolean
  /** Load the user-invocable catalog for the current Session. */
  readonly loadCatalog: () => Promise<SkillPickerCatalog>
  /** Install one complete Skill folder in an authorized persistent target. */
  readonly installSkill: (
    scope: SkillInstallScope,
    files: readonly SkillInstallFile[],
  ) => Promise<SkillInstallOutcome>
  /** Delete one personal Skill, or one built-in Skill for an administrator. */
  readonly deleteSkill: (scope: SkillManagedScope, name: string) => Promise<SkillDeleteOutcome>
}

/** Complete props supplied by the Conversation slot, ui-skill, and locale registry. */
export type SkillPickerProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<SkillPickerInjected>
  & PropsLocale<typeof NS>

/** Props supplied by the root settings section. */
export type SkillSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<SkillPickerInjected>
  & PropsLocale<typeof NS>

/** Props used by the visual skill picker independently of Slot runtime metadata. */
export type SkillPickerViewProps = SkillPickerInjected & {
  readonly t: SkillPickerProps['t']
} & (
  | {
    readonly surface?: 'composer'
    readonly inputActions: SkillPickerProps['inputActions']
  }
  | {
    readonly surface: 'settings'
    readonly inputActions?: never
  }
)

function mergeSkill(catalog: readonly SkillEntry[], installed: SkillEntry): readonly SkillEntry[] {
  return [...catalog.filter(skill => skill.name !== installed.name), installed]
    .sort((left, right) => left.name.localeCompare(right.name))
}

function invalidReasonKey(reason: SkillInstallInvalidReason | undefined): SkillKey {
  switch (reason) {
    case 'content-too-large': return 'error.contentTooLarge'
    case 'description': return 'error.description'
    case 'empty-folder': return 'error.emptyFolder'
    case 'file-too-large': return 'error.fileTooLarge'
    case 'folder-too-large': return 'error.folderTooLarge'
    case 'frontmatter': return 'error.frontmatter'
    case 'invalid-file-content': return 'error.invalidFileContent'
    case 'invalid-file-path': return 'error.invalidFilePath'
    case 'missing-skill-file': return 'error.missingSkillFile'
    case 'name': return 'error.name'
    case 'path': return 'error.path'
    case 'project-cwd': return 'error.projectCwd'
    case 'skill-file-not-text': return 'error.skillFileNotText'
    case 'too-many-files': return 'error.tooManyFiles'
    case 'user-invocable': return 'error.userInvocable'
    case undefined: return 'error.invalid'
  }
}

interface SelectedFolder {
  readonly name: string
  readonly files: readonly { readonly path: string; readonly file: File }[]
}

/** Normalize browser directory paths and require every file to share one selected root. */
function selectedFolder(files: readonly File[]): SelectedFolder | undefined {
  let root: string | undefined
  const selected: Array<{ path: string; file: File }> = []
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/')
    const currentRoot = parts.shift()
    if (currentRoot === undefined || currentRoot.length === 0 || parts.length === 0) return undefined
    if (root !== undefined && currentRoot !== root) return undefined
    root = currentRoot
    selected.push({ path: parts.join('/'), file })
  }
  return root === undefined ? undefined : { name: root, files: selected }
}

/** Encode browser file bytes without spreading an unbounded array into one call. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function installError(outcome: Extract<SkillInstallOutcome, { readonly ok: false }>, t: SkillPickerProps['t']): string {
  if (outcome.error.code === 'skill/already-exists') return t('error.exists')
  if (outcome.error.code === 'skill/invalid') return t(invalidReasonKey(outcome.error.reason))
  if (outcome.error.code === 'skill/forbidden') return t('error.forbidden')
  if (outcome.error.code === 'session/not-found') return t('error.sessionUnavailable')
  return t('error.installFailed')
}

/** Composer skill button, searchable picker, and account-aware skill manager. */
export function SkillPickerView({
  available,
  deleteSkill,
  inputActions,
  installSkill,
  loadCatalog,
  surface = 'composer',
  t,
}: SkillPickerViewProps) {
  const [open, setOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<readonly SkillEntry[]>([])
  const [installScopes, setInstallScopes] = useState<readonly SkillInstallScope[]>([])
  const [managedSkills, setManagedSkills] = useState<readonly SkillManagedEntry[]>([])
  const [installScope, setInstallScope] = useState<SkillInstallScope | null>(null)
  const [loading, setLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [folderName, setFolderName] = useState<string | null>(null)
  const [importFiles, setImportFiles] = useState<readonly SkillInstallFile[] | null>(null)
  const [managerError, setManagerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillManagedEntry | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const selectionRevisionRef = useRef(0)
  const insertionRef = useRef<ReturnType<SkillPickerProps['inputActions']['captureInsertion']> | null>(null)
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
    if (surface === 'composer' && !open) return
    let current = true
    setLoading(true)
    setPickerError(null)
    void loadCatalog().then((value) => {
      if (!current) return
      setCatalog(value.skills)
      setInstallScopes(value.installScopes)
      setManagedSkills(value.managedSkills)
      setInstallScope(selected => selected !== null && value.installScopes.includes(selected)
        ? selected
        : value.installScopes[0] ?? null)
      setLoading(false)
    }, () => {
      if (!current) return
      setLoading(false)
      setPickerError(t('picker.loadFailed'))
    })
    return () => { current = false }
  }, [loadCatalog, open, surface, t])

  useEffect(() => {
    if (surface !== 'composer' || !open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, surface])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(
    () => normalizedQuery === ''
      ? catalog
      : catalog.filter(skill => `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(normalizedQuery)),
    [catalog, normalizedQuery],
  )
  const canInstall = importFiles !== null && installScope !== null
  const visibleManagedSkills = installScope === null || installScope === 'project'
    ? []
    : managedSkills.filter(skill => skill.scope === installScope)

  if (!available) {
    if (surface === 'composer') return null
    return <section className={css.settingsSection}>
      <h2>{t('settings.title')}</h2>
      <p>{t('settings.description')}</p>
      <p className={css.settingsNotice}>{t('settings.sessionRequired')}</p>
    </section>
  }

  const toggle = (): void => {
    if (inputActions === undefined) return
    if (!open) {
      insertionRef.current = inputActions.captureInsertion()
      setQuery('')
      setStatus(null)
    }
    setOpen(!open)
  }

  const pick = (skill: SkillEntry): void => {
    if (inputActions === undefined) return
    const span = insertionRef.current ?? inputActions.captureInsertion()
    if (!inputActions.insertText(`/${skill.name} `, span)) {
      setPickerError(t('picker.insertFailed'))
      return
    }
    setOpen(false)
  }

  const openManager = (): void => {
    if (installScopes.length === 0) return
    setOpen(false)
    setManagerError(null)
    setManagerOpen(true)
  }

  const resetManager = (): void => {
    selectionRevisionRef.current += 1
    setFolderName(null)
    setImportFiles(null)
    setManagerError(null)
    setSaving(false)
    setDeleteTarget(null)
    setDeleteError(null)
    setDeleting(false)
  }

  const closeManager = (): void => {
    setManagerOpen(false)
    resetManager()
  }

  const selectFolder = (event: ChangeEvent<HTMLInputElement>): void => {
    const browserFiles = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (browserFiles.length === 0) return
    const revision = selectionRevisionRef.current + 1
    selectionRevisionRef.current = revision
    setManagerError(null)
    setImportFiles(null)
    const folder = selectedFolder(browserFiles)
    if (folder === undefined) {
      setFolderName(null)
      setManagerError(t('error.invalidFolder'))
      return
    }
    setFolderName(folder.name)
    if (folder.files.length > SKILL_INSTALL_MAX_FILES) {
      setManagerError(t('error.tooManyFiles'))
      return
    }
    if (!folder.files.some(file => file.path === 'SKILL.md')) {
      setManagerError(t('error.missingSkillFile'))
      return
    }
    if (folder.files.some(file => file.file.size > SKILL_INSTALL_MAX_FILE_BYTES)) {
      setManagerError(t('error.fileTooLarge'))
      return
    }
    const totalBytes = folder.files.reduce((total, file) => total + file.file.size, 0)
    if (totalBytes > SKILL_INSTALL_MAX_TOTAL_BYTES) {
      setManagerError(t('error.folderTooLarge'))
      return
    }
    void Promise.all(folder.files.map(async ({ path, file }) => ({
      path,
      contentBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    }))).then((files) => {
      if (selectionRevisionRef.current !== revision) return
      setImportFiles(files)
    }, () => {
      if (selectionRevisionRef.current !== revision) return
      setImportFiles(null)
      setManagerError(t('manager.readFailed'))
    })
  }

  const save = (): void => {
    if (!canInstall || saving || importFiles === null || installScope === null) return
    setSaving(true)
    setManagerError(null)
    void installSkill(installScope, importFiles).then((outcome) => {
      if (!outcome.ok) {
        setSaving(false)
        setManagerError(installError(outcome, t))
        return
      }
      setCatalog(current => mergeSkill(current, outcome.skill))
      if (installScope !== 'project') {
        setManagedSkills(current => [
          ...current.filter(skill => skill.name !== outcome.skill.name || skill.scope !== installScope),
          { ...outcome.skill, scope: installScope },
        ].sort((left, right) => left.name.localeCompare(right.name)))
      }
      setStatus(t('manager.success', { name: outcome.skill.name }))
      closeManager()
    }, (error: unknown) => {
      // Preserve unexpected adapter failures for operators while keeping UI copy localized.
      console.error('[ui-skill] skill installation adapter failed:', error)
      setSaving(false)
      setManagerError(t('error.installFailed'))
    })
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
  }

  const confirmDelete = (): void => {
    if (deleteTarget === null || deleting) return
    setDeleting(true)
    setDeleteError(null)
    void deleteSkill(deleteTarget.scope, deleteTarget.name).then((outcome) => {
      if (!outcome.ok) {
        setDeleting(false)
        setDeleteError(t('error.deleteFailed'))
        return
      }
      setManagedSkills(current => current.filter(skill => (
        skill.name !== deleteTarget.name || skill.scope !== deleteTarget.scope
      )))
      setCatalog(current => current.filter(skill => skill.name !== deleteTarget.name))
      setStatus(t('manager.deleteSuccess', { name: deleteTarget.name }))
      setDeleting(false)
      setDeleteTarget(null)
    }, (error: unknown) => {
      // Preserve unexpected adapter failures for operators while keeping UI copy localized.
      console.error('[ui-skill] skill deletion adapter failed:', error)
      setDeleting(false)
      setDeleteError(t('error.deleteFailed'))
    })
  }

  const manager = managerOpen ? (
    <Modal
      open
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
      <div className={css.importPanel}>
        <div className={css.scopeField}>
          <span className={css.scopeLabel}>{t('manager.scope')}</span>
          <div className={css.scopeOptions} role="tablist" aria-label={t('manager.scope')}>
            {installScopes.map(scope => (
              <button
                key={scope}
                type="button"
                role="tab"
                className={scope === installScope ? css.scopeActive : css.scopeOption}
                aria-selected={scope === installScope}
                onClick={() => { setInstallScope(scope) }}
              >
                {t(`manager.scope.${scope}`)}
              </button>
            ))}
          </div>
          {installScope !== null && <span className={css.scopeHint}>{t(`manager.scopeHint.${installScope}`)}</span>}
        </div>
        {installScope !== 'project' && (
          <div className={css.managedSection}>
            <h3>{t('manager.installed')}</h3>
            {visibleManagedSkills.length === 0 && (
              <p className={css.managedEmpty}>{t('manager.installedEmpty')}</p>
            )}
            {visibleManagedSkills.map(skill => (
              <div key={`${skill.scope}:${skill.name}`} className={css.managedSkill}>
                <span className={css.managedSkillCopy}>
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                </span>
                <Button
                  variant="toolbar"
                  size="sm"
                  className={css.deleteButton}
                  aria-label={t('manager.deleteButton', { name: skill.name })}
                  icon={<IconTrashOutlineRegular size={14} />}
                  onClick={() => {
                    setDeleteError(null)
                    setDeleteTarget(skill)
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          {...{ webkitdirectory: '' }}
          onChange={selectFolder}
        />
        <div className={css.dropHint}>
          <IconSkillOutlineRegular size={24} />
          <strong>{folderName ?? t('manager.importPrompt')}</strong>
          <span>{importFiles === null
            ? t('manager.importHint')
            : t('manager.selectedFiles', { count: String(importFiles.length) })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => { fileInputRef.current?.click() }}
          >
            {t('manager.chooseFolder')}
          </Button>
        </div>
      </div>
      {managerError !== null && <p className={css.managerError} role="alert">{managerError}</p>}
    </Modal>
  ) : null

  const deleteConfirmation = deleteTarget === null ? null : (
    <Modal
      open
      onClose={closeDelete}
      title={t('manager.deleteTitle')}
      description={t(`manager.deleteDescription.${deleteTarget.scope}`, { name: deleteTarget.name })}
      closeLabel={t('manager.deleteClose')}
      className={css.deleteDialog ?? ''}
      footer={(
        <>
          <Button variant="outline" onClick={closeDelete} disabled={deleting}>
            {t('manager.deleteCancel')}
          </Button>
          <Button
            variant="primary"
            className={css.deleteConfirm}
            onClick={confirmDelete}
            disabled={deleting}
          >
            {deleting ? t('manager.deleting') : t('manager.deleteConfirm')}
          </Button>
        </>
      )}
    >
      {deleteError !== null && <p className={css.managerError} role="alert">{deleteError}</p>}
    </Modal>
  )

  if (surface === 'settings') {
    return <section className={css.settingsSection}>
      <h2>{t('settings.title')}</h2>
      <p>{t('settings.description')}</p>
      {loading && <p className={css.settingsNotice}>{t('settings.loading')}</p>}
      {!loading && pickerError !== null && <p className={css.managerError} role="alert">{t('settings.loadFailed')}</p>}
      {!loading && pickerError === null && (
        <Button variant="primary" onClick={openManager} disabled={installScopes.length === 0}>
          {t('picker.manage')}
        </Button>
      )}
      {status !== null && <p className={css.settingsSuccess} role="status">{status}</p>}
      {manager}
      {deleteConfirmation}
    </section>
  }

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
            {installScopes.length > 0 && (
              <button type="button" className={css.manage} onClick={openManager}>
                <IconPlusOutlineRegular size={14} />
                {t('picker.manage')}
              </button>
            )}
          </div>
        </div>
      )}
      {manager}
      {deleteConfirmation}
    </span>
  )
}

/** Slot-facing adapter that keeps framework standard props outside the visual component. */
export function SkillPicker(props: SkillPickerProps) {
  return <SkillPickerView
    available={props.available}
    inputActions={props.inputActions}
    deleteSkill={props.deleteSkill}
    installSkill={props.installSkill}
    loadCatalog={props.loadCatalog}
    t={props.t}
  />
}

/** Settings-page adapter that reuses the account-aware manager without composer controls. */
export function SkillSettingsSection(props: SkillSettingsSectionProps) {
  return <SkillPickerView
    surface="settings"
    available={props.available}
    deleteSkill={props.deleteSkill}
    installSkill={props.installSkill}
    loadCatalog={props.loadCatalog}
    t={props.t}
  />
}
