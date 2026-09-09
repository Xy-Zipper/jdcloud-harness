import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {
  JdcloudAuthenticatedRequest,
  JdcloudAuthStatus,
} from '@deepseek-ai/dsh-api-jdcloud-auth-controller'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as LowcodePlugin from '../src/index.ts'
import type { LowcodeCapabilitySnapshot } from '../src/current-user.ts'
import { registerLowcodeTools, type LowcodeSnapshotStore } from '../src/tools.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface RecordedRequest extends JdcloudAuthenticatedRequest {
  readonly body?: unknown
}

type RequestResponder = (request: RecordedRequest, index: number) => unknown

const AUTHENTICATED: Extract<JdcloudAuthStatus, { readonly authenticated: true }> = {
  authenticated: true,
  baseUrl: 'https://lowcode.example.test',
  username: 'tester',
  corpId: 'corp-1',
  corpName: 'Tenant One',
  corps: [{ corpId: 'corp-1', corpName: 'Tenant One' }],
}

const SNAPSHOT: LowcodeCapabilitySnapshot = {
  turn: 1,
  corpId: 'corp-1',
  corpName: 'Tenant One',
  systemAdministrator: true,
  menus: [
    {
      menuId: 'form-1',
      fullName: 'Clock Form',
      path: 'Attendance / Clock Form',
      type: 3,
      agentPermissions: ['addData', 'editData', 'deleteData'],
    },
    {
      menuId: 'flow-1',
      fullName: 'Leave Flow',
      path: 'Attendance / Leave Flow',
      type: 4,
      agentPermissions: ['addData', 'editData', 'deleteData'],
    },
  ],
}

/** Current-user data sufficient for the browser-prompt listener. */
function currentUser(): Record<string, unknown> {
  return {
    userInfo: { id: 'user-1' },
    userPermission: { systemAdministrator: true },
    menuList: [{
      id: 'form-1',
      parentId: '-1',
      fullName: 'Clock Form',
      type: 3,
      agentPermissions: ['addData', 'editData', 'deleteData'],
    }],
  }
}

/** Build the complete live Agent surface required by AgentRegistry and ToolRuntime. */
function makeAgent(ctx: Context, rawId = 'coverage-agent', status: Agent['status'] = 'running'): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    status,
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

interface Services {
  readonly ctx: Context
  readonly requests: RecordedRequest[]
  readonly requestAuthenticated: ReturnType<typeof vi.fn>
  readonly status: ReturnType<typeof vi.fn>
  setStatus(value: JdcloudAuthStatus): void
  setResponder(value: RequestResponder): void
}

/** Mount real registries and a mutable Host authentication fixture. */
async function services(options: {
  readonly turnBoundary?: boolean
  readonly response?: RequestResponder
} = {}): Promise<Services> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  if (options.turnBoundary !== false) ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)

  let statusValue: JdcloudAuthStatus = AUTHENTICATED
  let responder: RequestResponder = options.response ?? (() => ({ ok: true }))
  const requests: RecordedRequest[] = []
  const requestAuthenticated = vi.fn(async (request: RecordedRequest): Promise<unknown> => {
    requests.push(request)
    return await responder(request, requests.length - 1)
  })
  const status = vi.fn((): Promise<JdcloudAuthStatus> => Promise.resolve(statusValue))
  ctx.provide('jdcloudAuthController', { requestAuthenticated, status } as never)
  return {
    ctx,
    requests,
    requestAuthenticated,
    status,
    setStatus(value) { statusValue = value },
    setResponder(value) { responder = value },
  }
}

interface ToolHarness extends Services {
  readonly agent: Agent
  readonly snapshots: LowcodeSnapshotStore
  call(
    name: string,
    args: unknown,
    options?: { readonly agent?: Agent | undefined; readonly initiator?: boolean },
  ): Promise<ToolExecutionResult>
}

