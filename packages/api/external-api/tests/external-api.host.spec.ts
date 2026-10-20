import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchExternalApi } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function request(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://harness.test${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer provider-token',
      'x-tenant-id': 'tenant-a',
      'x-jdcloud-base-url': 'https://mi.kindoucloud.com',
      ...headers,
    },
  })
}

/** Build the public multipart upload with one optionally wrapped Skill folder. */
function skillArchiveForm(scope: 'personal' | 'built-in' = 'personal'): FormData {
  const archive = zipSync({
    'sample-skill/SKILL.md': new TextEncoder().encode(
      '---\nname: sample-skill\ndescription: Sample external Skill.\n---\n\nUse the sample.\n',
    ),
    'sample-skill/references/guide.md': new TextEncoder().encode('Guide.\n'),
  })
  const form = new FormData()
  form.set('scope', scope)
  form.set('file', new Blob([Uint8Array.from(archive)], { type: 'application/zip' }), 'sample-skill.zip')
  return form
}

function context(services: {
  readonly provider?: 'jdcloud' | 'ontology'
  readonly authenticate?: (
    token: string,
    scopeId: string,
    serviceBaseUrl: string | undefined,
    signal: AbortSignal,
    operation: () => unknown,
  ) => Promise<unknown>
  readonly skills?: object
  readonly sessions?: object
  readonly workspaces?: object
  readonly files?: object
} = {}): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide(services.provider === 'ontology' ? 'ontologyAuthController' : 'jdcloudAuthController', {
    externalScopeHeader: () => services.provider === 'ontology' ? 'x-project-id' : 'x-tenant-id',
    runExternalRequest: services.authenticate ?? (async (
      _token: string,
      _scopeId: string,
      _serviceBaseUrl: string | undefined,
      _signal: AbortSignal,
      operation: () => unknown,
    ) => await operation()),
    workspaceRoot: () => Promise.resolve('C:\\external-workspaces'),
  } as never)
  ctx.provide('sessionSkillCatalog', services.skills ?? {
    listAccount: () => Promise.resolve({
      skills: [{ name: 'shared-skill', scope: 'built-in' }],
      installScopes: ['personal'],
    }),
  } as never)
  ctx.provide('sessionController', services.sessions ?? {} as never)
  ctx.provide('workspaceController', services.workspaces ?? {} as never)
  ctx.provide('workspaceFiles', services.files ?? {} as never)
  return ctx
}

