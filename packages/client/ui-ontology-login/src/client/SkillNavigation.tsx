/** Ontology's footer menu and central Skill page use the existing shell slots. */
import { useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { OntologyRuntimeContext } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconAppsAddOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { KnowledgeSkillPage } from './KnowledgeSkillPage.tsx'
import { NS } from './locales.ts'
import css from './Knowledge.module.css'

/** Main panel that can stay open when the same administrator changes projects. */
export const ontologySkillPanel = 'ontology-skills' as MainPanelId
type Launcher = PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS> & InjectFace<{ openSkills?: (() => void) | undefined }>
type SkillPanelProps = PropsLocale<typeof NS> & InjectFace<{
  close: () => void
  hooks: { skillProject: SnapshotStore<OntologyRuntimeContext | undefined> }
}>

function SkillPanel({ close, t, useSkillProject }: SkillPanelProps) {
  const context = useSkillProject(value => value)
  return <KnowledgeSkillPage close={close} t={t}
    project={context === undefined ? undefined : { id: context.projectId, name: context.projectName }} />
}

function MoreSettings({ wide, openSettings, openSkills, t }: Launcher) {
  const [open, setOpen] = useState(false)
  const options = [{ id: 'settings', label: t('knowledgePanelSettings') },
    ...(openSkills === undefined ? [] : [{ id: 'skills', label: t('knowledgeSkills') }])]
  return <Menu open={open} onClose={() => { setOpen(false) }} items={options} portal side="top" autoFocus
    onSelect={(id) => {
      setOpen(false)
      if (id === 'settings') openSettings()
      if (id === 'skills') openSkills?.()
    }}
    anchor={<Button size="sm" className={wide ? css.moreWide : css.moreRail}
      data-testid="ontology-more-trigger" aria-label={t('knowledgeMoreAria')} aria-haspopup="menu" aria-expanded={open}
      icon={<IconAppsAddOutlineRegular size={16} />} onClick={() => { setOpen(!open) }}>
      {wide && t('knowledgeMore')}
    </Button>} />
}

/**
 * Install the authenticated footer menu and the administrative central page.
 * @param ctx - Browser plugin context.
 * @param admin - Whether the current Ontology identity may manage releases.
 * @param project - The current Project selection verified by the Host.
 * @returns Disposes the account's entries on sign-out or identity change.
 */
export function installSkillNavigation(
  ctx: Context, admin: boolean, project: SnapshotStore<OntologyRuntimeContext | undefined>,
): () => void {
  const fiber = ctx.inject(['layout'], (scope) => {
    if (admin) scope.effect(() => scope.slots.inject('main', () => {
      const dispose = scope.slots.register({
        name: 'main', key: ontologySkillPanel, locale: NS,
        inject: () => ({ close: () => { scope.layout.selectPanel(null) }, hooks: { skillProject: project } }),
      }, SkillPanel)
      return () => {
        if (scope.layout.panelInfo.getSnapshot().activePanelId === ontologySkillPanel) scope.layout.selectPanel(null)
        dispose()
      }
    }))
    scope.effect(() => scope.slots.inject('settings.launcher', () => scope.slots.register({
      name: 'settings.launcher', locale: NS, priority: -10,
      inject: () => ({ openSkills: admin ? () => { scope.layout.selectPanel(ontologySkillPanel) } : undefined }),
    }, MoreSettings)))
  })
  return () => { void fiber.dispose() }
}
