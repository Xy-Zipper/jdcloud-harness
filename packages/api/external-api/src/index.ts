/** Token-authenticated external HTTP and SSE facade over existing Host business services. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  SKILL_INSTALL_MAX_FILES,
  SKILL_INSTALL_MAX_FILE_BYTES,
  SKILL_INSTALL_MAX_TOTAL_BYTES,
  type AccountSkillDeleteRequest,
  type AccountSkillInstallRequest,
  type SessionFollowFrame,
  type SessionHistoryRecord,
  type PromptContentPart,
  type SessionRequestId,
  type SkillInstallFile,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { bridge, type ConnectionFetchHandler, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { unzipSync } from 'fflate'

export const name = 'external-api'
export const inject = [
  'agents',
  'sessionController',
  'sessionSkillCatalog',
  'webServer',
  'workspaceController',
  'workspaceFiles',
]

const API_PREFIX = '/api/external/v1'
const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024
const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
}

interface ExternalAuthenticator {
  externalScopeHeader(): 'x-tenant-id' | 'x-project-id'
  runExternalRequest<Value>(
    token: string,
    scopeId: string,
    serviceBaseUrl: string | undefined,
    signal: AbortSignal,
    operation: () => Value,
  ): Promise<Awaited<Value>>
  workspaceRoot(): Promise<string | undefined>
}

interface ExternalRequestCredentials {
  readonly token: string
  readonly scopeId: string
  readonly serviceBaseUrl?: string
}

interface ChatRequest {
  readonly message: string
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly skillNames: readonly string[]
  readonly fileReceiptIds: readonly string[]
}

interface ExternalSessionMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly createdAt: number
}

const ROUTES = new Map<string, (ctx: Context, request: Request) => Promise<Response>>([
  [`${API_PREFIX}/skills`, skillsList],
  [`${API_PREFIX}/skills/upload`, skillsUpload],
  [`${API_PREFIX}/skills/delete`, skillsDelete],
  [`${API_PREFIX}/workspaces`, workspacesList],
  [`${API_PREFIX}/workspaces/create`, workspacesCreate],
  [`${API_PREFIX}/workspaces/files`, workspaceFilesList],
  [`${API_PREFIX}/sessions/history`, sessionHistory],
  [`${API_PREFIX}/sessions/questions/answer`, answerSessionQuestion],
  [`${API_PREFIX}/sessions/cancel`, cancelSession],
  [`${API_PREFIX}/sessions/create`, sessionCreate],
  [`${API_PREFIX}/sessions/file`, sessionFile],
  [`${API_PREFIX}/sessions/files/upload`, sessionFileUpload],
  [`${API_PREFIX}/sessions/files/content`, sessionFileContent],
  [`${API_PREFIX}/chat`, chat],
])

/** Register the external API routes directly so provider tokens are not mistaken for browser-session tokens. */
export function apply(ctx: Context): void {
  for (const path of ROUTES.keys()) register(ctx, path)
}

function register(ctx: Context, path: string): void {
  const fetchHandler: ConnectionFetchHandler = {
    requestBodyMode: () => 'buffered',
    fetch: request => fetchExternalApi(ctx, request),
  }
  // External calls authenticate with provider tokens, so one owner-principal
  // Peer shared by the whole surface stands in for the browser admission the
  // shared bridge requires; createPeer Peers are disposed with the Context.
  let ownerPeer: PeerScope | undefined
  const peerOf = (): PeerScope | undefined => {
    const connection = ctx.get('connection')
    if (connection === undefined) return undefined
    return ownerPeer ??= connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  }
  const route: WebRoute = {
    kind: 'exact',
    path,
    handler: (request, response) => {
      const peer = peerOf()
      if (peer === undefined) {
        response.writeHead(503)
        response.end()
        return Promise.resolve()
      }
      return bridge(
        request,
        response,
        fetchHandler,
        peer,
        MAX_REQUEST_BODY_BYTES,
      )
    },
  }
  ctx.effect(() => ctx.webServer.register(route), `external-api: ${path}`)
}

/**
 * Dispatch one fetch-shaped request to an exact external API route.
 * @param ctx - Host context containing the authentication and business services.
 * @param request - Provider-token-authenticated request candidate.
 * @returns Route response, or 404 for an unowned path.
 */
export function fetchExternalApi(ctx: Context, request: Request): Promise<Response> {
  const handler = ROUTES.get(new URL(request.url).pathname)
  return handler === undefined
    ? Promise.resolve(failureResponse(404, 'not_found', 'External API route not found'))
    : handler(ctx, request)
}

