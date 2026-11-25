/** Type declaration for the build-owned PDF.js worker source. */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?raw' {
  const source: string
  export default source
}

declare module '*ocr-assets?raw' {
  export const worker: string
  export const core: string
  export const language: string
  export const createWorker: typeof import('tesseract.js').createWorker
  export const OEM: typeof import('tesseract.js').OEM
}
