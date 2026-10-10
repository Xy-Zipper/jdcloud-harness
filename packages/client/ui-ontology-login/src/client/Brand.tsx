/** Ontology graph artwork shared by login and application shells. */

import { useId } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './Brand.module.css'

/** Presentation accepted by sidebar and conversation brand slots. */
export interface OntologyBrandMarkProps {
  /** Requested square edge in pixels. */
  size: number
  /** Optional host class preserving surrounding layout geometry. */
  className?: string | undefined
}

/** Locale share used by the product-name slot. */
export type OntologyBrandNameProps = PropsLocale<typeof NS>

/**
 * Render the Ontology connected-node mark.
 * @param props - Host-requested size and optional layout class.
 * @returns Decorative gradient SVG artwork.
 */
export function OntologyBrandMark({ size, className }: OntologyBrandMarkProps) {
  const gradientId = useId()
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      data-ontology-brand-mark="true"
    >
      <rect x="3" y="3" width="42" height="42" rx="10" fill={`url(#${gradientId})`} />
      <path d="M15 17 24 12l9 5v12l-9 6-9-6V17Z" stroke="white" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="m15 17 9 6 9-6M24 23v12" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="15" cy="17" r="2.5" fill="white" />
      <circle cx="24" cy="12" r="2.5" fill="white" />
      <circle cx="33" cy="17" r="2.5" fill="white" />
      <circle cx="24" cy="35" r="2.5" fill="white" />
      <defs>
        <linearGradient id={gradientId} x1="5" y1="4" x2="44" y2="45" gradientUnits="userSpaceOnUse">
          <stop stopColor="#156CFD" />
          <stop offset="1" stopColor="#6728D0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/**
 * Render the localized Ontology product name.
 * @param props - Slot-provided locale translator.
 * @returns Sidebar wordmark text.
 */
export function OntologyBrandName({ t }: OntologyBrandNameProps) {
  return <span className={css.name}>{process.env.DSH_CLIENT_TITLE ?? t('brandName')}</span>
}
