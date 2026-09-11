// Keyless assembled-browser coverage for the optional JDCloud login bundle:
// an ordinary tenant uses the Host model default and receives no administrator controls.
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-client-modules'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh,
  saveFailureShot,
  writeComposerDraft,
  ZH_BROWSER_LOCALE,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/jdcloud-ordinary-user', import.meta.url))
const ORDINARY_USER_EXPECTED = join(SNAPSHOT_DIR, 'controls.expected.md')
const LOWCODE_ACTIONS_EXPECTED = join(SNAPSHOT_DIR, 'lowcode-actions.expected.md')
const JDCLOUD_BUNDLE_PATCH = fileURLToPath(
  new URL('../../../packages/bundle/jdcloud-login/cordis.patch.yml', import.meta.url),
)
const JDCLOUD_BUNDLE_MANIFEST = fileURLToPath(
  new URL('../../../packages/bundle/jdcloud-login/package.json', import.meta.url),
)
const MODE = webSnapshotMode()

interface JdcloudServer {
  readonly server: Server
  readonly baseUrl: string
  readonly requests: string[]
}

/** Start the deterministic JDCloud endpoints used by the login controller. */
async function startJdcloudServer(): Promise<JdcloudServer> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://jdcloud.test')
    requests.push(`${request.method ?? 'GET'} ${url.pathname}`)
    const reply = (data: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 200, msg: 'ok', data }))
    }
    if (request.method === 'POST' && url.pathname === '/api/oauth/login') {
      reply({ token: 'ordinary-token' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/system/corp/getCorpList') {
      reply({
        corpId: 'corp-ordinary',
        corpList: [{ corpId: 'corp-ordinary', corpName: '普通租户' }],
        joinCorpList: [],
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/oauth/currentUser') {
      reply({
        userInfo: { userName: 'ordinary-user', corpId: 'corp-ordinary' },
        userPermission: { systemAdministrator: false },
        menuList: [
          { id: 'folder-hr', parentId: '-1', fullName: '人事管理', type: 1 },
          {
            id: 'leave', parentId: 'folder-hr', fullName: '请假申请', type: 4,
            agentPermissions: ['addData'],
          },
          {
            id: 'expense', parentId: 'folder-hr', fullName: '报账单', type: 3,
            agentPermissions: ['editData'],
          },
          { id: 'attendance', parentId: 'folder-hr', fullName: '打卡记录', type: 3 },
          {
            id: 'board', parentId: '-1', fullName: '数据看板', type: 6,
            agentPermissions: ['deleteData'],
          },
        ],
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('JDCloud fixture server has no TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

describe('web e2e: JDCloud ordinary-user controls', () => {
  let jdcloud: JdcloudServer
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    jdcloud = await startJdcloudServer()
    scaffold = await launchWebScaffold({
      extraOverlayPath: JDCLOUD_BUNDLE_PATCH,
      extraInstallAnchors: [JDCLOUD_BUNDLE_MANIFEST],
    })
    expect(scaffold.ctx.clientModules.graph().entries.map(entry => entry.id)).toContain(
      '@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions',
    )
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('heading', { name: '欢迎登录' }).waitFor({ timeout: 30_000 })
    await page.getByLabel('服务地址').fill(jdcloud.baseUrl)
    await page.getByLabel('账号').fill('ordinary-user')
    await page.getByLabel('密码').fill('secret')
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByRole('textbox', { name: '选择工作区' }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (jdcloud !== undefined) {
      await new Promise<void>((resolve, reject) => {
        jdcloud.server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  })

  it('hides administrator controls and offers single-select writable low-code functions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jdcloud-ordinary-user'))
    await page.getByRole('button', {
      name: '当前账号 ordinary-user，租户 普通租户', exact: true,
    }).waitFor({ timeout: 10_000 })
    expect(await page.getByRole('button', { name: '设置', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /标准模式/ }).count()).toBe(0)

    const snapshot = await captureStableAria(page, 'body', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ORDINARY_USER_EXPECTED, snapshot, MODE)

    const serverDefault = scaffold.ctx.agentDefaultModel.currentSelection()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    expect(await page.getByRole('button', { name: /^选择模型/ }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    await expect.poll(() => jdcloud.requests.slice(), { timeout: 10_000 }).toEqual([
      'POST /api/oauth/login',
      'GET /api/system/corp/getCorpList',
      'GET /api/oauth/currentUser',
      'GET /api/oauth/currentUser',
      'GET /api/oauth/currentUser',
    ])

    const panel = page.getByRole('region', { name: '可用的低代码功能' })
    await panel.waitFor({ timeout: 10_000 })
    const actionsSnapshot = await captureStableAria(
      page,
      '[data-jdcloud-lowcode-actions]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(LOWCODE_ACTIONS_EXPECTED, actionsSnapshot, MODE)
    expect(await panel.getByRole('button').count()).toBe(2)
    expect(await panel.getByRole('button', { name: /打卡记录/ }).count()).toBe(0)
    expect(await panel.getByRole('button', { name: /数据看板/ }).count()).toBe(0)
    const firstActionBox = await panel.getByRole('button', { name: /请假申请/ }).boundingBox()
    expect(firstActionBox).not.toBeNull()
    expect(firstActionBox?.width).toBeGreaterThanOrEqual(250)
    expect(firstActionBox?.height).toBeGreaterThanOrEqual(96)

    await panel.getByRole('button', { name: /请假申请/ }).click()
    expect(await page.getByRole('region', { name: '可用的低代码功能' }).count()).toBe(0)
    const input = page.locator('[data-composer-input]').first()
    const chip = input.locator('[data-composer-chip="jdcloud-lowcode-function"]')
    await expect.poll(() => chip.count()).toBe(1)
    await expect.poll(() => chip.textContent()).toBe('@请假申请')

    await writeComposerDraft(page, input, '')
    await expect.poll(() => chip.count()).toBe(0)
    await page.getByRole('region', { name: '可用的低代码功能' }).waitFor()

    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected JDCloud workspace did not create an Agent')
    expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
    expect(
      scaffold.ctx.sessionProjections.snapshot(agent.session).values.modelSelection?.next
        ?? scaffold.ctx.agentDefaultModel.currentSelection(),
    ).toEqual(serverDefault)
    await expect(scaffold.ctx.sessionController.selectModel({
      sessionId: agent.id,
      provider: serverDefault.provider,
      model: serverDefault.model,
    })).rejects.toMatchObject({ code: 'jdcloud/administrator-required' })
    expect(tripwire.pageErrors).toEqual([])
    expect(jdcloud.requests).toEqual([
      'POST /api/oauth/login',
      'GET /api/system/corp/getCorpList',
      'GET /api/oauth/currentUser',
      'GET /api/oauth/currentUser',
      'GET /api/oauth/currentUser',
    ])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'controls.expected.md',
      'lowcode-actions.expected.md',
    ])
  })
})
