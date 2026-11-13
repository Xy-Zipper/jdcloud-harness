// Keyless assembled-browser coverage for the optional Ontology login surface.
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
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
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/ontology-login', import.meta.url))
const LOGIN_EXPECTED = join(SNAPSHOT_DIR, 'login.expected.md')
const MODELING_EXPECTED = join(SNAPSHOT_DIR, 'modeling.expected.md')
const ONTOLOGY_BUNDLE_PATCH = fileURLToPath(
  new URL('../../../packages/bundle/ontology-login/cordis.patch.yml', import.meta.url),
)
const ONTOLOGY_BUNDLE_MANIFEST = fileURLToPath(
  new URL('../../../packages/bundle/ontology-login/package.json', import.meta.url),
)
const MODE = webSnapshotMode()

interface OntologyServer {
  readonly server: Server
  readonly baseUrl: string
  readonly requests: string[]
}

/** Start deterministic Runtime authentication endpoints on an atomically allocated loopback port. */
async function startOntologyServer(): Promise<OntologyServer> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://ontology.test')
    requests.push(`${request.method ?? 'GET'} ${url.pathname}`)
    const identity = {
      userId: 'user-alice',
      username: 'alice',
      displayName: 'Alice',
      accountType: 'admin',
      authorizationVersion: '1',
    }
    if (request.method === 'GET' && url.pathname === '/embed') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html lang="zh"><body><iframe title="建模助手" style="width:520px;height:720px;border:0"></iframe><script>
        const frame = document.querySelector('iframe');
        const harness = new URL(${JSON.stringify(url.searchParams.get('harness'))});
        harness.searchParams.set('ontologyEmbed', '1');
        window.handoff = null;
        window.addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.origin !== harness.origin) return;
          if (event.data.type === 'ontology/runtime-session-ready') {
            frame.contentWindow.postMessage({
              type: 'ontology/runtime-session', version: 1, nonce: 'modeling-e2e',
              context: { projectId: 'project-unpublished', projectName: '未发布项目', mode: 'modeling' },
              session: {
                accessToken: 'access-alice', accessTokenExpiresAt: '2026-11-12T12:15:00Z',
                refreshToken: 'refresh-alice', refreshTokenExpiresAt: '2026-12-12T12:00:00Z',
                user: ${JSON.stringify(identity)}
              }
            }, harness.origin);
          }
          if (event.data.type === 'ontology/runtime-session-result') window.handoff = event.data;
        });
        frame.src = harness.href;
      </script></body></html>`)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/runtime/projects/project-unpublished/draft') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ project: { id: 'project-unpublished', name: '未发布项目' }, draft: {} }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/auth/login') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        accessToken: 'access-alice',
        accessTokenExpiresAt: '2026-10-09T10:15:00Z',
        refreshToken: 'refresh-alice',
        refreshTokenExpiresAt: '2026-11-08T10:00:00Z',
        user: identity,
      }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/runtime/auth/current') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(identity))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/auth/logout') {
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Ontology fixture server has no TCP address')
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}`, requests }
}

