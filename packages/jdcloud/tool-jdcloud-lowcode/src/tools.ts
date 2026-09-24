/** Model-facing JDCloud tools with execution-time tenant and permission checks. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  FileAttachmentRef,
  ImageAttachmentRef,
  ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import mime from 'mime-types'
import {
  parseTenantUserSearch,
  resolveTenantUserSearch,
} from './current-user.ts'
import type {
  LowcodeCapabilitySnapshot,
  LowcodeMenuCapability,
  LowcodePermission,
  LowcodeTenantDepartment,
  LowcodeTenantRole,
} from './current-user.ts'
import { buildFormData } from './table-schema.ts'
import type { TableFieldInput } from './table-schema.ts'
import { actionForPermission, permissionNotice, staleSnapshotNotice } from './user-notice.ts'

/** Fully resolved output and pagination limits for the tool set. */
export interface LowcodeToolConfig {
  readonly maxPageSize: number
  readonly maxOutputBytes: number
}

/** Per-agent authority snapshots refreshed by the prompt listener. */
export type LowcodeSnapshotStore = WeakMap<Agent, LowcodeCapabilitySnapshot>

/** Resolve the current tenant-user's cached JDCloud departments for one tool call. */
export type LowcodeDepartmentSearch = (
  scopeKey: string,
  signal: AbortSignal,
) => Promise<readonly LowcodeTenantDepartment[]>

/** Resolve the current tenant-user's cached JDCloud roles for one tool call. */
export type LowcodeRoleSearch = (
  scopeKey: string,
  signal: AbortSignal,
) => Promise<readonly LowcodeTenantRole[]>

/** Maximum department candidates exposed in one model-visible search result. */
const DEPARTMENT_SEARCH_LIMIT = 20

/** Maximum role candidates exposed in one model-visible search result. */
const ROLE_SEARCH_LIMIT = 20

/** Maximum tenant-user candidates exposed in one model-visible search result. */
const USER_SEARCH_LIMIT = 20

const FILTER_METHODS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'nin',
  'enable', 'unEnable', 'empty', 'unEmpty', 'range',
] as const
const FILTER_TYPES = ['custom', 'field', 'systemField'] as const
const FIELD_KINDS = [
  'text', 'textarea', 'number', 'switch', 'single_select', 'multi_select', 'date', 'time',
] as const

type FieldWriteType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | '{name:string,url:string}[]'
  | 'object[]'
  | '{lnglat:{lng:number,lat:number},address:string}'
  | 'json'
  | 'json[]'

/** Fixed JDCloud component value types used by record create and update operations. */
const COMPONENT_WRITE_TYPES: Readonly<Record<string, FieldWriteType>> = {
  comInput: 'string',
  textarea: 'string',
  radio: 'string',
  time: 'string',
  editor: 'string',
  editorParse: 'string',
  billRule: 'string',
  AssociatedData: 'string',
  AssociatedSelect: 'string',
  colorPicker: 'string',
  creatorUserId: 'string',
  lastModifyUserId: 'string',
  numInput: 'number',
  calculate: 'number',
  slider: 'number',
  rate: 'number',
  switch: 'number',
  date: 'number',
  creatorTime: 'number',
  lastModifyTime: 'number',
  checkbox: 'string[]',
  multipleInput: 'string[]',
  uploadImg: '{name:string,url:string}[]',
  uploadFz: '{name:string,url:string}[]',
  table: 'object[]',
  location: '{lnglat:{lng:number,lat:number},address:string}',
}

/** Components whose single- or multi-select mode is reported by the live field value kind. */
const MODED_SELECTION_COMPONENTS = new Set(['select', 'userSelect', 'depSelect', 'roleSelect'])

/** Layout-only components never own a record value. */
const VALUELESS_COMPONENTS = new Set(['divider', 'text', 'groupTitle', 'tabs', 'card', 'row'])

