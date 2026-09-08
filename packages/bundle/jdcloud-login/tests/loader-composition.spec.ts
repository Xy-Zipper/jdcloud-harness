/** JDCloud bundle rows must activate through the real Cordis Loader. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '../../../core/agent/src/index.ts'
import { createUserMessage } from '../../../llm/llm/src/index.ts'
import { Session, SessionId } from '../../../core/session/src/index.ts'
import SessionProjectionRegistry from '../../../session/session-projection/src/index.ts'
import SystemPrompt from '../../../core/system-prompt/src/index.ts'
import ToolRuntime from '../../../core/tools/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import JdcloudAuthController from '../../../api/jdcloud-auth-controller/src/index.ts'

let directory: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.unstubAllGlobals()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

/** Build one successful JDCloud JSON envelope. */
function json(data: unknown): Response {
  return Response.json({ code: 200, msg: 'ok', data })
}

/** Return the tenant-list data accepted by the authentication controller. */
function corpData(): Record<string, unknown> {
  return {
    corpId: 'corp-current',
    corpList: [{ corpId: 'corp-current', corpName: 'Current Tenant' }],
    joinCorpList: [],
  }
}

/** Create the real Loader tree used by both composition assertions. */
async function bootComposition(fetcher?: typeof fetch): Promise<Context> {
  if (fetcher !== undefined) vi.stubGlobal('fetch', fetcher)
  const lowcodeEntry = pathToFileURL(join(
    import.meta.dirname,
    '../../../jdcloud/tool-jdcloud-lowcode/src/index.ts',
  )).href
  const loginUiEntry = pathToFileURL(join(
    import.meta.dirname,
    '../../../client/ui-jdcloud-login/src/index.ts',
  )).href
  const lowcodeModule = await import(lowcodeEntry) as Record<string, unknown>
  const loginUiModule = await import(loginUiEntry) as Record<string, unknown>
  expect('default' in lowcodeModule).toBe(false)
  expect('default' in loginUiModule).toBe(false)

  directory = await mkdtemp(join(tmpdir(), 'dsh-jdcloud-login-loader-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@fixture/memory-credentials'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    '  config:',
    "    persona: ''",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-api-jdcloud-auth-controller'",
    '  config:',
    '    defaultBaseUrl: https://kindoucloud.com',
    '    requestTimeoutMs: 15000',
    "- name: '@deepseek-ai/dsh-tool-jdcloud-lowcode'",
    "- name: '@deepseek-ai/dsh-client-ui-jdcloud-login'",
    '',
  ].join('\n'))

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@fixture/memory-credentials', MemoryCredentials],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-api-jdcloud-auth-controller', JdcloudAuthController],
    ['@deepseek-ai/dsh-tool-jdcloud-lowcode', lowcodeModule],
    ['@deepseek-ai/dsh-client-ui-jdcloud-login', loginUiModule],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

/** Build a registered running Agent for the real scoped pre-step waterfall. */
function runningAgent(context: Context): Agent {
  const id = SessionId('jdcloud-loader-agent')
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: context,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('JDCloud login through a real Loader composition', () => {
  it('activates the foundation services, Host controller, low-code tools, and login UI node half', async () => {
    const context = await bootComposition()

    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect(context.get('agents')).toBeInstanceOf(AgentRegistry)
    expect(context.get('sessionProjections')).toBeInstanceOf(SessionProjectionRegistry)
    expect(context.get('systemPrompt')).toBeInstanceOf(SystemPrompt)
    expect(context.get('tools')).toBeInstanceOf(ToolRuntime)
    expect(context.tools.schemas().map(schema => schema.name)).toEqual([
      'jdcloud_lowcode_describe',
      'jdcloud_lowcode_query',
      'jdcloud_lowcode_get',
      'jdcloud_lowcode_create',
      'jdcloud_lowcode_update',
      'jdcloud_lowcode_delete',
      'jdcloud_lowcode_create_table',
    ])
    expect((await context.systemPrompt.assemble()).sections.map(section => section.name))
      .toContain('tool:jdcloud-lowcode')
    await expect(context.jdcloudAuthController.status()).resolves.toEqual({
      authenticated: false,
      baseUrl: 'https://kindoucloud.com',
    })
  })

  it('checks the tenant before fetching current-user capabilities for one browser prompt', async () => {
    const requestPaths: string[] = []
    const fetcher = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requestPaths.push(url.pathname)
      switch (url.pathname) {
        case '/api/oauth/login':
          return Promise.resolve(json({ token: 'stored-token' }))
        case '/api/system/corp/getCorpList':
          return Promise.resolve(json(corpData()))
        case '/api/oauth/currentUser':
          return Promise.resolve(json({
            userInfo: { id: 'user-1' },
            userPermission: { systemAdministrator: false },
            menuList: [
              { id: 'form-1', parentId: '-1', fullName: '打卡记录', type: 3 },
              { id: 'board-1', parentId: '-1', fullName: '打卡看板', type: 6 },
            ],
          }))
        default:
          throw new Error(`unexpected JDCloud request: ${url.pathname}`)
      }
    })
    const context = await bootComposition(fetcher)
    const signal = AbortSignal.timeout(1_000)
    await context.jdcloudAuthController.login({
      baseUrl: 'https://kindoucloud.com',
      username: 'user',
      password: 'secret',
    }, signal)
    requestPaths.splice(0)

    const agent = runningAgent(context)
    context.agents.register(agent)
    const admission = vi.fn(() => Promise.resolve())
    await context.waterfall('api-session/prompt-admission', {
      sessionId: agent.id,
      signal,
    }, admission)
    const prompt = createUserMessage({
      content: [{ type: 'text', text: '查询这周打卡数据' }],
      source: { kind: 'user', rpcId: 'browser-prompt-1' } as never,
    })
    const decision = await agentEvents(context, agent).waterfall(
      'agent/pre-step',
      { messages: [prompt], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [prompt] }),
    )

    expect(admission).toHaveBeenCalledOnce()
    expect(requestPaths).toEqual([
      '/api/system/corp/getCorpList',
      '/api/oauth/currentUser',
    ])
    expect(decision).toMatchObject({
      kind: 'enter',
      messages: [
        { source: { kind: 'user', rpcId: 'browser-prompt-1' } },
        { source: { kind: 'plugin', plugin: 'tool-jdcloud-lowcode', form: 'snapshot' } },
      ],
    })
    expect(JSON.stringify(decision)).toContain('form-1')
    expect(JSON.stringify(decision)).not.toContain('board-1')
  })
})
