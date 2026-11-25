import { expect, it, vi } from 'vitest'
import { findPdfExcerptPage } from '../src/client/pdf/excerpt.ts'
import type { PdfDocument } from '../src/client/pdf/document.ts'

function pdf(...pages: string[][]): PdfDocument {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => ({
      getTextContent: async () => ({ items: pages[number - 1]?.map(str => ({ str })) ?? [] }),
      cleanup: () => true,
    })) as unknown as PdfDocument['getPage'],
  }
}

it('finds the cited content on a later page across text-layer breaks', async () => {
  const document = pdf(['Sunshine Cafeteria Operations Manual'], [
    'Sunshine Cafeteria Operations Manual', '增删改查各品类商品信息，', '方便学校和供应商快速管理商品。',
  ])
  await expect(findPdfExcerptPage(document, [
    'Sunshine Cafeteria Operations Manual', '增删改查各品类商品信息, 方便学校和供应商快速管理商品。',
  ], new AbortController().signal)).resolves.toBe(2)
})

it('leaves an ambiguous or image-only excerpt without a page', async () => {
  const document = pdf(['Sunshine Cafeteria Operations Manual'], ['Sunshine Cafeteria Operations Manual'])
  const signal = new AbortController().signal
  await expect(findPdfExcerptPage(document, ['Sunshine Cafeteria Operations Manual'], signal)).resolves.toBeUndefined()
  await expect(findPdfExcerptPage(document, ['图'], signal)).resolves.toBeUndefined()
})

it('prioritizes image pages near the source position and requires recognized excerpt text', async () => {
  const document = pdf([''], ['!"#'.repeat(28)], ['!"$'.repeat(28)])
  const prose = ['分户图是在分丘图基础上绘制的细部图，以一户产权人为单位。']
  const search = vi.fn(async (pages: readonly number[], matches: (text: string) => boolean) => {
    expect(pages[0]).toBe(3)
    expect(matches('其他小节的章节名称和页眉')).toBe(false)
    return pages.find(page => page === 3 && matches('分户图是在分丘图基础上绘制的细部图, 以一户产权人为单位'))
  })
  await expect(findPdfExcerptPage(document, prose, new AbortController().signal, { position: 0.86, search })).resolves.toBe(3)
  expect(search).toHaveBeenCalledOnce()
})

it('checks the approximate page first when unreadable text-layer lengths skew the order', async () => {
  const document = pdf(['!'.repeat(1000)], ['!'], ['!'.repeat(20)], ['!'])
  const prose = ['分户图是在分丘图基础上绘制的细部图，以一户产权人为单位。']
  const search = vi.fn(async (pages: readonly number[], matches: (text: string) => boolean) => {
    expect(pages[0]).toBe(3)
    expect([...pages].sort()).toEqual([1, 2, 3, 4])
    return pages.find(page => matches(page === 3 ? prose[0]! : '其他页面'))
  })
  await expect(findPdfExcerptPage(document, prose, new AbortController().signal, { position: 0.6, search })).resolves.toBe(3)
})
