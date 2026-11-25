/** Manage the credentials and one-time secret display for a published role. */
import { useState } from 'react'
import { Button, Modal, useClipboardCopy } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillAPIKey, SkillDeliveryAction } from './knowledge-api.ts'
import css from './Knowledge.module.css'

type Copy = PropsLocale<'ontology.login'>
type KeyAction = Extract<SkillDeliveryAction, 'issue-key' | 'revoke-key'>

/** The API key list exposes only masked values after the creation dialog closes. */
export function SkillApiKeys({ keys, issued, pending, failure, busy, onAction, onClose, t }: Copy & {
  keys: readonly SkillAPIKey[]
  issued?: { id: string; value: string } | undefined
  pending?: KeyAction | undefined
  failure?: string | undefined
  busy: boolean
  onAction: (action: KeyAction, keyId?: string) => void
  onClose: () => void
}) {
  const [removal, setRemoval] = useState<SkillAPIKey>()
  return <>
    <Modal open className={css.keyModal ?? ''} title={t('knowledgeKeysTitle')} closeLabel={t('knowledgeClose')}
      onClose={() => { if (!busy) onClose() }}
      footer={<Button variant="primary" disabled={busy} onClick={() => { onAction('issue-key') }}>
        {t(pending === 'issue-key' ? 'knowledgeCreatingKey' : 'knowledgeCreateKey')}
      </Button>}>
      <div className={css.keyTableWrap}>
        <table className={css.keyTable}>
          <thead><tr><th scope="col">{t('knowledgeKeyToken')}</th><th scope="col">{t('knowledgeKeyCreatedAt')}</th><th scope="col">{t('knowledgeKeyActions')}</th></tr></thead>
          <tbody>
            {keys.map(key => <KeyRow key={key.id} token={key} value={issued?.id === key.id ? issued.value : undefined}
              busy={busy} onRemove={() => { setRemoval(key) }} t={t} />)}
            {keys.length === 0 && <tr><td colSpan={3}>{t('knowledgeKeyInactive')}</td></tr>}
          </tbody>
        </table>
      </div>
      {issued !== undefined && <p className={css.releaseHint}>{t('knowledgeKeyOnce')}</p>}
      {pending === 'revoke-key' && <p role="status" className={css.releaseHint}>{t('knowledgeDeleting')}</p>}
      {failure !== undefined && <p role="alert" className={css.error}>{failure || t('knowledgeError')}</p>}
    </Modal>
    {removal !== undefined && <Modal open tone="warning" title={t('knowledgeRevokeKey')} closeLabel={t('knowledgeClose')}
      onClose={() => { setRemoval(undefined) }}
      footer={<>
        <Button variant="outline" data-modal-autofocus onClick={() => { setRemoval(undefined) }}>{t('knowledgeCancel')}</Button>
        <Button className={css.danger} variant="outline" disabled={busy} onClick={() => {
          onAction('revoke-key', removal.id)
          setRemoval(undefined)
        }}>{t('knowledgeConfirmDelete')}</Button>
      </>}>
      <p>{t('knowledgeRevokeKeyHint', { token: removal.preview })}</p>
    </Modal>}
  </>
}

/** Only a newly issued key can be copied in full. */
function KeyRow({ token, value, busy, onRemove, t }: Copy & {
  token: SkillAPIKey
  value?: string | undefined
  busy: boolean
  onRemove: () => void
}) {
  const { copied, onCopy } = useClipboardCopy(value ?? '')
  return <tr>
    <td>{value === undefined ? <code>{token.preview}</code> : <input className={css.keyValue} value={value} readOnly
      aria-label={t('knowledgeIssuedKey')} onFocus={(event) => { event.currentTarget.select() }} />}</td>
    <td>{token.createdAt === null ? '—' : <time dateTime={token.createdAt}>{new Date(token.createdAt).toLocaleString()}</time>}</td>
    <td><div className={css.skillActions}>
      {value !== undefined && <Button size="sm" onClick={onCopy} disabled={busy || copied}>{t(copied ? 'knowledgeCopied' : 'knowledgeCopyValue')}</Button>}
      <Button size="sm" className={css.danger} disabled={busy} onClick={onRemove}
        aria-label={t('knowledgeRevokeKeyLabel', { token: token.preview })}>{t('knowledgeRevokeKey')}</Button>
    </div></td>
  </tr>
}
