/** Recognize candidate pages with bundled assets and an operation-owned browser Worker. */
import { core, createWorker, language, OEM, worker } from './ocr-assets?raw'

/**
 * Find a cited passage in PDF pages whose displayed glyphs are absent from their text layer.
 * @param pages - candidate pages in preferred search order.
 * @param render - isolated canvas rendering provided by the authorized PDF's preview.
 * @param matches - tests a page's recognized prose for citation evidence.
 * @param signal - preview lifetime and time limit.
 * @returns the first page with a verified passage, or undefined.
 */
export async function searchPdfImages(pages: readonly number[], render: (page: number, canvas: HTMLCanvasElement) => Promise<unknown>,
  matches: (text: string) => boolean, signal: AbortSignal): Promise<number | undefined> {
  signal.throwIfAborted()
  const workerUrl = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }))
  const coreUrl = URL.createObjectURL(new Blob([core], { type: 'text/javascript' }))
  const languageUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(language), char => char.charCodeAt(0))]))
  const interrupted = Promise.withResolvers<never>()
  const abort = (): void => { interrupted.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  const opened = createWorker('chi_sim', OEM.LSTM_ONLY, {
    // Suffixes are fragments, so Tesseract can append its filename without leaving the local Blob.
    corePath: `${coreUrl}#engine.js`, langPath: `${languageUrl}#models`, workerPath: workerUrl,
    workerBlobURL: false, cacheMethod: 'none', errorHandler: interrupted.reject,
  })
  const canvas = window.document.createElement('canvas')
  try {
    const engine = await Promise.race([opened, interrupted.promise])
    for (const page of pages) {
      signal.throwIfAborted()
      await render(page, canvas)
      const result = await Promise.race([engine.recognize(canvas), interrupted.promise])
      if (matches(result.data.text)) return page
    }
    return undefined
  } finally {
    signal.removeEventListener('abort', abort)
    // A cancelled initialization may still resolve. Its worker is disposed when it becomes available.
    const cleanup = () => { for (const url of [workerUrl, coreUrl, languageUrl]) URL.revokeObjectURL(url) }
    void opened.then(engine => engine.terminate()).then(cleanup, cleanup)
    if (signal.aborted) cleanup()
  }
}