const IMAGE_FILE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

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
    description: 'Field-code to JSON-value map. Match each field writeType returned by jdcloud_lowcode_describe; '
      + 'single-select values are id strings and multi-select values are arrays of id strings.',
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
 * @param findDepartments - Scope-isolated department lookup supplied by the prompt plugin.
 * @param findRoles - Scope-isolated role lookup supplied by the prompt plugin.
 * @param config - Resolved query and output limits.
 */
export function registerLowcodeTools(
  ctx: Context,
  snapshots: LowcodeSnapshotStore,
  findDepartments: LowcodeDepartmentSearch,
  findRoles: LowcodeRoleSearch,
  config: LowcodeToolConfig,
): void {
  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_find_department',
    description: 'Find up to 20 departments by exact or partial name or path in the current JDCloud tenant. Use an exact returned id for depSelect values.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Department name or path fragment to match.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = requireText(args.query, 'query')
      const snapshot = await requireExecutionSnapshot(ctx, snapshots, exec)
      const departments = await findDepartments(snapshot.scopeKey, exec.signal)
      await requireExecutionSnapshot(ctx, snapshots, exec)
      return renderResult({ departments: matchedDepartments(departments, query) }, config.maxOutputBytes)
    },
    presentCall: args => present('Find JDCloud department', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_find_role',
    description: 'Find up to 20 roles by exact or partial name or group path in the current JDCloud tenant. Use an exact returned id for roleSelect values.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Role name or group-path fragment to match.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = requireText(args.query, 'query')
      const snapshot = await requireExecutionSnapshot(ctx, snapshots, exec)
      const roles = await findRoles(snapshot.scopeKey, exec.signal)
      await requireExecutionSnapshot(ctx, snapshots, exec)
      return renderResult({ roles: matchedRoles(roles, query) }, config.maxOutputBytes)
    },
    presentCall: args => present('Find JDCloud role', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_find_user',
    description: 'Find up to 20 users by phone or real name in the current JDCloud tenant. '
      + 'A unique result can supply userSelect, department, and role ids. When multiple users match, ask the user to choose one or provide a phone number.',
    parameters: {
      search_by: {
        type: 'string',
        required: true,
        enum: ['phone', 'name'] as const,
        description: 'Whether query is a phone number or real name.',
      },
      query: {
        type: 'string',
        required: true,
        description: 'Phone number or real-name fragment to match.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = requireText(args.query, 'query')
      await requireExecutionSnapshot(ctx, snapshots, exec)
      const search = parseTenantUserSearch(
        await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
          path: '/api/system/permission/organize/-1/user',
          method: 'POST',
          body: {
            currentPage: 1,
            pageSize: USER_SEARCH_LIMIT,
            connect: 'and',
            filter: [{
              enCode: args.search_by === 'phone' ? 'phone' : 'realName',
              value: [query],
              type: 'custom',
              method: 'like',
            }],
          },
        }, exec.signal),
      )
      const candidates = search.users
        .filter(user => args.search_by !== 'phone' || user.phone === query)
        .slice(0, USER_SEARCH_LIMIT)
      const memberIds = [...new Set(candidates.flatMap(user => [
        ...user.departmentIds,
        ...user.roleIds,
      ]))]
      const memberNames = memberIds.length === 0
        ? { department: [], role: [] }
        : await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
          path: '/api/system/permission/users/getMemberName',
          method: 'POST',
          body: memberIds,
        }, exec.signal)
      const users = resolveTenantUserSearch(candidates, memberNames)
      await requireExecutionSnapshot(ctx, snapshots, exec)
      const total = args.search_by === 'phone' ? candidates.length : search.total
      const resolution = total === 0
        ? 'none'
        : total === 1 && users.length === 1 ? 'unique' : 'ambiguous'
      return renderResult({ resolution, total, users }, config.maxOutputBytes)
    },
    presentCall: args => present('Find JDCloud user', 'read', args.query),
  }))

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
      requirePermission(menu, 'readData')
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
      requirePermission(menu, 'readData')
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
    name: 'jdcloud_lowcode_upload_file',
    description: 'Upload one file or image already attached in this Session to JDCloud. '
      + 'Host execution requires the target menu write permission. Use the returned name and url object inside an attachment or image-upload field only after user confirmation.',
    parameters: {
      ...MENU_PARAMETER,
      write_kind: {
        type: 'string',
        required: true,
        enum: ['create', 'update'] as const,
        description: 'Whether the uploaded value will be used by a create or update operation.',
      },
      attachment_id: {
        type: 'string',
        required: true,
        description: 'The sha256 value shown in the conversation attachment handle or its saved path.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Untrusted JDCloud uploaded file reference:\n${JSON.stringify(value)}`,
      }],
    },
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      requirePermission(menu, args.write_kind === 'create' ? 'addData' : 'editData')
      const ref = requireSessionAttachment(exec.agent as Agent, args.attachment_id)
      const multipartFile = ref.type === 'image'
        ? await imageMultipartFile(ctx, ref.attachment, exec.signal)
        : {
          name: ref.attachment.name,
          mediaType: mime.lookup(ref.attachment.name) || 'application/octet-stream',
          stream: ctx.attachments.readFileStream(ref.attachment, exec.signal),
          bytes: ref.attachment.bytes,
        }
      const uploaded = await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: '/api/file/uploader',
        method: 'POST',
        multipartFile,
      }, exec.signal)
      return readUploadedFile(uploaded)
    },
    presentCall: args => present('Upload JDCloud file', 'other', args.attachment_id),
  }))

  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_create',
    description: 'Create one form record or start one workflow. Host execution requires addData and rejects values that do not match the live field writeType or omit a required field.',
    parameters: { ...MENU_PARAMETER, ...AUTH_GROUP_PARAMETER, ...DATA_PARAMETER },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const menu = await requireMenu(ctx, snapshots, exec, args.menu_id)
      requirePermission(menu, 'addData')
      const fields = parseFields(await ctx.jdcloudAuthController.requestAuthenticated<unknown>({
        path: `/api/visualdev/base/fields/${encodeURIComponent(menu.menuId)}`,
        method: 'GET',
      }, exec.signal))
      requireCreateFields(args.data, fields)
      requireFieldValueTypes(args.data, fields)
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
    description: 'Update one JDCloud record. Host execution requires editData, rejects values that do not match the live field writeType, and removes empty automatic-number fields.',
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
      requireFieldValueTypes(data, fields)
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
    const notice = staleSnapshotNotice()
    reject(notice.message, notice.code)
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
  if (await ctx.jdcloudAuthController.currentScopeKey() !== snapshot.scopeKey) {
    reject(
      'JDCloud account changed after this Turn capability snapshot; submit a new browser prompt before using low-code tools',
      'JDCLOUD_LOWCODE_TENANT_CHANGED',
    )
  }
  return snapshot
}

