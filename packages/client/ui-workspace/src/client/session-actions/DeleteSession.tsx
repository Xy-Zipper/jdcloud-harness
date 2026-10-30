/** Permanent Session deletion requires confirmation outside the dismissible row menu. */
import { useState } from 'react'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteConfirmProps, SessionMenuItemProps, SessionRowOwnerProps,
} from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/**
 * Open a permanent-deletion confirmation after dismissing the row menu.
 * @param props - Session identity, menu state, locale and confirmation callback.
 * @returns the destructive menu row.
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, useSessionAccess, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const allowed = useSessionAccess(sessionId, 'session/delete')
  if (!allowed) return null
  return (
    <MenuItemButton danger separatorBefore icon={<IconTrashOutlineRegular size={14} />} onSelect={() => {
      setMenuOpen(false)
      requestSessionDelete(sessionId, displayTitle)
    }}>
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * Render one confirmation per target, keeping failures visible for retry.
 * @param props - pending target, deletion callback and locale.
 * @returns the confirmation, or null without a pending target.
 */
export function SessionDeleteConfirmDialog(props: SessionDeleteConfirmProps) {
  const request = props.useDeleteRequest(value => value)
  if (request === null) return null
  return <DeleteForm key={request.sessionId} request={request} {...props} />
}

/** Busy state prevents dismissal or duplicate irreversible submissions. */
function DeleteForm({ request, deleteSession, settleSessionDelete, t }: SessionDeleteConfirmProps & {
  request: SessionRowOwnerProps
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => { if (!busy) settleSessionDelete() }
  const confirm = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    deleteSession(request.sessionId).then(settleSessionDelete).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : t('delete.session.failed'))
    })
  }
  return (
    <Modal open onClose={close} closeLabel={t('close')} title={t('menu.deleteSession')}
      description={t('delete.session.desc', { title: request.displayTitle || t('session.untitled') })}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={css.deleteAction} disabled={busy} onClick={confirm}>
            {t('menu.deleteSession')}
          </Button>
        </>
      )}>
      {busy && <div className={css.deleteStatus} role="status">{t('delete.session.pending')}</div>}
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
