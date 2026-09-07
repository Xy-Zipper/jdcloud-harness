/** Browser entry for the JDCloud authentication gate. */

import jdcloudAuthRemote from '@deepseek-ai/dsh-api-jdcloud-auth-controller/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { installJdcloudLoginUi, uiInject } from './mount.ts'

/** Required service for mounting the generated JDCloud Remote contribution. */
export const inject = ['remote']

/** Mount the JDCloud Remote namespace and the login root as one lifecycle. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(jdcloudAuthRemote)
  const ui = ctx.inject(uiInject, installJdcloudLoginUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