async function skillsList(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return authenticated(ctx, request, () => ctx.sessionSkillCatalog.listAccount(request.signal))
}

async function skillsUpload(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async () => {
    const input = await skillArchiveUpload(request)
    return ctx.sessionSkillCatalog.createAccount(input, request.signal)
  })
}

async function skillsDelete(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async () => {
    const body = await jsonBody(request)
    const input: AccountSkillDeleteRequest = {
      scope: managedSkillScope(body['scope']),
      name: requiredString(body['name'], 'name'),
    }
    return ctx.sessionSkillCatalog.deleteAccount(input, request.signal)
  })
}

async function workspacesList(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return authenticated(ctx, request, async () => ({ workspaces: await ctx.workspaceController.listVisible() }))
}

async function workspacesCreate(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async (authenticator) => {
    const body = await jsonBody(request)
    const directoryName = requiredString(body['name'], 'name')
    if (directoryName !== directoryName.trim()
      || directoryName === '.' || directoryName === '..'
      || directoryName.endsWith('.') || /[/\\:\0]/u.test(directoryName)) {
      throw badRequest('name must be one valid directory segment')
    }
    const root = await authenticator.workspaceRoot()
    if (root === undefined) throw badRequest('authenticated workspace root is unavailable')
    const path = join(root, directoryName)
    await mkdir(path, { recursive: true })
    return ctx.workspaceController.create({ path })
  })
}

async function workspaceFilesList(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return authenticated(ctx, request, async () => {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get('workspaceId')
    if (workspaceId === null || workspaceId === '') throw badRequest('workspaceId query parameter is required')
    const path = url.searchParams.get('path') ?? ''
    return ctx.workspaceFiles.listWorkspace(workspaceId, path, request.signal)
  })
}

/** Read one owned Session's latest user and assistant text messages without activating its Agent. */
async function sessionHistory(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return authenticated(ctx, request, async () => {
    const url = new URL(request.url)
    const sessionId = requiredValue(url.searchParams.get('sessionId') || undefined, 'sessionId query parameter is required')
    const maxMessages = historyLimit(url.searchParams.get('maxMessages'))
    const id = brandString<SessionId>(sessionId)
    // An intermediate Assistant message does not settle the Agent's running interval.
    const wasRunning = ctx.agents.get(id)?.status === 'running'
    const iterator = ctx.sessionController.follow({
      address: { kind: 'session', sessionId: id },
      maxMessages,
    }, request.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') {
        throw new Error('Session history did not open with a snapshot')
      }
      const live = ctx.agents.get(id)
      const running = wasRunning || live?.status === 'running'
      const visibleRecords = [...opening.value.records]
      // Recover older foreground calls through paged history without reading the live Session log.
      let hasMore = opening.value.hasMore
      while (running && hasMore && !visibleRecords.some(record => record.event.type === 'turn/start')) {
        const page = await ctx.sessionController.page({
          address: { kind: 'session', sessionId: id },
          throughSeq: opening.value.cursor,
          beforeSeq: visibleRecords[0]?.event.seq ?? opening.value.cursor + 1,
          maxMessages,
          turnWindow: { minMessages: 1, minTurns: 1 },
        }, request.signal)
        visibleRecords.unshift(...page.records)
        hasMore = page.hasMore
      }
      const startedAt = running ? visibleRecords.findLast(record => record.event.type === 'turn/start')?.event.time : undefined
      const pendingQuestions = sessionQuestions(ctx, id, visibleRecords)
      return {
        sessionId,
        cursor: opening.value.cursor,
        hasMore: opening.value.hasMore,
        running,
        ...(startedAt === undefined ? {} : { startedAt }),
        messages: externalSessionMessages(visibleRecords).slice(-maxMessages),
        ...(pendingQuestions.length ? { pendingQuestions } : {}),
      }
    } finally {
      await iterator.return?.()
    }
  })
}

