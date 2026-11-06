/** Typed Loader entry for the migrated Creation Studio media execution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import * as media from './plugin.mjs'

/** Fixed platform, persistent receipts, and Host-only credential references. */
export interface Config {
  /** Fixed HTTPS low-code platform origin. */
  platformURL: string
  /** Tenant owning the project, account pool, and usage tables. */
  tenantId: string
  /** Private directory exclusively owned by one Host for tasks, reservations, and uploads. */
  stateDirectory: string
  /** Default Seedream model when a new request omits model selection. */
  imageModel: string
  /** Automatic replacement budget for already-persisted legacy GPT tasks. */
  imageRetryLimit: number
  /** Host credential reference used only to recover legacy GPT tasks. */
  imageKeyRef: string
  /** Single Ark credential used when the private account-pool reader is absent. */
  arkKeyRef: string
  /** Administrator-only table containing numbered Ark and Jimeng credentials. */
  accountPoolTableId: string
  /** Optional legacy token reference; password login takes priority when configured. */
  accountPoolKeyRef: string
  /** Host credential reference for the account-table service login name. */
  accountPoolUsernameRef: string
  /** Host credential reference for its password; expiry triggers one shared login and read retry. */
  accountPoolPasswordRef: string
  /** Optional restricted service credential for metered usage synchronization. */
  billingWriterKeyRef: string
  /** Legacy Jimeng access-key reference used without a private pool reader. */
  jimengAccessKeyRef: string
  /** Legacy Jimeng secret-key reference used without a private pool reader. */
  jimengSecretKeyRef: string
}

export const name = media.name
export const inject = ['attachments', 'credentials', 'jdcloudAuthController', 'tools', 'webServer']
/** Loader defaults and accepted models are inspectable by the configuration catalog. */
export const Config = z.object({
  platformURL: z.string().required(),
  tenantId: z.string().required(),
  stateDirectory: z.string().required(),
  imageModel: z.union(['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915']).default('doubao-seedream-5-0-pro-260628'),
  imageRetryLimit: z.natural().default(4),
  imageKeyRef: z.string().default('GPT_IMAGE_API_KEY'),
  arkKeyRef: z.string().default('ARK_API_KEY'),
  accountPoolTableId: z.string().default('6aead43ac3ca9f3dcdaf4b23'),
  accountPoolKeyRef: z.string().default('CREATION_STUDIO_ACCOUNT_POOL_TOKEN'),
  accountPoolUsernameRef: z.string().default('CREATION_STUDIO_ACCOUNT_POOL_USERNAME'),
  accountPoolPasswordRef: z.string().default('CREATION_STUDIO_ACCOUNT_POOL_PASSWORD'),
  billingWriterKeyRef: z.string().default('CREATION_STUDIO_BILLING_WRITER_TOKEN'),
  jimengAccessKeyRef: z.string().default('JIMENG_ACCESS_KEY_ID'),
  jimengSecretKeyRef: z.string().default('JIMENG_SECRET_ACCESS_KEY'),
})

/**
 * Mount authenticated media routes and tools; unloading waits for pending receipts.
 * @param ctx - Harness Host services.
 * @param config - Fixed platform, task storage, and credential references.
 */
export function apply(ctx: Context, config: Config): void {
  media.apply(ctx, config)
}
