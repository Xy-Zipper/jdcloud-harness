import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
  readonly uploads?: object
  readonly agents?: object
} = {}): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('agents', (services.agents ?? { get: () => undefined }) as never)
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
  if (services.uploads !== undefined) ctx.provide('fileUploads', services.uploads as never)
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
  it.each([{ fileReceiptIds: [] }, { fileReceiptIds: ['receipt-1'] }])('creates a Session, invokes selected Skills, and admits file receipts $fileReceiptIds', async ({ fileReceiptIds }) => {
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
          data: { source: { kind: 'user', rpcId: promptRequest?.requestId } },
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
        fileReceiptIds,
      }),
    }, { 'content-type': 'application/json' }))
    const stream = await response.text()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-a' })
    expect(promptRequest?.content).toEqual([
      { type: 'text', text: '/shared-skill\n完成任务' },
      ...fileReceiptIds.map(receiptId => ({ type: 'file', receiptId })),
    ])
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

describe('external API Session files', () => {
  function snapshot() {
    return { type: 'snapshot', header: { id: 'session-files', cwd: '/owned/project' }, cursor: -1, records: [], hasMore: false }
  }

  it('creates an ordinary Session without submitting a prompt', async () => {
    const create = vi.fn(async () => ({ sessionId: 'session-files' }))
    const prompt = vi.fn()
    const ctx = context({ sessions: { create, prompt } })
    const response = await fetchExternalApi(ctx, request('/api/external/v1/sessions/create', {
      method: 'POST', body: JSON.stringify({ workspaceId: 'workspace-a' }),
    }, { 'content-type': 'application/json' }))
    await expect(response.json()).resolves.toEqual({ code: 200, data: { sessionId: 'session-files' } })
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-a' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('reads through the owned Session and closes the history iterator', async () => {
    let closed = false
    const follow = vi.fn(async function* () {
      try { yield snapshot() } finally { closed = true }
    })
    const read = vi.fn(async () => ({ text: '{"plans":[]}', version: 'v1', eof: true }))
    const ctx = context({ sessions: { follow }, files: { read } })
    const response = await fetchExternalApi(ctx, request('/api/external/v1/sessions/file?sessionId=session-files&path=artifact.json'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 200, data: { path: 'artifact.json', text: '{"plans":[]}', version: 'v1' } })
    expect(read).toHaveBeenCalledWith({ sessionId: 'session-files', workspaceRoot: '/owned/project' }, 'artifact.json', {}, expect.any(AbortSignal))
    expect(closed).toBe(true)
  })

  it('refuses ownership failures before reading or staging file bytes', async () => {
    const follow = vi.fn(async function* () {
      throw new RemoteError('session/not-found', 'not owned', { sessionId: brandString<SessionId>('foreign') })
    })
    const read = vi.fn()
    const uploadStream = vi.fn()
    const ctx = context({ sessions: { follow }, files: { read }, uploads: { uploadStream } })
    const response = await fetchExternalApi(ctx, request('/api/external/v1/sessions/file?sessionId=foreign&path=secret.json'))
    expect(response.status).toBe(404)
    const upload = await fetchExternalApi(ctx, request('/api/external/v1/sessions/files/upload?sessionId=foreign', {
      method: 'POST', body: 'file',
    }, { 'content-type': 'application/octet-stream' }))
    expect(upload.status).toBe(404)
    expect(read).not.toHaveBeenCalled()
    expect(uploadStream).not.toHaveBeenCalled()
  })

  it('rejects a partial artifact instead of returning truncated JSON', async () => {
    const follow = async function* () { yield snapshot() }
    const ctx = context({ sessions: { follow }, files: { read: async () => ({ text: '{', eof: false }) } })
    const response = await fetchExternalApi(ctx, request('/api/external/v1/sessions/file?sessionId=session-files&path=big.json'))
    expect(response.status).toBe(400)
  })

  it('stages exact raw file bytes using the existing receipt service', async () => {
    const follow = async function* () { yield snapshot() }
    let stored = ''
    const uploadStream = vi.fn(async (input: { data: AsyncIterable<Uint8Array> }) => {
      for await (const bytes of input.data) stored += new TextDecoder().decode(bytes)
      return { receiptId: 'receipt-1', file: { attachmentId: 'digest', name: 'brief.txt', bytes: 7 } }
    })
    const ctx = context({ sessions: { follow }, uploads: { uploadStream } })
    const response = await fetchExternalApi(ctx, request('/api/external/v1/sessions/files/upload?sessionId=session-files&name=brief.txt', {
      method: 'POST', body: 'example',
    }, { 'content-type': 'application/octet-stream' }))
    expect(response.status).toBe(200)
    expect(stored).toBe('example')
    expect(uploadStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-files', name: 'brief.txt' }))
    await expect(response.json()).resolves.toMatchObject({ code: 200, data: { receiptId: 'receipt-1' } })
  })

  it('rejects empty or incorrectly typed uploads and missing query parameters', async () => {
    const follow = async function* () { yield snapshot() }
    const uploadStream = async (input: { data: AsyncIterable<Uint8Array> }) => {
      for await (const _bytes of input.data) { /* Consume the checked request stream. */ }
    }
    const ctx = context({ sessions: { follow }, uploads: { uploadStream } })
    for (const path of ['/api/external/v1/sessions/file', '/api/external/v1/sessions/file?sessionId=session-files']) {
      expect((await fetchExternalApi(ctx, request(path))).status).toBe(400)
    }
    expect((await fetchExternalApi(ctx, request('/api/external/v1/sessions/files/upload?sessionId=session-files', {
      method: 'POST', body: '',
    }, { 'content-type': 'application/octet-stream' }))).status).toBe(400)
    expect((await fetchExternalApi(ctx, request('/api/external/v1/sessions/files/upload?sessionId=session-files', {
      method: 'POST', body: 'content',
    }, { 'content-type': 'application/json' }))).status).toBe(400)
  })
})

describe('external API Session history', () => {
  it('reports a running Agent even after intermediate assistant text and never submits another prompt', async () => {
    let running = true
    const prompt = vi.fn()
    const follow = vi.fn(async function* () {
      yield {
        type: 'snapshot', header: { id: 'session-history' }, cursor: 3, hasMore: false,
        projections: { asOfSeq: 3, values: {} },
        records: [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } } }],
      }
    })
    const ctx = context({ agents: { get: () => ({ status: running ? 'running' : 'idle' }) }, sessions: { follow, prompt } })
    const path = '/api/external/v1/sessions/history?sessionId=session-history'
    const active = await fetchExternalApi(ctx, request(path))
    await expect(active.json()).resolves.toMatchObject({ data: { running: true, startedAt: 100 } })
    running = false
    const completed = await fetchExternalApi(ctx, request(path))
    await expect(completed.json()).resolves.toMatchObject({ data: { running: false } })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('returns one owned text-only history page without assistant reasoning or tools', async () => {
    const follow = vi.fn(async function* () {
      yield {
        type: 'snapshot',
        header: { id: 'session-history' },
        cursor: 7,
        hasMore: false,
        projections: { asOfSeq: 7, values: {} },
        records: [
          {
            event: {
              type: 'user/message', seq: 1, time: 10, surfaceOp: 'append',
              data: {
                id: 'user-1', role: 'user', source: { kind: 'user' },
                content: [{ type: 'text', text: '调整平台' }],
              },
            },
          },
          {
            event: {
              type: 'assistant/message', seq: 2, time: 20, surfaceOp: 'append',
              data: {
                message: {
                  id: 'assistant-1', role: 'assistant', source: { kind: 'model' },
                  content: [
                    { type: 'reasoning', text: 'hidden' },
                    { type: 'text', text: '**已生成候选修改**' },
                    { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{}' },
                  ],
                },
              },
            },
          },
          {
            event: {
              type: 'user/message', seq: 3, time: 25, surfaceOp: 'append',
              data: {
                id: 'runtime-1', role: 'user', source: { kind: 'runtime-context', form: 'snapshot' },
                content: [{ type: 'text', text: 'Current runtime context.' }],
              },
            },
          },
          { event: { type: 'tool/result', seq: 4, time: 30, data: { content: 'ignored' } } },
        ],
      }
    })
    const ctx = context({ sessions: { follow } })

    const response = await fetchExternalApi(ctx, request(
      '/api/external/v1/sessions/history?sessionId=session-history&maxMessages=40',
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        sessionId: 'session-history',
        cursor: 7,
        hasMore: false,
        running: false,
        messages: [
          { id: 'user-1', role: 'user', text: '调整平台', createdAt: 10 },
          { id: 'assistant-1', role: 'assistant', text: '**已生成候选修改**', createdAt: 20 },
        ],
      },
    })
    expect(follow).toHaveBeenCalledWith({
      address: { kind: 'session', sessionId: 'session-history' },
      maxMessages: 40,
    }, expect.any(AbortSignal))
  })

  it('requires a Session id and a bounded message limit', async () => {
    const ctx = context({ sessions: { follow: vi.fn() } })
    const missing = await fetchExternalApi(ctx, request('/api/external/v1/sessions/history'))
    const oversized = await fetchExternalApi(ctx, request(
      '/api/external/v1/sessions/history?sessionId=session-history&maxMessages=201',
    ))

    expect(missing.status).toBe(400)
    expect(oversized.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({ code: 400, errorCode: 'gateway/bad-request' })
    await expect(oversized.json()).resolves.toMatchObject({ code: 400, errorCode: 'gateway/bad-request' })
  })
})