describe('external API authentication', () => {
  it('requires a provider Bearer token, JDCloud tenant scope, and service address', async () => {
    const ctx = context()
    const missingToken = await fetchExternalApi(ctx, request('/api/external/v1/skills', {}, {
      authorization: '',
    }))
    expect(missingToken.status).toBe(401)
    await expect(missingToken.json()).resolves.toMatchObject({ code: 401, errorCode: 'unauthorized' })

    const missingScope = await fetchExternalApi(ctx, request('/api/external/v1/skills', {}, {
      'x-tenant-id': '',
    }))
    expect(missingScope.status).toBe(400)
    await expect(missingScope.json()).resolves.toMatchObject({ code: 400, errorCode: 'invalid_scope' })

    const missingServiceAddress = await fetchExternalApi(ctx, request('/api/external/v1/skills', {}, {
      'x-jdcloud-base-url': '',
    }))
    expect(missingServiceAddress.status).toBe(400)
    await expect(missingServiceAddress.json()).resolves.toMatchObject({ code: 400, errorCode: 'invalid_request' })
  })

  it('accepts only the scope header selected by the active authentication controller', async () => {
    const jdcloud = context()
    expect((await fetchExternalApi(jdcloud, request('/api/external/v1/skills', {}, {
      'x-project-id': 'project-a',
    }))).status).toBe(400)

    const ontology = context({ provider: 'ontology' })
    const accepted = await fetchExternalApi(ontology, request('/api/external/v1/skills', {}, {
      'x-tenant-id': '',
      'x-project-id': 'project-a',
      'x-jdcloud-base-url': '',
    }))
    expect(accepted.status).toBe(200)
    expect((await fetchExternalApi(ontology, request('/api/external/v1/skills'))).status).toBe(400)
    expect((await fetchExternalApi(ontology, request('/api/external/v1/skills', {}, {
      'x-tenant-id': '',
      'x-project-id': 'project-a',
    }))).status).toBe(400)
  })

  it('passes the raw token and scope to the active authentication controller', async () => {
    const authenticate = vi.fn(async (
      _token: string,
      _scopeId: string,
      _serviceBaseUrl: string | undefined,
      _signal: AbortSignal,
      operation: () => unknown,
    ) => await operation())
    const ctx = context({ authenticate })

    const response = await fetchExternalApi(ctx, request('/api/external/v1/skills'))

    expect(response.status).toBe(200)
    expect(authenticate).toHaveBeenCalledWith(
      'provider-token',
      'tenant-a',
      'https://mi.kindoucloud.com',
      expect.any(AbortSignal),
      expect.any(Function),
    )
    await expect(response.json()).resolves.toMatchObject({
      code: 200,
      data: { installScopes: ['personal'] },
    })
  })

  it('maps tenant and administrator refusals without exposing an internal failure', async () => {
    const tenant = context({
      authenticate: () => Promise.reject(new RemoteError(
        'jdcloud/external-tenant-forbidden',
        'wrong tenant',
        { tenantId: 'tenant-a' },
      )),
    })
    const tenantResponse = await fetchExternalApi(tenant, request('/api/external/v1/skills'))
    expect(tenantResponse.status).toBe(403)
    await expect(tenantResponse.json()).resolves.toMatchObject({
      code: 403,
      errorCode: 'jdcloud/external-tenant-forbidden',
    })

    const member = context({
      skills: {
        createAccount: () => Promise.reject(new RemoteError(
          'skill/forbidden',
          'administrator required',
          { scope: 'built-in' },
        )),
      },
    })
    const response = await fetchExternalApi(member, request('/api/external/v1/skills/upload', {
      method: 'POST',
      body: skillArchiveForm('built-in'),
    }))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 403, errorCode: 'skill/forbidden' })
  })

  it('installs one ZIP archive after removing its wrapping directory', async () => {
    const createAccount = vi.fn(() => Promise.resolve({
      skill: { name: 'sample-skill', description: 'Sample external Skill.', scope: 'personal' },
    }))
    const ctx = context({ skills: { createAccount } })

    const response = await fetchExternalApi(ctx, request('/api/external/v1/skills/upload', {
      method: 'POST',
      body: skillArchiveForm(),
    }))

    expect(response.status).toBe(200)
    await expect(response.clone().json()).resolves.toMatchObject({
      code: 200,
      data: { skill: { name: 'sample-skill', scope: 'personal' } },
    })
    expect(createAccount).toHaveBeenCalledWith({
      scope: 'personal',
      files: [
        {
          path: 'references/guide.md',
          contentBase64: Buffer.from('Guide.\n').toString('base64'),
        },
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            '---\nname: sample-skill\ndescription: Sample external Skill.\n---\n\nUse the sample.\n',
          ).toString('base64'),
        },
      ],
    }, expect.any(AbortSignal))
  })

  it('rejects the former JSON file-array upload format', async () => {
    const ctx = context({ skills: { createAccount: vi.fn() } })
    const response = await fetchExternalApi(ctx, request('/api/external/v1/skills/upload', {
      method: 'POST',
      body: JSON.stringify({ scope: 'personal', files: [] }),
    }, { 'content-type': 'application/json' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      errorCode: 'gateway/bad-request',
      message: 'content type must be multipart/form-data',
    })
  })

  it('returns numeric envelopes for unknown routes and unsupported methods', async () => {
    const ctx = context()
    const missing = await fetchExternalApi(ctx, request('/api/external/v1/missing'))
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      code: 404,
      errorCode: 'not_found',
      message: 'External API route not found',
    })

    const method = await fetchExternalApi(ctx, request('/api/external/v1/skills', { method: 'POST' }))
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET')
    await expect(method.json()).resolves.toEqual({
      code: 405,
      errorCode: 'method_not_allowed',
      message: 'Method not allowed',
    })

    const unavailable = new Context()
    contexts.push(unavailable)
    const unavailableResponse = await fetchExternalApi(unavailable, request('/api/external/v1/skills'))
    expect(unavailableResponse.status).toBe(503)
    await expect(unavailableResponse.json()).resolves.toEqual({
      code: 503,
      errorCode: 'external_api_unavailable',
      message: 'External API authentication is unavailable',
    })

    const failed = context({ authenticate: () => Promise.reject(new Error('private failure')) })
    const failedResponse = await fetchExternalApi(failed, request('/api/external/v1/skills'))
    expect(failedResponse.status).toBe(500)
    await expect(failedResponse.json()).resolves.toEqual({
      code: 500,
      errorCode: 'internal_error',
      message: 'External API request failed',
    })
  })
})

