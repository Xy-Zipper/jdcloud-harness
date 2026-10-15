/** Typed Ontology Runtime values exposed by the model-facing tools. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable published Project identifier. */
export type OntologyProjectId = Branded<'OntologyProjectId'>

/** Stable published Object Type identifier. */
export type OntologyObjectTypeId = Branded<'OntologyObjectTypeId'>

/** Stable published Property identifier. */
export type OntologyPropertyId = Branded<'OntologyPropertyId'>

/** Stable published Link Type identifier. */
export type OntologyLinkTypeId = Branded<'OntologyLinkTypeId'>

/** Stable published Action Type identifier. */
export type OntologyActionTypeId = Branded<'OntologyActionTypeId'>

/** Opaque one-use Action Invocation identifier. */
export type OntologyInvocationId = Branded<'OntologyInvocationId'>

/** Published Project summary visible to the current Runtime user. */
export interface OntologyProjectSummary {
  readonly id: OntologyProjectId
  readonly name: string
  readonly description: string
  readonly releaseVersion: string
}

/** Published Property summary used for discovery and result maps. */
export interface OntologyPropertySummary {
  readonly id: OntologyPropertyId
  readonly label: string
  readonly type: string
  readonly sourceField: string
}

/** Published Object Type summary. */
export interface OntologyObjectSummary {
  readonly id: OntologyObjectTypeId
  readonly label: string
  readonly description: string
  readonly primaryKey: OntologyPropertySummary
}

/** Published Action summary after Runtime authorization filtering. */
export interface OntologyActionSummary {
  readonly id: OntologyActionTypeId
  readonly label: string
  readonly description: string
  readonly kind: string
  readonly operation: string
  readonly effect: string
  readonly targetType?: OntologyObjectTypeId
  readonly requiresConfirmation: boolean
}

/** One caller-supplied parameter accepted by a published Action. */
export interface OntologyActionParameterSummary {
  readonly label: string
  readonly inputName: string
  readonly required: boolean
  readonly description: string
  readonly type: string
  readonly targetProperty: OntologyPropertyId
}

/** Published Action detail with exact required and optional caller inputs. */
export interface OntologyActionDetail extends OntologyActionSummary {
  readonly parameters: readonly OntologyActionParameterSummary[]
}

/** One published Object record keyed by Ontology Property ids. */
export interface OntologyObjectRecord {
  readonly objectTypeId: OntologyObjectTypeId
  readonly primaryKey: JsonValue
  readonly properties: Readonly<Record<string, JsonValue>>
}

/** Preview returned by Action preparation. */
export interface OntologyPreparedAction {
  readonly invocationId: OntologyInvocationId
  readonly expiresAt: string
  readonly requiresConfirmation: boolean
  readonly summary: string
  readonly affectedObjects: readonly {
    readonly objectTypeId: OntologyObjectTypeId
    readonly primaryKey?: JsonValue
  }[]
}