/** Register only the low-code tool surface with directly controlled Host snapshots. */
async function toolHarness(options: {
  readonly turnBoundary?: boolean
  readonly openTurn?: boolean
  readonly registerAgent?: boolean
  readonly snapshot?: LowcodeCapabilitySnapshot | false
  readonly status?: Agent['status']
  readonly maxPageSize?: number
  readonly maxOutputBytes?: number
  readonly response?: RequestResponder
} = {}): Promise<ToolHarness> {
  const mounted = await services(options)
  const snapshots: LowcodeSnapshotStore = new WeakMap()
  registerLowcodeTools(mounted.ctx, snapshots, {
    maxPageSize: options.maxPageSize ?? 20,
    maxOutputBytes: options.maxOutputBytes ?? 8_192,
  })
  const agent = makeAgent(mounted.ctx, 'coverage-agent', options.status)
  if (options.registerAgent !== false) mounted.ctx.agents.register(agent)
  if (options.openTurn !== false) agent.session.append('turn/start', { turn: 1 })
  if (options.snapshot !== false) snapshots.set(agent, options.snapshot ?? SNAPSHOT)
  let calls = 0
  return {
    ...mounted,
    agent,
    snapshots,
    call(name, args, callOptions = {}) {
      const subject = Object.hasOwn(callOptions, 'agent') ? callOptions.agent : agent
      const execute = () => mounted.ctx.tools.execute({
        name,
        arguments: args,
        callId: ToolCallId(`coverage-call-${String(++calls)}`),
        signal: new AbortController().signal,
        ...subject === undefined ? {} : { agent: subject },
      })
      return callOptions.initiator === false || subject === undefined
        ? execute()
        : mounted.ctx.agents.withInitiator(subject, execute)
    },
  }
}

/** Execute the plugin's browser-prompt listener through its scoped event channel. */
async function preStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
  signal: AbortSignal,
  next: () => Promise<{ readonly kind: 'enter'; readonly messages: UserMessage[] } | { readonly kind: 'reject' }>,
) {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    next,
  )
}

/** Build one admitted browser message. */
function browserMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'read JDCloud data' }],
    source: { kind: 'user', rpcId: 'coverage-rpc' } as never,
  })
}

