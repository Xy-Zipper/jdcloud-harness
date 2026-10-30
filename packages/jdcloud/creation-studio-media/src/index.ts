/** Typed Loader entry for the migrated Creation Studio media execution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import * as media from './plugin.mjs'

/** Fixed platform, persistent receipts, and Host-only credential references. */
export interface Config {
  platformURL: string
  tenantId: string
  stateDirectory: string
  imageModel: string
  imageRetryLimit: number
  imageKeyRef: string
  arkKeyRef: string
}

export const name = media.name
export const inject = media.inject
export const Config = media.Config

/**
 * Mount authenticated media routes and tools; unloading waits for pending receipts.
 * @param ctx - Harness Host services.
 * @param config - Fixed platform, task storage, and credential references.
 */
export function apply(ctx: Context, config: Config): void {
  media.apply(ctx, config)
}
