/** Recognize durable JDCloud function references without moving their grammar into Conversation core. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface JdcloudLowcodeFunctionData {
  readonly label: string
  readonly menuId: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** Host-confirmed JDCloud function reference serialized into a submitted user message. */
    'jdcloud-lowcode-function': JdcloudLowcodeFunctionData
  }
}

const FUNCTION_REFERENCE_RE = /@\[([^\]\n]+)\]\(dsh-reference:jdcloud-lowcode-function\/([^)\s]+)\)/gu

/** Return the nearest complete JDCloud function marker at or after the requested offset. */
export const jdcloudLowcodeFunctionRule: UserTextRule<'jdcloud-lowcode-function'> = {
  id: 'jdcloud-lowcode-function',
  order: 20,
  match(text, from) {
    FUNCTION_REFERENCE_RE.lastIndex = from
    const match = FUNCTION_REFERENCE_RE.exec(text)
    if (match === null) return undefined
    return {
      id: 'jdcloud-lowcode-function',
      start: match.index,
      end: match.index + match[0].length,
      data: {
        label: match[1] as string,
        menuId: match[2] as string,
      },
    }
  },
}