/** Match departments in stable response order with exact names and paths first. */
function matchedDepartments(
  departments: readonly LowcodeTenantDepartment[],
  query: string,
): readonly LowcodeTenantDepartment[] {
  const normalized = query.toLocaleLowerCase()
  return departments
    .map((department, index) => ({ department, index, rank: departmentMatchRank(department, normalized) }))
    .filter((candidate): candidate is {
      readonly department: LowcodeTenantDepartment
      readonly index: number
      readonly rank: number
    } => candidate.rank !== undefined)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, DEPARTMENT_SEARCH_LIMIT)
    .map(candidate => candidate.department)
}

/** Rank a department match so an exact selection is always presented first. */
function departmentMatchRank(department: LowcodeTenantDepartment, query: string): number | undefined {
  const fullName = department.fullName.toLocaleLowerCase()
  const path = department.path.toLocaleLowerCase()
  if (fullName === query) return 0
  if (path === query) return 1
  if (fullName.includes(query)) return 2
  if (path.includes(query)) return 3
  return undefined
}

/** Match roles in stable response order with exact names and paths first. */
function matchedRoles(
  roles: readonly LowcodeTenantRole[],
  query: string,
): readonly LowcodeTenantRole[] {
  const normalized = query.toLocaleLowerCase()
  return roles
    .map((role, index) => ({ role, index, rank: roleMatchRank(role, normalized) }))
    .filter((candidate): candidate is {
      readonly role: LowcodeTenantRole
      readonly index: number
      readonly rank: number
    } => candidate.rank !== undefined)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, ROLE_SEARCH_LIMIT)
    .map(candidate => candidate.role)
}

