import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

const DEFAULT_PRODUCT_NAME = 'LSY-Agent'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the build's product name beside the independently slotted mark.
 * @returns the product name.
 */
export function OfficialBrandName() {
  return <span>{process.env.DSH_CLIENT_TITLE ?? DEFAULT_PRODUCT_NAME}</span>
}
