// The real composition exposes skill discovery, folder import, and bounded skill management.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

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

  it('imports a skill folder into the selected project without replacing the invocation format', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-manager'))
    const source = join(scaffold.workspaceCwd, CREATED_SKILL)
    await mkdir(source)
    await writeFile(join(source, 'SKILL.md'), [
      '---',
      `name: ${CREATED_SKILL}`,
      'description: Imported through the Web skill manager',
      '---',
      'Return a concise workspace summary.',
      '',
    ].join('\n'))
    await page.getByRole('button', { name: 'Choose skill', exact: true }).click()
    await page.getByRole('dialog', { name: 'Skills', exact: true })
      .getByRole('button', { name: 'Manage skills', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Manage skills', exact: true })
    await manager.locator('input[type="file"]').setInputFiles(source)
    await manager.getByText('Read 1 files', { exact: true }).waitFor()
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Manage skills"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    await manager.getByRole('button', { name: 'Import skill', exact: true }).click()
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
    expect(installed).toContain('description: Imported through the Web skill manager')
    expect(installed).toContain('Return a concise workspace summary.')

    await page.getByRole('button', { name: 'Choose skill', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Skills', exact: true })
      .getByRole('option', { name: new RegExp(CREATED_SKILL) }).count()).toBe(1)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the folder chooser and footer within the viewport with a long managed catalog', async () => {
    const shortPage = await newEnglishPage(browser, 620)
    onTestFinished(() => shortPage.close())
    onTestFailed(() => saveFailureShot(shortPage, 'web-e2e-skill-manager-short'))
    const managedSkills = Array.from({ length: 12 }, (_, index) => ({
      name: `workspace-automation-skill-${index + 1}`,
      description: 'A reusable workflow with a long description that exceeds the row width in a narrow dialog.',
      modelInvocable: true,
      scope: 'personal',
    }))
    // Account catalogs require a tenant login. Supply only that response for the assembled page.
    await shortPage.route('**/api/skills/list', (route) => {
      const request = route.request().postDataJSON() as { rpcId: string }
      return route.fulfill({
        json: {
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: { skills: managedSkills, managedSkills, installScopes: ['personal', 'built-in'] } },
        },
      })
    })
    await shortPage.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(shortPage, scaffold.workspaceCwd)
    await openSettings(shortPage, 'en')
    const settings = shortPage.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Skills', exact: true }).click()
    await settings.getByRole('button', { name: 'Manage skills', exact: true }).click()
    const manager = shortPage.getByRole('dialog', { name: 'Manage skills', exact: true })
    const installed = manager.getByRole('heading', { name: 'Installed skills', exact: true }).locator('..')
    const last = installed.getByRole('button', { name: 'Delete workspace-automation-skill-12', exact: true })
    for (const viewport of [{ width: 1280, height: 620 }, { width: 390, height: 660 }]) {
      await shortPage.setViewportSize(viewport)
      const dialog = await manager.boundingBox()
      expect(dialog?.y).toBeGreaterThan(0)
      expect(dialog!.y + dialog!.height).toBeLessThan(viewport.height)
      for (const name of ['Close skill manager', 'Choose folder', 'Cancel', 'Import skill']) {
        const visible = await manager.getByRole('button', { name, exact: true }).evaluate((button) => {
          const { x, y, width, height } = button.getBoundingClientRect()
          const center = document.elementFromPoint(x + width / 2, y + height / 2)
          return button.contains(center) && y >= 0 && y + height <= window.innerHeight
        })
        expect(visible, `${name} at ${viewport.width}×${viewport.height}`).toBe(true)
      }
      expect(await installed.evaluate(list => list.scrollHeight > list.clientHeight)).toBe(true)
      await last.scrollIntoViewIfNeeded()
      expect(await installed.evaluate(list => list.scrollTop)).toBeGreaterThan(0)
    }

    const height = (await manager.boundingBox())?.height
    await manager.getByRole('tab', { name: 'Built-in skills', exact: true }).click()
    await manager.getByText('No skills are installed in this scope', { exact: true }).waitFor()
    expect((await manager.boundingBox())?.height).toBe(height)
    await manager.getByRole('button', { name: 'Cancel', exact: true }).click()
    await manager.waitFor({ state: 'hidden' })
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['manager.expected.md', 'picker.expected.md'])
  })
})