/** Rank a role match so an exact selection is always presented first. */
function roleMatchRank(role: LowcodeTenantRole, query: string): number | undefined {
  const fullName = role.fullName.toLocaleLowerCase()
  const path = role.path.toLocaleLowerCase()
  if (fullName === query) return 0
  if (path === query) return 1
  if (fullName.includes(query)) return 2
  if (path.includes(query)) return 3
  return undefined
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

/** Enforce one JDCloud data grant before the matching Host request is sent. */
function requirePermission(menu: LowcodeMenuCapability, permission: LowcodePermission): void {
  if (menu.agentPermissions.includes(permission)) return
  const notice = permissionNotice(actionForPermission(permission))
  reject(notice.message, notice.code)
}

type SessionAttachment =
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }

/** Resolve one full attachment id only from the calling Session's durable user blocks. */
function requireSessionAttachment(agent: Agent, attachmentIdValue: string): SessionAttachment {
  const attachmentId = requireText(attachmentIdValue, 'attachment_id')
  const attachments = sessionAttachments(agent)
  const exact = attachments.find(ref => String(ref.attachment.attachmentId) === attachmentId)
  if (exact !== undefined) return exact

  const candidate = attachmentId.startsWith('sha256:') ? attachmentId : `sha256:${attachmentId}`
  const digest = /^sha256:([a-f0-9]{8}|[a-f0-9]{64})$/.exec(candidate)?.[1]
  if (digest !== undefined) {
    const prefix = `sha256:${digest}`
    const matches = attachments.filter(ref => String(ref.attachment.attachmentId).startsWith(prefix))
    const match = matches.length === 1 ? matches[0] : undefined
    if (match !== undefined) return match
    if (matches.length > 1) {
      reject(
        `attachment_id ${JSON.stringify(attachmentId)} matches multiple attachments in the current Session`,
        'JDCLOUD_LOWCODE_ATTACHMENT_REQUIRED',
      )
    }
  }
  reject(
    `attachment_id ${JSON.stringify(attachmentId)} is not a file or image in the current Session`,
    'JDCLOUD_LOWCODE_ATTACHMENT_REQUIRED',
  )
}

/** Collect each distinct durable user attachment available to the calling Session. */
function sessionAttachments(agent: Agent): SessionAttachment[] {
  const attachments = new Map<string, SessionAttachment>()
  for (const message of agent.session.deriveMessages()) {
    if (message.role !== 'user') continue
    collectAttachments(message.content, attachments)
  }
  return [...attachments.values()]
}

/** Collect durable user attachments without accepting a model-invented reference. */
function collectAttachments(
  blocks: readonly ContentBlock[],
  attachments: Map<string, SessionAttachment>,
): void {
  for (const block of blocks) {
    if (block.type === 'image') {
      attachments.set(String(block.attachment.attachmentId), { type: 'image', attachment: block.attachment })
    }
    if (block.type === 'file') {
      attachments.set(String(block.attachment.attachmentId), { type: 'file', attachment: block.attachment })
    }
  }
}

/** Read one normalized image into the existing byte-backed multipart request. */
async function imageMultipartFile(
  ctx: Context,
  ref: ImageAttachmentRef,
  signal: AbortSignal,
): Promise<{ readonly name: string; readonly mediaType: ImageMediaType; readonly data: Uint8Array }> {
  const stored = await ctx.attachments.readImage(ref, signal)
  return { name: imageFileName(ref), mediaType: ref.mediaType, data: stored.data }
}

/** Preserve a safe display name, or derive one that matches the verified image format. */
function imageFileName(ref: ImageAttachmentRef): string {
  if (ref.name !== undefined && ref.name.trim() !== '') return ref.name
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 12)
  return `image-${digest}${IMAGE_FILE_EXTENSIONS[ref.mediaType]}`
}

