/** Validated, credential-free draft definitions returned to the modeling tools. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

type JsonRecord = Readonly<Record<string, JsonValue>>

/**
 * Project one authenticated draft response without connection references or executor internals.
 * @param value - Untrusted Runtime draft response.
 * @param projectId - Exact Project addressed by the tool.
 * @param added - Require the counts returned by an additive write.
 * @returns Validated Project metadata, draft definitions, trusted executor metadata, and optional counts.
 */
export function readDraftResult(value: unknown, projectId: string, added = false): JsonRecord {
  const response = record(value, 'draft response')
  const project = record(response['project'], 'draft Project')
  if (text(project, 'id') !== projectId) invalid('draft Project id')
  const updatedAt = text(project, 'updatedAt')
  if (!Number.isFinite(Date.parse(updatedAt))) invalid('draft revision')
  const draft = record(response['draft'], 'draft')
  const result: Record<string, JsonValue> = {
    project: {
      ...strings(project, ['id', 'name', 'description']),
      updatedAt,
      publishedVersion: count(project['publishedVersion'], 'published version'),
      status: choice(project, 'status', ['active', 'disabled']),
    },
    draft: {
      dataSources: list(draft, 'dataSources', source => ({
        ...strings(source, ['id', 'label', 'description', 'kind']),
        enabled: flag(source, 'enabled'),
        readOnly: flag(source, 'readOnly'),
      })),
      objectTypes: list(draft, 'objectTypes', object => ({
        ...strings(object, [
          'id', 'label', 'description', 'dataSourceId', 'resourceKind',
          'resourceRef', 'primaryKey', 'versionProperty',
        ]),
        properties: list(object, 'properties', property),
      })),
      linkTypes: list(draft, 'linkTypes', link => ({
        ...strings(link, ['id', 'label', 'description', 'sourceType', 'targetType', 'sourceProperty', 'targetProperty']),
        cardinality: choice(link, 'cardinality', ['one-to-one', 'one-to-many', 'many-to-one']),
      })),
      actionTypes: list(draft, 'actionTypes', action => ({
        ...strings(action, ['id', 'label', 'description', 'targetType', 'executorRef']),
        kind: choice(action, 'kind', ['object', 'function']),
        operation: choice(action, 'operation', ['create', 'update', 'upsert', 'delete', 'invoke']),
        effect: choice(action, 'effect', ['read', 'write']),
        requiresConfirmation: flag(action, 'requiresConfirmation'),
        mappings: list(action, 'mappings', mapping => ({
          ...strings(mapping, ['targetProperty', 'inputName']),
          ...mapping['source'] === undefined ? {} : { source: choice(mapping, 'source', ['parameter', 'constant', 'formula']) },
          ...mapping['formula'] === undefined ? {} : { formula: text(mapping, 'formula') },
          ...mapping['constantValue'] === undefined ? {} : { constantValue: json(mapping['constantValue'], 'mapping constant') },
          required: flag(mapping, 'required'),
        })),
      })),
    },
    executors: list(response, 'executors', executor => ({
      ...strings(executor, ['key', 'label', 'description', 'kind']),
      effect: choice(executor, 'effect', ['read', 'write']),
    })),
  }
  if (added) {
    const counts = record(response['added'], 'added draft counts')
    result['added'] = Object.fromEntries(
      ['objectTypes', 'properties', 'linkTypes', 'actionTypes'].map(key => [key, count(counts[key], key)]),
    )
  }
  return result
}

/**
 * Validate credential-free discovery against the addressed Project-local source.
 * @param value - Runtime resource or field inspection response.
 * @param sourceId - Exact source addressed by the tool.
 * @param resourceRef - Optional exact resource addressed by field inspection.
 * @returns Only normalized resources or fields, without connection settings.
 */
export function readDataSourceInspection(value: unknown, sourceId: string, resourceRef?: string): JsonRecord {
  const response = record(value, 'data source inspection')
  if (text(response, 'dataSourceId') !== sourceId) invalid('data source id')
  if (resourceRef === undefined || resourceRef === '') {
    return { dataSourceId: sourceId, resources: list(response, 'resources', item => strings(item, ['ref', 'label', 'kind'])) }
  }
  const resource = record(response['resource'], 'resource')
  if (text(resource, 'ref') !== resourceRef) invalid('resource reference')
  return {
    dataSourceId: sourceId,
    resource: strings(resource, ['ref', 'label', 'kind']),
    fields: list(response, 'fields', field => ({
      ...strings(field, ['name', 'label', 'type']), required: flag(field, 'required'),
    })),
  }
}

/**
 * Preserve the saved draft and the Runtime-confirmed binding update counts.
 * @param value - Runtime binding update response.
 * @param projectId - Exact Project addressed by the tool.
 * @returns Public draft definitions and the confirmed number of updated bindings.
 */
export function readDraftBindingResult(value: unknown, projectId: string): JsonRecord {
  const response = record(value, 'binding update')
  const updated = record(response['updated'], 'updated bindings')
  return {
    ...readDraftResult(value, projectId),
    updated: {
      objectTypes: count(updated['objectTypes'], 'updated Objects'),
      properties: count(updated['properties'], 'updated Properties'),
      linkTypes: count(updated['linkTypes'], 'updated Links'),
    },
  }
}

function property(value: Record<string, unknown>): JsonRecord {
  return {
    ...strings(value, ['id', 'label', 'description', 'sourceField']),
    type: choice(value, 'type', ['string', 'number', 'boolean', 'date', 'datetime', 'user', 'object']),
    required: flag(value, 'required'),
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(name)
  return value as Record<string, unknown>
}

function text(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') invalid(key)
  return field
}

function strings(value: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map(key => [key, text(value, key)]))
}

function flag(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') invalid(key)
  return field
}

function choice(value: Record<string, unknown>, key: string, choices: readonly string[]): string {
  const field = text(value, key)
  if (!choices.includes(field)) invalid(key)
  return field
}

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(name)
  return value
}

function list(
  value: Record<string, unknown>,
  key: string,
  read: (item: Record<string, unknown>) => JsonRecord,
): JsonRecord[] {
  const field = value[key]
  if (!Array.isArray(field)) invalid(key)
  return field.map(item => read(record(item, key)))
}

function json(value: unknown, name: string): JsonValue {
  const result = snapshotJsonValue(value)
  if (result === undefined) invalid(name)
  return result as JsonValue
}

function invalid(name: string): never {
  throw new HarnessError(`Ontology ${name} is invalid`, 'ONTOLOGY_RUNTIME_INVALID_RESPONSE')
}
