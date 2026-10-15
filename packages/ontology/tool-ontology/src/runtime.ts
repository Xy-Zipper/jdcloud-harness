/** Runtime response validation for Ontology model tools. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  OntologyActionSummary,
  OntologyActionTypeId,
  OntologyInvocationId,
  OntologyLinkTypeId,
  OntologyObjectRecord,
  OntologyObjectSummary,
  OntologyObjectTypeId,
  OntologyPreparedAction,
  OntologyProjectId,
  OntologyProjectSummary,
  OntologyPropertyId,
  OntologyPropertySummary,
} from './types.ts'

/** One page of published Object records. */
export interface OntologyRecordPage {
  readonly records: readonly OntologyObjectRecord[]
  readonly page: number
  readonly pageSize: number
  readonly total: number
}

/** One Link traversal page. */
export interface OntologyTraversalPage extends OntologyRecordPage {
  readonly linkTypeId: OntologyLinkTypeId
  readonly direction: 'outgoing' | 'incoming'
  readonly objectTypeId: OntologyObjectTypeId
}

/** One Property from the published Object detail. */
export interface OntologyPropertyDetail extends OntologyPropertySummary {
  readonly description: string
  readonly required: boolean
}

/** One Link definition related to a published Object. */
export interface OntologyLinkSummary {
  readonly id: OntologyLinkTypeId
  readonly label: string
  readonly description: string
  readonly sourceType: OntologyObjectTypeId
  readonly targetType: OntologyObjectTypeId
  readonly cardinality: string
  readonly sourceProperty: OntologyPropertyId
  readonly targetProperty: OntologyPropertyId
}

/** Published Object detail returned only after explicit discovery. */
export interface OntologyObjectDetail {
  readonly id: OntologyObjectTypeId
  readonly label: string
  readonly description: string
  readonly primaryKey: OntologyPropertySummary
  readonly properties: readonly OntologyPropertyDetail[]
  readonly links: readonly OntologyLinkSummary[]
  readonly actions: readonly OntologyActionSummary[]
}

/** One published Action mapping used to derive caller-supplied parameters. */
export interface OntologyActionMapping {
  readonly targetProperty: OntologyPropertyId
  readonly source: 'parameter' | 'constant' | 'formula'
  readonly inputName: string
  readonly required: boolean
}

/** Authorized published Action detail returned by Runtime. */
export interface OntologyActionDefinition extends OntologyActionSummary {
  readonly mappings: readonly OntologyActionMapping[]
}

/** Successful Action execution result. */
export interface OntologyActionResult {
  readonly invocationId: OntologyInvocationId
  readonly status: 'succeeded'
  readonly result: Readonly<Record<string, JsonValue>>
}

/** Action Invocation fields needed to gate one execution request. */
export interface OntologyActionInvocation extends OntologyPreparedAction {
  readonly projectId: OntologyProjectId
  readonly actionTypeId: OntologyActionTypeId
  readonly actionKind: string
  readonly status: 'prepared' | 'executing' | 'succeeded' | 'failed'
}

/**
 * Parse the authorized Project list.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated published Project summaries.
 */
export function readProjects(value: unknown): { readonly projects: readonly OntologyProjectSummary[] } {
  const record = requireRecord(value, 'Ontology Project list')
  return { projects: requireArray(record['projects'], 'Ontology Projects').map(readProject) }
}

/**
 * Parse the published Object summary list.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated published Object summaries.
 */
export function readObjects(value: unknown): { readonly objects: readonly OntologyObjectSummary[] } {
  const record = requireRecord(value, 'Ontology Object list')
  return { objects: requireArray(record['objects'], 'Ontology Objects').map(readObjectSummary) }
}

/**
 * Parse one published Object detail.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated Object properties, Links, and Actions.
 */
export function readObjectDetail(value: unknown): OntologyObjectDetail {
  const record = requireRecord(value, 'Ontology Object detail')
  return {
    id: objectTypeId(record['id'], 'Ontology Object id'),
    label: requireString(record['label'], 'Ontology Object label'),
    description: requireString(record['description'], 'Ontology Object description'),
    primaryKey: readPropertySummary(record['primaryKey']),
    properties: requireArray(record['properties'], 'Ontology Object properties').map(readPropertyDetail),
    links: requireArray(record['links'], 'Ontology Object links').map(readLink),
    actions: requireArray(record['actions'], 'Ontology Object actions').map(readAction),
  }
}

/**
 * Parse one authorized published Action definition.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated Action metadata and Property mappings.
 */
export function readActionDetail(value: unknown): OntologyActionDefinition {
  const record = requireRecord(value, 'Ontology Action detail')
  return {
    ...readAction(record),
    mappings: requireArray(record['mappings'], 'Ontology Action mappings').map(readActionMapping),
  }
}

/**
 * Parse one Object query page.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated bounded Object records and pagination metadata.
 */
