/** JDCloud bundle rows must activate through the real Cordis Loader. */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as ExternalApi from '@deepseek-ai/dsh-api-external'
import * as Media from '@deepseek-ai/dsh-creation-studio-media'
import * as yaml from 'js-yaml'
import AgentRegistry, { agentEvents, type Agent } from '../../../core/agent/src/index.ts'
import { createInboxStub } from '../../../test-support/agent-loop-testkit/src/index.ts'
import { createUserMessage } from '../../../llm/llm/src/index.ts'
import { Session, SessionId } from '../../../core/session/src/index.ts'
import SessionProjectionRegistry from '../../../session/session-projection/src/index.ts'
import SystemPrompt from '../../../core/system-prompt/src/index.ts'
import ToolRuntime from '../../../core/tools/src/index.ts'
import JdcloudAuthController from '../../../api/jdcloud-auth-controller/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import WebServer from '../../../host/webserver/src/index.ts'

let directory: string | undefined
let ctx: Context | undefined
const localFetch = globalThis.fetch

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
async function bootComposition(fetcher?: typeof fetch, externalApi = false, media = false): Promise<Context> {
  if (fetcher !== undefined) vi.stubGlobal('fetch', fetcher)
  const lowcodeEntry = pathToFileURL(join(
    import.meta.dirname,
    '../../../jdcloud/tool-jdcloud-lowcode/src/index.ts',
  )).href
  const loginUiEntry = pathToFileURL(join(
    import.meta.dirname,
    '../../../client/ui-jdcloud-login/src/index.ts',
  )).href
  const lowcodeActionsUiEntry = pathToFileURL(join(
    import.meta.dirname,
    '../../../client/ui-jdcloud-lowcode-actions/src/index.ts',
  )).href
  const lowcodeModule = await import(lowcodeEntry) as Record<string, unknown>
  const loginUiModule = await import(loginUiEntry) as Record<string, unknown>
  const lowcodeActionsUiModule = await import(lowcodeActionsUiEntry) as Record<string, unknown>
  expect('default' in lowcodeModule).toBe(false)
  expect('default' in loginUiModule).toBe(false)
  expect('default' in lowcodeActionsUiModule).toBe(false)

  directory = await mkdtemp(join(tmpdir(), 'dsh-jdcloud-login-loader-'))
  const configPath = join(directory, 'cordis.yml')
  const externalEntries = externalApi
    ? [
      "- name: '@fixture/external-services'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
    ]
    : []
  await writeFile(configPath, [
    "- name: '@fixture/memory-credentials'",
    ...externalEntries,
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
    ...externalApi ? ["- name: '@deepseek-ai/dsh-api-external'"] : [],
    ...media ? [
      "- name: '@deepseek-ai/dsh-creation-studio-media'",
      '  config:',
      '    platformURL: https://kindoucloud.com',
      `    tenantId: ${'a'.repeat(24)}`,
      `    stateDirectory: ${JSON.stringify(join(directory, 'media'))}`,
    ] : [],
    "- name: '@deepseek-ai/dsh-tool-jdcloud-lowcode'",
    "- name: '@deepseek-ai/dsh-client-ui-jdcloud-login'",
    "- name: '@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions'",
    '',
  ].join('\n'))

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  ctx.provide('attachments', { readImage: () => Promise.reject(new Error('unused')) } as never)
  // The existing UI composition needs only a route registry; the external API test uses a real listener.
  if (!externalApi) ctx.provide('webServer', { register: () => () => {} } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // The external API is loaded through its production dependency names while this test owns only their data.
  const externalServicesModule = {
    apply(context: Context) {
      context.provide('sessionController', {} as never)
      context.provide('sessionSkillCatalog', {
        listAccount: async () => ({
          skills: [{ name: 'global-skill', scope: 'built-in' }],
          canManageBuiltIn: true,
        }),
      } as never)
      context.provide('workspaceController', {} as never)
      context.provide('workspaceFiles', {} as never)
    },
  }
  const modules = new Map<string, unknown>([
    ['@fixture/memory-credentials', MemoryCredentials],
    ['@fixture/external-services', externalServicesModule],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-api-jdcloud-auth-controller', JdcloudAuthController],
    ['@deepseek-ai/dsh-api-external', ExternalApi],
    ['@deepseek-ai/dsh-creation-studio-media', Media],
    ['@deepseek-ai/dsh-tool-jdcloud-lowcode', lowcodeModule],
    ['@deepseek-ai/dsh-client-ui-jdcloud-login', loginUiModule],
    ['@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions', lowcodeActionsUiModule],
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
    inbox: createInboxStub(),
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
  it('preserves JDCloud deployment settings through the Docker overlay', () => {
    const web = yaml.load(
      readFileSync(join(import.meta.dirname, '../../web-app/cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as PatchOptions[]
    const jdcloud = yaml.load(
      readFileSync(join(import.meta.dirname, '../cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as PatchOptions[]
    const docker = yaml.load(
      readFileSync(join(import.meta.dirname, '../../../../docker.no-browser-auth.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as PatchOptions[]
    const rows = applyEntryPatches([], [...web, ...jdcloud, ...docker], () => {})
    expect(rows.find(row => row.id === 'ui-settings-models')).toMatchObject({
      name: '@deepseek-ai/dsh-client-ui-settings-models',
      config: { welcomeNotice: false, credentialOnboarding: false },
    })
    expect(rows.find(row => row.id === 'connection')).toMatchObject({
      config: {
        browserSessionTransport: 'bearer',
      },
    })
    expect(rows.find(row => row.id === 'directory-picker')).toMatchObject({ disabled: true })
    expect(rows.find(row => row.id === 'directory-picker-browse')?.name)
      .toBe('@deepseek-ai/dsh-host-directory-picker-browse')
    expect(rows.find(row => row.id === 'ui-directory-picker-browse')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-directory-picker-browse')
    expect(rows.find(row => row.id === 'external-api')?.name)
      .toBe('@deepseek-ai/dsh-api-external')
    expect(rows.find(row => row.id === 'creation-studio-media')?.name)
      .toBe('@deepseek-ai/dsh-creation-studio-media')
    expect(jdcloud.find(row => row.id === 'skill-filesystem')).toMatchObject({
      disabled: false,
      config: {
        includeDefaultRoots: false,
        scopedUserWorkspaceDir: {
          __jsExpr: "process.env.JDCLOUD_USER_WORKSPACE_DIR ?? process.getBuiltinModule('node:path').join(process.env.DSH_HOME ?? process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), '.dsh'), 'account-workspaces')",
        },
      },
    })
    expect(rows.find(row => row.id === 'ui-jdcloud-login')).toMatchObject({
      config: {
        transferFrameAncestorOrigin: { __jsExpr: 'process.env.JDCLOUD_IFRAME_PARENT_ORIGIN' },
      },
    })
  })

  it('loads media tools and authenticated routes from the JDCloud bundle and removes them on unload', async () => {
    const tenantId = 'a'.repeat(24)
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/api/system/corp/getCorpList')
        return json({ corpId: tenantId, corpList: [{ corpId: tenantId, corpName: 'Media' }], joinCorpList: [] })
      if (url.pathname === '/api/oauth/currentUser')
        return json({ userInfo: { id: 'media-user', corpId: tenantId }, userPermission: {} })
      throw new Error(`unexpected media request: ${url.pathname}`)
    })
    const context = await bootComposition(fetcher, true, true)
    expect('default' in Media).toBe(false)
    expect(context.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'creation_studio_image_generate', 'creation_studio_image_task', 'creation_studio_video_task',
    ]))
    const address = `http://127.0.0.1:${context.webServer.port}/api/external/v1/creation-studio/media/config`
    const headers = {
      authorization: 'Bearer media-token',
      'x-tenant-id': tenantId,
      'x-jdcloud-base-url': 'https://kindoucloud.com',
    }
    // Only the remote platform is mocked; the listener, Loader, auth, and registry are real.
    expect((await localFetch(address, { method: 'POST' })).status).toBe(401)
    for (const operation of ['images/tasks', 'images/refresh', 'images/list']) {
      const route = address.replace(/config$/u, operation)
      expect((await localFetch(route, { method: 'POST' })).status).toBe(401)
      expect((await localFetch(route, { method: 'GET' })).status).toBe(405)
    }
    const response = await localFetch(address, { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      code: 200,
      data: { image: { model: 'gpt-image-2.5' }, video: { model: 'doubao-seedance-2-5-260628' } },
    })
    const batch = await localFetch(address.replace(/config$/u, 'images/refresh'), {
      method: 'POST', headers, body: JSON.stringify({ taskIds: [] }),
    })
    expect(batch.status).toBe(400)
    expect(await batch.json()).toMatchObject({ code: 400, message: '请传入非空且不重复的 taskIds 数组。' })
    const entry = [...context.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-creation-studio-media')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(context.tools.schemas().some(schema => schema.name.startsWith('creation_studio_'))).toBe(false)
    expect((await localFetch(address, { method: 'POST', headers })).status).toBe(404)
  })

  it('activates the foundation services, Host controller, low-code tools, and login UI node half', async () => {
    const context = await bootComposition()

    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect(context.get('agents')).toBeInstanceOf(AgentRegistry)
    expect(context.get('sessionProjections')).toBeInstanceOf(SessionProjectionRegistry)
    expect(context.get('systemPrompt')).toBeInstanceOf(SystemPrompt)
    expect(context.get('tools')).toBeInstanceOf(ToolRuntime)
    expect(context.tools.schemas().map(schema => schema.name)).toEqual([
      'jdcloud_lowcode_find_department',
      'jdcloud_lowcode_find_role',
      'jdcloud_lowcode_find_user',
      'jdcloud_lowcode_describe',
      'jdcloud_lowcode_query',
      'jdcloud_lowcode_get',
      'jdcloud_lowcode_upload_file',
      'jdcloud_lowcode_create',
      'jdcloud_lowcode_update',
      'jdcloud_lowcode_delete',
      'jdcloud_lowcode_create_table',
    ])
    const assembled = await context.systemPrompt.assemble()
    expect(assembled.sections.map(section => section.name)).toContain('tool:jdcloud-lowcode')
    const lowcodeGuidance = assembled.sections.find(section => section.name === 'tool:jdcloud-lowcode')?.text ?? ''
    expect(lowcodeGuidance).toContain('infer every field value that is directly supported')
    expect(lowcodeGuidance).toContain('not only titles, but also values such as amounts, dates')
    expect(lowcodeGuidance).toContain('Never invent opaque ids')
    expect(lowcodeGuidance).toContain('currentMember')
    expect(lowcodeGuidance).toContain('目前还缺少关键信息')
    expect(lowcodeGuidance).toContain('every described field, including required and optional fields')
    await expect(context.jdcloudAuthController.status()).resolves.toEqual({
      authenticated: false,
      baseUrl: 'https://kindoucloud.com',
    })
  })

  it('loads the external API with a low-code Bearer token and current tenant header', async () => {
    const fetcher = vi.fn((input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      switch (url.pathname) {
        case '/api/system/corp/getCorpList':
          return Promise.resolve(json(corpData()))
        case '/api/oauth/currentUser':
          return Promise.resolve(json({
            userInfo: { id: 'external-user-id', userName: 'external-user', corpId: 'corp-current' },
            userPermission: { systemAdministrator: true },
          }))
        default:
          throw new Error(`unexpected JDCloud request: ${url.pathname}`)
      }
    })
    const context = await bootComposition(fetcher, true)
    const externalResponse = await ExternalApi.fetchExternalApi(context, new Request(
      'http://127.0.0.1/api/external/v1/skills',
      {
        headers: {
          authorization: 'Bearer low-code-token',
          'x-tenant-id': 'corp-current',
          'x-jdcloud-base-url': 'https://kindoucloud.com',
        },
      },
    ))
    expect(externalResponse.status).toBe(200)
    await expect(externalResponse.json()).resolves.toEqual({
      code: 200,
      data: {
        skills: [{ name: 'global-skill', scope: 'built-in' }],
        canManageBuiltIn: true,
      },
    })
    expect(fetcher.mock.calls.map(call => call[1]?.headers)).toEqual([
      { authorization: 'low-code-token' },
      { authorization: 'low-code-token' },
    ])
  })

  it('synchronizes a transferred token to the tenant reported by the real controller composition', async () => {
    const requestPaths: string[] = []
    const fetcher = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requestPaths.push(url.pathname)
      switch (url.pathname) {
        case '/api/system/corp/getCorpList':
          return Promise.resolve(json(corpData()))
        case '/api/system/corp/switchCorp/corp-current':
          return Promise.resolve(json({ corpId: 'corp-current' }))
        case '/api/oauth/currentUser':
          return Promise.resolve(json({
            userInfo: { id: 'transfer-user-id', userName: 'transfer-user', corpId: 'corp-current' },
            userPermission: { systemAdministrator: true },
          }))
        default:
          throw new Error(`unexpected JDCloud request: ${url.pathname}`)
      }
    })
    const context = await bootComposition(fetcher)

    await expect(context.jdcloudAuthController.loginWithToken({
      baseUrl: 'https://kindoucloud.com',
      token: 'bearer transferred-token',
    }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      authenticated: true,
      username: 'transfer-user',
      corpId: 'corp-current',
      systemAdministrator: true,
    })
    expect(requestPaths).toEqual([
      '/api/system/corp/getCorpList',
      '/api/system/corp/switchCorp/corp-current',
      '/api/oauth/currentUser',
    ])
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
            userInfo: {
              id: 'user-1',
              corpId: 'corp-current',
              departmentId: ['department-1'],
              roleId: [],
            },
            userPermission: { systemAdministrator: true },
            menuList: [
              { id: 'form-1', parentId: '-1', fullName: '打卡记录', type: 3, agentPermissions: ['readData'] },
              { id: 'board-1', parentId: '-1', fullName: '打卡看板', type: 6 },
            ],
          }))
        case '/api/system/permission/users/getMemberName':
          return Promise.resolve(json({
            department: [{ id: 'department-1', fullName: '研发部' }],
            role: [],
            user: [{ id: 'user-1', fullName: '测试用户', phone: '13800000000' }],
          }))
        case '/api/system/permission/organize/selector':
          return Promise.resolve(json([{
            id: 'tenant-root',
            parentId: '-1',
            hasChildren: true,
            fullName: '测试租户',
            children: [{
              id: 'department-it',
              parentId: 'tenant-root',
              hasChildren: false,
              fullName: 'IT部门',
            }],
          }]))
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
      '/api/oauth/currentUser',
      '/api/system/permission/users/getMemberName',
      '/api/system/permission/organize/selector',
    ])
    expect(decision).toMatchObject({
      kind: 'enter',
      messages: [
        { source: { kind: 'user', rpcId: 'browser-prompt-1' } },
        { source: { kind: 'jdcloud-lowcode', plugin: 'tool-jdcloud-lowcode', form: 'snapshot' } },
      ],
    })
    expect(JSON.stringify(decision)).toContain('form-1')
    expect(JSON.stringify(decision)).toContain('测试用户')
    expect(JSON.stringify(decision)).toContain('研发部')
    expect(JSON.stringify(decision)).toContain('Current Tenant')
    expect(JSON.stringify(decision)).not.toContain('board-1')
  })
})
