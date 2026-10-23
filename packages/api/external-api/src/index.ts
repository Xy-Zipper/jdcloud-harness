/** Token-authenticated external HTTP and SSE facade over existing Host business services. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  SKILL_INSTALL_MAX_FILES,
  SKILL_INSTALL_MAX_FILE_BYTES,
  SKILL_INSTALL_MAX_TOTAL_BYTES,
  type AccountSkillDeleteRequest,
  type AccountSkillInstallRequest,
  type SessionFollowFrame,
  type SessionRequestId,
  type SkillInstallFile,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import { brandString } from '@deepseek-ai/dsh-brand'
import { bridge, type ConnectionFetchHandler, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { unzipSync } from 'fflate'

export const name = 'external-api'
export const inject = [
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
}

const ROUTES = new Map<string, (ctx: Context, request: Request) => Promise<Response>>([
  [`${API_PREFIX}/skills`, skillsList],
  [`${API_PREFIX}/skills/upload`, skillsUpload],
  [`${API_PREFIX}/skills/delete`, skillsDelete],
  [`${API_PREFIX}/workspaces`, workspacesList],
  [`${API_PREFIX}/workspaces/create`, workspacesCreate],
  [`${API_PREFIX}/workspaces/files`, workspaceFilesList],
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
  const iterator = ctx.sessionController.follow({
    address: { kind: 'session', sessionId },
    assistantStream: true,
  }, signal)[Symbol.asyncIterator]()
  let submittedMessageSeen = false
  try {
    const opening = await iterator.next()
    if (opening.done || opening.value.type !== 'snapshot') throw new Error('Session follow did not open with a snapshot')
    sendEvent(controller, encoder, 'session', { sessionId })
    sendEvent(controller, encoder, 'snapshot', opening.value)
    const skillPrefix = input.skillNames.map(name => `/${name}`).join(' ')
    const text = skillPrefix === '' ? input.message : `${skillPrefix}\n${input.message}`
    await ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
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
    await iterator.return?.()
  }
}

function isSubmittedUserMessage(frame: Extract<SessionFollowFrame, { type: 'event' }>, requestId: SessionRequestId): boolean {
  if (frame.event.type !== 'user/message') return false
  const data = frame.event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const source = Reflect.get(data, 'source')
  return typeof source === 'object' && source !== null && Reflect.get(source, 'rpcId') === requestId
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
    return successResponse(value)
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
  return {
    message,
    ...sessionId === undefined ? {} : { sessionId },
    ...workspaceId === undefined ? {} : { workspaceId },
    skillNames,
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
