/**
 * Model-facing discovery, query, relationship, and Action tools over the
 * current browser's Ontology Runtime login.
 * @module @deepseek-ai/dsh-tool-ontology
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-api-ontology-auth-controller'
import type { OntologyAuthenticatedRequest } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  readActionDetail,
  readActionResult,
  readObjectDetail,
  readObjectGet,
  readObjects,
  readInvocation,
  readPreparedAction,
  readProjects,
  readRecordPage,
  readTraversal,
} from './runtime.ts'
import type { OntologyActionDetail, OntologyActionParameterSummary } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-ontology'

/** Services required by all Ontology tools. */
export const inject = ['ontologyAuthController', 'systemPrompt', 'tools']

const JSON_OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

const PROJECT_ID = {
  type: 'string' as const,
  required: true as const,
  description: 'Exact Project id returned by ontology_list_projects.',
}

const OBJECT_TYPE_ID = {
  type: 'string' as const,
  required: true as const,
  description: 'Exact Object Type id returned by ontology_list_objects.',
}

const PAGE = { type: 'number' as const, description: '1-based page number. Default 1.' }
const PAGE_SIZE = { type: 'number' as const, description: 'Records per page from 1 through 100. Default 20.' }
const APPROVAL_OBJECT_LIMIT = 10
const APPROVAL_PRIMARY_KEY_LIMIT = 80

