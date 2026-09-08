/** Model-facing JDCloud tools with execution-time tenant and permission checks. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  LowcodeCapabilitySnapshot,
  LowcodeMenuCapability,
  LowcodeWritePermission,
} from './current-user.ts'
import { buildFormData } from './table-schema.ts'
import type { TableFieldInput } from './table-schema.ts'

/** Fully resolved output and pagination limits for the tool set. */
export interface LowcodeToolConfig {
  readonly maxPageSize: number
  readonly maxOutputBytes: number
}

/** Per-agent authority snapshots refreshed by the prompt listener. */
export type LowcodeSnapshotStore = WeakMap<Agent, LowcodeCapabilitySnapshot>

const FILTER_METHODS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'nin',
  'enable', 'unEnable', 'empty', 'unEmpty', 'range',
] as const
const FILTER_TYPES = ['custom', 'field', 'systemField'] as const
const FIELD_KINDS = [
  'text', 'textarea', 'number', 'switch', 'single_select', 'multi_select', 'date', 'time',
] as const

const MENU_PARAMETER = {
  menu_id: {
    type: 'string' as const,
    required: true as const,
    description: 'Exact menuId from the current JDCloud capability snapshot.',
  },
}

const AUTH_GROUP_PARAMETER = {
  auth_group_id: {
    type: 'string' as const,
    description: 'Optional JDCloud data-permission group id when the target function requires one.',
  },
}

const RECORD_PARAMETER = {
  record_id: {
    type: 'string' as const,
    required: true as const,
    description: 'Exact JDCloud record _id.',
  },
}