/** Read foreground questions after the Session ownership check; older live calls remain visible but read-only. */
function sessionQuestions(ctx: Context, sessionId: SessionId, records: readonly SessionHistoryRecord[]) {
  const agent = ctx.agents.get(sessionId)
  const service = ctx.get('userQuestions')
  if (agent !== undefined && typeof service?.pendingOpen === 'function') {
    const open = service.pendingOpen(agent)
    if (open.length) return open.map(item => ({ ...item, answerable: true }))
  }
  const pending = new Map<string, { callId: string; questions: AskUserQuestionItem[]; answerable: boolean }>()
  for (const { event } of records) {
    if (event.type === 'turn/end') pending.clear()
    const data: unknown = event.data
    if (!isPlainRecord(data)) continue
    if (event.type === 'tool/result' && isPlainRecord(data.message) && typeof data.message.toolCallId === 'string') pending.delete(data.message.toolCallId)
    if (event.type !== 'tool/call' || data.name !== 'ask_user_question' || typeof data.callId !== 'string' || typeof data.arguments !== 'string') continue
    let args: unknown
    try { args = JSON.parse(data.arguments) }
    catch { continue }
    if (!isPlainRecord(args) || !Array.isArray(args.questions)) continue
    const questions = args.questions.flatMap((item): AskUserQuestionItem[] => {
      if (!isPlainRecord(item) || typeof item.id !== 'string' || typeof item.question !== 'string') return []
      const options = Array.isArray(item.options) ? item.options.flatMap(option =>
        isPlainRecord(option) && typeof option.label === 'string'
          ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }] : []) : undefined
      return [{ id: item.id, question: item.question,
        ...(typeof item.header === 'string' ? { header: item.header } : {}),
        ...(options === undefined ? {} : { options }), multiSelect: item.multi_select === true }]
    })
    if (questions.length) pending.set(data.callId, { callId: data.callId, questions, answerable: false })
  }
  return [...pending.values()]
}

/** Resume the owned foreground question instead of queuing another model prompt. */
async function answerSessionQuestion(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async () => {
    const body = await jsonBody(request)
    const sessionId = brandString<SessionId>(requiredString(body['sessionId'], 'sessionId'))
    const callId = ToolCallId(requiredString(body['callId'], 'callId'))
    if (!Array.isArray(body['answers'])) throw badRequest('answers must be an array')
    const answer: AskUserQuestionAnswer = { answers: body['answers'].map((item) => {
      if (!isPlainRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.selected)
        || !item.selected.every((label: unknown) => typeof label === 'string')
        || (item.custom !== undefined && typeof item.custom !== 'string')) throw badRequest('invalid question answer')
      return { id: item.id, selected: item.selected, ...(typeof item.custom === 'string' ? { custom: item.custom } : {}) }
    }) }
    const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, request.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') throw badRequest('Session history is unavailable')
      const agent = ctx.agents.get(sessionId)
      const service = ctx.get('userQuestions')
      if (agent === undefined || typeof service?.answerOpen !== 'function')
        throw badRequest('This question is still owned by the original Harness window; answer it there.')
      try {
        if (!service.answerOpen(agent, callId, answer)) throw badRequest('The question has already closed; refresh before answering.')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'BAD_ANSWER') throw badRequest(error.message)
        throw error
      }
      return { accepted: true, sessionId, callId }
    } finally {
      await iterator.return?.()
    }
  })
}

/** Request cancellation only after the current identity can read the Session; acceptance does not imply quiescence. */
async function cancelSession(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async () => {
    const body = await jsonBody(request)
    const sessionId = brandString<SessionId>(requiredString(body['sessionId'], 'sessionId'))
    const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, request.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') throw badRequest('Session history is unavailable')
      if (ctx.agents.get(sessionId)?.status === 'running') {
        ctx.sessionController.cancel({ sessionId })
      }
      return { accepted: true, sessionId }
    } finally {
      await iterator.return?.()
    }
  })
}

/** Create an owned Session without submitting a model turn, so files can be staged first. */
async function sessionCreate(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async () => {
    const body = await jsonBody(request)
    return ctx.sessionController.create({ workspaceId: brandString<WorkspaceId>(requiredString(body['workspaceId'], 'workspaceId')) })
  })
}

/** Read bounded UTF-8 text through the existing Session ownership and filesystem policies. */
async function sessionFile(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return authenticated(ctx, request, async () => {
    const url = new URL(request.url)
    const sessionId = brandString<SessionId>(requiredValue(url.searchParams.get('sessionId') || undefined, 'sessionId is required'))
    const path = requiredValue(url.searchParams.get('path') || undefined, 'path is required')
    const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, request.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('Session file read did not open with a snapshot')
      const workspaceRoot = requiredValue(opening.value.header.cwd, 'Session has no workspace directory')
      const file = await ctx.workspaceFiles.read({ sessionId, workspaceRoot }, path, {}, request.signal)
      if (!file.eof) throw badRequest('File exceeds the complete text preview limit')
      return { path, text: file.text, version: file.version }
    } finally {
      await iterator.return?.()
    }
  })
}