/** Register the stable Ontology tool suite and its compact usage policy. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:ontology',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 20,
    text: 'Use Ontology tools only with ids returned by discovery. List Projects before selecting one, '
      + 'list and describe Objects before querying their Property ids or Link ids, and never guess ids. '
      + 'Describe a selected Action before preparation to discover its required and optional parameters and confirmation requirement. '
      + 'Present each Action parameter to users by its business label, technical inputName, and required status. '
      + 'Prepare every Action before execution. Execute only the invocation_id returned by preparation; '
      + 'do not claim a write succeeded until ontology_execute_action returns status succeeded.',
  })

  // Runtime owns the immutable preview and current authorization state, so the
  // approval decision always starts from a fresh Invocation read.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'ontology_execute_action') return next()
    const requestedId = executeInvocationId(exec.arguments)
    const invocation = readInvocation(await request(ctx, {
      method: 'GET', path: invocationPath(requestedId),
    }, exec.signal))
    if (invocation.invocationId !== requestedId) {
      throw new HarnessError(
        'Ontology Runtime returned a different Action invocation',
        'ONTOLOGY_RUNTIME_INVALID_RESPONSE',
      )
    }
    if (invocation.status !== 'prepared') {
      throw new HarnessError(
        `Ontology Action invocation is not prepared (status: ${invocation.status})`,
        'ONTOLOGY_ACTION_NOT_PREPARED',
      )
    }
    if (!invocation.requiresConfirmation) return next()
    return { kind: 'ask', reason: actionApprovalReason(invocation) }
  })

  ctx.tools.register(defineTool({
    name: 'ontology_list_projects',
    description: 'List published Ontology Projects authorized for the current signed-in user.',
    parameters: {},
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      return modelValue(readProjects(await request(ctx, { method: 'GET', path: '/api/runtime/projects' }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_list_objects',
    description: 'List published Object Types in one authorized Ontology Project.',
    parameters: { project_id: PROJECT_ID },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return modelValue(readObjects(await request(ctx, {
        method: 'GET', path: projectPath(args.project_id, 'objects'),
      }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_describe_object',
    description: 'Read one published Object Type with Properties, Links, and authorized related Actions.',
    parameters: {
      project_id: PROJECT_ID,
      object_type_id: OBJECT_TYPE_ID,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return modelValue(readObjectDetail(await request(ctx, {
        method: 'GET', path: projectPath(args.project_id, 'objects', args.object_type_id),
      }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_describe_action',
    description: 'Read one authorized published Action with exact required and optional parameters and its confirmation requirement.',
    parameters: {
      project_id: PROJECT_ID,
      action_type_id: {
        type: 'string', required: true,
        description: 'Exact authorized Action Type id returned by ontology_describe_object.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const action = readActionDetail(await request(ctx, {
        method: 'GET', path: projectPath(args.project_id, 'actions', args.action_type_id),
      }, exec.signal))
      if (action.targetType === undefined) return modelValue(actionDetail(action, []))
      const object = readObjectDetail(await request(ctx, {
        method: 'GET', path: projectPath(args.project_id, 'objects', action.targetType),
      }, exec.signal))
      return modelValue(actionDetail(action, object.properties))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_query_objects',
    description: 'Query one published Object Type with bounded pagination and Property-id equality filters.',
    parameters: {
      project_id: PROJECT_ID,
      object_type_id: OBJECT_TYPE_ID,
      page: PAGE,
      page_size: PAGE_SIZE,
      filters: {
        type: 'array',
        description: 'Optional equality filters using Property ids from ontology_describe_object.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            property_id: { type: 'string', required: true },
            value: { type: 'json', required: true },
          },
        },
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const pagination = resolvePagination(args.page, args.page_size)
      return modelValue(readRecordPage(await request(ctx, {
        method: 'POST',
        path: projectPath(args.project_id, 'objects', args.object_type_id, 'query'),
        body: {
          ...pagination,
          filters: (args.filters ?? []).map(filter => ({
            propertyId: nonEmpty(filter.property_id, 'property_id'),
            operator: 'eq',
            value: filter.value,
          })),
        },
      }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_get_object',
    description: 'Get one published Object record by the Object Type primary key.',
    parameters: {
      project_id: PROJECT_ID,
      object_type_id: OBJECT_TYPE_ID,
      primary_key: { type: 'json', required: true, description: 'Primary-key value for the selected Object Type.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return modelValue(readObjectGet(await request(ctx, {
        method: 'POST',
        path: projectPath(args.project_id, 'objects', args.object_type_id, 'get'),
        body: { primaryKey: args.primary_key },
      }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_traverse_link',
    description: 'Traverse one published Link from a source record in the outgoing or incoming direction.',
    parameters: {
      project_id: PROJECT_ID,
      link_type_id: {
        type: 'string', required: true,
        description: 'Exact Link Type id returned by ontology_describe_object.',
      },
      direction: {
        type: 'string', required: true, enum: ['outgoing', 'incoming'],
        description: 'Direction relative to the Link source and target Object Types.',
      },
      source_primary_key: {
        type: 'json', required: true,
        description: 'Primary key of the root Object record for the selected direction.',
      },
      page: PAGE,
      page_size: PAGE_SIZE,
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const pagination = resolvePagination(args.page, args.page_size)
      return modelValue(readTraversal(await request(ctx, {
        method: 'POST',
        path: projectPath(args.project_id, 'links', args.link_type_id, 'traverse'),
        body: {
          direction: args.direction,
          sourcePrimaryKey: args.source_primary_key,
          ...pagination,
        },
      }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_prepare_action',
    description: 'Validate one authorized published Action and return an immutable preview plus invocation id.',
    parameters: {
      project_id: PROJECT_ID,
      action_type_id: {
        type: 'string', required: true,
        description: 'Exact authorized Action Type id returned by ontology_describe_action.',
      },
      parameters: {
        type: 'object', additionalProperties: true, required: true,
        description: 'Action inputs using the names defined by the published Action.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return modelValue(readPreparedAction(await request(ctx, {
        method: 'POST',
        path: projectPath(args.project_id, 'actions', args.action_type_id, 'prepare'),
        body: { parameters: args.parameters, idempotencyKey: randomUUID() },
      }, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_execute_action',
    description: 'Execute one prepared Ontology Action by invocation id without accepting replacement parameters.',
    parameters: {
      invocation_id: {
        type: 'string', required: true,
        description: 'Exact invocation id returned by ontology_prepare_action.',
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return modelValue(readActionResult(await request(ctx, {
        method: 'POST', path: `${invocationPath(args.invocation_id)}/execute`,
      }, exec.signal)))
    },
  }))
}

/** Join caller-supplied Action mappings with their published Property metadata. */
function actionDetail(
  action: ReturnType<typeof readActionDetail>,
  properties: readonly {
    readonly id: string
    readonly label: string
    readonly description: string
    readonly type: string
  }[],
): OntologyActionDetail {
  const propertyById = new Map(properties.map(property => [property.id, property]))
  const parameters: OntologyActionParameterSummary[] = []
  for (const mapping of action.mappings) {
    if (mapping.source !== 'parameter') continue
    const property = propertyById.get(mapping.targetProperty)
    if (property === undefined) {
      throw new HarnessError(
        `Ontology Action parameter targets missing Property ${String(mapping.targetProperty)}`,
        'ONTOLOGY_RUNTIME_INVALID_RESPONSE',
      )
    }
    if (mapping.inputName.length === 0) {
      throw new HarnessError(
        `Ontology Action parameter for Property ${String(mapping.targetProperty)} has no name`,
        'ONTOLOGY_RUNTIME_INVALID_RESPONSE',
      )
    }
    parameters.push({
      label: property.label,
      inputName: mapping.inputName,
      required: mapping.required,
      description: property.description,
      type: property.type,
      targetProperty: mapping.targetProperty,
    })
  }
  const { mappings: _mappings, ...summary } = action
  return { ...summary, parameters }
}

