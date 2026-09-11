/** New-conversation cards for Host-confirmed writable JDCloud menus. */

import type { JdcloudWritableMenu } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import { IconBranchOutline16, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import type { WritableMenuPickerInjected } from './types.ts'
import { NS } from './locales.ts'
import css from './LowcodeActionPicker.module.css'

/** Full props for the writable-menu cards in the input dock. */
export type LowcodeActionPickerProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<WritableMenuPickerInjected>
  & PropsLocale<typeof NS>

/** Show one single-select menu panel only while the current Session is blank. */
export function LowcodeActionPicker({
  sessionId,
  session,
  input,
  useWritableMenus,
  selectMenu,
  t,
}: LowcodeActionPickerProps) {
  const menuState = useWritableMenus(state => state)
  const selected = input.occurrences.some(occurrence => occurrence.source === 'jdcloud-lowcode-function')
  const [pendingSessionId, setPendingSessionId] = useState<typeof sessionId>()
  const selectionLock = useRef<typeof sessionId>()

  // The optimistic state closes the panel in the click frame; the inserted chip owns the lasting selection.
  useEffect(() => {
    if (!selected) return
    selectionLock.current = undefined
    setPendingSessionId(undefined)
  }, [selected])

  if (!session.blank
    || session.promptAttempted
    || session.subagent !== null
    || selected
    || pendingSessionId === sessionId
    || menuState.phase !== 'ready'
    || menuState.menus.length === 0) return null

  return (
    <section className={css.panel} aria-label={t('panelAria')} data-jdcloud-lowcode-actions="">
      <div className={css.list}>
        {menuState.menus.map(menu => (
          <button
            key={menu.menuId}
            type="button"
            className={css.card}
            title={menu.path}
            onClick={() => {
              if (selectionLock.current === sessionId) return
              selectionLock.current = sessionId
              setPendingSessionId(sessionId)
              if (selectMenu(menu, input.draftRev)) return
              selectionLock.current = undefined
              setPendingSessionId(undefined)
            }}
          >
            <span className={css.icon} aria-hidden="true">
              {menu.type === 3 ? <IconDataOutline16 size={20} /> : <IconBranchOutline16 size={20} />}
            </span>
            <span className={css.content}>
              <span className={css.name}>{menu.fullName}</span>
              <span className={css.path}>{menu.path}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** Menu type retained by the component's public test surface. */
export type { JdcloudWritableMenu }
