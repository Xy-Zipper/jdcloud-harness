// Web e2e scenario: the real composition exposes the searchable skill picker
// and persists one manager-created SKILL.md inside the selected project.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/skill-picker', import.meta.url))
const PICKER_EXPECTED = join(SNAPSHOT_DIR, 'picker.expected.md')
const MANAGER_EXPECTED = join(SNAPSHOT_DIR, 'manager.expected.md')
const MODE = webSnapshotMode()

const SEEDED_SKILL = 'workspace-summary'
const CREATED_SKILL = 'web-created-demo'

/** Seed one ordinary project skill for searchable picker discovery. */
async function seedSkill(workspaceCwd: string): Promise<void> {
  const directory = join(workspaceCwd, 'workspace', '.agents', 'skills', SEEDED_SKILL)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${SEEDED_SKILL}`,
    'description: Summarize the current workspace',
    '---',
    '',
    'Return a concise workspace summary.',
    '',
  ].join('\n'))
}

describe('web e2e: searchable skill picker and project-local management', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const installDiagnostics: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSkill(scaffold.workspaceCwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('console', (message) => {
      if (message.text().includes('[ui-skill] skill installation')) {
        installDiagnostics.push(message.text())
      }
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('searches and inserts a catalog skill through the dedicated composer button', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-picker'))
    const input = page.locator('[data-composer-input]').first()
    await page.getByRole('button', { name: 'Choose skill', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Skills', exact: true })
    await picker.waitFor({ timeout: 10_000 })
    await picker.getByRole('textbox', { name: 'Search skills' }).fill('workspace')
    expect(await picker.getByRole('option', { name: /workspace-summary/ }).count()).toBe(1)
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Skills"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PICKER_EXPECTED, snapshot, MODE)

    await picker.getByRole('option', { name: /workspace-summary/ }).click()
    await expect.poll(() => input.textContent()).toBe(`/${SEEDED_SKILL} `)
    await writeComposerDraft(page, input, '')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('creates a skill in the selected project without replacing the invocation format', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-manager'))
    await page.getByRole('button', { name: 'Choose skill', exact: true }).click()
    await page.getByRole('dialog', { name: 'Skills', exact: true })
      .getByRole('button', { name: 'Manage skills', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Manage skills', exact: true })
    await manager.getByRole('textbox', { name: 'Skill name' }).fill(CREATED_SKILL)
    await manager.getByRole('textbox', { name: 'Description' }).fill('Created through the Web skill manager')
    await manager.getByRole('textbox', { name: 'Instructions' }).fill('Return a concise workspace summary.')
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Manage skills"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    await manager.getByRole('button', { name: 'Save skill', exact: true }).click()
    await expect.poll(async () => ({
      dialog: await manager.count(),
      error: await manager.getByRole('alert').textContent().catch(() => null),
    }), { timeout: 10_000 }).toEqual({ dialog: 0, error: null }).catch((error: unknown) => {
      throw new Error(`skill manager did not close: ${installDiagnostics.join('\n')}`, { cause: error })
    })

    const installed = await readFile(
      join(scaffold.workspaceCwd, 'workspace', '.dsh', 'skills', CREATED_SKILL, 'SKILL.md'),
      'utf8',
    )
    expect(installed).toContain(`name: ${CREATED_SKILL}`)
    expect(installed).toContain('description: "Created through the Web skill manager"')
    expect(installed).toContain('Return a concise workspace summary.')

    await page.getByRole('button', { name: 'Choose skill', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Skills', exact: true })
      .getByRole('option', { name: new RegExp(CREATED_SKILL) }).count()).toBe(1)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['manager.expected.md', 'picker.expected.md'])
  })
})