describe('external API chat stream', () => {
  it('creates a Session, invokes selected Skills, and streams model-provided reasoning through SSE', async () => {
    let promptRequest: {
      readonly requestId: string
      readonly content: readonly { readonly type: string; readonly text: string }[]
    } | undefined
    let promptAccepted: (() => void) | undefined
    const promptReady = new Promise<void>((resolve) => { promptAccepted = resolve })
    const create = vi.fn(() => Promise.resolve({ sessionId: 'session-external' }))
    const prompt = vi.fn((value: typeof promptRequest) => {
      promptRequest = value
      promptAccepted?.()
      return Promise.resolve({ accepted: true })
    })
    async function* follow() {
      yield {
        type: 'snapshot',
        header: { id: 'session-external' },
        cursor: -1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
        assistantStream: { revision: 0 },
      }
      await promptReady
      yield {
        type: 'event',
        event: {
          type: 'user/message', seq: 0, time: 1,
          data: { source: { kind: 'user-rpc', rpcId: promptRequest?.requestId } },
        },
      }
      yield {
        type: 'assistant-stream',
        frame: {
          type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 2,
          chunk: { reasoning: 'model-provided reasoning', content: 'answer' },
        },
      }
      yield { type: 'event', event: { type: 'turn/end', seq: 1, time: 3, data: {} } }
    }
    const ctx = context({
      skills: {
        list: () => Promise.resolve({ skills: [{ name: 'shared-skill' }] }),
      },
      sessions: { create, prompt, follow },
    })

    const response = await fetchExternalApi(ctx, request('/api/external/v1/chat', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'workspace-a',
        message: '完成任务',
        skillNames: ['shared-skill'],
      }),
    }, { 'content-type': 'application/json' }))
    const stream = await response.text()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-a' })
    expect(promptRequest?.content).toEqual([{ type: 'text', text: '/shared-skill\n完成任务' }])
    expect(stream).toContain('event: assistant')
    expect(stream).toContain('model-provided reasoning')
    expect(stream).toContain('event: done')
    expect(stream).toContain('data: {"code":200,"data":{"sessionId":"session-external"}}')
  })

  it('streams a numeric error envelope after the response has opened', async () => {
    async function* follow() {
      yield {
        type: 'snapshot',
        header: { id: 'session-external' },
        cursor: -1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
        assistantStream: { revision: 0 },
      }
    }
    const ctx = context({
      skills: { list: () => Promise.resolve({ skills: [] }) },
      sessions: {
        create: () => Promise.resolve({ sessionId: 'session-external' }),
        follow,
        prompt: () => Promise.reject(new RemoteError('gateway/bad-request', 'prompt rejected', {})),
      },
    })

    const response = await fetchExternalApi(ctx, request('/api/external/v1/chat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'workspace-a', message: 'test' }),
    }, { 'content-type': 'application/json' }))
    const stream = await response.text()

    expect(response.status).toBe(200)
    expect(stream).toContain('event: error')
    expect(stream).toContain('data: {"code":400,"errorCode":"gateway/bad-request","message":"prompt rejected","details":{}}')
  })
})
