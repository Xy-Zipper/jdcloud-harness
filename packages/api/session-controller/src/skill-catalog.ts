/** Session-addressed skill catalog and workspace installer Remote. */

import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { parse as parseYaml } from 'yaml'
import {
  SKILL_INSTALL_MAX_BYTES,
  type SkillInstallInvalidReason,
  type SkillInstallRequest,
  type SkillInstallValue,
  type SkillListRequest,
  type SkillListValue,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

interface ScopeOwner {
  owns(kind: 'session' | 'workspace', id: string): Promise<boolean>
  assertWorkspacePath(path: string): Promise<void>
}

interface ParsedInstallSkill {
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'fs', 'sessionQuery', 'typert']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    void signal
    const { sessionId } = request
    let cwd: string | undefined
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.header.cwd
      agentPreset = observation.projections.values.agentPreset ?? undefined
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }
    if (cwd === undefined) {
      throw new RemoteError('gateway/internal', `session "${sessionId}" has no project cwd`, {})
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    await using lease = live === undefined ? await this.scopeFor(agentPreset) : undefined
    const scope = live ?? lease?.key
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /**
   * Install one user-invocable SKILL.md in the Session project's `.dsh/skills` directory.
   * @param request - Session identity and complete UTF-8 Markdown document.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns installed metadata for optimistic catalog display.
   * @throws RemoteError when validation, ownership, containment, or the guarded create fails.
   */
  @Remote
  async create(request: SkillInstallRequest, signal: AbortSignal): Promise<SkillInstallValue> {
    this.throwIfCancelled(signal)
    const owner = this.ctx.get('ontologyAuthController') as ScopeOwner | undefined
    if (owner !== undefined && !(await owner.owns('session', String(request.sessionId)))) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found`,
        { sessionId: request.sessionId },
      )
    }
    this.throwIfCancelled(signal)

    const parsed = parseInstallSkill(request.content)
    let cwd: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(request.sessionId)
      cwd = observation.header.cwd
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError(
          'session/not-found',
          `session "${request.sessionId}" not found`,
          { sessionId: request.sessionId },
        )
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${request.sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }
    if (cwd === undefined) throw invalidSkill('project-cwd', 'the Session has no project cwd')
    this.throwIfCancelled(signal)

    const fs = this.ctx.fs
    const projectRoot = await findProjectRoot(cwd, fs, signal)
    const rootTarget = await fs.resolve(projectRoot, { signal })
    const rootInfo = await fs.stat(rootTarget, signal)
    if (rootInfo?.type !== 'directory') {
      throw invalidSkill('project-cwd', 'the Session project cwd is not a directory')
    }
    const canonicalRoot = fs.processPath(rootTarget)
    try {
      await owner?.assertWorkspacePath(canonicalRoot)
    } catch (error: unknown) {
      throw new RemoteError(
        'skill/invalid',
        'the Session project is outside the current user workspace',
        { reason: 'path' },
        { cause: error },
      )
    }

    const target = await fs.resolve(
      join(canonicalRoot, '.dsh', 'skills', parsed.name, 'SKILL.md'),
      { signal },
    )
    if (!fs.contains(rootTarget, target)) {
      throw invalidSkill('path', 'the skill path leaves the Session project')
    }

    try {
      await fs.writeText(
        target,
        request.content,
        { kind: 'createIfAbsent' },
        signal,
        { mode: 'workspace-write', workspaceRoot: canonicalRoot, sessionId: request.sessionId },
      )
    } catch (error: unknown) {
      this.throwIfCancelled(signal)
      if (error instanceof FsError && error.code === 'FS_NOT_OBSERVED') {
        throw new RemoteError(
          'skill/already-exists',
          `skill "${parsed.name}" already exists`,
          { name: parsed.name },
          { cause: error },
        )
      }
      if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED') {
        throw new RemoteError(
          'skill/invalid',
          'the skill path is not writable inside the Session project',
          { reason: 'path' },
          { cause: error },
        )
      }
      throw new RemoteError('gateway/internal', `skill installation failed: ${String(error)}`, {}, { cause: error })
    }

    return {
      skill: {
        name: parsed.name,
        description: parsed.description,
        modelInvocable: parsed.modelInvocable,
        path: fs.processPath(target),
      },
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    agentPreset: string | undefined,
  ): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.acquireScope(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }

  /** Reject a cancelled install with the transport's stable cancellation code. */
  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new RemoteError('gateway/cancelled', 'skill installation was aborted', {})
    }
  }
}

function invalidSkill(reason: SkillInstallInvalidReason, message: string): RemoteError {
  return new RemoteError('skill/invalid', message, { reason })
}

/** Parse and validate the metadata needed by the human-facing installer. */
function parseInstallSkill(content: string): ParsedInstallSkill {
  if (Buffer.byteLength(content, 'utf8') > SKILL_INSTALL_MAX_BYTES) {
    throw invalidSkill('content-too-large', `SKILL.md exceeds ${SKILL_INSTALL_MAX_BYTES} UTF-8 bytes`)
  }
  const parsed = parseFrontmatter(content)
  if (parsed === undefined) throw invalidSkill('frontmatter', 'SKILL.md requires YAML frontmatter')
  const name = stringField(parsed, 'name')
  if (name === undefined || !isSkillName(name)) {
    throw invalidSkill('name', 'skill name must use lowercase kebab-case')
  }
  const description = stringField(parsed, 'description')
  if (description === undefined || description.trim().length === 0) {
    throw invalidSkill('description', 'skill description is required')
  }
  let userInvocable: boolean | undefined
  let disableModelInvocation: boolean | undefined
  try {
    userInvocable = frontmatterBoolean(parsed, 'user-invocable')
    disableModelInvocation = frontmatterBoolean(parsed, 'disable-model-invocation')
  } catch (error: unknown) {
    throw new RemoteError(
      'skill/invalid',
      `SKILL.md invocation metadata is invalid: ${String(error)}`,
      { reason: 'frontmatter' },
      { cause: error },
    )
  }
  if (userInvocable === false) {
    throw invalidSkill('user-invocable', 'workspace imports must remain user-invocable')
  }
  return { name, description, modelInvocable: disableModelInvocation !== true }
}

/** Read the YAML object between the opening and closing frontmatter markers. */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const firstLineEnd = content.indexOf('\n')
  if (firstLineEnd < 0 || content.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= content.length) {
    const nextNewline = content.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? content.length : nextNewline
    if (content.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      let value: unknown
      try {
        value = parseYaml(content.slice(firstLineEnd + 1, lineStart))
      } catch (error: unknown) {
        throw new RemoteError(
          'skill/invalid',
          `SKILL.md frontmatter is invalid YAML: ${String(error)}`,
          { reason: 'frontmatter' },
          { cause: error },
        )
      }
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/** Match the filesystem skill provider's nearest-`.git` project-root rule. */
async function findProjectRoot(cwd: string, fs: FileSystem, signal: AbortSignal): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    signal.throwIfAborted()
    const marker = await fs.resolve(join(current, '.git'), { signal })
    if (await fs.stat(marker, signal) !== undefined) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

export default SessionSkillCatalog
