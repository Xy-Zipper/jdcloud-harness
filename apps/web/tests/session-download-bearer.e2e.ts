/** Bearer-browser Session export through the native browser download manager. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/navigation-panes/session.v3.jsonl', import.meta.url))
const SESSION_ID = 'session-download-bearer-e2e'
const EXPORTED_LOG_FILE = `session.v${SESSION_FORMAT_VERSION}.jsonl`

async function openSeed(page: Page): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByPlaceholder('Search session names', { exact: false })
  await search.fill('WATERFALL')
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
  await result.click()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await page.getByText('FIRST_DONE', { exact: true }).waitFor({ timeout: 15_000 })
}

describe('web e2e: Session download with a Bearer browser identity', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ browserSessionTransport: 'bearer', publicMount: {} })
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('uses a one-use ticket for the streamed ZIP download', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-download-bearer'))
    await openSeed(page)
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Download session log' }).click()
    const download = await downloadPromise
    expect(download.url()).toContain('downloadTicket=')
    expect(download.suggestedFilename()).toMatch(/^dsh-session-.+\.zip$/u)
    const archive = unzipSync(await readFile(await download.path()))
    expect(Object.keys(archive)).toEqual([EXPORTED_LOG_FILE])
    expect(strFromU8(archive[EXPORTED_LOG_FILE] as Uint8Array)).toContain(SESSION_ID)
    const reusedStatus = await page.evaluate(url => new Promise<number>((resolve, reject) => {
      // XHR is intentionally outside Connection's Fetch wrapper, like the native download manager.
      const request = new XMLHttpRequest()
      request.open('GET', url)
      request.onload = () => { resolve(request.status) }
      request.onerror = () => { reject(new Error('download-ticket reuse probe failed')) }
      request.send()
    }), download.url())
    expect(reusedStatus).toBe(401)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
