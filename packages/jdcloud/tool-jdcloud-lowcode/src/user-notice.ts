/**
 * Customer-facing notices for expected JDCloud refusals.
 *
 * The model never composes these. A refusal that a customer can act on is a
 * product decision, so it is fixed here instead of being re-derived per turn:
 * the alternative leaves backend vocabulary (capability names, endpoint
 * paths) and self-service configuration advice in customer-visible output.
 */

import type { LowcodeWritePermission } from './current-user.ts'

/** What the customer is trying to do, in customer vocabulary. */
export type LowcodeWriteAction = 'create' | 'update' | 'delete'

/**
 * One refusal a customer could resolve by asking an administrator, paired with
 * the machine-routable code that carries it to the Host.
 */
export interface LowcodeUserNotice {
  readonly message: string
  readonly code: string
}

/** Machine-routable code for a write refused by a missing JDCloud grant. */
export const NOTICE_CODE_PERMISSION_REQUIRED = 'JDCLOUD_LOWCODE_PERMISSION_REQUIRED'

/** Machine-routable code for a capability snapshot taken before the current turn. */
export const NOTICE_CODE_SNAPSHOT_REQUIRED = 'JDCLOUD_LOWCODE_SNAPSHOT_REQUIRED'

const ACTION_LABELS: Readonly<Record<LowcodeWriteAction, string>> = {
  create: '新增',
  update: '修改',
  delete: '删除',
}

/**
 * Build the notice for a write the current account is not authorized to perform.
 *
 * Every grant-backed action shares one sentence so the customer sees a single
 * consistent policy rather than a per-operation variant, and the sentence names
 * no JDCloud capability identifier — `addData` and its siblings are contract
 * vocabulary, not something a customer can act on. The requested wording names
 * the administrator as the actor, because the customer cannot grant it.
 *
 * @param action - the write the customer asked for.
 * @returns customer-visible text plus the Host-routable code.
 */
export function permissionNotice(action: LowcodeWriteAction): LowcodeUserNotice {
  return {
    message: `您当前暂无${ACTION_LABELS[action]}权限，请联系管理人员完成授权后再进行操作。`,
    code: NOTICE_CODE_PERMISSION_REQUIRED,
  }
}

/**
 * Build the notice for a write attempted before the current turn's capability
 * snapshot was refreshed.
 *
 * The customer cannot cause this directly — it means the request reached the
 * tools without a browser prompt in the open turn — so the sentence asks for
 * the only action that does resolve it rather than explaining the mechanism.
 *
 * @returns customer-visible text plus the Host-routable code.
 */
export function staleSnapshotNotice(): LowcodeUserNotice {
  return {
    message: '当前操作已失效，请重新发送一次您的请求后再操作。',
    code: NOTICE_CODE_SNAPSHOT_REQUIRED,
  }
}

/**
 * Map one JDCloud write grant to the customer action it authorizes.
 * @param permission - write grant returned by the JDCloud capability snapshot.
 * @returns customer action authorized by the grant.
 */
export function actionForPermission(permission: LowcodeWritePermission): LowcodeWriteAction {
  switch (permission) {
    case 'addData': return 'create'
    case 'editData': return 'update'
    case 'deleteData': return 'delete'
  }
}
