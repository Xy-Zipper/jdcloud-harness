// Keyless Web-profile coverage for current-account form selections: the Host
// resolves current user, department, and role names before the first model call.
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId as sessionId, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory,
  fixtureUserPrompts,
  launchWebScaffold,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/jdcloud-current-member', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const JDCLOUD_BUNDLE_PATCH = fileURLToPath(
  new URL('../../../packages/bundle/jdcloud-login/cordis.patch.yml', import.meta.url),
)
const JDCLOUD_BUNDLE_MANIFEST = fileURLToPath(
  new URL('../../../packages/bundle/jdcloud-login/package.json', import.meta.url),
)
const MODE = webSnapshotMode()
const PROMPT = '我昨天在 https://krill-ai.com 购买了 token，申请报账。'

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

interface JdcloudFixtureServer {
  readonly server: Server
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
}

/** Read one request JSON body after Node has received every chunk. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Start deterministic JDCloud endpoints for login, prompt admission, and member resolution. */
async function startJdcloudServer(): Promise<JdcloudFixtureServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://jdcloud.test')
      const method = request.method ?? 'GET'
      const body = await readJsonBody(request)
      requests.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) })
      const reply = (data: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 200, msg: 'ok', data }))
      }
      if (method === 'POST' && url.pathname === '/api/oauth/login') {
        reply({ token: 'current-member-token' })
        return
      }
      if (method === 'GET' && url.pathname === '/api/system/corp/getCorpList') {
        reply({
          corpId: 'corp-1',
          corpList: [{ corpId: 'corp-1', corpName: '测试租户' }],
          joinCorpList: [],
        })
        return
      }
      if (method === 'GET' && url.pathname === '/api/oauth/currentUser') {
        reply({
          userInfo: {
            id: 'user-1',
            userName: '18100000000',
            realName: '测试用户',
            corpId: 'corp-1',
            departmentId: ['department-1'],
            roleId: ['role-1'],
          },
          userPermission: { systemAdministrator: false },
          menuList: [{
            id: 'expense-form',
            parentId: '-1',
            fullName: '报账申请',
            type: 3,
            agentPermissions: ['addData'],
          }],
        })
        return
      }
      if (method === 'POST' && url.pathname === '/api/system/permission/users/getMemberName') {
        reply({
          department: [{ id: 'department-1', fullName: '研发部' }],
          role: [{ id: 'role-1', fullName: '普通员工' }],
          user: [{ id: 'user-1', fullName: '测试用户', phone: '18100000000' }],
        })
        return
      }
      response.writeHead(404)
      response.end()
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('JDCloud fixture server has no TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

/** Extract the text of one durable user message. */
function userText(event: Extract<SessionEvent, { type: 'user/message' }>): string {
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe.skipIf(MODE === 'record')('web e2e: JDCloud current account reaches the first low-code request', () => {
  let jdcloud: JdcloudFixtureServer
  let scaffold: WebScaffold
  let settledSessionId: SessionId | undefined
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    jdcloud = await startJdcloudServer()
    scaffold = await launchWebScaffold({
      extraOverlayPath: JDCLOUD_BUNDLE_PATCH,
      extraInstallAnchors: [JDCLOUD_BUNDLE_MANIFEST],
      replayFixture: FIXTURE,
      compareReplaySession: true,
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    await scaffold.ctx.jdcloudAuthController.login({
      baseUrl: jdcloud.baseUrl,
      username: '18100000000',
      password: 'secret',
    }, AbortSignal.timeout(5_000))
    const created = await scaffold.ctx.sessionController.create({
      sessionId: sessionId('jdcloud-current-member'),
      cwd: scaffold.workspaceCwd,
    })
    const settled = scaffold.whenTurnSettled()
    await scaffold.ctx.sessionController.prompt({
      requestId: 'jdcloud-current-member-request' as never,
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: PROMPT }],
    }, AbortSignal.timeout(10_000))
    settledSessionId = await settled
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (jdcloud !== undefined) {
      await new Promise<void>((resolve, reject) => {
        jdcloud.server.close(error => error === undefined ? resolve() : reject(error))
      }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'JDCloud current-member teardown failed')
  })

  it('batches current-user member ids before the model sees the prompt', async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    expect(jdcloud.requests).toEqual([
      {
        method: 'POST',
        path: '/api/oauth/login',
        body: { username: '18100000000', password: '5ebe2294ecd0e0f08eab7690d2a6ee69' },
      },
      { method: 'GET', path: '/api/system/corp/getCorpList' },
      { method: 'GET', path: '/api/oauth/currentUser' },
      { method: 'GET', path: '/api/system/corp/getCorpList' },
      { method: 'GET', path: '/api/oauth/currentUser' },
      { method: 'GET', path: '/api/oauth/currentUser' },
      {
        method: 'POST',
        path: '/api/system/permission/users/getMemberName',
        body: ['user-1', 'department-1', 'role-1'],
      },
    ])
    const pluginMessage = sessionEvents.find((event): event is Extract<SessionEvent, { type: 'user/message' }> => (
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'tool-jdcloud-lowcode'
    ))
    if (pluginMessage === undefined) throw new Error('JDCloud current-member snapshot was not persisted')
    expect(sessionEvents.indexOf(pluginMessage)).toBeLessThan(
      sessionEvents.findIndex(event => event.type === 'request/header'),
    )
    expect(JSON.parse(userText(pluginMessage).split('\n').slice(1).join('\n'))).toMatchObject({
      currentMember: {
        department: [{ id: 'department-1', fullName: '研发部' }],
        role: [{ id: 'role-1', fullName: '普通员工' }],
        user: [{ id: 'user-1', fullName: '测试用户', phone: '18100000000' }],
      },
    })
    if (settledSessionId === undefined) throw new Error('JDCloud current-member turn did not settle')
    const agent = scaffold.ctx.agents.get(settledSessionId)
    if (agent === undefined) throw new Error('JDCloud current-member Agent is not live')
    expect(agent.session.deriveMessages().some(message => JSON.stringify(message).includes('研发部'))).toBe(true)
    expect(agent.session.deriveMessages().some(message => JSON.stringify(message).includes('测试用户'))).toBe(true)
    const answer = sessionEvents.find(event => event.type === 'assistant/message')
    expect(answer?.type === 'assistant/message'
      ? answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      : undefined).toBe('已读取当前报账人和所属部门。')
  })

  it('keeps the recorded-session inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
    ])
  })
})