export function readRecordPage(value: unknown): OntologyRecordPage {
  const record = requireRecord(value, 'Ontology Object query')
  return {
    records: requireArray(record['records'], 'Ontology Object records').map(readObjectRecord),
    page: requireNonNegativeInteger(record['page'], 'Ontology query page', 1),
    pageSize: requireNonNegativeInteger(record['pageSize'], 'Ontology query page size', 1),
    total: requireNonNegativeInteger(record['total'], 'Ontology query total', 0),
  }
}

/**
 * Parse one primary-key Object response.
 * @param value Untrusted Ontology Runtime response.
 * @returns The validated Object record.
 */
export function readObjectGet(value: unknown): { readonly record: OntologyObjectRecord } {
  const record = requireRecord(value, 'Ontology Object get')
  return { record: readObjectRecord(record['record']) }
}

/**
 * Parse one Link traversal page.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated related records and Link traversal metadata.
 */
export function readTraversal(value: unknown): OntologyTraversalPage {
  const record = requireRecord(value, 'Ontology Link traversal')
  const direction = record['direction']
  if (direction !== 'outgoing' && direction !== 'incoming') {
    throw new Error('Ontology Link direction is invalid')
  }
  return {
    linkTypeId: linkTypeId(record['linkTypeId'], 'Ontology Link id'),
    direction,
    objectTypeId: objectTypeId(record['objectTypeId'], 'Ontology related Object id'),
    records: requireArray(record['records'], 'Ontology related records').map(readObjectRecord),
    page: requireNonNegativeInteger(record['page'], 'Ontology traversal page', 1),
    pageSize: requireNonNegativeInteger(record['pageSize'], 'Ontology traversal page size', 1),
    total: requireNonNegativeInteger(record['total'], 'Ontology traversal total', 0),
  }
}

/**
 * Parse an immutable Action preparation preview.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated Invocation preview and affected Object references.
 */
export function readPreparedAction(value: unknown): OntologyPreparedAction {
  const record = requireRecord(value, 'Ontology Action preparation')
  return {
    invocationId: invocationId(record['invocationId'], 'Ontology Invocation id'),
    expiresAt: requireTimestamp(record['expiresAt'], 'Ontology Invocation expiry'),
    requiresConfirmation: requireBoolean(record['requiresConfirmation'], 'Ontology confirmation requirement'),
    summary: requireString(record['summary'], 'Ontology Action summary'),
    affectedObjects: requireArray(record['affectedObjects'], 'Ontology affected Objects').map((item) => {
      const affected = requireRecord(item, 'Ontology affected Object')
      const primaryKey = affected['primaryKey']
      return {
        objectTypeId: objectTypeId(affected['objectTypeId'], 'Ontology affected Object Type id'),
        ...primaryKey === undefined ? {} : { primaryKey: requireJson(primaryKey, 'Ontology affected primary key') },
      }
    }),
  }
}

/**
 * Parse one successful Action execution result.
 * @param value Untrusted Ontology Runtime response.
 * @returns The validated succeeded Invocation and Action output.
 */
export function readActionResult(value: unknown): OntologyActionResult {
  const record = requireRecord(value, 'Ontology Action result')
  if (record['status'] !== 'succeeded') throw new Error('Ontology Action result status is invalid')
  return {
    invocationId: invocationId(record['invocationId'], 'Ontology Invocation id'),
    status: 'succeeded',
    result: requireJsonRecord(record['result'], 'Ontology Action output'),
  }
}

/**
 * Parse one Invocation preview used by the approval adapter.
 * @param value Untrusted Ontology Runtime response.
 * @returns Validated Invocation identity, preview, Action metadata, and status.
 */
export function readInvocation(value: unknown): OntologyActionInvocation {
  const record = requireRecord(value, 'Ontology Action Invocation')
  const status = record['status']
  if (status !== 'prepared' && status !== 'executing' && status !== 'succeeded' && status !== 'failed') {
    throw new Error('Ontology Invocation status is invalid')
  }
  return {
    ...readPreparedAction(record),
    projectId: projectId(record['projectId'], 'Ontology Invocation Project id'),
    actionTypeId: actionTypeId(record['actionTypeId'], 'Ontology Invocation Action id'),
    actionKind: requireString(record['actionKind'], 'Ontology Invocation Action kind'),
    status,
  }
}

function readProject(value: unknown): OntologyProjectSummary {
  const record = requireRecord(value, 'Ontology Project')
  return {
    id: projectId(record['id'], 'Ontology Project id'),
    name: requireString(record['name'], 'Ontology Project name'),
    description: requireString(record['description'], 'Ontology Project description'),
    releaseVersion: requireString(record['releaseVersion'], 'Ontology release version'),
  }
}

function readObjectSummary(value: unknown): OntologyObjectSummary {
  const record = requireRecord(value, 'Ontology Object summary')
  return {
    id: objectTypeId(record['id'], 'Ontology Object id'),
    label: requireString(record['label'], 'Ontology Object label'),
    description: requireString(record['description'], 'Ontology Object description'),
    primaryKey: readPropertySummary(record['primaryKey']),
  }
}

