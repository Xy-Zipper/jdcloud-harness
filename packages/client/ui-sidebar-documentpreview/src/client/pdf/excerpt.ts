/** Find an original PDF page from cited text when ingestion supplied no page number. */
import type { PdfDocument } from './document.ts'

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')

/** The fallback searches rendered pages only when their text layer cannot match. */
interface ImageSearch {
  readonly position: number | undefined
  readonly search: (pages: readonly number[], matches: (text: string) => boolean) => Promise<number | undefined>
}

/**
 * Search text layers by distinct runs of the citation, allowing differences in layout and punctuation.
 * @param document - loaded PDF.
 * @param prose - plain text runs from the cited excerpt in document order.
 * @param signal - preview lifetime.
 * @param images - optional OCR search with a relative document-position hint.
 * @returns the strongest unambiguous matching page, or undefined if the PDF provides insufficient evidence.
 */
export async function findPdfExcerptPage(
  document: PdfDocument, prose: readonly string[], signal: AbortSignal, images?: ImageSearch,
): Promise<number | undefined> {
  const phrases = new Set<string>()
  for (const run of prose) {
    const text = normalize(run)
    // Match several runs so a repeating page header cannot outscore more specific body text.
    for (let start = 0; start + 14 <= text.length; start += 32) phrases.add(text.slice(start, start + 48))
  }
  const queries = [...phrases].sort((a, b) => b.length - a.length).slice(0, 16)
  if (queries.length === 0) return undefined
  let best = 0
  let found: number | undefined
  const lengths: number[] = []
  for (let number = 1; number <= document.numPages; number++) {
    signal.throwIfAborted()
    const page = await document.getPage(number)
    try {
      signal.throwIfAborted()
      const { items } = await page.getTextContent()
      signal.throwIfAborted()
      const fullText = items.map(item => 'str' in item ? item.str : '').join('')
      lengths.push(fullText.replace(/\s/gu, '').length)
      const text = normalize(fullText)
      const score = queries.reduce((sum, query) => sum + (text.includes(query) ? query.length : 0), 0)
      if (score > best) {
        best = score
        found = number
      } else if (score === best) {
        found = undefined
      }
    } finally {
      page.cleanup()
    }
  }
  if (best > 0 || images === undefined) return found

  // A long exact phrase tolerates OCR errors elsewhere while requiring evidence from the page's image.
  const anchors = new Set<string>()
  for (const run of prose) {
    const text = normalize(run)
    for (let start = 0; start + 16 <= text.length && anchors.size < 128; start += 8) {
      anchors.add(text.slice(start, start + 24))
    }
  }
  if (anchors.size === 0) return undefined
  return images.search(prioritizePdfPages(lengths, images.position), (text) => {
    const value = normalize(text)
    for (const anchor of anchors) if (value.includes(anchor)) return true
    return false
  })
}

/** Try the page nearest the index position before using glyph counts to order the remaining candidates. */
function prioritizePdfPages(lengths: readonly number[], position: number | undefined): number[] {
  if (position === undefined) return lengths.map((_length, index) => index + 1)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const estimatedLength = total / lengths.filter(Boolean).length || 1
  const weights = lengths.map(length => length || estimatedLength)
  const target = position * weights.reduce((sum, length) => sum + length, 0)
  let previous = 0
  const weighted = weights.map((length, index) => {
    const result = { page: index + 1, distance: Math.abs(previous + length / 2 - target) }
    previous += length
    return result
  }).sort((a, b) => a.distance - b.distance).map(item => item.page)
  const estimate = Math.min(lengths.length, Math.floor(position * lengths.length) + 1)
  return [estimate, ...weighted.filter(page => page !== estimate)]
}