/** Stage one bounded raw file for an owned Session; the receipt is accepted only by that Session. */
async function sessionFileUpload(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return authenticated(ctx, request, async () => {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/octet-stream') {
      throw badRequest('content type must be application/octet-stream')
    }
    const url = new URL(request.url)
    const sessionId = brandString<SessionId>(requiredValue(url.searchParams.get('sessionId') || undefined, 'sessionId is required'))
    const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, request.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('Session upload did not open with a snapshot')
    } finally {
      await iterator.return?.()
    }
    const uploads = ctx.get('fileUploads')
    if (uploads === undefined) throw badRequest('Session file uploads are unavailable')
    const name = url.searchParams.get('name') ?? 'attachment'
    return uploads.uploadStream({ sessionId, name, data: requestFileChunks(request), signal: request.signal })
  })
}

/** Return stored file bytes only when an owned Session's user history references the file. */
async function sessionFileContent(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return authenticated(ctx, request, async () => {
    const url = new URL(request.url)
    const sessionId = brandString<SessionId>(requiredString(url.searchParams.get('sessionId'), 'sessionId'))
    const attachmentId = requiredString(url.searchParams.get('attachmentId'), 'attachmentId')
    const address = { kind: 'session' as const, sessionId }
    const iterator = ctx.sessionController.follow({ address, maxMessages: 200 }, request.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') throw badRequest('Session history is unavailable')
      let records = opening.value.records
      let hasMore = opening.value.hasMore
      let ref = userFileAttachment(records, attachmentId)
      while (ref === undefined && hasMore) {
        const page = await ctx.sessionController.page({
          address, throughSeq: opening.value.cursor,
          beforeSeq: records[0]?.event.seq ?? opening.value.cursor + 1, maxMessages: 200,
        }, request.signal)
        records = page.records
        hasMore = page.hasMore
        ref = userFileAttachment(records, attachmentId)
      }
      if (ref === undefined) throw badRequest('File is not referenced by this Session')
      if (ref.bytes > MAX_REQUEST_BODY_BYTES) throw badRequest('File exceeds the attachment read limit')
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw badRequest('File attachment storage is unavailable')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let bytes = 0
      for await (const chunk of attachments.readFileStream(ref, request.signal)) {
        bytes += chunk.byteLength
        if (bytes > MAX_REQUEST_BODY_BYTES) throw badRequest('File exceeds the attachment read limit')
        chunks.push(Uint8Array.from(chunk))
      }
      if (bytes !== ref.bytes) throw badRequest('Stored file length differs from its reference')
      return new Response(new Blob(chunks), { headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      } })
    } finally {
      await iterator.return?.()
    }
  })
}

function userFileAttachment(records: readonly SessionHistoryRecord[], attachmentId: string): FileAttachmentRef | undefined {
  for (const { event } of records) {
    const data = event.data
    if (event.type !== 'user/message' || !isPlainRecord(data) || !isPlainRecord(data.source)
      || data.source.kind !== 'user' || !Array.isArray(data.content)) continue
    for (const block of data.content) {
      if (!isPlainRecord(block) || block.type !== 'file' || !isPlainRecord(block.attachment)) continue
      const ref = block.attachment
      if (ref.attachmentId === attachmentId && typeof ref.name === 'string'
        && typeof ref.bytes === 'number' && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0) {
        return { attachmentId: AttachmentId(attachmentId), name: ref.name, bytes: ref.bytes }
      }
    }
  }
  return undefined
}

async function* requestFileChunks(request: Request): AsyncIterable<Uint8Array> {
  if (request.body === null) throw badRequest('file body is required')
  const reader = request.body.getReader()
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_REQUEST_BODY_BYTES) throw badRequest('file exceeds the external request byte limit')
      yield next.value
    }
    if (bytes === 0) throw badRequest('file must not be empty')
  } finally {
    reader.releaseLock()
  }
}

