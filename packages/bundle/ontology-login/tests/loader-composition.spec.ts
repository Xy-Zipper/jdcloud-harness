/** Ontology login rows must activate through the real Cordis Loader. */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, parseEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import * as ExternalApi from '@deepseek-ai/dsh-api-external'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as fileAssistant from '@deepseek-ai/dsh-ontology-login/file-assistant'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import OntologyAuthController from '../../../api/ontology-auth-controller/src/index.ts'
import { BrowserSessionService } from '../../../client/connection/src/browser-session.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import WebServer from '../../../host/webserver/src/index.ts'
import * as ontologyTool from '../../../ontology/tool-ontology/src/index.ts'

let directory: string | undefined
let ctx: Context | undefined
const socketFetch = globalThis.fetch
const fileAssistantPackage = '@deepseek-ai/dsh-ontology-login/file-assistant'

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

/** Create the Loader tree with the real controller and UI Host entry. */
async function bootComposition(fetcher: typeof fetch): Promise<Context> {
  vi.stubGlobal('fetch', fetcher)
  const loginUiEntry = pathToFileURL(join(
    import.meta.dirname,
    '../../../client/ui-ontology-login/src/index.ts',
  )).href
  const loginUiModule = await import(loginUiEntry) as Record<string, unknown>
  expect('default' in loginUiModule).toBe(false)

  directory = await mkdtemp(join(tmpdir(), 'dsh-ontology-login-loader-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@fixture/memory-credentials'",
    "- name: '@fixture/browser-session'",
    "- name: '@fixture/external-services'",
    "- name: '@deepseek-ai/dsh-client-connection'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-api-ontology-auth-controller'",
    '  config:',
    '    ontologyBaseUrl: https://ontology.example.com',
    '    requestTimeoutMs: 15000',
    "- name: '@deepseek-ai/dsh-api-external'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-default-model'",
    '  config: { provider: fixture, model: file-model }',
    `- name: '${fileAssistantPackage}'`,
    "- name: '@deepseek-ai/dsh-tool-ontology'",
    "- name: '@deepseek-ai/dsh-client-ui-ontology-login'",
    '',
  ].join('\n'))

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const browserSessionModule = {
    inject: ['credentials'],
    async apply(context: Context) {
      await BrowserSessionService.create(context, context.credentials)
    },
  }
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
    ['@fixture/browser-session', browserSessionModule],
    ['@fixture/external-services', externalServicesModule],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-api-ontology-auth-controller', OntologyAuthController],
    ['@deepseek-ai/dsh-api-external', ExternalApi],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    [fileAssistantPackage, fileAssistant],
    ['@deepseek-ai/dsh-tool-ontology', ontologyTool],
    ['@deepseek-ai/dsh-client-ui-ontology-login', loginUiModule],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal

  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

function browserCookie(browserSession: BrowserSessionService): string {
  const response: {
    headers: Record<string, string>
    writeHead: (_status: number, headers?: Readonly<Record<string, string>>) => void
    end: () => void
  } = {
    headers: {},
    writeHead: (_status, headers) => { if (headers !== undefined) Object.assign(response.headers, headers) },
    end: () => undefined,
  }
  browserSession.authorizeIndex({ headers: { host: 'harness.example' }, method: 'GET', url: '/' }, response)
  const cookie = response.headers['set-cookie']?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('browser session cookie was not created')
  return cookie
}

describe('Ontology login through a real Loader composition', () => {
  it('adds an independent browser session and the Ontology packages', () => {
    const web = parseEntryYaml(
      readFileSync(join(import.meta.dirname, '../../web-app/cordis.patch.yml'), 'utf8'),
    ) as PatchOptions[]
    const ontology = parseEntryYaml(
      readFileSync(join(import.meta.dirname, '../cordis.patch.yml'), 'utf8'),
    ) as PatchOptions[]
    const rows = applyEntryPatches([], [...web, ...ontology], () => {})
    expect(rows.find(row => row.id === 'authentication-token')).toMatchObject({ disabled: true })
    expect(rows.find(row => row.id === 'browser-session')?.name).toBe('@deepseek-ai/dsh-client-connection/browser-session')
    expect(rows.find(row => row.id === 'directory-picker')).toMatchObject({ disabled: true })
    expect(rows.find(row => row.id === 'directory-picker-browse')?.name)
      .toBe('@deepseek-ai/dsh-host-directory-picker-browse')
    expect(rows.find(row => row.id === 'ui-directory-picker-browse')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-directory-picker-browse')
    expect(rows.find(row => row.id === 'ontology-auth-controller')?.name)
      .toBe('@deepseek-ai/dsh-api-ontology-auth-controller')
    expect(rows.find(row => row.id === 'external-api')?.name)
      .toBe('@deepseek-ai/dsh-api-external')
    expect(rows.find(row => row.id === 'file-assistant')?.name)
      .toBe(fileAssistantPackage)
    expect(rows.find(row => row.id === 'tool-ontology')?.name)
      .toBe('@deepseek-ai/dsh-tool-ontology')
    expect(rows.find(row => row.id === 'ui-ontology-login')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-ontology-login')
    expect(rows.find(row => row.id === 'ui-settings-models')).toMatchObject({
      config: { welcomeNotice: false, credentialOnboarding: false },
    })
  })

  it('answers from the submitted excerpts on the configured route and rejects unsupported citations', async () => {
    const context = await bootComposition(vi.fn())
    const endpoint = `http://127.0.0.1:${String(context.webServer.port)}/api/internal/file-assistant/answer`
    const input = { question: '交付日期是哪天？', sources: [{ id: 'S1', text: '11月12日交付。', fileName: '项目.txt' }] }
    const post = (body: unknown, token = 'test-only') => socketFetch(endpoint, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const seen: GenerateOptions[] = []
    const supported = { answer: '交付日期为11月12日。', sourceIds: ['S1'] }
    const absent = { answer: '当前所选资料中未找到足够依据。', sourceIds: [] }
    let output = JSON.stringify(supported)
    const adapter = new class extends LlmAdapter {
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        seen.push(options)
        yield { type: 'reasoning-delta', index: 0, text: 'internal reasoning' }
        yield { type: 'text-delta', index: 1, text: output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }()
    context.llm.registerAdapter(['fixture'], adapter)
    vi.stubEnv('FILE_ASSISTANT_SERVICE_TOKEN', '')
    expect((await post(input)).status).toBe(503)
    vi.stubEnv('FILE_ASSISTANT_SERVICE_TOKEN', 'test-only')
    expect((await post(input, 'browser-token')).status).toBe(401)
    const auth = { authorization: 'Bearer test-only' }
    expect((await socketFetch(endpoint, { headers: auth })).status).toBe(405)
    expect((await socketFetch(endpoint, { method: 'POST', headers: auth, body: 'plain text' })).status).toBe(415)
    expect((await socketFetch(endpoint, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{',
    })).status).toBe(400)
    expect((await post({ ...input, sources: Array.from({ length: 9 }, (_, i) => ({
      id: String(i), fileName: '文件', text: '片段',
    })) })).status).toBe(400)
    expect((await post({ ...input, sources: [input.sources[0], input.sources[0]] })).status).toBe(400)
    await expect((await post({ ...input, sources: [] })).json()).resolves.toEqual(absent)
    expect(seen).toHaveLength(0)
    await expect((await post({ ...input, model: 'untrusted', tools: ['shell'] })).json()).resolves.toEqual(supported)
    expect(seen[0]).toMatchObject({
      provider: 'fixture', model: 'file-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }],
    })
    expect(seen[0]?.tools).toBeUndefined()
    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.system).toMatchSnapshot()
    output = JSON.stringify({ answer: '无依据的猜测', sourceIds: [] })
    await expect((await post(input)).json()).resolves.toEqual(absent)
    for (const invalid of [
      'not JSON', '{"answer":"答复","sourceIds":["S2"]}', '{"answer":"答复","sourceIds":["S1","S1"]}',
    ]) {
      output = invalid
      expect((await post(input)).status).toBe(502)
    }
    const qa = { task: 'qa', sources: input.sources }
    const generated = { questions: [{ question: input.question, answer: supported.answer, sourceIds: ['S1'] }] }
    output = JSON.stringify(generated)
    await expect((await post(qa)).json()).resolves.toEqual(generated)
    expect(seen.at(-1)?.system).toMatchSnapshot('generate cited questions')
    output = JSON.stringify({ questions: [{ ...generated.questions[0], sourceIds: ['outside'] }] })
    expect((await post(qa)).status).toBe(502)
    expect((await post({ ...qa, sources: [] })).status).toBe(400)
    const extract = { task: 'extract', sources: input.sources }
    const extracted = {
      entities: [{ name: '交付', type: '事件', sourceIds: ['S1'] }, { name: '11月12日', type: '日期', sourceIds: ['S1'] }],
      relations: [{ subject: '交付', predicate: '日期', object: '11月12日', sourceIds: ['S1'] }],
    }
    output = JSON.stringify(extracted)
    await expect((await post(extract)).json()).resolves.toEqual(extracted)
    expect(seen.at(-1)?.system).toMatchSnapshot('extract cited entities and relations')
    output = JSON.stringify({ ...extracted, relations: [{ ...extracted.relations[0], object: '11月13日' }] })
    expect((await post(extract)).status).toBe(502)
    const transform = { task: 'pipeline', prompt: '提取水库名称', fields: { content: '示例水库' }, outputType: 'entities' }
    output = JSON.stringify({ value: ['示例水库'] })
    await expect((await post(transform)).json()).resolves.toEqual({ value: ['示例水库'] })
    expect(seen.at(-1)?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: JSON.stringify(transform) }] }])
    expect(seen.at(-1)?.system).toMatchSnapshot('transform selected pipeline fields')
    output = ['```json', '{"value":["示例水库"]}', '```'].join('\n')
    await expect((await post(transform)).json()).resolves.toEqual({ value: ['示例水库'] })
    output = '提取结果如下：\n' + output
    await expect((await post(transform)).json()).resolves.toEqual({ error: 'invalid_model_answer' })
    output = '{"value":[]}'
    await expect((await post(transform)).json()).resolves.toEqual({ value: [] })
    output = JSON.stringify({ value: { name: '示例水库' } })
    expect((await post(transform)).status).toBe(502)
    await expect((await post({ ...transform, outputType: 'json' })).json()).resolves.toEqual({ value: { name: '示例水库' } })
    output = '{"value":"摘要"}'
    await expect((await post({ ...transform, outputType: 'text' })).json()).resolves.toEqual({ value: '摘要' })
    const entry = [...context.loader.entries()].find(candidate => candidate.options.name === fileAssistantPackage)
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    // The remaining /api prefix now checks browser credentials.
    expect((await post(input)).status).toBe(401)
  })

  it('activates the controller and UI node half for password and imported browser-scoped logins', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.endsWith('/api/runtime/auth/login')) {
        return Response.json({
          accessToken: 'access-token',
          accessTokenExpiresAt: '2026-10-09T10:15:00Z',
          refreshToken: 'refresh-token',
          refreshTokenExpiresAt: '2026-11-08T10:00:00Z',
          user: {
            userId: 'user-alice', username: 'alice', displayName: 'Alice',
            accountType: 'admin', authorizationVersion: '1',
          },
        })
      }
      if (url.pathname.endsWith('/api/runtime/auth/current')) {
        return Response.json({
          userId: 'user-alice', username: 'alice', displayName: 'Alice',
          accountType: 'admin', authorizationVersion: '1',
        })
      }
      if (url.pathname.endsWith('/api/runtime/projects')) {
        return Response.json({
          projects: [{
            id: 'project-sales', name: 'Sales', description: 'Sales project', releaseVersion: 'release-1',
          }],
        })
      }
      throw new Error(`unexpected Ontology request: ${url.pathname}`)
    })
    const context = await bootComposition(fetcher)
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const browserSession = context.get('browserSession') as BrowserSessionService
    expect(browserSession).toBeInstanceOf(BrowserSessionService)
    expect(context.get('ontologyAuthController')).toBeInstanceOf(OntologyAuthController)
    expect(context.tools.schemas().map(schema => schema.name)).toEqual([
      'ontology_list_projects',
      'ontology_list_objects',
      'ontology_describe_object',
      'ontology_describe_action',
      'ontology_query_objects',
      'ontology_get_object',
      'ontology_traverse_link',
      'ontology_prepare_action',
      'ontology_execute_action',
      'ontology_get_draft',
      'ontology_add_draft_resources',
      'ontology_inspect_data_source',
      'ontology_update_draft_bindings',
    ])
    const externalResponse = await socketFetch(
      `http://127.0.0.1:${String(context.webServer.port)}/api/external/v1/skills`,
      {
        headers: {
          authorization: 'Bearer go-runtime-access-token',
          'x-project-id': 'project-sales',
        },
      },
    )
    expect(externalResponse.status).toBe(200)
    await expect(externalResponse.json()).resolves.toEqual({
      code: 200,
      data: {
        skills: [{ name: 'global-skill', scope: 'built-in' }],
        canManageBuiltIn: true,
      },
    })
    const cookie = browserCookie(browserSession)
    const request = { headers: { host: 'harness.example', cookie } }

    await expect(browserSession.run(request, () => context.ontologyAuthController.login({
      username: 'alice', password: 'password123',
    }, AbortSignal.timeout(1_000)))).resolves.toMatchObject({
      authenticated: true,
      user: { userId: 'user-alice', authorizationVersion: '1' },
    })

    const importedRequest = { headers: { host: 'harness.example', cookie: browserCookie(browserSession) } }
    await expect(browserSession.run(importedRequest, () => context.ontologyAuthController.importSession({
      accessToken: 'access-imported',
      accessTokenExpiresAt: '2026-10-09T10:15:00Z',
      refreshToken: 'refresh-imported',
      refreshTokenExpiresAt: '2026-11-08T10:00:00Z',
      user: {
        userId: 'user-alice', username: 'alice', displayName: 'Alice',
        accountType: 'admin', authorizationVersion: '1',
      },
    }, AbortSignal.timeout(1_000)))).resolves.toMatchObject({
      authenticated: true,
      user: { userId: 'user-alice', authorizationVersion: '1' },
    })
  })

  it('uses the current browser token and rechecks Project authorization on every tool call', async () => {
    let aliceProjectAllowed = true
    let aliceAuthorizationVersion = '1'
    const projectTokens: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/api/runtime/auth/login')) {
        const body = await request.json() as { username: string }
        const username = body.username
        return Response.json({
          accessToken: `access-${username}`,
          accessTokenExpiresAt: '2026-10-10T12:00:00Z',
          refreshToken: `refresh-${username}`,
          refreshTokenExpiresAt: '2026-11-10T12:00:00Z',
          user: {
            userId: `user-${username}`, username, displayName: username,
            accountType: 'member', authorizationVersion: '1',
          },
        })
      }
      const token = request.headers.get('authorization')?.replace('Bearer ', '')
      const username = token?.replace('access-', '')
      if (url.pathname.endsWith('/api/runtime/auth/current')) {
        if (username === undefined) throw new Error('current-user request omitted the Access Token')
        return Response.json({
          userId: `user-${username}`, username, displayName: username,
          accountType: 'member',
          authorizationVersion: username === 'alice' ? aliceAuthorizationVersion : '1',
        })
      }
      if (url.pathname.endsWith('/api/runtime/projects')) {
        if (token === undefined) throw new Error('Project request omitted the Access Token')
        projectTokens.push(token)
        if (username === 'alice' && !aliceProjectAllowed) {
          return Response.json({
            code: 'runtime_project_forbidden', message: 'Project access was revoked', requestId: 'request-revoked',
          }, { status: 403 })
        }
        return Response.json({
          projects: [{
            id: `project-${username}`, name: `${username} project`, description: 'authorized project',
            releaseVersion: 'release-1',
          }],
        })
      }
      throw new Error(`unexpected Ontology request: ${url.pathname}`)
    })
    const context = await bootComposition(fetcher)
    const browserSession = context.get('browserSession') as BrowserSessionService
    const aliceCookie = browserCookie(browserSession)
    const bobCookie = browserCookie(browserSession)
    const aliceRequest = { headers: { host: 'harness.example', cookie: aliceCookie } }
    const bobRequest = { headers: { host: 'harness.example', cookie: bobCookie } }

    await browserSession.run(aliceRequest, () => context.ontologyAuthController.login({
      username: 'alice', password: 'alice-password',
    }, AbortSignal.timeout(1_000)))
    await browserSession.run(bobRequest, () => context.ontologyAuthController.login({
      username: 'bob', password: 'bob-password',
    }, AbortSignal.timeout(1_000)))

    let call = 0
    const listProjects = (request: typeof aliceRequest) => browserSession.run(request, () => executeToolFixture(context, {
      name: 'ontology_list_projects',
      arguments: {},
      callId: ToolCallId(`loader-ontology-${String(++call)}`),
      signal: new AbortController().signal,
    }))
    await expect(listProjects(aliceRequest)).resolves.toMatchObject({
      isError: false, value: { projects: [{ id: 'project-alice' }] },
    })
    await expect(listProjects(bobRequest)).resolves.toMatchObject({
      isError: false, value: { projects: [{ id: 'project-bob' }] },
    })

    aliceProjectAllowed = false
    aliceAuthorizationVersion = '2'
    await expect(listProjects(aliceRequest)).resolves.toMatchObject({ isError: true })
    expect(projectTokens).toEqual(['access-alice', 'access-bob', 'access-alice'])
  })

  it('loads the Action approval gate and executes only after the Runtime preview is allowed', async () => {
    const runtimePaths: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/api/runtime/auth/login')) {
        return Response.json({
          accessToken: 'access-alice', accessTokenExpiresAt: '2026-10-10T23:00:00Z',
          refreshToken: 'refresh-alice', refreshTokenExpiresAt: '2026-11-10T23:00:00Z',
          user: {
            userId: 'user-alice', username: 'alice', displayName: 'Alice',
            accountType: 'member', authorizationVersion: '1',
          },
        })
      }
      if (url.pathname.endsWith('/api/runtime/auth/current')) {
        return Response.json({
          userId: 'user-alice', username: 'alice', displayName: 'Alice',
          accountType: 'member', authorizationVersion: '1',
        })
      }
      if (url.pathname.endsWith('/api/runtime/action-invocations/invocation-loader')) {
        runtimePaths.push(`${request.method} ${url.pathname}`)
        return Response.json({
          invocationId: 'invocation-loader', projectId: 'project-sales', actionTypeId: 'action-update-order',
          actionKind: 'object', releaseVersion: 'release-1', authorizationVersion: '1',
          expiresAt: '2026-10-10T23:00:00Z', requiresConfirmation: true,
          summary: '更新订单 order-loader',
          affectedObjects: [{ objectTypeId: 'object-order', primaryKey: 'order-loader' }],
          status: 'prepared',
        })
      }
      if (url.pathname.endsWith('/api/runtime/action-invocations/invocation-loader/execute')) {
        runtimePaths.push(`${request.method} ${url.pathname}`)
        return Response.json({
          invocationId: 'invocation-loader', status: 'succeeded', result: { operation: 'update' },
        })
      }
      throw new Error(`unexpected Ontology request: ${url.pathname}`)
    })
    const context = await bootComposition(fetcher)
    const browserSession = context.get('browserSession') as BrowserSessionService
    const cookie = browserCookie(browserSession)
    const request = { headers: { host: 'harness.example', cookie } }
    await browserSession.run(request, () => context.ontologyAuthController.login({
      username: 'alice', password: 'alice-password',
    }, AbortSignal.timeout(1_000)))

    const approvalReasons: string[] = []
    context.on('approval/request', (approval) => {
      approvalReasons.push(approval.reason ?? '')
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const session = Session.create(SessionId('loader-ontology-action'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as never

    await expect(browserSession.run(request, () => executeToolFixture(context, {
      name: 'ontology_execute_action',
      arguments: { invocation_id: 'invocation-loader' },
      callId: ToolCallId('loader-ontology-action'),
      agent,
      signal: new AbortController().signal,
    }))).resolves.toMatchObject({
      isError: false,
      value: { invocationId: 'invocation-loader', status: 'succeeded' },
    })
    expect(approvalReasons).toEqual([expect.stringContaining('更新订单 order-loader')])
    expect(runtimePaths).toEqual([
      'GET /api/runtime/action-invocations/invocation-loader',
      'POST /api/runtime/action-invocations/invocation-loader/execute',
    ])
  })
})
