/** Browser-safe request and result vocabulary for Ontology Runtime authentication. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'ontology/auth-required': { readonly reason: 'missing' | 'expired' }
    'ontology/auth-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/session-import-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/validation-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/logout-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/administrator-required': { readonly capability: 'danger-full-access' }
    'ontology/external-project-forbidden': { readonly projectId: string }
  }
}

/** Account kinds returned by the Ontology Runtime identity API. */
export type OntologyAccountType = 'admin' | 'member'

/** Stable Ontology identity resolved from one Runtime Session. */
export interface OntologyRuntimeIdentity {
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly accountType: OntologyAccountType
  readonly authorizationVersion: string
}

/** Password-login request sent from the browser to the Host. */
export interface OntologyLoginRequest {
  readonly username: string
  readonly password: string
}

/** Project selected by an authenticated management page for draft modeling. */
export interface OntologyModelingContext {
  readonly projectId: string
  readonly projectName: string
  readonly mode: 'modeling'
}

/** Project selected for published business queries in the full assistant. */
export interface OntologyRuntimeContext {
  readonly projectId: string
  readonly projectName: string
  readonly mode: 'runtime'
}

/** Management selection shared by the full assistant and draft-modeling assistant. */
export type OntologyProjectContext = OntologyModelingContext | OntologyRuntimeContext

/** Runtime tokens transferred from an authenticated Ontology management page. */
export interface OntologyRuntimeSessionTransfer {
  readonly accessToken: string
  readonly accessTokenExpiresAt: string
  readonly refreshToken: string
  readonly refreshTokenExpiresAt: string
  readonly user: OntologyRuntimeIdentity
  readonly context?: OntologyProjectContext
}

/** Host-only request to one fixed Ontology Runtime endpoint. */
export interface OntologyAuthenticatedRequest {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: `/api/runtime/${string}`
  readonly body?: Readonly<Record<string, unknown>>
}

/** Redacted authentication state returned to the browser. */
export type OntologyAuthStatus =
  | {
    readonly authenticated: false
    readonly baseUrl: string
  }
  | {
    readonly authenticated: true
    readonly baseUrl: string
    readonly user: OntologyRuntimeIdentity
    readonly context?: OntologyProjectContext
  }

/** A validated import can keep the browser's selected conversation within its previous scope. */
export type OntologyRuntimeSessionImport = Extract<OntologyAuthStatus, { readonly authenticated: true }> & {
  readonly preserveSelection: boolean
}

/** Wire name for the Ontology RAGFlow search tool and its durable citation presentation. */
export const ONTOLOGY_KNOWLEDGE_TOOL = 'ontology_search_knowledge'

/** An authorized excerpt with the same dataset and document keys used in Ontology slice datasets. */
export interface OntologyKnowledgeSource {
  readonly citationId: string
  readonly projectId: string
  readonly fileId: string
  readonly fileName: string
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly chunkId: string
  readonly mediaType: string
  readonly nodeIds: readonly string[]
  readonly text: string
  readonly page?: number
}

/**
 * Validate a source array from Runtime or stored tool presentation data.
 * @param value - Untrusted JSON array.
 * @returns Parsed citations, or undefined when the payload cannot be interpreted.
 */
export function readOntologyKnowledgeSources(value: unknown): OntologyKnowledgeSource[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined
  const sources: OntologyKnowledgeSource[] = []
  const id = (text: unknown): text is string => typeof text === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(text)
  for (const item of value) {
    const source: unknown = item
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
    const { citationId, projectId, fileId, fileName, knowledgeBaseId, documentId, chunkId, mediaType, nodeIds, text, page } =
      source as Record<string, unknown>
    if (!id(citationId) || !/^R-[a-f0-9]{10}$/u.test(citationId)
      || !id(projectId) || !id(fileId) || !id(knowledgeBaseId) || !id(documentId)
      || typeof chunkId !== 'string' || chunkId === ''
      || typeof fileName !== 'string' || typeof mediaType !== 'string' || typeof text !== 'string'
      || !Array.isArray(nodeIds) || !nodeIds.every(id)
      || (page !== undefined && (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1))) return undefined
    sources.push({ citationId, projectId, fileId, fileName, knowledgeBaseId, documentId, chunkId, mediaType, nodeIds, text,
      ...(page === undefined ? {} : { page }) })
  }
  return sources
}