async function chat(ctx: Context, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  const authenticator = externalAuthenticator(ctx)
  if (authenticator === undefined) {
    return failureResponse(503, 'external_api_unavailable', 'External API authentication is unavailable')
  }
  const credentials = requestCredentials(request, authenticator.externalScopeHeader())
  if (credentials instanceof Response) return credentials
  try {
    return await authenticator.runExternalRequest(
      credentials.token,
      credentials.scopeId,
      credentials.serviceBaseUrl,
      request.signal,
      async () => {
        const input = parseChatRequest(await jsonBody(request))
        const sessionId = input.sessionId === undefined
          ? (await ctx.sessionController.create({
            workspaceId: brandString<WorkspaceId>(requiredValue(input.workspaceId, 'workspaceId is required for a new chat')),
          })).sessionId
          : brandString<SessionId>(input.sessionId)
        const catalog = await ctx.sessionSkillCatalog.list({ sessionId }, request.signal)
        const available = new Set(catalog.skills.map(skill => skill.name))
        for (const skillName of input.skillNames) {
          if (!available.has(skillName)) throw badRequest(`skill "${skillName}" is unavailable in this Session`)
        }
        return chatStream(ctx, request, sessionId, input)
      },
    )
  } catch (error: unknown) {
    return errorResponse(error)
  }
}

function chatStream(ctx: Context, request: Request, sessionId: SessionId, input: ChatRequest): Response {
  const localAbort = new AbortController()
  const signal = AbortSignal.any([request.signal, localAbort.signal])
  const requestId = brandString<SessionRequestId>(`external-${randomUUID()}`)
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void pumpChat(ctx, controller, encoder, sessionId, requestId, input, signal)
    },
    cancel() {
      localAbort.abort()
    },
  })
  return new Response(body, {
    headers: {
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function pumpChat(
  ctx: Context,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  sessionId: SessionId,
  requestId: SessionRequestId,
  input: ChatRequest,
  signal: AbortSignal,
): Promise<void> {
  let stopQuestions: (() => void) | undefined
  const iterator = ctx.sessionController.follow({
    address: { kind: 'session', sessionId },
    assistantStream: true,
  }, signal)[Symbol.asyncIterator]()
  let submittedMessageSeen = false
  try {
    const opening = await iterator.next()
    if (opening.done || opening.value.type !== 'snapshot') throw new Error('Session follow did not open with a snapshot')
    // The owned external conversation supplies an answer UI even without a Web tab.
    stopQuestions = ctx.on('user-questions/request', (question, next) => {
      if (question.agent?.id !== sessionId || question.wait === undefined) return next()
      return new Promise((_resolve, reject) => {
        const signal = question.signal
        const abort = () => {
          const reason: unknown = signal?.reason
          reject(reason instanceof Error ? reason : new Error('Question request aborted'))
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    }, { global: true, prepend: true })
    sendEvent(controller, encoder, 'session', { sessionId })
    sendEvent(controller, encoder, 'snapshot', opening.value)
    const skillPrefix = input.skillNames.map(name => `/${name}`).join(' ')
    const text = skillPrefix === '' ? input.message : `${skillPrefix}\n${input.message}`
    await ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [
        { type: 'text', text },
        ...input.fileReceiptIds.map((receiptId): PromptContentPart => ({ type: 'file', receiptId: brandString<Extract<PromptContentPart, { type: 'file' }>['receiptId']>(receiptId) })),
      ],
    }, signal)
    for (;;) {
      const next = await iterator.next()
      if (next.done) throw new Error('Session follow ended before the submitted turn completed')
      const frame = next.value
      sendEvent(controller, encoder, frame.type === 'assistant-stream' ? 'assistant' : 'event', frame)
      if (frame.type !== 'event') continue
      if (isSubmittedUserMessage(frame, requestId)) submittedMessageSeen = true
      if (submittedMessageSeen && frame.event.type === 'turn/end') {
        sendEvent(controller, encoder, 'done', { sessionId })
        controller.close()
        return
      }
    }
  } catch (error: unknown) {
    if (!signal.aborted) {
      sendErrorEvent(controller, encoder, error)
      controller.close()
    }
  } finally {
    stopQuestions?.()
    await iterator.return?.()
  }
}

function isSubmittedUserMessage(frame: Extract<SessionFollowFrame, { type: 'event' }>, requestId: SessionRequestId): boolean {
  if (frame.event.type !== 'user/message') return false
  const data = frame.event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const source = Reflect.get(data, 'source')
  return typeof source === 'object'
    && source !== null
    && Reflect.get(source, 'kind') === 'user'
    && Reflect.get(source, 'rpcId') === requestId
}

/** Parse and bound the public history page size. */
function historyLimit(raw: string | null): number {
  if (raw === null || raw === '') return 100
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw badRequest('maxMessages must be an integer between 1 and 200')
  }
  return parsed
}

/** Project durable Session events into the text-only history creation-studio can render. */
function externalSessionMessages(records: readonly SessionHistoryRecord[]): ExternalSessionMessage[] {
  return records.flatMap<ExternalSessionMessage>(({ event }) => {
    if (event.type === 'user/message') {
      const source = isPlainRecord(event.data) ? Reflect.get(event.data, 'source') : undefined
      if (!isPlainRecord(source) || Reflect.get(source, 'kind') !== 'user') return []
      const message = sessionMessage(event.data)
      return message === undefined ? [] : [{
        id: message.id || `user-${String(event.seq)}`,
        role: 'user' as const,
        text: message.text,
        createdAt: event.time,
      }]
    }
    if (event.type === 'assistant/message') {
      const data = isPlainRecord(event.data) ? Reflect.get(event.data, 'message') : undefined
      const message = sessionMessage(data)
      return message === undefined ? [] : [{
        id: message.id || `assistant-${String(event.seq)}`,
        role: 'assistant' as const,
        text: message.text,
        createdAt: event.time,
      }]
    }
    return []
  })
}

function sessionMessage(value: unknown): { readonly id: string; readonly text: string } | undefined {
  if (!isPlainRecord(value)) return undefined
  const content = Reflect.get(value, 'content')
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((block) => {
    if (!isPlainRecord(block) || Reflect.get(block, 'type') !== 'text') return []
    const text = Reflect.get(block, 'text')
    return typeof text === 'string' && text !== '' ? [text] : []
  })
  if (parts.length === 0) return undefined
  const id = Reflect.get(value, 'id')
  return { id: typeof id === 'string' ? id : '', text: parts.join('\n') }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  value: unknown,
): void {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ code: 200, data: value })}\n\n`))
}

function sendErrorEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  error: unknown,
): void {
  // The HTTP status is already committed after SSE opens, so the event carries the numeric failure status.
  const value = responseError(error)
  const payload = failureBody(errorStatus(value.errorCode), value.errorCode, value.message, value.details)
  controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`))
}

