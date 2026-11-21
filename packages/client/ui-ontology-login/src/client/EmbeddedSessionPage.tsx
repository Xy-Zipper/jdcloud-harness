/** Ontology session-transfer page shown only inside an embedding application. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { OntologyBrandMark } from './Brand.tsx'
import { NS } from './locales.ts'
import css from './EmbeddedSessionPage.module.css'

/** Full composed props for the embedded root slot. */
export type OntologyEmbeddedSessionPageProps = PropsRuntime<'root'> & PropsLocale<typeof NS>

/** Render a neutral handoff screen while the parent page supplies the Runtime Session. */
export function EmbeddedSessionPage({ t }: OntologyEmbeddedSessionPageProps) {
  const productName = process.env.DSH_CLIENT_TITLE ?? t('brandName')
  const title = t('embeddedTitle', { productName })
  return (
    <main className={css.page} aria-busy="true">
      <section className={css.card} aria-label={title}>
        <div className={css.glow} aria-hidden="true" />
        <div className={css.mark}><OntologyBrandMark size={56} /></div>
        <p className={css.eyebrow}>{productName}</p>
        <h1>{title}</h1>
        <p className={css.description}>{t('embeddedDescription')}</p>
        <div className={css.status} role="status">
          <span className={css.spinner} aria-hidden="true" />
          <span>{t('embeddedStatus')}</span>
        </div>
      </section>
    </main>
  )
}