const DATA_PARAMETER = {
  data: {
    type: 'object' as const,
    required: true as const,
    additionalProperties: true as const,
    description: 'Field-code to JSON-value map. Use field codes returned by jdcloud_lowcode_describe.',
  },
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Register the complete JDCloud low-code tool surface.
 * @param ctx - Plugin context carrying tool, Agent, projection, and authentication services.
 * @param snapshots - Per-Agent current-turn authorization snapshots.
 * @param config - Resolved query and output limits.
 */
export function registerLowcodeTools(
  ctx: Context,
  snapshots: LowcodeSnapshotStore,
  config: LowcodeToolConfig,
): void {
  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_describe',
    description: 'Read field codes and field types for one authorized JDCloud form or workflow before querying or writing it.',
    parameters: MENU_PARAMETER,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      const fields = parseFields(await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: `/api/visualdev/base/fields/${encodeURIComponent(menu.menuId)}`,
        method: 'GET',
      }, exec.signal))
      return renderResult({ menu, fields }, config.maxOutputBytes)
    },
    presentCall: args => present('Describe JDCloud function', 'read', args.menu_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_query',
    description: 'Query rows from one authorized JDCloud form or workflow. All supplied filters are combined with AND. '
      + 'For date ranges use millisecond timestamps and method range.',
    parameters: {
      ...MENU_PARAMETER,
      ...AUTH_GROUP_PARAMETER,
      current_page: { type: 'integer', description: 'One-based page number. Defaults to 1.' },
      page_size: { type: 'integer', description: 'Requested rows, bounded by the plugin maxPageSize.' },
      association: { type: 'boolean', description: 'Whether JDCloud should include associated records.' },
      user_info_convert: { type: 'boolean', description: 'Whether JDCloud should expand user ids into user objects.' },
      sort: {
        type: 'object',
        additionalProperties: true,
        description: 'Field-code map whose values are asc or desc.',
      },
      filters: {
        type: 'array',
        description: 'Flat filter list combined with AND.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            en_code: { type: 'string', required: true, description: 'JDCloud field code.' },
            method: { type: 'string', required: true, enum: FILTER_METHODS },
            type: { type: 'string', required: true, enum: FILTER_TYPES },
            value: { type: 'json', description: 'Scalar or array expected by the selected filter method.' },
            jdcloud_key: { type: 'string', description: 'Optional component key returned by field discovery.' },
          },
        },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      const currentPage = positiveInteger(args.current_page ?? 1, 'current_page')
      const defaultPageSize = Math.min(20, config.maxPageSize)
      const pageSize = positiveInteger(args.page_size ?? defaultPageSize, 'page_size')
      if (pageSize > config.maxPageSize) {
        reject(`page_size exceeds the configured maximum of ${String(config.maxPageSize)}`, 'JDCLOUD_LOWCODE_PAGE_SIZE')
      }
      const result = await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: '/api/visualdev/form/list',
        method: 'POST',
        body: {
          menuId: menu.menuId,
          currentPage,
          pageSize,
          connect: 'and',
          ...optionalText('authGroupId', args.auth_group_id),
          ...args.association === undefined ? {} : { association: args.association },
          ...args.user_info_convert === undefined ? {} : { userInfoConvert: args.user_info_convert },
          ...args.sort === undefined ? {} : { sort: readSort(args.sort) },
          ...args.filters === undefined ? {} : { filter: args.filters.map(filter => ({
            enCode: requireText(filter.en_code, 'filter en_code'),
            method: filter.method,
            type: filter.type,
            ...filter.value === undefined ? {} : { value: filter.value },
            ...optionalText('jdcloudKey', filter.jdcloud_key),
          })) },
        },
      }, exec.signal)
      return renderResult(result, config.maxOutputBytes)
    },
    presentCall: args => present('Query JDCloud data', 'read', args.menu_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_get',
    description: 'Read one JDCloud form or workflow record by its exact _id.',
    parameters: {
      ...MENU_PARAMETER,
      ...RECORD_PARAMETER,
      ...AUTH_GROUP_PARAMETER,
      association: { type: 'boolean', description: 'Whether JDCloud should include associated records.' },
      user_info_convert: { type: 'boolean', description: 'Whether JDCloud should expand user ids into user objects.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      const result = await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: '/api/visualdev/form/info',
        method: 'POST',
        body: {
          menuId: menu.menuId,
          _id: requireText(args.record_id, 'record_id'),
          ...optionalText('authGroupId', args.auth_group_id),
          ...args.association === undefined ? {} : { association: args.association },
          ...args.user_info_convert === undefined ? {} : { userInfoConvert: args.user_info_convert },
        },
      }, exec.signal)
      return renderResult(result, config.maxOutputBytes)
    },
    presentCall: args => present('Read JDCloud record', 'read', args.record_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_create',
    description: 'Create one form record or start one workflow. Host execution requires addData on the current menu snapshot.',
    parameters: { ...MENU_PARAMETER, ...AUTH_GROUP_PARAMETER, ...DATA_PARAMETER },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      requirePermission(menu, 'addData')
      const result = menu.type === 4
        ? await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
          path: '/api/workflow/flowTask/submit',
          method: 'POST',
          body: { menuId: menu.menuId, formData: args.data },
        }, exec.signal)
        : await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
          path: '/api/visualdev/form/create',
          method: 'POST',
          body: {
            menuId: menu.menuId,
            data: JSON.stringify(args.data),
            ...optionalText('authGroupId', args.auth_group_id),
          },
        }, exec.signal)
      return renderResult({ menuId: menu.menuId, type: menu.type === 3 ? 'form' : 'workflow', result }, config.maxOutputBytes)
    },
    presentCall: args => present('Create JDCloud data', 'other', args.menu_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_update',
    description: 'Update one JDCloud record. Host execution requires editData and removes empty automatic-number fields.',
    parameters: { ...MENU_PARAMETER, ...RECORD_PARAMETER, ...AUTH_GROUP_PARAMETER, ...DATA_PARAMETER },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      requirePermission(menu, 'editData')
      const fields = parseFields(await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: `/api/visualdev/base/fields/${encodeURIComponent(menu.menuId)}`,
        method: 'GET',
      }, exec.signal))
      const { data, omitted } = omitEmptyAutomaticFields(args.data, fields)
      if (Object.keys(data).length === 0) {
        reject('update data contains no writable values after automatic-number protection', 'JDCLOUD_LOWCODE_EMPTY_UPDATE')
      }
      const recordId = requireText(args.record_id, 'record_id')
      const result = await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: '/api/visualdev/form/update',
        method: 'PUT',
        body: {
          menuId: menu.menuId,
          _id: recordId,
          data: JSON.stringify(data),
          ...optionalText('authGroupId', args.auth_group_id),
        },
      }, exec.signal)
      return renderResult({ menuId: menu.menuId, recordId, updated: true, omittedAutomaticFields: omitted, result }, config.maxOutputBytes)
    },
    presentCall: args => present('Update JDCloud record', 'other', args.record_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_delete',
    description: 'Delete one JDCloud record. Host execution requires deleteData on the current menu snapshot.',
    parameters: { ...MENU_PARAMETER, ...RECORD_PARAMETER, ...AUTH_GROUP_PARAMETER },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      requirePermission(menu, 'deleteData')
      const recordId = requireText(args.record_id, 'record_id')
      const result = await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: '/api/visualdev/form/delete',
        method: 'DELETE',
        body: {
          menuId: menu.menuId,
          _id: recordId,
          ...optionalText('authGroupId', args.auth_group_id),
        },
      }, exec.signal)
      return renderResult({ menuId: menu.menuId, recordId, deleted: true, result }, config.maxOutputBytes)
    },
    presentCall: args => present('Delete JDCloud record', 'other', args.record_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_create_table',
    description: 'Create a JDCloud form table, save its fields, and grant manage-all-data to explicit authorization objects. '
      + 'Host execution requires systemAdministrator in the current userPermission snapshot.',
    parameters: {
      full_name: { type: 'string', required: true, description: 'New JDCloud form name.' },
      parent_id: { type: 'string', description: 'Parent menu id. Omit for the top level.' },
      authorization_object_ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Non-empty department, role, or user ids that receive the manage-all-data permission group.',
      },
      fields: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            en_code: { type: 'string', required: true, description: 'Unique database field code.' },
            label: { type: 'string', required: true, description: 'Human-readable field label.' },
            kind: { type: 'string', required: true, enum: FIELD_KINDS },
            required: { type: 'boolean', description: 'Whether the generated form requires a value.' },
            options: {
              type: 'array',
              description: 'Required only for single_select and multi_select.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                },
              },
            },
          },
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const snapshot = await requireExecutionSnapshot(ctx, snapshots, exec)
      if (!snapshot.systemAdministrator) {
        reject('creating a JDCloud table requires userPermission.systemAdministrator', 'JDCLOUD_LOWCODE_ADMIN_REQUIRED')
      }
      const fullName = requireText(args.full_name, 'full_name')
      const parentId = args.parent_id === undefined ? '-1' : requireText(args.parent_id, 'parent_id')
      const objectIds = uniqueTexts(args.authorization_object_ids, 'authorization_object_ids')
      const fields: TableFieldInput[] = args.fields.map(field => ({
        enCode: field.en_code,
        label: field.label,
        kind: field.kind,
        required: field.required ?? false,
        ...field.options === undefined ? {} : { options: field.options },
      }))
      const formData = buildFormData(fields)
      const created = await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: '/api/system/Base/Menu',
        method: 'POST',
        body: {
          type: 3,
          fullName,
          parentId,
          icon: 'iconfont icon-note-text',
          category: 'All',
          sortCode: 0,
          description: '',
          linkTarget: '_self',
          urlAddress: '',
        },
      }, exec.signal)
      const menuId = readCreatedMenuId(created)
      let stage = 'saving the form schema'
      try {
        await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
          path: `/api/visualdev/base/${encodeURIComponent(menuId)}`,
          method: 'PUT',
          body: { menuId, formData },
        }, exec.signal)
        stage = 'creating the data permission group'
        await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
          path: '/api/system/permission/authority/create',
          method: 'POST',
          body: {
            type: 'manageAllData',
            menuId,
            name: '管理全部数据',
            desc: '在此分组内的成员可以管理全部数据、填报数据、导入数据',
            objectId: objectIds,
          },
        }, exec.signal)
      } catch (error: unknown) {
        reject(
          `JDCloud table menu ${JSON.stringify(menuId)} was created, but ${stage} failed: ${errorMessage(error)}`,
          'JDCLOUD_LOWCODE_TABLE_PARTIAL',
        )
      }
      return renderResult({ menuId, fullName, created: true }, config.maxOutputBytes)
    },
    presentCall: args => present('Create JDCloud table', 'other', args.full_name),
  }))
}