/** Validate the two external fields JDCloud attachment components persist. */
function readUploadedFile(value: unknown): { readonly name: string; readonly url: string } {
  if (!isRecord(value)) throw new Error('JDCloud file-upload response is invalid')
  return {
    name: requireExternalText(Reflect.get(value, 'name'), 'JDCloud uploaded file name'),
    url: requireExternalText(Reflect.get(value, 'url'), 'JDCloud uploaded file url'),
  }
}

/** Require one non-empty string from an external JDCloud response. */
function requireExternalText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is invalid`)
  return value.trim()
}

interface SafeField {
  readonly enCode: string
  readonly value?: string
  readonly jdcloudKey: string
  readonly fullName: string
  readonly required: boolean
  readonly writeType?: FieldWriteType
  readonly children?: readonly SafeField[]
}

/** Parse and redact field definitions returned by JDCloud. */
function parseFields(value: unknown): SafeField[] {
  if (!Array.isArray(value)) throw new Error('JDCloud field response is invalid')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`JDCloud field ${String(index)} is invalid`)
    const enCode = requireText(Reflect.get(entry, 'enCode'), `field ${String(index)} enCode`)
    const jdcloudKey = requireText(Reflect.get(entry, 'jdcloudKey'), `field ${JSON.stringify(enCode)} jdcloudKey`)
    const fullName = requireText(Reflect.get(entry, 'fullName'), `field ${JSON.stringify(enCode)} fullName`)
    const children = Reflect.get(entry, 'children')
    const parsedChildren = children === undefined || children === null ? undefined : parseFields(children)
    const rawValue = Reflect.get(entry, 'value')
    let fieldValue: string | undefined
    if (rawValue === undefined || rawValue === null || (typeof rawValue === 'string' && rawValue.trim() === '')) {
      if (parsedChildren === undefined) fieldValue = requireText(rawValue, `field ${JSON.stringify(enCode)} value`)
    } else {
      fieldValue = requireText(rawValue, `field ${JSON.stringify(enCode)} value`)
    }
    const writeType = fieldWriteType(jdcloudKey, fieldValue)
    return {
      enCode,
      ...fieldValue === undefined ? {} : { value: fieldValue },
      jdcloudKey,
      fullName,
      required: Reflect.get(entry, 'required') === true,
      ...writeType === undefined ? {} : { writeType },
      ...parsedChildren === undefined ? {} : { children: parsedChildren },
    }
  })
}

/** Resolve the record-write type from the component and its live single- or multi-select mode. */
function fieldWriteType(jdcloudKey: string, value: string | undefined): FieldWriteType | undefined {
  if (VALUELESS_COMPONENTS.has(jdcloudKey)) return undefined
  if (MODED_SELECTION_COMPONENTS.has(jdcloudKey)) return value === 'array' ? 'string[]' : 'string'
  const fixed = COMPONENT_WRITE_TYPES[jdcloudKey]
  if (fixed !== undefined) return fixed
  if (value === 'string' || value === 'number' || value === 'boolean') return value
  return value === 'array' ? 'json[]' : 'json'
}

/** Reject component values whose JSON types cannot be persisted by the live form fields. */
function requireFieldValueTypes(data: Record<string, JsonValue>, fields: readonly SafeField[]): void {
  const invalid = collectInvalidFieldValues(data, fields)
  if (invalid.length === 0) return
  reject(`JDCloud data has invalid field values: ${invalid.join(', ')}`, 'JDCLOUD_LOWCODE_FIELD_TYPE')
}

/** Collect readable type failures, including values inside child-table rows. */
function collectInvalidFieldValues(
  data: Record<string, unknown>,
  fields: readonly SafeField[],
  labelPrefix = '',
  codePrefix = '',
): string[] {
  const invalid: string[] = []
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, field.enCode)) continue
    const value = data[field.enCode]
    const label = labelPrefix === '' ? field.fullName : `${labelPrefix}.${field.fullName}`
    const code = codePrefix === '' ? field.enCode : `${codePrefix}.${field.enCode}`
    if (field.writeType !== undefined && !matchesWriteType(value, field.writeType)) {
      invalid.push(`${label} (${code}) must be ${field.writeType}`)
      continue
    }
    if (field.jdcloudKey !== 'table' || field.children === undefined || !Array.isArray(value)) continue
    const children = field.children
    const rows = value as Record<string, unknown>[]
    rows.forEach((row, index) => {
      invalid.push(...collectInvalidFieldValues(
        row,
        children,
        `${label}[${String(index + 1)}]`,
        `${code}[${String(index + 1)}]`,
      ))
    })
  }
  return invalid
}

/** Test one JSON value against the model-visible JDCloud write type. */
function matchesWriteType(value: unknown, writeType: FieldWriteType): boolean {
  if (writeType === 'string') return typeof value === 'string'
  if (writeType === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (writeType === 'boolean') return typeof value === 'boolean'
  if (writeType === 'string[]') return Array.isArray(value) && value.every(item => typeof item === 'string')
  if (writeType === 'json[]') return Array.isArray(value)
  if (writeType === 'object[]') return Array.isArray(value) && value.every(isRecord)
  if (writeType === '{name:string,url:string}[]') {
    return Array.isArray(value) && value.every(item => isRecord(item)
      && typeof Reflect.get(item, 'name') === 'string'
      && typeof Reflect.get(item, 'url') === 'string')
  }
  if (writeType === '{lnglat:{lng:number,lat:number},address:string}') {
    if (!isRecord(value) || !isRecord(Reflect.get(value, 'lnglat'))) return false
    const lnglat = Reflect.get(value, 'lnglat') as Record<string, unknown>
    return typeof Reflect.get(value, 'address') === 'string'
      && typeof lnglat.lng === 'number' && Number.isFinite(lnglat.lng)
      && typeof lnglat.lat === 'number' && Number.isFinite(lnglat.lat)
  }
  return true
}

/** Reject a create call when its live JDCloud field definition still has required values missing. */
function requireCreateFields(data: Record<string, JsonValue>, fields: readonly SafeField[]): void {
  const missing = collectMissingRequiredFields(data, fields)
  if (missing.length === 0) return
  reject(
    `JDCloud create data is missing required fields: ${missing.join(', ')}`,
    'JDCLOUD_LOWCODE_REQUIRED_FIELDS',
  )
}

/** Collect readable field labels and codes for empty required values, including each child-table row. */
function collectMissingRequiredFields(
  data: Record<string, unknown>,
  fields: readonly SafeField[],
  labelPrefix = '',
  codePrefix = '',
): string[] {
  const missing: string[] = []
  for (const field of fields) {
    const label = labelPrefix === '' ? field.fullName : `${labelPrefix}.${field.fullName}`
    const code = codePrefix === '' ? field.enCode : `${codePrefix}.${field.enCode}`
    const value = data[field.enCode]
    const children = field.children
    if (children !== undefined) {
      if (!Array.isArray(value) || value.length === 0) {
        if (field.required) missing.push(`${label} (${code})`)
        continue
      }
      value.forEach((row, index) => {
        const rowLabel = `${label}[${String(index + 1)}]`
        const rowCode = `${code}[${String(index + 1)}]`
        if (isRecord(row)) {
          missing.push(...collectMissingRequiredFields(row, children, rowLabel, rowCode))
        } else {
          missing.push(`${rowLabel} (${rowCode})`)
        }
      })
      continue
    }
    if (!hasRequiredValue(value, field) && field.required) missing.push(`${label} (${code})`)
  }
  return missing
}

/** Decide whether one external JSON value satisfies the field's required-value semantics. */
function hasRequiredValue(value: unknown, field: SafeField): boolean {
  if (value === undefined || value === null) return false
  if (field.writeType === 'string[]' || field.writeType === 'json[]'
    || field.writeType === 'object[]' || field.writeType === '{name:string,url:string}[]') {
    return Array.isArray(value) && value.length > 0
  }
  if (field.writeType === 'string') return typeof value === 'string' && value.trim() !== ''
  if (field.writeType === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (field.writeType === 'boolean') return typeof value === 'boolean'
  return true
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
