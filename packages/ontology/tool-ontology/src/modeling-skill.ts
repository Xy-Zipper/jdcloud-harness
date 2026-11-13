/** Packaged ontology-modeler instructions shared by user and model Skill invocations. */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const SKILL_NAME = 'ontology-modeler'
const SKILL_PROVIDER = 'ontology-modeler-bundled'

function parseSkill(raw: string): { description: string; content: string } {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (header?.[1] === undefined) throw new Error('ontology-modeler: SKILL.md has no YAML frontmatter')
  const metadata: unknown = parseYaml(header[1])
  if (typeof metadata !== 'object' || metadata === null
    || !('name' in metadata) || metadata.name !== SKILL_NAME
    || !('description' in metadata) || typeof metadata.description !== 'string'
    || metadata.description.length === 0) {
    throw new Error('ontology-modeler: SKILL.md requires its name and description')
  }
  return { description: metadata.description, content: raw.slice(header[0].length).trim() }
}

/**
 * Contribute the packaged modeling Skill when the host supplies a Skill registry.
 * @param ctx - Ontology tool plugin context owning the reversible provider.
 */
export function installModelingSkill(ctx: Context): void {
  ctx.inject(['skills'], (skillCtx) => {
    const path = fileURLToPath(new URL('../assets/ontology-modeler/SKILL.md', import.meta.url))
    const { description } = parseSkill(readFileSync(path, 'utf8'))
    const candidate: SkillCandidate = {
      name: SKILL_NAME,
      path,
      description,
      provider: SKILL_PROVIDER,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: dirname(path) },
      locator: path,
    }
    skillCtx.skills.registerProvider(() => ({
      name: SKILL_PROVIDER,
      list: () => Promise.resolve([candidate]),
      async get(_candidate, options) {
        const { rank: _rank, locator: _locator, ...summary } = candidate
        const raw = await readFile(path, { encoding: 'utf8', signal: options.signal })
        return { ...summary, content: parseSkill(raw).content }
      },
    }))
  })
}
