/** Browser calls through the authenticated same-origin knowledge proxy. */

import { readOntologyKnowledgeSources, type OntologyKnowledgeSource } from '@deepseek-ai/dsh-api-ontology-auth-controller/types'

/** Draft and published settings for a dedicated knowledge Skill. */
export interface KnowledgeSkillConfig {
  readonly name: string
  readonly instructions: string
  readonly datasetIds: readonly string[]
}

/** Administrative Skill record. */
export interface KnowledgeSkill {
  readonly id: string
  readonly projectId: string
  readonly draft: KnowledgeSkillConfig
  readonly revision: number
  readonly version: number
  readonly published?: KnowledgeSkillConfig
  readonly delivery?: SkillDelivery
}

/** The external entry settings returned to an authorized administrator. */
export interface SkillDelivery {
  readonly embedToken?: string
  readonly apiKeys?: readonly SkillAPIKey[]
}

/** Display-only API key metadata for one published Skill. */
export interface SkillAPIKey {
  readonly id: string
  readonly preview: string
  readonly createdAt: string | null
}

/** A change to one of the published Skill's independent credentials. */
export type SkillDeliveryAction = 'enable-embed' | 'disable-embed' | 'issue-key' | 'revoke-key'

/** Updated delivery settings and the one-time value of any newly issued server key. */
export interface SkillDeliveryUpdate {
  readonly delivery: SkillDelivery
  readonly apiKey?: string
  readonly apiKeyId?: string
}

/** Project or knowledge-base option returned by the server. */
export interface KnowledgeOption { readonly id: string; readonly name: string }

/** Choices available to the administrator for one Skill. */
export interface KnowledgeCatalog {
  readonly projects: readonly KnowledgeOption[]
  readonly datasets: readonly KnowledgeOption[]
}

/**
 * Read one response from the browser's fixed knowledge proxy.
 * @param path - Knowledge route inside Harness.
 * @param signal - View or action lifetime.
 * @param body - Optional JSON mutation or question.
 * @param method - Explicit DELETE for removing a draft or release.
 * @returns The authorized response body.
 */
export async function knowledgeRequest(path: string, signal: AbortSignal, body?: object, method?: 'DELETE'): Promise<Response> {
  const response = await fetch(new URL(`api/ontology-knowledge/${path}`, document.baseURI),
    body === undefined ? { signal, ...(method === undefined ? {} : { method }) } : {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => undefined)
    const message: unknown = failure === null || typeof failure !== 'object' ? undefined : Reflect.get(failure, 'message')
    throw new Error(typeof message === 'string' ? message : '')
  }
  return response
}

/** Published answer with the exact sources selected by the model. */
export interface KnowledgeReply {
  readonly answer: string
  readonly sources: readonly OntologyKnowledgeSource[]
}

/**
 * Read the authenticated answer without treating excerpt text as HTML.
 * @param id - Published Skill selected by the current page.
 * @param question - User question.
 * @param signal - View lifetime.
 * @returns Plain answer and validated sources.
 */
export async function askKnowledge(id: string, question: string, signal: AbortSignal): Promise<KnowledgeReply> {
  const value: unknown = await (await knowledgeRequest(`skills/${id}/ask`, signal, { question })).json()
  if (typeof value !== 'object' || value === null) throw new Error()
  const answer: unknown = Reflect.get(value, 'answer')
  const sources = readOntologyKnowledgeSources(Reflect.get(value, 'sources'))
  if (typeof answer !== 'string' || sources === undefined) throw new Error()
  return { answer, sources }
}
