// Keyless browser e2e: the shipped DeepSeek adapter stays mounted while its
// credential is absent, no first-run credential modal takes over the product,
// and the ordinary Models page stores the key in an isolated harness home.
import { randomBytes } from 'node:crypto'
import { assertModelInputLayout } from './model-input-layout.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/onboarding-deepseek-config', import.meta.url))
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const DEFAULT_MODELS_EXPECTED = join(SNAPSHOT_DIR, 'default-models.expected.md')
const REMOTE_MODELS_EXPECTED = join(SNAPSHOT_DIR, 'remote-models.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: DeepSeek configuration without first-run takeover', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', message => browserConsole.push(message.text()))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens normally and stores a key write-only from Models', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-config'))
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    const keyInput = settings.getByLabel('API 密钥', { exact: true })
    await keyInput.waitFor({ timeout: 10_000 })

    const secret = `dsh_models_${randomBytes(12).toString('hex')}`
    await keyInput.fill(secret)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await keyInput.waitFor({ state: 'detached', timeout: 15_000 })

    const stored = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(stored.includes(`DEEPSEEK_API_KEY: ${secret}`)).toBe(true)
    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)

    // The Models surface reuses the refreshed join and exposes the configured
    // write-only placeholder without a reload.
    const deepSeekRow = settings.getByText('DeepSeek', { exact: true }).first()
    await deepSeekRow.waitFor({ timeout: 10_000 })
    await deepSeekRow.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    const configuredInput = settings.getByLabel('API 密钥', { exact: true })
    await configuredInput.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => configuredInput.getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe('已配置——输入新值可替换')

    const secondReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, secondReloadWarnings)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)

    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('configures arbitrary DeepSeek models and prompts after the selected model is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-models'))
    // Opened here rather than inherited: the credential test reloads the page
    // after configuring the key, so nothing carries an open dialog across.
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    const deepSeek = settings.getByText('DeepSeek', { exact: true }).first()
    await deepSeek.waitFor({ timeout: 10_000 })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    await settings.getByText('自定义设置').click()
    expect(await settings.getByLabel('模型 ID 1').inputValue()).toBe('deepseek-flash')
    expect(await settings.getByLabel('显示名称 1').inputValue()).toBe('DeepSeek-V41-Flash')
    expect(await settings.getByLabel('模型 ID 2').inputValue()).toBe('deepseek-v4-pro')
    expect(await settings.getByRole('button', { name: /删除模型/ }).count()).toBe(2)
    await settings.getByRole('button', { name: '模型选项 1' }).click()
    expect(await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).isChecked()).toBe(true)
    await assertModelInputLayout(page, settings)
    const defaultModels = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DEFAULT_MODELS_EXPECTED, defaultModels, MODE)
    await settings.getByLabel('显示名称 1').fill('Configured Flash')
    await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).uncheck()
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByLabel('模型 ID 1').waitFor({ state: 'detached', timeout: 15_000 })
    const savedDefaults = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(savedDefaults).toContain('id: deepseek-flash')
    expect(savedDefaults).toContain('inputModalities:')
    expect(savedDefaults).toContain('- text')
    expect(savedDefaults).toContain('systemPromptUpdate: in-history')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      name: 'Configured Flash', inputModalities: ['text'], systemPromptUpdate: 'in-history',
    })
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-pro')).resolves.toMatchObject({
      name: 'DeepSeek-V4-Pro', inputModalities: ['text'],
    })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    await settings.getByText('自定义设置').click()
    for (let index = 0; index < 2; index++) {
      await settings.getByRole('button', { name: /删除模型/ }).first().click()
    }
    await settings.getByRole('button', { name: '添加模型' }).click()
    const customModelId = settings.getByLabel('模型 ID 1')
    await customModelId.fill('private-preview')
    await settings.getByLabel('显示名称 1').fill('Private Preview')
    await settings.getByRole('button', { name: '模型选项 1' }).click()
    await settings.getByLabel('上下文窗口 1').fill('131072')
    await settings.getByLabel('最大输出 token 数 1').fill('64K')
    expect(await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).isChecked()).toBe(false)
    await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).check()

    await expect.poll(
      () => settings.getByLabel('API 密钥', { exact: true }).getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe('已配置——输入新值可替换')
    const modelEditor = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, modelEditor, MODE)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await customModelId.waitFor({ state: 'detached', timeout: 15_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('id: private-preview')
    expect(document).toContain('name: Private Preview')
    expect(document).toContain('contextWindow: 131072')
    expect(document).toContain('maxTokens: 64000')
    expect(document).not.toContain('id: deepseek-flash')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'private-preview')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
    })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    await settings.getByText('自定义设置').click()
    await settings.getByRole('button', { name: '模型选项 1' }).click()
    expect(await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).isChecked()).toBe(true)
    await settings.getByRole('button', { name: '取消', exact: true }).click()

    await page.keyboard.press('Escape')
    // A connected Workspace is what puts a live composer — and its model
    // trigger — on the page; the scaffold boots without one.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'model-fallback-e2e')

    const modelTrigger = page.getByRole('button', { name: /^选择模型/ })
    await modelTrigger.waitFor({ timeout: 10_000 })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    expect(await page.getByText('Configured Flash', { exact: true }).count()).toBe(0)
    await page.getByRole('menuitemradio', { name: 'Private Preview' }).waitFor({ timeout: 10_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

})

describe.skipIf(MODE === 'record')('web e2e: remote Models directory', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let settingsDescribeRequests = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      deepSeekMissingCredential: true,
      remoteAuthority: 'models.remote.localhost',
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/settings/describe') settingsDescribeRequests += 1
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows active providers read-only without requesting Host settings', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-remote-models'))
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    await settings.getByText('模型设置由服务器统一管理，当前浏览器仅可查看。').waitFor({ timeout: 10_000 })

    expect(await settings.getByText('DeepSeek', { exact: true }).count()).toBe(1)
    expect(await settings.getByText(/加载提供方目录失败/).count()).toBe(0)
    expect(await settings.getByRole('button', { name: '编辑', exact: true }).count()).toBe(0)
    expect(await settings.getByRole('button', { name: '添加提供方' }).count()).toBe(0)
    expect(await settings.getByLabel('API 密钥', { exact: true }).count()).toBe(0)
    expect(settingsDescribeRequests).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(REMOTE_MODELS_EXPECTED, snapshot, MODE)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(
      SNAPSHOT_DIR,
      ['welcome.expected.md', 'missing.expected.md', 'models.expected.md', 'default-models.expected.md'],
    )
  })
})