/** Resolve the exact live caller and its capability snapshot for the open turn. */
async function requireExecutionSnapshot(
  ctx: Context,
  snapshots: LowcodeSnapshotStore,
  exec: ToolRunContext,
): Promise<LowcodeCapabilitySnapshot> {
  const agent = exec.agent
  if (agent === undefined) reject('JDCloud low-code tools require a calling agent', 'JDCLOUD_LOWCODE_AGENT_REQUIRED')
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running' || ctx.agents.currentInitiator() !== agent) {
    reject('JDCloud low-code tools require the exact live calling agent inside its active driver', 'JDCLOUD_LOWCODE_DRIVER_REQUIRED')
  }
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  const snapshot = snapshots.get(agent)
  if (boundary === undefined || boundary.openTurnStartSeq === null || snapshot === undefined
    || boundary.lastTurn !== snapshot.turn) {
    reject('JDCloud capabilities must be refreshed by a browser prompt in the current open turn', 'JDCLOUD_LOWCODE_SNAPSHOT_REQUIRED')
  }
  const status = await ctx.jdcloudAuthController.status()
  if (!status.authenticated) {
    reject('JDCloud login is required', 'JDCLOUD_LOWCODE_AUTH_REQUIRED')
  }
  if (status.corpId !== snapshot.corpId) {
    reject(
      'JDCloud tenant changed after this Turn capability snapshot; submit a new browser prompt before using low-code tools',
      'JDCLOUD_LOWCODE_TENANT_CHANGED',
    )
  }
  return snapshot
}

