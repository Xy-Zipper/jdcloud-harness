// Keyless assembled-browser coverage for the optional Ontology login surface.
import { once } from 'node:events'
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

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['login.expected.md'])
  })
})
