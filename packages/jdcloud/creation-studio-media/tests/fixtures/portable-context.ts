/** Keep this media-only snapshot independent of JSON escaping in the randomly allocated Windows cwd. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

export const name = 'media-snapshot-portable-context'
export const inject = ['systemPrompt', 'workingDirectory']

/** Render the actual cwd without JSON quoting so the shared snapshot path tokenizer can replace it. */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: () => `Current working directory: ${ctx.workingDirectory.get(agent.session)}.`,
    })
  })
}