/** Resolve a menu only from the current Host-attested capability snapshot. */
async function requireMenu(
  ctx: Context,
  snapshots: LowcodeSnapshotStore,
  exec: ToolRunContext,
  requestedMenuId: string,
): Promise<LowcodeMenuCapability> {
  const menuId = requireText(requestedMenuId, 'menu_id')
  const snapshot = await requireExecutionSnapshot(ctx, snapshots, exec)
  const menu = snapshot.menus.find(candidate => candidate.menuId === menuId)
  if (menu === undefined) {
    reject(`menu_id ${JSON.stringify(menuId)} is not available in the current JDCloud capability snapshot`, 'JDCLOUD_LOWCODE_MENU_REQUIRED')
  }
  return menu
}

/** Enforce one JDCloud write grant before any modifying request is sent. */
function requirePermission(menu: LowcodeMenuCapability, permission: LowcodeWritePermission): void {
  if (menu.agentPermissions.includes(permission)) return
  reject(
    `JDCloud function ${JSON.stringify(menu.fullName)} does not grant ${permission}`,
    'JDCLOUD_LOWCODE_PERMISSION_REQUIRED',
  )
}

interface SafeField {
  readonly enCode: string
  readonly value: string
  readonly jdcloudKey: string
  readonly fullName: string
  readonly required: boolean
  readonly children?: readonly SafeField[]
}

/** Parse and redact field definitions returned by JDCloud. */
function parseFields(value: unknown): SafeField[] {
  if (!Array.isArray(value)) throw new Error('JDCloud field response is invalid')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`JDCloud field ${String(index)} is invalid`)
    const enCode = requireText(Reflect.get(entry, 'enCode'), `field ${String(index)} enCode`)
    const fieldValue = requireText(Reflect.get(entry, 'value'), `field ${JSON.stringify(enCode)} value`)
    const jdcloudKey = requireText(Reflect.get(entry, 'jdcloudKey'), `field ${JSON.stringify(enCode)} jdcloudKey`)
    const fullName = requireText(Reflect.get(entry, 'fullName'), `field ${JSON.stringify(enCode)} fullName`)
    const children = Reflect.get(entry, 'children')
    return {
      enCode,
      value: fieldValue,
      jdcloudKey,
      fullName,
      required: Reflect.get(entry, 'required') === true,
      ...children === undefined || children === null ? {} : { children: parseFields(children) },
    }
  })
}

