/** Browser entry for the Ontology authentication gate. */

import ontologyAuthRemote from '@deepseek-ai/dsh-api-ontology-auth-controller/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { installOntologyLoginUi, uiInject } from './mount.ts'

/** Required service for mounting the generated Ontology Remote contribution. */
export const inject = ['remote']

/** Mount the Ontology Remote namespace and login UI as one lifecycle. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(ontologyAuthRemote)
  const ui = ctx.inject(uiInject, installOntologyLoginUi)
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