async function authenticated(
  ctx: Context,
  request: Request,
  operation: (authenticator: ExternalAuthenticator) => Promise<unknown>,
): Promise<Response> {
  const authenticator = externalAuthenticator(ctx)
  if (authenticator === undefined) {
    return failureResponse(503, 'external_api_unavailable', 'External API authentication is unavailable')
  }
  const credentials = requestCredentials(request, authenticator.externalScopeHeader())
  if (credentials instanceof Response) return credentials
  try {
    const value = await authenticator.runExternalRequest(
      credentials.token,
      credentials.scopeId,
      credentials.serviceBaseUrl,
      request.signal,
      () => operation(authenticator),
    )
    return value instanceof Response ? value : successResponse(value)
  } catch (error: unknown) {
    return errorResponse(error)
  }
}

function externalAuthenticator(ctx: Context): ExternalAuthenticator | undefined {
  const getService = ctx.get.bind(ctx) as (name: string) => object | undefined
  const candidate = getService('ontologyAuthController') ?? getService('jdcloudAuthController')
  if (candidate === undefined
    || typeof Reflect.get(candidate, 'externalScopeHeader') !== 'function'
    || typeof Reflect.get(candidate, 'runExternalRequest') !== 'function'
    || typeof Reflect.get(candidate, 'workspaceRoot') !== 'function') return undefined
  return candidate as ExternalAuthenticator
}

function requestCredentials(
  request: Request,
  scopeHeader: 'x-tenant-id' | 'x-project-id',
): ExternalRequestCredentials | Response {
  const authorization = request.headers.get('authorization')
  const match = authorization === null ? null : /^Bearer\s+(.+)$/iu.exec(authorization)
  if (match?.[1] === undefined || match[1].trim() === '') {
    return failureResponse(401, 'unauthorized', 'Bearer token is required')
  }
  const otherHeader = scopeHeader === 'x-tenant-id' ? 'x-project-id' : 'x-tenant-id'
  if ((request.headers.get(otherHeader)?.trim() ?? '') !== '') {
    return failureResponse(400, 'invalid_scope', `${headerName(otherHeader)} is not accepted by this deployment`)
  }
  const scopeId = request.headers.get(scopeHeader)?.trim()
  if (scopeId === undefined || scopeId === '') {
    return failureResponse(400, 'invalid_scope', `${headerName(scopeHeader)} is required`)
  }
  const serviceBaseUrl = request.headers.get('x-jdcloud-base-url')?.trim()
  if (scopeHeader === 'x-project-id') {
    if (serviceBaseUrl !== undefined && serviceBaseUrl !== '') {
      return failureResponse(400, 'invalid_scope', 'X-JDCloud-Base-Url is not accepted by this deployment')
    }
    return { token: match[1].trim(), scopeId }
  }
  if (serviceBaseUrl === undefined || serviceBaseUrl === '') {
    return failureResponse(400, 'invalid_request', 'X-JDCloud-Base-Url is required')
  }
  return { token: match[1].trim(), scopeId, serviceBaseUrl }
}

