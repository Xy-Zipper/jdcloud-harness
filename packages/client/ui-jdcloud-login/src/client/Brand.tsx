/** JDCloud geometric brand artwork shared by the login and application shells. */

import { useId } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './Brand.module.css'

/** Presentation accepted by both sidebar and blank-conversation brand slots. */
export interface JdcloudBrandMarkProps {
  /** Requested square edge in pixels. */
  size: number
  /** Optional host class preserving surrounding layout geometry. */
  className?: string | undefined
}

/** Locale share used by the product-name slot. */
export type JdcloudBrandNameProps = PropsLocale<typeof NS>

/**
 * Render the JDCloud hexagonal circuit-J mark.
 * @param props - Host-requested size and optional layout class.
 * @returns decorative gradient SVG artwork.
 */
export function JdcloudBrandMark({ size, className }: JdcloudBrandMarkProps) {
  const gradientId = useId()
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      data-jdcloud-brand-mark="true"
    >
      <path d="M24 2.5 42.6 13.25v21.5L24 45.5 5.4 34.75v-21.5L24 2.5Z" fill={`url(#${gradientId})`} />
      <path d="M24 7.2 38.5 15.6v16.8L24 40.8 9.5 32.4V15.6L24 7.2Z" stroke="white" strokeOpacity=".24" />
      <circle cx="15.7" cy="17.2" r="2.2" fill="white" />
      <path
        d="M17.9 17.2h12.2v11.4c0 5.2-3.5 8.4-8.7 8.4-3.8 0-6.7-1.8-8.2-5l4.4-2.1c.8 1.6 2 2.4 3.8 2.4 2.3 0 3.7-1.4 3.7-4V22h-7.2v-4.8Z"
        fill="white"
      />
      <defs>
        <linearGradient id={gradientId} x1="7" y1="7" x2="41" y2="41" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563EB" />
          <stop offset=".55" stopColor="#0EA5E9" />
          <stop offset="1" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/**
 * Render the localized JDCloud product name without duplicating the mark.
 * @param props - Slot-provided locale translator.
 * @returns the sidebar wordmark text.
 */
export function JdcloudBrandName({ t }: JdcloudBrandNameProps) {
  return <span className={css.name}>{t('brandName')}</span>
}
