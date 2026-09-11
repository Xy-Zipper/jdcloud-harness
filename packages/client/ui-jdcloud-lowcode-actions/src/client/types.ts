/** Browser-only state and slot injection types for the JDCloud action picker. */

import type { JdcloudWritableMenu } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Load state of the current tenant's writable menus. */
export type WritableMenuState =
  | { readonly phase: 'loading'; readonly menus: readonly [] }
  | { readonly phase: 'ready'; readonly menus: readonly JdcloudWritableMenu[]; readonly corpId: string }
  | { readonly phase: 'error'; readonly menus: readonly [] }

/** Per-Session picker hooks and the guarded reference insertion verb. */
export interface WritableMenuPickerInjected {
  readonly hooks: { readonly writableMenus: SnapshotStore<WritableMenuState> }
  /** Insert one function tag at the start of the current draft revision. */
  readonly selectMenu: (menu: JdcloudWritableMenu, draftRev: number) => boolean
}
