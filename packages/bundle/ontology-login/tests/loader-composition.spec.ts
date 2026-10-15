/** Ontology login rows must activate through the real Cordis Loader. */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as yaml from 'js-yaml'
import { BrowserSessionService } from '../../../client/connection/src/browser-session.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OntologyAuthController from '../../../api/ontology-auth-controller/src/index.ts'
import * as ontologyTool from '../../../ontology/tool-ontology/src/index.ts'

let directory: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.unstubAllGlobals()
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
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-api-ontology-auth-controller'",
    '  config:',
    '    ontologyBaseUrl: https://ontology.example.com',
    '    requestTimeoutMs: 15000',
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
  const modules = new Map<string, unknown>([
    ['@fixture/memory-credentials', MemoryCredentials],
    ['@fixture/browser-session', browserSessionModule],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-api-ontology-auth-controller', OntologyAuthController],
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
    const web = yaml.load(
      readFileSync(join(import.meta.dirname, '../../web-app/cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as PatchOptions[]
    const ontology = yaml.load(
      readFileSync(join(import.meta.dirname, '../cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as PatchOptions[]
    const rows = applyEntryPatches([], [...web, ...ontology], () => {})
    expect(rows.find(row => row.id === 'connection')).toMatchObject({
      config: {
        browserAuthentication: false,
        browserSession: true,
        browserSessionTransport: 'bearer',
      },
    })
    expect(rows.find(row => row.id === 'ontology-auth-controller')?.name)
      .toBe('@deepseek-ai/dsh-api-ontology-auth-controller')
    expect(rows.find(row => row.id === 'tool-ontology')?.name)
      .toBe('@deepseek-ai/dsh-tool-ontology')
    expect(rows.find(row => row.id === 'ui-ontology-login')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-ontology-login')
    expect(rows.find(row => row.id === 'ui-settings-models')).toMatchObject({
      config: { welcomeNotice: false, credentialOnboarding: false },
    })
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
    ])
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
    const listProjects = (request: typeof aliceRequest) => browserSession.run(request, () => context.tools.execute({
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

    await expect(browserSession.run(request, () => context.tools.execute({
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
