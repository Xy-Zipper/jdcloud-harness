// Keyless assembled-browser coverage for the optional Ontology login surface.
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
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
import { readWebClientBuildEnvironment } from './client-build-environment.ts'
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
const environment = await readWebClientBuildEnvironment()
const productName = environment.DSH_CLIENT_TITLE ?? 'LSY-Agent'
const loginHeading = `登录 ${productName}`
const citationSource = {
  projectId: 'project-unpublished', fileId: 'file-survey', fileName: '房产测量规范.pdf', mediaType: 'application/pdf',
  knowledgeBaseId: 'kb-survey', documentId: '74edf7c9c1684ec385840dd719d9a82a', chunkId: 'chunk-survey',
  citationId: 'R-736f5dc7d5', nodeIds: [], text: '分户图用于表示房屋权属范围。',
}

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
      const runtime = url.searchParams.get('mode') === 'runtime'
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html lang="zh"><body>${runtime ? '<button id="sales">销售项目</button><button id="training">培训项目</button>' : ''}
      <iframe title="${runtime ? '智能助手' : '建模助手'}" style="width:${runtime ? 1260 : 520}px;height:${runtime ? 860 : 720}px;border:0"></iframe><script>
        const frame = document.querySelector('iframe');
        const harness = new URL(${JSON.stringify(url.searchParams.get('harness'))});
        const runtime = ${String(runtime)};
        if (!runtime) harness.searchParams.set('ontologyEmbed', '1');
        window.handoff = null;
        let sequence = 0;
        function selectProject(projectId, projectName) {
          const count = ++sequence;
          window.handoff = null;
          frame.contentWindow.postMessage({
            type: 'ontology/runtime-session', version: 1, nonce: runtime ? 'runtime-' + count : 'modeling-e2e',
            context: { projectId, projectName, mode: runtime ? 'runtime' : 'modeling' },
            session: {
              accessToken: 'access-alice-' + count, accessTokenExpiresAt: '2026-11-12T12:15:00Z',
              refreshToken: 'refresh-alice-' + count, refreshTokenExpiresAt: '2026-12-12T12:00:00Z',
              user: ${JSON.stringify(identity)}
            }
          }, harness.origin);
        }
        if (runtime) {
          document.querySelector('#sales').onclick = () => selectProject('project-sales', '销售项目');
          document.querySelector('#training').onclick = () => selectProject('project-unpublished', '培训项目');
        }
        window.addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.origin !== harness.origin) return;
          if (event.data.type === 'ontology/runtime-session-ready') {
            if (runtime) selectProject('project-sales', '销售项目');
            else selectProject('project-unpublished', '未发布项目');
          }
          if (event.data.type === 'ontology/runtime-session-result') window.handoff = event.data;
        });
        frame.src = harness.href;
      </script></body></html>`)
      return
    }
    if (request.method === 'GET' && (url.pathname === '/api/runtime/projects/project-unpublished/draft'
      || url.pathname === '/api/runtime/projects/project-sales/draft')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ project: { id: url.pathname.split('/')[4] }, draft: {} }))
      return
    }
    const filePath = `/api/runtime/knowledge/files/${citationSource.projectId}/${citationSource.fileId}`
    if (request.method === 'POST' && url.pathname === `${filePath}/page-location`) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ page: 22 }))
      return
    }
    if (request.method === 'GET' && url.pathname === `${filePath}/preview`) {
      response.setHeader('content-type', 'application/pdf')
      response.end('%PDF-1.4\n')
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
      })
      browser = await chromium.launch()
      page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('heading', { name: loginHeading, exact: true }).waitFor({ timeout: 30_000 })
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
    expect(await page.title()).toBe(productName)
    const snapshot = await captureStableAria(page, 'body', scaffold.workspaceCwd, {
      replacements: [[ontology.baseUrl, '{{ontologyBaseUrl}}'], [productName, '{{productName}}']],
    })
    await compareOrRefreshGolden(LOGIN_EXPECTED, snapshot, MODE)
    expect(await page.getByLabel('Ontology 服务').count()).toBe(0)

    await page.getByLabel('账号').fill('alice')
    await page.getByLabel('密码').fill('password123')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    const account = page.getByRole('button', { name: '当前账号 Alice', exact: true })
    await account.waitFor({ timeout: 30_000 })
    await page.locator('[data-slot="sidebar.brand.name"]').getByText(productName, { exact: true }).waitFor()
    const more = page.getByTestId('ontology-more-trigger')
    await more.waitFor({ timeout: 10_000 })
    expect(await page.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)
    await more.click()
    await page.getByRole('menuitem', { name: 'Skill', exact: true }).waitFor()
    await page.getByRole('menuitem', { name: '面板设置', exact: true }).click()
    await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await account.click()
    await page.getByText(ontology.baseUrl, { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByText('管理员', { exact: true }).count()).toBe(1)
    expect(await page.getByText('access-alice', { exact: true }).count()).toBe(0)
    expect(await page.getByText('refresh-alice', { exact: true }).count()).toBe(0)
    expect(ontology.requests).toContain('POST /api/runtime/auth/login')
    expect(ontology.requests).toContain('GET /api/runtime/auth/current')
    expect(tripwire.pageErrors).toEqual([])

    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await page.getByRole('heading', { name: loginHeading, exact: true }).waitFor({ timeout: 30_000 })
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

  it('opens the source title of a saved answer with a raw document ID', async () => {
    const title = '《房产测量规范 第一单元 GB/T 17986.1-2000》'
    const answer = `${citationSource.text}[${citationSource.citationId}]\n\n来源：${title}7.3.1、7.3.2（项目知识库，documentId \`${citationSource.documentId}\`）。`
    await page.goto(`${ontology.baseUrl}/embed?harness=${encodeURIComponent(scaffold.authenticatedUrl)}`)
    const frame = page.frameLocator('iframe[title="建模助手"]')
    await frame.getByRole('textbox').waitFor()
    const [session] = scaffold.ctx.sessions.list()
    if (session === undefined) throw new Error('Missing conversation for citation replay')
    // Persist a completed retrieval turn before reopening it in the browser.
    const model = { provider: 'fixture', model: 'fixture' }
    const call = {
      type: 'tool-call' as const, id: brandString<ToolCallId>('call-survey'),
      name: 'ontology_search_knowledge', arguments: '{"question":"分户图的用途"}',
    }
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '分户图的用途' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [call], source: model }),
    }, { surfaceOp: 'append' })
    const tool = session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({
        callId: call.id, content: [{ type: 'text', text: citationSource.text }], isError: false,
      }),
      meta: { knowledgeSources: [citationSource] },
    }, { surfaceOp: 'append', sourceEventSeqs: [tool.seq] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    session.append('assistant/message', {
      turn: 1, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: answer }], source: model }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    await page.reload()

    await frame.getByRole('button', { name: title, exact: true }).click()
    const preview = frame.getByRole('dialog', { name: citationSource.fileName, exact: true })
    await preview.getByText('第 22 页', { exact: true }).waitFor()
    expect(await preview.locator('iframe').getAttribute('src')).toMatch(/^blob:.*#page=22$/u)
    expect(await frame.getByRole('button', { name: '片段 1', exact: true }).count()).toBe(1)
  }, 60_000)

  it('restores the folders and conversations of the selected runtime Project', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ontology-project-scope'))
    await page.goto(`${ontology.baseUrl}/embed?mode=runtime&harness=${encodeURIComponent(scaffold.authenticatedUrl)}`)
    const frame = page.frameLocator('iframe[title="智能助手"]')
    const selected = async (projectId: string): Promise<void> => {
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'handoff'))).toMatchObject({
        type: 'ontology/runtime-session-result', ok: true, projectId, mode: 'runtime',
      })
    }
    const folderRow = (name: string) => frame.getByRole('treeitem').filter({ hasText: name }).first()
    const addConversation = async (folderName: string, title: string) => {
      await frame.getByRole('button', { name: '添加工作区', exact: true }).click()
      const picker = frame.getByRole('dialog', { name: '选择工作区目录' })
      await picker.getByRole('button', { name: '新建文件夹' }).click()
      await frame.getByLabel('文件夹名称').fill(folderName)
      await frame.getByRole('button', { name: '创建', exact: true }).click()
      await picker.getByRole('button', { name: '打开', exact: true }).click()
      await picker.waitFor({ state: 'hidden' })
      const findWorkspace = () => scaffold.ctx.workspaceRegistry.list().find(item => item.title === folderName)
      await expect.poll(() => findWorkspace()?.sessionIds.length).toBe(1)
      const workspace = findWorkspace()
      const id = workspace?.sessionIds[0]
      const session = id === undefined ? undefined : scaffold.ctx.sessions.get(id)
      if (workspace === undefined || session === undefined) throw new Error('Missing conversation created by the directory picker')
      // Seed a completed turn through the durable Session without calling an LLM provider.
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: title }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      scaffold.ctx.sessionTitle.rename(session, title)
      await scaffold.ctx.sessions.flush(session)
      await folderRow(folderName).waitFor()
      await frame.getByRole('treeitem').getByText(title, { exact: true }).waitFor()
      return workspace.path
    }

    await selected('project-sales')
    const salesPath = await addConversation('销售文件夹', '销售对话')
    await page.getByRole('button', { name: '培训项目', exact: true }).click()
    await selected('project-unpublished')
    await folderRow('销售文件夹').waitFor({ state: 'hidden' })
    await frame.getByRole('treeitem').getByText('销售对话', { exact: true }).waitFor({ state: 'hidden' })
    const trainingPath = await addConversation('培训文件夹', '培训对话')
    expect(dirname(salesPath)).not.toBe(dirname(trainingPath))

    await page.getByRole('button', { name: '销售项目', exact: true }).click()
    await selected('project-sales')
    await folderRow('培训文件夹').waitFor({ state: 'hidden' })
    await frame.getByRole('treeitem').getByText('培训对话', { exact: true }).waitFor({ state: 'hidden' })
    const folder = folderRow('销售文件夹')
    await folder.waitFor()
    if (await folder.getAttribute('aria-expanded') === 'false') await folder.click()
    await frame.getByRole('treeitem').getByText('销售对话', { exact: true }).click()
    await frame.getByText('销售对话', { exact: true }).last().waitFor()
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['login.expected.md', 'modeling.expected.md'])
  })
})