function headerName(header: 'x-tenant-id' | 'x-project-id'): 'X-Tenant-Id' | 'X-Project-Id' {
  return header === 'x-tenant-id' ? 'X-Tenant-Id' : 'X-Project-Id'
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw badRequest('content type must be application/json')
  let value: unknown
  try {
    value = await request.json()
  } catch (error: unknown) {
    throw badRequest('body is not valid JSON', error)
  }
  return record(value, 'body')
}

function parseChatRequest(body: Record<string, unknown>): ChatRequest {
  const message = requiredString(body['message'], 'message')
  if (message.trim() === '') throw badRequest('message must not be blank')
  const sessionId = optionalString(body['sessionId'], 'sessionId')
  const workspaceId = optionalString(body['workspaceId'], 'workspaceId')
  const rawSkills = body['skillNames'] ?? []
  if (!Array.isArray(rawSkills)) throw badRequest('skillNames must be an array')
  const skillNames = rawSkills.map((value, index) => requiredString(value, `skillNames[${String(index)}]`))
  if (new Set(skillNames).size !== skillNames.length) throw badRequest('skillNames must not contain duplicates')
  const rawReceipts = body['fileReceiptIds'] ?? []
  if (!Array.isArray(rawReceipts)) throw badRequest('fileReceiptIds must be an array')
  const fileReceiptIds = rawReceipts.map((value, index) => requiredString(value, `fileReceiptIds[${String(index)}]`))
  if (new Set(fileReceiptIds).size !== fileReceiptIds.length) throw badRequest('fileReceiptIds must not contain duplicates')
  return {
    message,
    ...sessionId === undefined ? {} : { sessionId },
    ...workspaceId === undefined ? {} : { workspaceId },
    skillNames,
    fileReceiptIds,
  }
}

function managedSkillScope(value: unknown): AccountSkillInstallRequest['scope'] {
  if (value !== 'personal' && value !== 'built-in') throw badRequest('scope must be personal or built-in')
  return value
}

/** Parse one multipart ZIP upload and preserve the existing Skill folder validation path. */
async function skillArchiveUpload(request: Request): Promise<AccountSkillInstallRequest> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'multipart/form-data') throw badRequest('content type must be multipart/form-data')
  let form: FormData
  try {
    form = await request.formData()
  } catch (error: unknown) {
    throw badRequest('body is not valid multipart form data', error)
  }
  for (const name of form.keys()) {
    if (name !== 'scope' && name !== 'file') throw badRequest(`unexpected multipart field: ${name}`)
  }
  const scopes = form.getAll('scope')
  if (scopes.length !== 1) throw badRequest('one scope field is required')
  const scope = managedSkillScope(scopes[0])
  const archives = form.getAll('file')
  if (archives.length !== 1 || !(archives[0] instanceof File)) throw badRequest('one ZIP file field is required')
  const archive = archives[0]
  if (!archive.name.toLowerCase().endsWith('.zip')) throw badRequest('file name must end with .zip')
  if (archive.size === 0) throw badRequest('ZIP file must not be empty')
  return {
    scope,
    files: skillFilesFromZip(new Uint8Array(await archive.arrayBuffer())),
  }
}