/** Remove empty values only for fields identified by JDCloud as automatic bill numbers. */
function omitEmptyAutomaticFields(
  input: Record<string, JsonValue>,
  fields: readonly SafeField[],
): { readonly data: Record<string, JsonValue>; readonly omitted: string[] } {
  const automatic = new Set<string>()
  const pending = [...fields]
  for (const field of pending) {
    if (field.jdcloudKey === 'billRule') automatic.add(field.enCode)
    if (field.children !== undefined) pending.push(...field.children)
  }
  const data: Record<string, JsonValue> = {}
  const omitted: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (automatic.has(key) && (value === '' || value === null)) omitted.push(key)
    else data[key] = value
  }
  return { data, omitted }
}

/** Parse the new menu id returned by the menu-creation endpoint. */
function readCreatedMenuId(value: unknown): string {
  if (!isRecord(value)) throw new Error('JDCloud menu creation response is invalid')
  return requireText(Reflect.get(value, 'id'), 'created JDCloud menu id')
}

/** Validate a sort map before forwarding it to JDCloud. */
function readSort(value: Record<string, JsonValue>): Record<string, 'asc' | 'desc'> {
  const sort: Record<string, 'asc' | 'desc'> = {}
  for (const [field, direction] of Object.entries(value)) {
    const code = requireText(field, 'sort field')
    if (direction !== 'asc' && direction !== 'desc') {
      reject(`sort direction for ${JSON.stringify(code)} must be asc or desc`, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT')
    }
    sort[code] = direction
  }
  return sort
}

/** Return a one-field object only when an optional text value was supplied. */
function optionalText<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: requireText(value, key) } as Record<K, string>
}

/** Require a trimmed, non-empty string from either model input or external data. */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject(`${label} must be a non-empty string`, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT')
  }
  return value.trim()
}

/** Require one positive safe integer. */
function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    reject(`${label} must be a positive safe integer`, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT')
  }
  return value
}

/** Require non-empty unique strings without inventing authorization scope. */
function uniqueTexts(values: readonly string[], label: string): string[] {
  if (values.length === 0) reject(`${label} must not be empty`, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT')
  const result = values.map(value => requireText(value, label))
  if (new Set(result).size !== result.length) {
    reject(`${label} must not contain duplicate ids`, 'JDCLOUD_LOWCODE_INVALID_ARGUMENT')
  }
  return result
}

/** Bound one model-visible result without splitting a UTF-8 code point. */
function renderResult(value: unknown, maxOutputBytes: number): string {
  const serialized: unknown = JSON.stringify(value)
  const json = typeof serialized === 'string' ? serialized : 'null'
  const complete = `Untrusted JDCloud response data:\n${json}`
  const completeBytes = new TextEncoder().encode(complete).length
  if (completeBytes <= maxOutputBytes) return complete
  const truncated = `Untrusted JDCloud response data was truncated from ${String(completeBytes)} bytes `
    + `to the configured ${String(maxOutputBytes)}-byte limit:\n${json}`
  return utf8Prefix(truncated, maxOutputBytes)
}

/** Return the longest complete-code-point prefix within one UTF-8 byte limit. */
function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, maxBytes), { stream: true })
}

/** Create a stable generic UI presentation for one JDCloud call. */
function present(title: string, kind: 'read' | 'other', rawInput: string): GenericCallView {
  return { card: 'generic', title, kind, rawInput }
}

/** Throw one structured model-tool policy failure. */
function reject(message: string, code: string): never {
  throw new HarnessError(message, code)
}

/** Whether a wire value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract a readable message when reporting a partially completed table creation. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