async function request(ctx: Context, request: OntologyAuthenticatedRequest, signal: AbortSignal): Promise<unknown> {
  try {
    return await ctx.ontologyAuthController.requestAuthenticated(request, signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HarnessError(message, 'ONTOLOGY_RUNTIME_REQUEST_FAILED', { cause: error })
  }
}

function modelValue(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new HarnessError('Ontology Runtime result is not JSON', 'ONTOLOGY_RUNTIME_INVALID_RESPONSE')
  return snapshot as JsonValue
}

function resolvePagination(page: number | undefined, pageSize: number | undefined): { page: number; pageSize: number } {
  const resolvedPage = page ?? 1
  const resolvedPageSize = pageSize ?? 20
  if (!Number.isSafeInteger(resolvedPage) || resolvedPage < 1) {
    throw new HarnessError('page must be a positive safe integer', 'ONTOLOGY_TOOL_INVALID_ARGUMENT')
  }
  if (!Number.isSafeInteger(resolvedPageSize) || resolvedPageSize < 1 || resolvedPageSize > 100) {
    throw new HarnessError('page_size must be a safe integer from 1 through 100', 'ONTOLOGY_TOOL_INVALID_ARGUMENT')
  }
  return { page: resolvedPage, pageSize: resolvedPageSize }
}

function nonEmpty(value: string, name: string): string {
  if (value.length === 0) throw new HarnessError(`${name} must be non-empty`, 'ONTOLOGY_TOOL_INVALID_ARGUMENT')
  return value
}

function executeInvocationId(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HarnessError('invocation_id must be non-empty', 'ONTOLOGY_TOOL_INVALID_ARGUMENT')
  }
  if (!('invocation_id' in value)) {
    throw new HarnessError('invocation_id must be non-empty', 'ONTOLOGY_TOOL_INVALID_ARGUMENT')
  }
  const invocationId = value.invocation_id
  if (typeof invocationId !== 'string') {
    throw new HarnessError('invocation_id must be non-empty', 'ONTOLOGY_TOOL_INVALID_ARGUMENT')
  }
  return nonEmpty(invocationId, 'invocation_id')
}

function actionApprovalReason(invocation: ReturnType<typeof readInvocation>): string {
  const affected = invocation.affectedObjects.slice(0, APPROVAL_OBJECT_LIMIT).map((object) => {
    if (object.primaryKey === undefined) return String(object.objectTypeId)
    const primaryKey = JSON.stringify(object.primaryKey)
    const boundedPrimaryKey = primaryKey.length <= APPROVAL_PRIMARY_KEY_LIMIT
      ? primaryKey
      : `${primaryKey.slice(0, APPROVAL_PRIMARY_KEY_LIMIT)}…`
    return `${String(object.objectTypeId)} ${boundedPrimaryKey}`
  })
  const remaining = invocation.affectedObjects.length - affected.length
  const affectedSummary = affected.length === 0
    ? 'none'
    : `${affected.join(', ')}${remaining > 0 ? `, and ${String(remaining)} more` : ''}`
  return `Ontology Action ${String(invocation.actionTypeId)} in Project ${String(invocation.projectId)}: `
    + `${invocation.summary} Affected Objects: ${affectedSummary}.`
}

function projectPath(projectId: string, ...parts: string[]): `/api/runtime/${string}` {
  return `/api/runtime/projects/${encodeId(projectId, 'project_id')}/${parts.map(part => encodeId(part, 'resource id')).join('/')}`
}

function invocationPath(invocationId: string): `/api/runtime/${string}` {
  return `/api/runtime/action-invocations/${encodeId(invocationId, 'invocation_id')}`
}

function encodeId(value: string, name: string): string {
  return encodeURIComponent(nonEmpty(value, name))
}