function readPropertySummary(value: unknown): OntologyPropertySummary {
  const record = requireRecord(value, 'Ontology Property summary')
  return {
    id: propertyId(record['id'], 'Ontology Property id'),
    label: requireString(record['label'], 'Ontology Property label'),
    type: requireString(record['type'], 'Ontology Property type'),
    sourceField: requireString(record['sourceField'], 'Ontology Property source field'),
  }
}

function readPropertyDetail(value: unknown): OntologyPropertyDetail {
  const record = requireRecord(value, 'Ontology Property')
  return {
    ...readPropertySummary(record),
    description: requireString(record['description'], 'Ontology Property description'),
    required: requireBoolean(record['required'], 'Ontology Property required flag'),
  }
}

function readLink(value: unknown): OntologyLinkSummary {
  const record = requireRecord(value, 'Ontology Link')
  return {
    id: linkTypeId(record['id'], 'Ontology Link id'),
    label: requireString(record['label'], 'Ontology Link label'),
    description: requireString(record['description'], 'Ontology Link description'),
    sourceType: objectTypeId(record['sourceType'], 'Ontology Link source Object id'),
    targetType: objectTypeId(record['targetType'], 'Ontology Link target Object id'),
    cardinality: requireString(record['cardinality'], 'Ontology Link cardinality'),
    sourceProperty: propertyId(record['sourceProperty'], 'Ontology Link source Property id'),
    targetProperty: propertyId(record['targetProperty'], 'Ontology Link target Property id'),
  }
}

function readAction(value: unknown): OntologyActionSummary {
  const record = requireRecord(value, 'Ontology Action')
  const targetType = record['targetType']
  return {
    id: actionTypeId(record['id'], 'Ontology Action id'),
    label: requireString(record['label'], 'Ontology Action label'),
    description: requireString(record['description'], 'Ontology Action description'),
    kind: requireString(record['kind'], 'Ontology Action kind'),
    operation: requireString(record['operation'], 'Ontology Action operation'),
    effect: requireString(record['effect'], 'Ontology Action effect'),
    ...targetType === undefined || targetType === ''
      ? {}
      : { targetType: objectTypeId(targetType, 'Ontology Action target Object id') },
    requiresConfirmation: requireBoolean(record['requiresConfirmation'], 'Ontology Action confirmation requirement'),
  }
}

function readActionMapping(value: unknown): OntologyActionMapping {
  const record = requireRecord(value, 'Ontology Action mapping')
  const sourceValue = record['source']
  const source = sourceValue === undefined || sourceValue === '' ? 'parameter' : sourceValue
  if (source !== 'parameter' && source !== 'constant' && source !== 'formula') {
    throw new Error('Ontology Action mapping source is invalid')
  }
  return {
    targetProperty: propertyId(record['targetProperty'], 'Ontology Action target Property id'),
    source,
    inputName: requireString(record['inputName'], 'Ontology Action input name'),
    required: requireBoolean(record['required'], 'Ontology Action parameter required flag'),
  }
}

function readObjectRecord(value: unknown): OntologyObjectRecord {
  const record = requireRecord(value, 'Ontology Object record')
  return {
    objectTypeId: objectTypeId(record['objectTypeId'], 'Ontology record Object Type id'),
    primaryKey: requireJson(record['primaryKey'], 'Ontology record primary key'),
    properties: requireJsonRecord(record['properties'], 'Ontology record properties'),
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}

function requireArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} is invalid`)
  return value
}

function requireId(value: unknown, name: string): string {
  const id = requireString(value, name)
  if (id.length === 0) throw new Error(`${name} is invalid`)
  return id
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function requireNonNegativeInteger(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} is invalid`)
  return value as number
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireString(value, name)
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} is invalid`)
  return timestamp
}

function requireJson(value: unknown, name: string): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new Error(`${name} is invalid`)
  return snapshot as JsonValue
}

function requireJsonRecord(value: unknown, name: string): Readonly<Record<string, JsonValue>> {
  const snapshot = requireJson(value, name)
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) throw new Error(`${name} is invalid`)
  return snapshot
}

function projectId(value: unknown, name: string): OntologyProjectId {
  return brandString<OntologyProjectId>(requireId(value, name))
}

function objectTypeId(value: unknown, name: string): OntologyObjectTypeId {
  return brandString<OntologyObjectTypeId>(requireId(value, name))
}

function propertyId(value: unknown, name: string): OntologyPropertyId {
  return brandString<OntologyPropertyId>(requireId(value, name))
}

function linkTypeId(value: unknown, name: string): OntologyLinkTypeId {
  return brandString<OntologyLinkTypeId>(requireId(value, name))
}

function actionTypeId(value: unknown, name: string): OntologyActionTypeId {
  return brandString<OntologyActionTypeId>(requireId(value, name))
}

function invocationId(value: unknown, name: string): OntologyInvocationId {
  return brandString<OntologyInvocationId>(requireId(value, name))
}