/** Expand one bounded Skill ZIP and remove its optional wrapping directory. */
function skillFilesFromZip(archive: Uint8Array): readonly SkillInstallFile[] {
  let declaredFiles = 0
  let declaredBytes = 0
  let expanded: Record<string, Uint8Array>
  try {
    expanded = unzipSync(archive, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false
        declaredFiles += 1
        if (declaredFiles > SKILL_INSTALL_MAX_FILES) {
          throw badRequest(`ZIP archive exceeds ${String(SKILL_INSTALL_MAX_FILES)} files`)
        }
        if (file.originalSize > SKILL_INSTALL_MAX_FILE_BYTES) {
          throw badRequest(`ZIP entry "${file.name}" exceeds ${String(SKILL_INSTALL_MAX_FILE_BYTES)} bytes`)
        }
        declaredBytes += file.originalSize
        if (declaredBytes > SKILL_INSTALL_MAX_TOTAL_BYTES) {
          throw badRequest(`ZIP archive exceeds ${String(SKILL_INSTALL_MAX_TOTAL_BYTES)} expanded bytes`)
        }
        return true
      },
    })
  } catch (error: unknown) {
    if (remoteErrorOf(error) !== undefined) throw error
    throw badRequest('file must contain a valid ZIP archive', error)
  }
  const entries = Object.entries(expanded)
  if (entries.length === 0) throw badRequest('ZIP archive contains no files')
  for (const [path] of entries) {
    if (!isArchiveFilePath(path)) throw badRequest(`ZIP archive contains an invalid path: ${JSON.stringify(path)}`)
  }
  const skillFiles = entries.filter(([path]) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  if (skillFiles.length !== 1) throw badRequest('ZIP archive must contain exactly one SKILL.md')
  const skillPath = skillFiles[0]?.[0]
  if (skillPath === undefined) throw badRequest('ZIP archive must contain SKILL.md')
  const root = skillPath.slice(0, -'SKILL.md'.length)
  let expandedBytes = 0
  return entries.map(([path, content]) => {
    if (!path.startsWith(root)) throw badRequest('every ZIP file must be inside the Skill folder')
    const relativePath = path.slice(root.length)
    if (relativePath === '') throw badRequest('ZIP archive contains an empty file path')
    expandedBytes += content.byteLength
    if (content.byteLength > SKILL_INSTALL_MAX_FILE_BYTES || expandedBytes > SKILL_INSTALL_MAX_TOTAL_BYTES) {
      throw badRequest('ZIP expanded content exceeds the Skill upload limits')
    }
    return { path: relativePath, contentBase64: Buffer.from(content).toString('base64') }
  }).sort((left, right) => left.path.localeCompare(right.path))
}

/** Reject traversal and platform-specific separators before removing the wrapping directory. */
function isArchiveFilePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest(`${name} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw badRequest(`${name} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, name)
}

function requiredValue<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw badRequest(message)
  return value
}

function badRequest(message: string, cause?: unknown): RemoteError {
  return new RemoteError(
    'gateway/bad-request',
    message,
    {},
    cause === undefined ? undefined : { cause },
  )
}

function methodNotAllowed(allowed: 'GET' | 'POST'): Response {
  return failureResponse(405, 'method_not_allowed', 'Method not allowed', undefined, { allow: allowed })
}

function errorResponse(error: unknown): Response {
  const value = responseError(error)
  return failureResponse(errorStatus(value.errorCode), value.errorCode, value.message, value.details)
}

function responseError(error: unknown): { errorCode: string; message: string; details?: unknown } {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { errorCode: remote.code, message: remote.message, details: remote.details }
  return { errorCode: 'internal_error', message: 'External API request failed' }
}

function errorStatus(errorCode: string): number {
  if (errorCode === 'jdcloud/auth-required' || errorCode === 'ontology/auth-required') return 401
  if (errorCode.includes('forbidden') || errorCode === 'skill/forbidden') return 403
  if (errorCode.includes('not-found')) return 404
  if (errorCode === 'skill/already-exists') return 409
  if (errorCode === 'gateway/bad-request' || errorCode === 'skill/invalid') return 400
  if (errorCode === 'gateway/cancelled') return 499
  return 500
}

function successResponse(value: unknown): Response {
  return jsonResponse({ code: 200, data: value }, 200)
}

/** Preserve the internal error identity without using it as the public numeric code. */
function failureBody(code: number, errorCode: string, message: string, details?: unknown): object {
  return { code, errorCode, message, ...details === undefined ? {} : { details } }
}

function failureResponse(
  code: number,
  errorCode: string,
  message: string,
  details?: unknown,
  additionalHeaders: Record<string, string> = {},
): Response {
  // Callers can use the same number from either the HTTP status or the JSON body.
  return jsonResponse(failureBody(code, errorCode, message, details), code, additionalHeaders)
}

function jsonResponse(value: unknown, status: number, additionalHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...additionalHeaders } })
}
