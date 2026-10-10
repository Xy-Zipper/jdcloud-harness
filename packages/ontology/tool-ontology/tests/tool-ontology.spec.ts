import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionFailure, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ontologyTool from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface FixtureOptions {
  readonly requiresConfirmation?: boolean
  readonly invocationStatus?: 'prepared' | 'executing' | 'succeeded' | 'failed'
  readonly invocationResponse?: unknown
  readonly approvalOutcome?: ApprovalOutcome
  readonly executeError?: Error
}

/** Mount the real tool and approval services with a Host-only Runtime request recorder. */
async function fixture(options: FixtureOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  let invocationStatus = options.invocationStatus ?? 'prepared'
  const requestAuthenticated = vi.fn(async (request: {
    readonly method: string
    readonly path: string
    readonly body?: unknown
  }) => {
    if (request.path === '/api/runtime/projects') {
      return { projects: [{ id: 'project-sales', name: '销售', description: '销售本体', releaseVersion: 'release-1' }] }
    }
    if (request.path === '/api/runtime/projects/project-sales/objects') {
      return { objects: [{
        id: 'object-order', label: '订单', description: '销售订单',
        primaryKey: { id: 'property-order-id', label: '订单 ID', type: 'string', sourceField: '_id' },
      }] }
    }
    if (request.path === '/api/runtime/projects/project-sales/objects/object-order') {
      return {
        id: 'object-order', label: '订单', description: '销售订单',
        primaryKey: { id: 'property-order-id', label: '订单 ID', type: 'string', sourceField: '_id' },
        properties: [{
          id: 'property-order-id', label: '订单 ID', description: '主键', type: 'string',
          sourceField: '_id', required: true,
        }],
        links: [{
          id: 'link-order-customer', label: '所属客户', description: '订单客户',
          sourceType: 'object-order', targetType: 'object-customer', cardinality: 'many-to-one',
          sourceProperty: 'property-customer-id', targetProperty: 'property-customer-id',
        }],
        actions: [{
          id: 'action-update-order', label: '更新订单', description: '更新订单状态', kind: 'object',
          operation: 'update', effect: 'write', targetType: 'object-order', requiresConfirmation: true,
        }],
      }
    }
    if (request.path.endsWith('/query')) {
      return {
        records: [{ objectTypeId: 'object-order', primaryKey: 'order-1', properties: { 'property-order-id': 'order-1' } }],
        page: 1, pageSize: 20, total: 1,
      }
    }
    if (request.path.endsWith('/get')) {
      return { record: { objectTypeId: 'object-order', primaryKey: 'order-1', properties: { 'property-order-id': 'order-1' } } }
    }
    if (request.path.endsWith('/traverse')) {
      return {
        linkTypeId: 'link-order-customer', direction: 'outgoing', objectTypeId: 'object-customer',
        records: [], page: 1, pageSize: 20, total: 0,
      }
    }
    if (request.path.endsWith('/prepare')) {
      return {
        invocationId: 'invocation-1', expiresAt: '2026-10-10T12:05:00Z',
        requiresConfirmation: options.requiresConfirmation ?? true,
        summary: '更新订单 order-1', affectedObjects: [{ objectTypeId: 'object-order', primaryKey: 'order-1' }],
      }
    }
    if (request.path === '/api/runtime/action-invocations/invocation-1') {
      if ('invocationResponse' in options) return options.invocationResponse
      return {
        invocationId: 'invocation-1', projectId: 'project-sales', actionTypeId: 'action-update-order',
        actionKind: 'object', releaseVersion: 'release-1', authorizationVersion: '1',
        expiresAt: '2026-10-10T12:05:00Z', requiresConfirmation: options.requiresConfirmation ?? true,
        summary: '更新订单 order-1', affectedObjects: [{ objectTypeId: 'object-order', primaryKey: 'order-1' }],
        status: invocationStatus,
      }
    }
    if (request.path.endsWith('/execute')) {
      if (options.executeError !== undefined) throw options.executeError
      invocationStatus = 'succeeded'
      return { invocationId: 'invocation-1', status: 'succeeded', result: { operation: 'update' } }
    }
    throw new Error(`unexpected Runtime path: ${request.path}`)
  })
  ctx.provide('ontologyAuthController', { requestAuthenticated } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService)
  const approvalRequests = vi.fn<(approval: ApprovalRequest) => Promise<ApprovalOutcome>>(
    () => Promise.resolve(options.approvalOutcome ?? 'allowed-once'),
  )
  ctx.on('approval/request', approvalRequests)
  const fiber = await ctx.plugin(ontologyTool)
  const session = Session.create(SessionId('ontology-tool-approval'))
  session.append('turn/start', { turn: 1 })
  const agent = { session } as never
  let call = 0
  const execute = (name: string, argumentsValue: unknown) => ctx.tools.execute({
    name,
    arguments: argumentsValue,
    callId: ToolCallId(`ontology-call-${String(++call)}`),
    agent,
    signal: new AbortController().signal,
  })
  return { approvalRequests, ctx, execute, fiber, requestAuthenticated, session }
}

