/** Inline presentation of one Host-confirmed JDCloud low-code function marker. */
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

interface JdcloudLowcodeFunctionReferenceProps {
  readonly node: { readonly data: { readonly label: string } }
  readonly raw: string
}

/**
 * Render a durable JDCloud function marker as its original at-tag label.
 * @param props - resolved marker data and its exact source spelling.
 * @returns an iconless, display-only reference chip.
 */
export function JdcloudLowcodeFunctionReference({
  node,
  raw,
}: JdcloudLowcodeFunctionReferenceProps) {
  return <ReferenceChip appearance="reference" label={`@${node.data.label}`} title={raw} />
}
