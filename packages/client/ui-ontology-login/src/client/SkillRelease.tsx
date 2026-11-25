/** Copyable integration options for one published Skill. */
import { useState } from 'react'
import { Button, useClipboardCopy } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { KnowledgeSkill, SkillDeliveryAction } from './knowledge-api.ts'
import { SkillApiKeys } from './SkillApiKeys.tsx'
import { SkillApiDocs } from './SkillApiDocs.tsx'
import css from './Knowledge.module.css'

const channels = [
  ['iframe', 'knowledgeIframe'], ['widget', 'knowledgeWidget'], ['api', 'knowledgeAPI'],
] as const
type Channel = typeof channels[number][0]
type Copy = PropsLocale<'ontology.login'>

/** Present the active release's integration code and credential controls. */
export function SkillRelease({ skill, busy, issuedKey, pendingKey, keyFailure, onAction, onClearKey, t }: Copy & {
  skill: KnowledgeSkill
  busy: boolean
  issuedKey?: { id: string; value: string } | undefined
  pendingKey?: 'issue-key' | 'revoke-key' | undefined
  keyFailure?: string | undefined
  onClearKey: () => void
  onAction: (action: SkillDeliveryAction, keyId?: string) => void
}) {
  const [channel, setChannel] = useState<Channel>('iframe')
  const [showKeys, setShowKeys] = useState(false)
  const root = new URL('./', document.baseURI)
  const privateChat = new URL(root)
  privateChat.searchParams.set('knowledgeSkill', skill.id)
  const shared = skill.delivery?.embedToken
  const keys = skill.delivery?.apiKeys ?? []
  const iframeUrl = new URL('api/ontology-skill/v1/chat', root)
  if (shared !== undefined) iframeUrl.hash = shared
  const widgetUrl = new URL('api/ontology-skill/v1/widget.js', root)
  const apiUrl = new URL(`api/ontology-skill/v1/skills/${skill.id}/`, root)

  return <section className={css.skillCard} aria-label={t('knowledgeRelease')}>
    <header className={css.releaseHeader}>
      <div><h2>{t('knowledgeRelease')}</h2><span>{t('knowledgeVersion', { version: String(skill.version) })}</span></div>
      <a className={css.link} href={privateChat.href} target="_blank" rel="noreferrer">{t('knowledgeTry')}</a>
    </header>
    <div className={css.skillActions} aria-label={t('knowledgeChannels')} role="group">
      {channels.map(([id, label]) => <Button key={id} size="sm" variant={channel === id ? 'primary' : 'outline'}
        aria-pressed={channel === id} disabled={busy} onClick={() => { setChannel(id) }}>{t(label)}</Button>)}
    </div>
    {channel === 'api' ? <>
      <div className={css.skillActions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setShowKeys(true) }}>{t('knowledgeManageKeys')}</Button>
        <small>{keys.length === 0 ? t('knowledgeKeyInactive') : t('knowledgeKeyCount', { count: String(keys.length) })}</small>
      </div>
      {showKeys && <SkillApiKeys keys={keys} issued={issuedKey} pending={pendingKey} failure={keyFailure} busy={busy}
        onAction={onAction} onClose={() => { setShowKeys(false); onClearKey() }} t={t} />}
      <SkillApiDocs base={apiUrl} t={t} />
    </> : <>
      <p className={css.releaseHint}>{t('knowledgePublicHint')}</p>
      <div className={css.skillActions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => {
          onAction(shared === undefined ? 'enable-embed' : 'disable-embed')
        }}>{t(shared === undefined ? 'knowledgeEnableEmbed' : 'knowledgeDisableEmbed')}</Button>
        {shared !== undefined && <a className={css.link} href={iframeUrl.href} target="_blank" rel="noreferrer">{t('knowledgeOpenShared')}</a>}
      </div>
      {shared !== undefined && <CopyField label={t(channel === 'iframe' ? 'knowledgeIframeCode' : 'knowledgeWidgetCode')}
        value={channel === 'iframe'
          ? `<iframe src="${iframeUrl.href}" title="Skill" style="width:100%;height:100dvh;border:0" referrerpolicy="no-referrer"></iframe>`
          : `<script defer src="${widgetUrl.href}" data-skill-share="${shared}"></script>`}
        t={t} />}
    </>}
  </section>
}

/** Copy a snippet, endpoint, or newly issued key without exposing it to a different entry. */
function CopyField({ label, value, t }: Copy & { label: string; value: string }) {
  const { copied, onCopy } = useClipboardCopy(value)
  return <div className={css.copyField}>
    <label className={css.field}>{label}
      <textarea value={value} rows={4} spellCheck={false} readOnly onFocus={(event) => { event.currentTarget.select() }} />
    </label>
    <Button size="sm" variant="outline" onClick={onCopy} disabled={copied}>{t(copied ? 'knowledgeCopied' : 'knowledgeCopyValue')}</Button>
  </div>
}