/** Restore one process environment key to its exact pre-suite presence and value. */
function restoreEnvironment(key: string, original: string | undefined): void {
  if (original === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = original
}

describe('web e2e: Ontology login', () => {
  let ontology: OntologyServer
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const originalBaseUrl = process.env.ONTOLOGY_BASE_URL
  const originalAllowInsecureLoopback = process.env.ONTOLOGY_ALLOW_INSECURE_LOOPBACK

  beforeAll(async () => {
    ontology = await startOntologyServer()
    process.env.ONTOLOGY_BASE_URL = ontology.baseUrl
    process.env.ONTOLOGY_ALLOW_INSECURE_LOOPBACK = 'true'
    try {
      scaffold = await launchWebScaffold({
        extraOverlayPath: ONTOLOGY_BUNDLE_PATCH,
        extraInstallAnchors: [ONTOLOGY_BUNDLE_MANIFEST],
        browserSessionTransport: 'bearer',
      })
      browser = await chromium.launch()
      page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('heading', { name: '登录本体智能助手' }).waitFor({ timeout: 30_000 })
    } catch (error) {
      restoreEnvironment('ONTOLOGY_BASE_URL', originalBaseUrl)
      restoreEnvironment('ONTOLOGY_ALLOW_INSECURE_LOOPBACK', originalAllowInsecureLoopback)
      throw error
    }
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (ontology !== undefined) {
      await new Promise<void>((resolve, reject) => {
        ontology.server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      }).catch((error: unknown) => failures.push(error))
    }
    restoreEnvironment('ONTOLOGY_BASE_URL', originalBaseUrl)
    restoreEnvironment('ONTOLOGY_ALLOW_INSECURE_LOOPBACK', originalAllowInsecureLoopback)
    if (failures.length > 0) throw new AggregateError(failures, 'Ontology Web fixture cleanup failed')
  })

  it('shows the fixed-service login gate and exposes only redacted account state after login', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ontology-login'))
    const snapshot = await captureStableAria(page, 'body', scaffold.workspaceCwd, {
      replacements: [[ontology.baseUrl, '{{ontologyBaseUrl}}']],
    })
    await compareOrRefreshGolden(LOGIN_EXPECTED, snapshot, MODE)
    expect(await page.getByLabel('Ontology 服务').count()).toBe(0)

    await page.getByLabel('账号').fill('alice')
    await page.getByLabel('密码').fill('password123')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    const account = page.getByRole('button', { name: '当前账号 Alice', exact: true })
    await account.waitFor({ timeout: 30_000 })
    await account.click()
    await page.getByText(ontology.baseUrl, { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByText('管理员', { exact: true }).count()).toBe(1)
    expect(await page.getByText('access-alice', { exact: true }).count()).toBe(0)
    expect(await page.getByText('refresh-alice', { exact: true }).count()).toBe(0)
    expect(ontology.requests).toContain('POST /api/runtime/auth/login')
    expect(ontology.requests).toContain('GET /api/runtime/auth/current')
    expect(tripwire.pageErrors).toEqual([])

    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await page.getByRole('heading', { name: '登录本体智能助手' }).waitFor({ timeout: 30_000 })
    expect(ontology.requests).toContain('POST /api/runtime/auth/logout')
  }, 60_000)

  it('opens a compact native project conversation with image and document attachments', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ontology-modeling'))
    await page.goto(`${ontology.baseUrl}/embed?harness=${encodeURIComponent(scaffold.authenticatedUrl)}`)
    const frame = page.frameLocator('iframe[title="建模助手"]')
    const chat = frame.getByRole('main', { name: '本体建模助手', exact: true })
    await chat.waitFor({ timeout: 30_000 })
    await frame.getByRole('textbox').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => {
      const handoff: unknown = Reflect.get(window, 'handoff')
      return handoff
    })).toMatchObject({
      type: 'ontology/runtime-session-result', version: 1, nonce: 'modeling-e2e',
      ok: true, projectId: 'project-unpublished', mode: 'modeling',
    })
    const snapshot = await chat.ariaSnapshot()
    await compareOrRefreshGolden(MODELING_EXPECTED, snapshot, MODE)
    const originalSessionIds = scaffold.ctx.sessions.list().map(session => session.id)
    const createConversation = frame.getByRole('button', { name: '新建会话', exact: true })
    await createConversation.click()
    await createConversation.click()
    await expect.poll(() => createConversation.isEnabled()).toBe(true)
    expect(scaffold.ctx.sessions.list().map(session => session.id)).toEqual(originalSessionIds)
    expect(await frame.getByRole('combobox', { name: '历史会话' }).locator('option').allTextContents())
      .toEqual(['历史会话'])
    expect(await frame.getByRole('button', { name: '当前账号 Alice', exact: true }).count()).toBe(0)
    await frame.locator('input[type="file"]').setInputFiles([
      { name: 'requirements.txt', mimeType: 'text/plain', buffer: Buffer.from('创建产品对象及产品名称属性') },
      {
        name: 'reference.png', mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'),
      },
    ])
    await frame.getByRole('button', { name: '移除文件 requirements.txt', exact: true }).waitFor({ timeout: 15_000 })
    await frame.getByRole('button', { name: '移除图片 reference.png', exact: true }).waitFor({ timeout: 15_000 })
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await chat.screenshot({ path: join(artifacts, 'ontology-modeling-compact.png') })
    const historyStartVisible = await frame.locator('[data-conversation-scroll]').evaluate((element) => {
      // Overflowing history must remain reachable at scrollTop=0 while short chats keep the composer docked.
      const history = document.createElement('div')
      history.style.height = '1600px'
      history.style.flex = 'none'
      history.textContent = 'Earlier conversation'
      element.prepend(history)
      element.scrollTop = 0
      const reachable = history.getBoundingClientRect().top >= element.getBoundingClientRect().top
      history.remove()
      return reachable
    })
    expect(historyStartVisible).toBe(true)
    expect(ontology.requests).toContain('GET /api/runtime/projects/project-unpublished/draft')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['login.expected.md', 'modeling.expected.md'])
  })
})