function value(result: ToolExecutionResult) {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value
}

function failure(result: ToolExecutionResult): ToolExecutionFailure {
  if (!result.isError) throw new Error('expected a failed tool execution')
  return result
}

describe('Ontology tools', () => {
  it('registers the eight stable tools and removes them with the plugin fiber', async () => {
    const { ctx, fiber } = await fixture()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'ontology_list_projects',
      'ontology_list_objects',
      'ontology_describe_object',
      'ontology_query_objects',
      'ontology_get_object',
      'ontology_traverse_link',
      'ontology_prepare_action',
      'ontology_execute_action',
    ])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('discovers published ids before querying and traversing records', async () => {
    const { execute, requestAuthenticated } = await fixture()
    expect(value(await execute('ontology_list_projects', {}))).toMatchObject({
      projects: [{ id: 'project-sales', releaseVersion: 'release-1' }],
    })
    expect(value(await execute('ontology_list_objects', { project_id: 'project-sales' }))).toMatchObject({
      objects: [{ id: 'object-order', primaryKey: { id: 'property-order-id' } }],
    })
    expect(value(await execute('ontology_describe_object', {
      project_id: 'project-sales', object_type_id: 'object-order',
    }))).toMatchObject({
      id: 'object-order', links: [{ id: 'link-order-customer' }], actions: [{ id: 'action-update-order' }],
    })
    expect(value(await execute('ontology_query_objects', {
      project_id: 'project-sales', object_type_id: 'object-order',
      filters: [{ property_id: 'property-order-id', value: 'order-1' }],
    }))).toMatchObject({ records: [{ primaryKey: 'order-1' }], total: 1 })
    expect(value(await execute('ontology_get_object', {
      project_id: 'project-sales', object_type_id: 'object-order', primary_key: 'order-1',
    }))).toMatchObject({ record: { primaryKey: 'order-1' } })
    expect(value(await execute('ontology_traverse_link', {
      project_id: 'project-sales', link_type_id: 'link-order-customer',
      direction: 'outgoing', source_primary_key: 'order-1',
    }))).toMatchObject({ linkTypeId: 'link-order-customer', direction: 'outgoing' })
    expect(requestAuthenticated).toHaveBeenCalledTimes(6)
    expect(requestAuthenticated.mock.calls[3]?.[0]).toMatchObject({
      body: {
        page: 1, pageSize: 20,
        filters: [{ propertyId: 'property-order-id', operator: 'eq', value: 'order-1' }],
      },
    })
  })

  it('prepares immutable Action input and executes only the returned invocation id', async () => {
    const { approvalRequests, execute, requestAuthenticated } = await fixture()
    expect(value(await execute('ontology_prepare_action', {
      project_id: 'project-sales', action_type_id: 'action-update-order',
      parameters: { orderId: 'order-1', status: 'approved' },
    }))).toMatchObject({
      invocationId: 'invocation-1', requiresConfirmation: true,
      affectedObjects: [{ objectTypeId: 'object-order', primaryKey: 'order-1' }],
    })
    const prepare = requestAuthenticated.mock.calls[0]?.[0]
    expect(prepare).toMatchObject({
      path: '/api/runtime/projects/project-sales/actions/action-update-order/prepare',
      body: { parameters: { orderId: 'order-1', status: 'approved' } },
    })
    expect((prepare?.body as { idempotencyKey?: string } | undefined)?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)

    expect(value(await execute('ontology_execute_action', { invocation_id: 'invocation-1' }))).toEqual({
      invocationId: 'invocation-1', status: 'succeeded', result: { operation: 'update' },
    })
    expect(requestAuthenticated.mock.calls[1]?.[0]).toEqual({
      method: 'GET', path: '/api/runtime/action-invocations/invocation-1',
    })
    expect(requestAuthenticated.mock.calls[2]?.[0]).toEqual({
      method: 'POST', path: '/api/runtime/action-invocations/invocation-1/execute',
    })
    expect(approvalRequests).toHaveBeenCalledOnce()
    const approval = approvalRequests.mock.calls[0]?.[0]
    expect(approval?.toolName).toBe('ontology_execute_action')
    expect(approval?.reason).toContain('更新订单 order-1')
    expect(approval?.reason).toContain('object-order "order-1"')
  })

  it('executes an Action without prompting when Runtime marks confirmation unnecessary', async () => {
    const { approvalRequests, execute, requestAuthenticated } = await fixture({ requiresConfirmation: false })

    expect(value(await execute('ontology_execute_action', { invocation_id: 'invocation-1' }))).toMatchObject({
      invocationId: 'invocation-1', status: 'succeeded',
    })
    expect(requestAuthenticated.mock.calls.map(call => call[0].method)).toEqual(['GET', 'POST'])
    expect(approvalRequests).not.toHaveBeenCalled()
  })

  it('does not dispatch execution when the user rejects the Runtime preview', async () => {
    const { approvalRequests, execute, requestAuthenticated } = await fixture({ approvalOutcome: 'rejected' })

    const result = await execute('ontology_execute_action', { invocation_id: 'invocation-1' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('the user rejected tool')
    expect(approvalRequests).toHaveBeenCalledOnce()
    expect(requestAuthenticated.mock.calls.map(call => call[0].method)).toEqual(['GET'])
  })

  it('fails closed before approval when an Invocation is no longer prepared', async () => {
    const { approvalRequests, execute, requestAuthenticated } = await fixture({ invocationStatus: 'succeeded' })

    const result = await execute('ontology_execute_action', { invocation_id: 'invocation-1' })

    expect(failure(result).error.info?.code).toBe('ONTOLOGY_ACTION_NOT_PREPARED')
    expect(approvalRequests).not.toHaveBeenCalled()
    expect(requestAuthenticated.mock.calls.map(call => call[0].method)).toEqual(['GET'])
  })

  it('rechecks Invocation state and rejects a sequential duplicate without another write', async () => {
    const { execute, requestAuthenticated } = await fixture()

    expect((await execute('ontology_execute_action', { invocation_id: 'invocation-1' })).isError).toBe(false)
    const duplicate = await execute('ontology_execute_action', { invocation_id: 'invocation-1' })

    expect(failure(duplicate).error.info?.code).toBe('ONTOLOGY_ACTION_NOT_PREPARED')
    expect(requestAuthenticated.mock.calls.map(call => call[0].method)).toEqual(['GET', 'POST', 'GET'])
  })

  it('shows the Runtime rejection when authorization changes during confirmation', async () => {
    const { approvalRequests, execute, requestAuthenticated } = await fixture({
      executeError: new Error('Project access was revoked'),
    })

    const result = await execute('ontology_execute_action', { invocation_id: 'invocation-1' })

    expect(approvalRequests).toHaveBeenCalledOnce()
    expect(failure(result).error.info?.code).toBe('ONTOLOGY_RUNTIME_REQUEST_FAILED')
    expect(JSON.stringify(result.content)).toContain('Project access was revoked')
    expect(requestAuthenticated.mock.calls.map(call => call[0].method)).toEqual(['GET', 'POST'])
  })

  it('fails closed on a malformed Invocation preview', async () => {
    const { approvalRequests, execute, requestAuthenticated } = await fixture({
      invocationResponse: {
        invocationId: 'invocation-1', expiresAt: '2026-10-10T12:05:00Z', requiresConfirmation: true,
        summary: 'bad preview', affectedObjects: [], status: 'prepared',
      },
    })

    const result = await execute('ontology_execute_action', { invocation_id: 'invocation-1' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Ontology Invocation Project id is invalid')
    expect(approvalRequests).not.toHaveBeenCalled()
    expect(requestAuthenticated.mock.calls.map(call => call[0].method)).toEqual(['GET'])
  })

  it('rejects invalid pagination before issuing a Runtime request', async () => {
    const { execute, requestAuthenticated } = await fixture()
    const result = await execute('ontology_query_objects', {
      project_id: 'project-sales', object_type_id: 'object-order', page: 0, page_size: 101,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('ONTOLOGY_TOOL_INVALID_ARGUMENT')
    expect(requestAuthenticated).not.toHaveBeenCalled()
  })

  it('rejects malformed Runtime responses instead of projecting untrusted fields', async () => {
    const { execute, requestAuthenticated } = await fixture()
    requestAuthenticated.mockResolvedValueOnce({ projects: [{ id: '', name: 'bad' }] })
    const result = await execute('ontology_list_projects', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Ontology Project id is invalid')
  })
})