/** Extract the normalized tool error code. */
function errorCode(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

/** Join normalized text blocks for assertions. */
function resultText(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

describe('plugin configuration and prompt branches', () => {
  it('resolves omitted limits and rejects each unsafe or non-positive direct configuration', async () => {
    const mounted = await services()
    const fiber = await mounted.ctx.plugin(LowcodePlugin, {})
    expect(mounted.ctx.tools.schemas()).toHaveLength(7)
    await fiber.dispose()

    for (const maxPageSize of [0, 1.5]) {
      expect(() => { LowcodePlugin.apply(new Context(), { maxPageSize }) })
        .toThrow('maxPageSize must be a positive safe integer')
    }
    for (const maxOutputBytes of [0, 1.5]) {
      expect(() => { LowcodePlugin.apply(new Context(), { maxOutputBytes }) })
        .toThrow('maxOutputBytes must be a positive safe integer')
    }
  })

  it('passes through rejected, aborted, non-browser, and plugin-only proposed steps', async () => {
    const mounted = await services({ response: () => currentUser() })
    await mounted.ctx.plugin(LowcodePlugin, {})
    const agent = makeAgent(mounted.ctx)
    mounted.ctx.agents.register(agent)

    await expect(preStep(
      mounted.ctx,
      agent,
      [browserMessage()],
      new AbortController().signal,
      () => Promise.resolve({ kind: 'reject' as const }),
    )).resolves.toEqual({ kind: 'reject' })

    const aborted = new AbortController()
    aborted.abort(new Error('cancelled before pre-step'))
    await expect(preStep(
      mounted.ctx,
      agent,
      [browserMessage()],
      aborted.signal,
      () => Promise.resolve({ kind: 'enter' as const, messages: [browserMessage()] }),
    )).resolves.toMatchObject({ kind: 'enter', messages: [{ source: { kind: 'user' } }] })

    const ordinary = createUserMessage({
      content: [{ type: 'text', text: 'ordinary' }],
      source: { kind: 'user' },
    })
    const plugin = createUserMessage({
      content: [{ type: 'text', text: 'plugin' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    })
    await expect(preStep(
      mounted.ctx,
      agent,
      [ordinary, plugin],
      new AbortController().signal,
      () => Promise.resolve({ kind: 'enter' as const, messages: [ordinary, plugin] }),
    )).resolves.toEqual({ kind: 'enter', messages: [ordinary, plugin] })
    expect(mounted.requestAuthenticated).not.toHaveBeenCalled()
  })

  it('rejects a browser prompt when authentication disappears after current-user loading', async () => {
    const mounted = await services({ response: () => currentUser() })
    mounted.setStatus({ authenticated: false, baseUrl: 'https://lowcode.example.test' })
    await mounted.ctx.plugin(LowcodePlugin, {})
    const agent = makeAgent(mounted.ctx)
    mounted.ctx.agents.register(agent)

    await expect(preStep(
      mounted.ctx,
      agent,
      [browserMessage()],
      new AbortController().signal,
      () => Promise.resolve({ kind: 'enter' as const, messages: [browserMessage()] }),
    )).rejects.toMatchObject({ code: 'JDCLOUD_LOWCODE_AUTH_REQUIRED' })
  })

  it('honors cancellation that arrives while current-user data is being loaded', async () => {
    const controller = new AbortController()
    const mounted = await services({
      response: () => {
        controller.abort(new Error('cancelled during current-user request'))
        return currentUser()
      },
    })
    await mounted.ctx.plugin(LowcodePlugin, {})
    const agent = makeAgent(mounted.ctx)
    mounted.ctx.agents.register(agent)

    await expect(preStep(
      mounted.ctx,
      agent,
      [browserMessage()],
      controller.signal,
      () => Promise.resolve({ kind: 'enter' as const, messages: [browserMessage()] }),
    )).rejects.toThrow('cancelled during current-user request')
    expect(mounted.status).not.toHaveBeenCalled()
  })
})

describe('schemas, presenters, describe, and exact reads', () => {
  it('executes describe/get and exposes every pure concurrency and presentation callback', async () => {
    const fields = [
      {
        enCode: 'group',
        jdcloudKey: 'table',
        fullName: 'Group',
        required: true,
        children: [{
          enCode: 'billNo',
          value: 'billNo',
          jdcloudKey: 'billRule',
          fullName: 'Bill number',
          children: null,
        }],
        privateValue: 'must not render',
      },
      {
        enCode: 'attachments',
        value: 'array',
        jdcloudKey: 'uploadFz',
        fullName: 'Attachments',
        required: false,
      },
    ]
    const mounted = await toolHarness({
      response: request => request.path.includes('/fields/') ? fields : { row: 'record-1' },
    })

    const concurrencyArguments = {
      jdcloud_lowcode_describe: { menu_id: 'form-1' },
      jdcloud_lowcode_query: { menu_id: 'form-1' },
      jdcloud_lowcode_get: { menu_id: 'form-1', record_id: 'row-1' },
    }
    for (const [name, args] of Object.entries(concurrencyArguments)) {
      expect(mounted.ctx.tools.get(name)?.isConcurrencySafe?.(args)).toBe(true)
    }
    const presentations = [
      ['jdcloud_lowcode_describe', { menu_id: 'form-1' }, 'Describe JDCloud function', 'read', 'form-1'],
      ['jdcloud_lowcode_query', { menu_id: 'form-1' }, 'Query JDCloud data', 'read', 'form-1'],
      ['jdcloud_lowcode_get', { menu_id: 'form-1', record_id: 'row-1' }, 'Read JDCloud record', 'read', 'row-1'],
      ['jdcloud_lowcode_create', { menu_id: 'form-1', data: {} }, 'Create JDCloud data', 'other', 'form-1'],
      [
        'jdcloud_lowcode_update',
        { menu_id: 'form-1', record_id: 'row-1', data: {} },
        'Update JDCloud record',
        'other',
        'row-1',
      ],
      ['jdcloud_lowcode_delete', { menu_id: 'form-1', record_id: 'row-1' }, 'Delete JDCloud record', 'other', 'row-1'],
      [
        'jdcloud_lowcode_create_table',
        {
          full_name: 'Table',
          authorization_object_ids: ['role-1'],
          fields: [{ en_code: 'title', label: 'Title', kind: 'text' }],
        },
        'Create JDCloud table',
        'other',
        'Table',
      ],
    ] as const
    for (const [name, args, title, kind, rawInput] of presentations) {
      expect(mounted.ctx.tools.get(name)?.presentCall?.(args as never)).toEqual({
        card: 'generic', title, kind, rawInput,
      })
    }

    const described = await mounted.call('jdcloud_lowcode_describe', { menu_id: 'form-1' })
    expect(described.isError).toBe(false)
    expect(resultText(described)).toContain('"required":true')
    expect(resultText(described)).toContain('"fullName":"Attachments","required":false')
    expect(resultText(described)).toContain('"children"')
    expect(resultText(described)).not.toContain('privateValue')

    const plain = await mounted.call('jdcloud_lowcode_get', {
      menu_id: 'form-1',
      record_id: ' row-1 ',
    })
    const expanded = await mounted.call('jdcloud_lowcode_get', {
      menu_id: 'form-1',
      record_id: 'row-2',
      auth_group_id: 'group-1',
      association: false,
      user_info_convert: true,
    })
    expect(plain.isError).toBe(false)
    expect(expanded.isError).toBe(false)
    expect(mounted.requests.slice(-2)).toEqual([
      {
        path: '/api/visualdev/form/info',
        method: 'POST',
        body: { menuId: 'form-1', _id: 'row-1' },
      },
      {
        path: '/api/visualdev/form/info',
        method: 'POST',
        body: {
          menuId: 'form-1',
          _id: 'row-2',
          authGroupId: 'group-1',
          association: false,
          userInfoConvert: true,
        },
      },
    ])
  })

  it.each([
    ['non-array response', {}, 'field response is invalid'],
    ['non-object field', [null], 'field 0 is invalid'],
    ['missing code', [{ value: 'v', jdcloudKey: 'k', fullName: 'n' }], 'field 0 enCode'],
    ['blank code', [{ enCode: ' ', value: 'v', jdcloudKey: 'k', fullName: 'n' }], 'field 0 enCode'],
    ['missing leaf value', [{ enCode: 'c', jdcloudKey: 'k', fullName: 'n' }], 'value'],
    ['missing component key', [{ enCode: 'c', value: 'v', fullName: 'n' }], 'jdcloudKey'],
    ['missing name', [{ enCode: 'c', value: 'v', jdcloudKey: 'k' }], 'fullName'],
    ['invalid children', [{ enCode: 'c', value: 'v', jdcloudKey: 'k', fullName: 'n', children: {} }], 'field response is invalid'],
  ])('contains malformed describe fields: %s', async (_label, response, message) => {
    const mounted = await toolHarness({ response: () => response })
    const result = await mounted.call('jdcloud_lowcode_describe', { menu_id: 'form-1' })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(message)
  })
})

describe('query validation, defaults, and bounded rendering', () => {
  it('uses the configured default page size and omits every absent optional field', async () => {
    const mounted = await toolHarness({
      maxPageSize: 7,
      response: () => undefined,
    })
    const result = await mounted.call('jdcloud_lowcode_query', { menu_id: 'form-1' })

    expect(result.isError).toBe(false)
    expect(resultText(result)).toBe('Untrusted JDCloud response data:\nnull')
    expect(mounted.requests).toEqual([{
      path: '/api/visualdev/form/list',
      method: 'POST',
      body: { menuId: 'form-1', currentPage: 1, pageSize: 7, connect: 'and' },
    }])
  })

  it('forwards an explicit filter without optional value or component key', async () => {
    const mounted = await toolHarness()
    const result = await mounted.call('jdcloud_lowcode_query', {
      menu_id: 'form-1',
      current_page: 3,
      page_size: 4,
      sort: { title: 'asc' },
      filters: [{ en_code: 'title', method: 'empty', type: 'field' }],
    })

    expect(result.isError).toBe(false)
    expect(mounted.requests[0]?.body).toEqual({
      menuId: 'form-1',
      currentPage: 3,
      pageSize: 4,
      connect: 'and',
      sort: { title: 'asc' },
      filter: [{ enCode: 'title', method: 'empty', type: 'field' }],
    })
  })

  it.each([
    [{ current_page: 0 }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ current_page: Number.MAX_SAFE_INTEGER + 1 }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ page_size: 21 }, 'JDCLOUD_LOWCODE_PAGE_SIZE'],
    [{ auth_group_id: ' ' }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ sort: { title: 'sideways' } }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ sort: { '': 'asc' } }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ filters: [{ en_code: ' ', method: 'eq', type: 'custom' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ filters: [{ en_code: 'title', method: 'eq', type: 'custom', jdcloud_key: ' ' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
  ])('rejects an invalid query argument before dispatch: %#', async (args, code) => {
    const mounted = await toolHarness()
    const result = await mounted.call('jdcloud_lowcode_query', { menu_id: 'form-1', ...args })
    expect(errorCode(result)).toBe(code)
    expect(mounted.requests).toEqual([])
  })

  it('keeps an exact-size complete result without a truncation notice', async () => {
    const payload = { ok: true }
    const expected = `Untrusted JDCloud response data:\n${JSON.stringify(payload)}`
    const limit = new TextEncoder().encode(expected).length
    const mounted = await toolHarness({ maxOutputBytes: limit, response: () => payload })

    const result = await mounted.call('jdcloud_lowcode_query', { menu_id: 'form-1' })
    expect(resultText(result)).toBe(expected)
    expect(new TextEncoder().encode(resultText(result))).toHaveLength(limit)
  })

  it('bounds a tiny result including its package prefix', async () => {
    const mounted = await toolHarness({ maxOutputBytes: 1, response: () => ({ long: 'value' }) })
    const result = await mounted.call('jdcloud_lowcode_query', { menu_id: 'form-1' })

    expect(resultText(result)).toBe('U')
    expect(new TextEncoder().encode(resultText(result))).toHaveLength(1)
  })

  it('drops an incomplete trailing multibyte code point without a replacement character', async () => {
    const payload = '中'.repeat(100)
    const json = JSON.stringify(payload)
    const complete = `Untrusted JDCloud response data:\n${json}`
    const completeBytes = new TextEncoder().encode(complete).length
    let limit = 100
    for (;;) {
      const beforeCharacter = `Untrusted JDCloud response data was truncated from ${String(completeBytes)} bytes `
        + `to the configured ${String(limit)}-byte limit:\n"`
      const next = new TextEncoder().encode(beforeCharacter).length + 1
      if (next === limit) break
      limit = next
    }
    const mounted = await toolHarness({ maxOutputBytes: limit, response: () => payload })

    const result = await mounted.call('jdcloud_lowcode_query', { menu_id: 'form-1' })
    const text = resultText(result)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(limit)
    expect(text).toContain(`truncated from ${String(completeBytes)} bytes`)
    expect(text).not.toContain('\uFFFD')
    expect(text.endsWith('"')).toBe(true)
  })
})

describe('write-tool failures and table partial completion', () => {
  it('validates every supported required-value kind before creating a record', async () => {
    const fields = [
      { enCode: 'missing', value: 'string', jdcloudKey: 'comInput', fullName: 'Missing', required: true },
      { enCode: 'nullValue', value: 'string', jdcloudKey: 'comInput', fullName: 'Null', required: true },
      { enCode: 'title', value: 'string', jdcloudKey: 'comInput', fullName: 'Title', required: true },
      { enCode: 'amount', value: 'number', jdcloudKey: 'numInput', fullName: 'Amount', required: true },
      { enCode: 'approved', value: 'boolean', jdcloudKey: 'switch', fullName: 'Approved', required: true },
      { enCode: 'selection', value: 'array', jdcloudKey: 'userSelect', fullName: 'Selection', required: true },
      { enCode: 'customText', value: 'custom', jdcloudKey: 'custom', fullName: 'Custom text', required: true },
      { enCode: 'customList', value: 'custom', jdcloudKey: 'custom', fullName: 'Custom list', required: true },
      { enCode: 'customObject', value: 'custom', jdcloudKey: 'custom', fullName: 'Custom object', required: true },
      { enCode: 'customScalar', value: 'custom', jdcloudKey: 'custom', fullName: 'Custom scalar', required: true },
      {
        enCode: 'missingDetails', jdcloudKey: 'table', fullName: 'Missing details', required: true,
        children: [{ enCode: 'line', value: 'string', jdcloudKey: 'comInput', fullName: 'Line', required: true }],
      },
      {
        enCode: 'emptyDetails', jdcloudKey: 'table', fullName: 'Empty details', required: true,
        children: [{ enCode: 'line', value: 'string', jdcloudKey: 'comInput', fullName: 'Line', required: true }],
      },
      {
        enCode: 'optionalDetails', jdcloudKey: 'table', fullName: 'Optional details', required: false,
        children: [{ enCode: 'line', value: 'string', jdcloudKey: 'comInput', fullName: 'Line', required: true }],
      },
      {
        enCode: 'details', jdcloudKey: 'table', fullName: 'Details', required: true,
        children: [{ enCode: 'line', value: 'string', jdcloudKey: 'comInput', fullName: 'Line', required: true }],
      },
    ]
    const mounted = await toolHarness({
      response: request => request.path.includes('/fields/') ? fields : { ok: true },
    })

    const invalid = await mounted.call('jdcloud_lowcode_create', {
      menu_id: 'form-1',
      data: {
        nullValue: null,
        title: ' ',
        amount: '1',
        approved: 'true',
        selection: [],
        customText: ' ',
        customList: [],
        customObject: {},
        customScalar: 1,
        emptyDetails: [],
        details: ['invalid row'],
      },
    })

    expect(errorCode(invalid)).toBe('JDCLOUD_LOWCODE_REQUIRED_FIELDS')
    expect(resultText(invalid)).toContain('Details[1] (details[1])')
    expect(mounted.requests.map(request => request.path))
      .toEqual(['/api/visualdev/base/fields/form-1'])

    const valid = await mounted.call('jdcloud_lowcode_create', {
      menu_id: 'form-1',
      data: {
        missing: 'provided',
        nullValue: 'provided',
        title: 'Expense',
        amount: 1,
        approved: false,
        selection: [{ id: 'user-1' }],
        customText: 'provided',
        customList: ['provided'],
        customObject: { id: 'object-1' },
        customScalar: 1,
        missingDetails: [{ line: 'provided' }],
        emptyDetails: [{ line: 'provided' }],
        details: [{ line: 'provided' }],
      },
    })

    expect(valid.isError).toBe(false)
    expect(mounted.requests.map(request => request.path)).toEqual([
      '/api/visualdev/base/fields/form-1',
      '/api/visualdev/base/fields/form-1',
      '/api/visualdev/form/create',
    ])
  })

  it('rejects an update containing only empty automatic-number fields', async () => {
    const mounted = await toolHarness({
      response: request => request.path.includes('/fields/')
        ? [{
          enCode: 'container', value: 'container', jdcloudKey: 'row', fullName: 'Container',
          children: [{ enCode: 'billNo', value: 'billNo', jdcloudKey: 'billRule', fullName: 'Bill' }],
        }]
        : { ok: true },
    })
    const result = await mounted.call('jdcloud_lowcode_update', {
      menu_id: 'form-1', record_id: 'row-1', data: { billNo: null },
    })

    expect(errorCode(result)).toBe('JDCLOUD_LOWCODE_EMPTY_UPDATE')
    expect(mounted.requests.map(request => request.path))
      .toEqual(['/api/visualdev/base/fields/form-1'])
  })

  it.each([
    ['jdcloud_lowcode_get', { menu_id: 'form-1', record_id: ' ' }],
    ['jdcloud_lowcode_update', { menu_id: 'form-1', record_id: ' ', data: { title: 'x' } }],
    ['jdcloud_lowcode_delete', { menu_id: 'form-1', record_id: ' ' }],
  ])('rejects a blank record identity for %s', async (name, args) => {
    const mounted = await toolHarness({ response: request => request.path.includes('/fields/') ? [] : { ok: true } })
    const result = await mounted.call(name, args)
    expect(errorCode(result)).toBe('JDCLOUD_LOWCODE_INVALID_ARGUMENT')
  })

  it.each([
    [{ full_name: ' ', authorization_object_ids: ['role-1'], fields: [{ en_code: 'x', label: 'X', kind: 'text' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ full_name: 'T', parent_id: ' ', authorization_object_ids: ['role-1'], fields: [{ en_code: 'x', label: 'X', kind: 'text' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ full_name: 'T', authorization_object_ids: [], fields: [{ en_code: 'x', label: 'X', kind: 'text' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ full_name: 'T', authorization_object_ids: ['role-1', 'role-1'], fields: [{ en_code: 'x', label: 'X', kind: 'text' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
    [{ full_name: 'T', authorization_object_ids: [' '], fields: [{ en_code: 'x', label: 'X', kind: 'text' }] }, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT'],
  ])('rejects invalid table creation input %#', async (args, code) => {
    const mounted = await toolHarness()
    const result = await mounted.call('jdcloud_lowcode_create_table', args)
    expect(errorCode(result)).toBe(code)
    expect(mounted.requests).toEqual([])
  })

  it.each([
    [[], 'menu creation response is invalid'],
    [{}, 'created JDCloud menu id'],
  ])('rejects an invalid created-menu response %#', async (created, message) => {
    const mounted = await toolHarness({ response: () => created })
    const result = await mounted.call('jdcloud_lowcode_create_table', {
      full_name: 'Table',
      authorization_object_ids: ['role-1'],
      fields: [{ en_code: 'x', label: 'X', kind: 'text' }],
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(message)
  })

  it('reports the created menu when saving its form schema fails', async () => {
    const mounted = await toolHarness({
      response: (_request, index) => {
        if (index === 0) return { id: 'partial-menu' }
        throw new Error('schema unavailable')
      },
    })
    const result = await mounted.call('jdcloud_lowcode_create_table', {
      full_name: 'Table',
      authorization_object_ids: ['role-1'],
      fields: [{ en_code: 'x', label: 'X', kind: 'text' }],
    })

    expect(errorCode(result)).toBe('JDCLOUD_LOWCODE_TABLE_PARTIAL')
    expect(resultText(result)).toContain('saving the form schema failed: schema unavailable')
  })

  it('reports a non-Error permission-group failure after the schema was saved', async () => {
    const mounted = await toolHarness({
      response: (_request, index) => {
        if (index === 0) return { id: 'partial-menu' }
        if (index === 1) return { saved: true }
        throw 'permission offline'
      },
    })
    const result = await mounted.call('jdcloud_lowcode_create_table', {
      full_name: 'Table',
      authorization_object_ids: ['role-1'],
      fields: [{ en_code: 'x', label: 'X', kind: 'text' }],
    })

    expect(errorCode(result)).toBe('JDCLOUD_LOWCODE_TABLE_PARTIAL')
    expect(resultText(result)).toContain('creating the data permission group failed: permission offline')
  })

  it('uses the top-level parent default and default field-required value on success', async () => {
    const mounted = await toolHarness({
      response: (_request, index) => index === 0 ? { id: 'created-menu' } : { ok: true },
    })
    const result = await mounted.call('jdcloud_lowcode_create_table', {
      full_name: ' Table ',
      authorization_object_ids: [' role-1 '],
      fields: [{ en_code: 'x', label: 'X', kind: 'text' }],
    })

    expect(result.isError).toBe(false)
    expect(mounted.requests[0]?.body).toMatchObject({ fullName: 'Table', parentId: '-1' })
    expect(mounted.requests[2]?.body).toMatchObject({ objectId: ['role-1'] })
  })
})

describe('live Agent, snapshot, menu, and tenant enforcement', () => {
  it('requires a calling Agent', async () => {
    const mounted = await toolHarness()
    const result = await mounted.call('jdcloud_lowcode_query', { menu_id: 'form-1' }, { agent: undefined })
    expect(errorCode(result)).toBe('JDCLOUD_LOWCODE_AGENT_REQUIRED')
  })

  it('requires the exact registered, running, initiating Agent', async () => {
    const unregistered = await toolHarness({ registerAgent: false })
    expect(errorCode(await unregistered.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_DRIVER_REQUIRED')

    const idle = await toolHarness({ status: 'idle' })
    expect(errorCode(await idle.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_DRIVER_REQUIRED')

    const noInitiator = await toolHarness()
    expect(errorCode(await noInitiator.call(
      'jdcloud_lowcode_query',
      { menu_id: 'form-1' },
      { initiator: false },
    ))).toBe('JDCLOUD_LOWCODE_DRIVER_REQUIRED')
  })

  it('requires a registered turn fold, an open turn, a snapshot, and a matching turn number', async () => {
    const noFold = await toolHarness({ turnBoundary: false })
    expect(errorCode(await noFold.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_SNAPSHOT_REQUIRED')

    const closed = await toolHarness({ openTurn: false })
    expect(errorCode(await closed.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_SNAPSHOT_REQUIRED')

    const missing = await toolHarness({ snapshot: false })
    expect(errorCode(await missing.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_SNAPSHOT_REQUIRED')

    const stale = await toolHarness({ snapshot: { ...SNAPSHOT, turn: 2 } })
    expect(errorCode(await stale.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_SNAPSHOT_REQUIRED')
  })

  it('rechecks authentication and tenant identity immediately before each operation', async () => {
    const missing = await toolHarness()
    missing.setStatus({ authenticated: false, baseUrl: 'https://lowcode.example.test' })
    expect(errorCode(await missing.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_AUTH_REQUIRED')

    const changed = await toolHarness()
    changed.setStatus({ ...AUTHENTICATED, corpId: 'corp-2', corpName: 'Tenant Two' })
    expect(errorCode(await changed.call('jdcloud_lowcode_query', { menu_id: 'form-1' })))
      .toBe('JDCLOUD_LOWCODE_TENANT_CHANGED')
  })

  it('rejects blank and unavailable menu identities from the attested snapshot', async () => {
    const mounted = await toolHarness()
    expect(errorCode(await mounted.call('jdcloud_lowcode_query', { menu_id: ' ' })))
      .toBe('JDCLOUD_LOWCODE_INVALID_ARGUMENT')
    expect(errorCode(await mounted.call('jdcloud_lowcode_query', { menu_id: 'unknown' })))
      .toBe('JDCLOUD_LOWCODE_MENU_REQUIRED')
  })
})
