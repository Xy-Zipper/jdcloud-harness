/** Session-addressed skill catalog and workspace installer Remote. */

import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
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
  SKILL_INSTALL_MAX_FILES,
  SKILL_INSTALL_MAX_FILE_BYTES,
  SKILL_INSTALL_MAX_TOTAL_BYTES,
  type SkillInstallFile,
  type SkillInstallInvalidReason,
  type SkillInstallRequest,
  type SkillInstallScope,
  type SkillInstallValue,
  type SkillDeleteRequest,
  type SkillDeleteValue,
  type SkillListRequest,
  type SkillListValue,
  type SkillManagedEntry,
  type SkillManagedScope,
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
  currentSkillAccess?(): Promise<SkillAccess | undefined>
}

interface SkillAccess {
  readonly userId: string
  readonly administrator: boolean
  readonly workspaceRoot: string
  readonly personalSkillDirectory: string
  readonly managedSkillDirectory: string
}

interface ParsedInstallSkill {
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
}

interface PreparedInstallFolder extends ParsedInstallSkill {
  readonly files: readonly PreparedInstallFile[]
}

interface PreparedInstallFile {
  readonly path: string
  readonly content: Uint8Array
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
    this.throwIfCancelled(signal, 'listing')
    const { sessionId } = request
    const owner = scopeOwner(this.ctx)
    if (owner !== undefined && !(await owner.owns('session', String(sessionId)))) {
      throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
    }
    const access = await owner?.currentSkillAccess?.()
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
      this.throwIfCancelled(signal, 'listing')
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
      const installScopes = allowedInstallScopes(owner, access)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
        installScopes,
        managedSkills: await listManagedSkills(this.ctx, access, installScopes, signal),
      }
    } catch (error: unknown) {
      this.throwIfCancelled(signal, 'listing')
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /**
   * Install one complete user-invocable Skill folder in the Session project's `.dsh/skills` directory.
   * @param request - Session identity and bounded folder files.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns installed metadata for optimistic catalog display.
   * @throws RemoteError when validation, ownership, containment, or the guarded create fails.
   */
  @Remote
  async create(request: SkillInstallRequest, signal: AbortSignal): Promise<SkillInstallValue> {
    this.throwIfCancelled(signal, 'installation')
    const owner = scopeOwner(this.ctx)
    if (owner !== undefined && !(await owner.owns('session', String(request.sessionId)))) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found`,
        { sessionId: request.sessionId },
      )
    }
    this.throwIfCancelled(signal, 'installation')

    const parsed = parseInstallFolder(request.files)
    const access = await owner?.currentSkillAccess?.()
    const scope = request.scope ?? (access === undefined ? 'project' : 'personal')
    if (!allowedInstallScopes(owner, access).includes(scope)) {
      throw new RemoteError('skill/forbidden', `skill install scope "${scope}" is not authorized`, { scope })
    }
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
    this.throwIfCancelled(signal, 'installation')

    const fs = this.ctx.fs
    const root = await installRoot(scope, cwd, access, fs, signal)
    const rootTarget = await fs.resolve(root.containmentRoot, { signal })
    const rootInfo = await fs.stat(rootTarget, signal)
    if (root.requireExistingDirectory && rootInfo?.type !== 'directory') {
      throw invalidSkill('project-cwd', 'the Skill install root is not a directory')
    }
    const canonicalRoot = fs.processPath(rootTarget)
    if (scope !== 'built-in') {
      try {
        await owner?.assertWorkspacePath(canonicalRoot)
      } catch (error: unknown) {
        throw new RemoteError(
          'skill/invalid',
          'the Skill install root is outside the current user workspace',
          { reason: 'path' },
          { cause: error },
        )
      }
    }

    const skillRoot = await fs.resolve(join(root.skillDirectory, parsed.name), { signal })
    if (!fs.contains(rootTarget, skillRoot)) {
      throw invalidSkill('path', 'the skill path leaves the selected Skill directory')
    }
    if (await fs.stat(skillRoot, signal) !== undefined) throw skillAlreadyExists(parsed.name)

    try {
      for (const file of parsed.files) {
        this.throwIfCancelled(signal, 'installation')
        const target = await fs.resolve(join(fs.processPath(skillRoot), ...file.path.split('/')), { signal })
        if (!fs.contains(skillRoot, target)) throw invalidSkill('path', 'a skill file path leaves the skill directory')
        await fs.writeBytes(
          target,
          file.content,
          { kind: 'createIfAbsent' },
          signal,
          scope === 'built-in'
            ? { mode: 'danger-full-access', workspaceRoot: canonicalRoot, sessionId: request.sessionId }
            : { mode: 'workspace-write', workspaceRoot: canonicalRoot, sessionId: request.sessionId },
        )
      }
    } catch (error: unknown) {
      this.throwIfCancelled(signal, 'installation')
      if (error instanceof FsError && error.code === 'FS_NOT_OBSERVED') {
        throw skillAlreadyExists(parsed.name, error)
      }
      if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED') {
        throw new RemoteError(
          'skill/invalid',
          'the selected Skill directory is not writable',
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
        path: fs.processPath(await fs.resolve(join(fs.processPath(skillRoot), 'SKILL.md'), { signal })),
      },
    }
  }

  /**
   * Delete one personal Skill, or one shared Skill when the current user is an administrator.
   * @param request - Session owner, account scope, and validated Skill name.
   * @param signal - caller cancellation checked before the irreversible removal.
   * @returns deletion confirmation after the complete Skill folder is absent.
   * @throws RemoteError when authentication, authorization, ownership, or the target folder check fails.
   */
  @Remote('delete')
  async delete(request: SkillDeleteRequest, signal: AbortSignal): Promise<SkillDeleteValue> {
    this.throwIfCancelled(signal, 'deletion')
    const owner = scopeOwner(this.ctx)
    if (owner === undefined || !(await owner.owns('session', String(request.sessionId)))) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found`,
        { sessionId: request.sessionId },
      )
    }
    if (!isSkillName(request.name)) throw invalidSkill('name', 'skill name must use lowercase kebab-case')
    const access = await owner.currentSkillAccess?.()
    if (access === undefined || !allowedInstallScopes(owner, access).includes(request.scope)) {
      throw new RemoteError(
        'skill/forbidden',
        `skill delete scope "${request.scope}" is not authorized`,
        { scope: request.scope },
      )
    }
    this.throwIfCancelled(signal, 'deletion')
    const root = managedSkillRoot(access, request.scope)
    let canonicalRoot: string
    let target: string
    try {
      canonicalRoot = await realpath(root)
      const requested = join(canonicalRoot, request.name)
      const info = await lstat(requested)
      if (!info.isDirectory() || info.isSymbolicLink()) throw skillNotFound(request.scope, request.name)
      target = await realpath(requested)
    } catch (error: unknown) {
      if (isNodeErrorCode(error, 'ENOENT')) throw skillNotFound(request.scope, request.name)
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', `skill deletion failed: ${String(error)}`, {}, { cause: error })
    }
    if (dirname(target) !== canonicalRoot) throw invalidSkill('path', 'the Skill folder leaves its managed directory')
    this.throwIfCancelled(signal, 'deletion')
    try {
      await rm(target, { recursive: true, force: false })
    } catch (error: unknown) {
      if (isNodeErrorCode(error, 'ENOENT')) throw skillNotFound(request.scope, request.name)
      throw new RemoteError('gateway/internal', `skill deletion failed: ${String(error)}`, {}, { cause: error })
    }
    return { deleted: true, scope: request.scope, name: request.name }
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

  /** Reject a cancelled catalog operation with the transport's stable cancellation code. */
  private throwIfCancelled(
    signal: AbortSignal,
    operation: 'listing' | 'installation' | 'deletion',
  ): void {
    if (signal.aborted) {
      throw new RemoteError('gateway/cancelled', `skill ${operation} was aborted`, {})
    }
  }
}

interface InstallRoot {
  readonly containmentRoot: string
  readonly skillDirectory: string
  readonly requireExistingDirectory: boolean
}

/** Read the account-owned Skill folders that the current user may remove. */
async function listManagedSkills(
  ctx: Context,
  access: SkillAccess | undefined,
  installScopes: readonly SkillInstallScope[],
  signal: AbortSignal,
): Promise<SkillManagedEntry[]> {
  if (access === undefined) return []
  const scopes = installScopes.filter((scope): scope is SkillManagedScope => scope !== 'project')
  const skills: SkillManagedEntry[] = []
  for (const scope of scopes) {
    signal.throwIfAborted()
    const root = managedSkillRoot(access, scope)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      if (isNodeErrorCode(error, 'ENOENT')) continue
      throw error
    }
    for (const entry of entries) {
      signal.throwIfAborted()
      if (!entry.isDirectory() || !isSkillName(entry.name)) continue
      const path = join(root, entry.name, 'SKILL.md')
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.size > SKILL_INSTALL_MAX_BYTES) continue
        const parsed = parseInstallSkill(await readFile(path, { encoding: 'utf8', signal }))
        if (parsed.name !== entry.name) continue
        skills.push({ ...parsed, path, scope })
      } catch (error: unknown) {
        if (!isNodeErrorCode(error, 'ENOENT')) {
          ctx.logger.warn(`managed skill ${path} ignored: ${String(error)}`)
        }
      }
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

/** Select the authenticated account directory for one removable Skill scope. */
function managedSkillRoot(access: SkillAccess, scope: SkillManagedScope): string {
  return scope === 'personal' ? access.personalSkillDirectory : access.managedSkillDirectory
}

/** Select the persistent root authorized for one project, user, or shared Skill install. */
async function installRoot(
  scope: SkillInstallScope,
  cwd: string,
  access: SkillAccess | undefined,
  fs: FileSystem,
  signal: AbortSignal,
): Promise<InstallRoot> {
  if (scope === 'project') {
    const containmentRoot = await findProjectRoot(cwd, fs, signal)
    return {
      containmentRoot,
      skillDirectory: join(containmentRoot, '.dsh', 'skills'),
      requireExistingDirectory: true,
    }
  }
  if (access === undefined) {
    throw new RemoteError('skill/forbidden', 'authenticated Skill access is unavailable', { scope })
  }
  return scope === 'personal'
    ? {
      containmentRoot: access.workspaceRoot,
      skillDirectory: access.personalSkillDirectory,
      requireExistingDirectory: true,
    }
    : {
      containmentRoot: access.managedSkillDirectory,
      skillDirectory: access.managedSkillDirectory,
      requireExistingDirectory: false,
    }
}

/** Return the install targets exposed to the current authenticated user. */
function allowedInstallScopes(
  owner: ScopeOwner | undefined,
  access: SkillAccess | undefined,
): readonly SkillInstallScope[] {
  if (owner?.currentSkillAccess === undefined) return ['project']
  if (access === undefined) return []
  return access.administrator ? ['personal', 'built-in'] : ['personal']
}

/** Resolve the active authentication controller without coupling Skill management to one login product. */
function scopeOwner(ctx: Context): ScopeOwner | undefined {
  const getService = ctx.get.bind(ctx) as (name: string) => object | undefined
  const candidate = getService('ontologyAuthController') ?? getService('jdcloudAuthController')
  if (candidate === undefined
    || typeof Reflect.get(candidate, 'owns') !== 'function'
    || typeof Reflect.get(candidate, 'assertWorkspacePath') !== 'function') return undefined
  return candidate as ScopeOwner
}

function invalidSkill(reason: SkillInstallInvalidReason, message: string): RemoteError {
  return new RemoteError('skill/invalid', message, { reason })
}

/** Build the stable refusal returned when an installed skill directory already exists. */
function skillAlreadyExists(name: string, cause?: unknown): RemoteError {
  return new RemoteError(
    'skill/already-exists',
    `skill "${name}" already exists`,
    { name },
    cause === undefined ? undefined : { cause },
  )
}

/** Build the stable refusal returned when a managed Skill folder is absent. */
function skillNotFound(scope: SkillManagedScope, name: string): RemoteError {
  return new RemoteError('skill/not-found', `skill "${name}" was not found in scope "${scope}"`, { scope, name })
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === code
}

/** Validate one browser-selected folder and decode its required root SKILL.md. */
function parseInstallFolder(files: readonly SkillInstallFile[]): PreparedInstallFolder {
  if (files.length === 0) throw invalidSkill('empty-folder', 'the selected skill folder is empty')
  if (files.length > SKILL_INSTALL_MAX_FILES) {
    throw invalidSkill('too-many-files', `a skill folder may contain at most ${SKILL_INSTALL_MAX_FILES} files`)
  }
  const paths = new Set<string>()
  let totalBytes = 0
  let skillFile: PreparedInstallFile | undefined
  const decodedFiles: PreparedInstallFile[] = []
  for (const file of files) {
    if (!isInstallFilePath(file.path)) {
      throw invalidSkill('invalid-file-path', `invalid skill file path: ${JSON.stringify(file.path)}`)
    }
    const collisionKey = file.path.toLocaleLowerCase('en-US')
    if (paths.has(collisionKey)) {
      throw invalidSkill('invalid-file-path', `duplicate skill file path: ${JSON.stringify(file.path)}`)
    }
    paths.add(collisionKey)
    const content = decodeInstallFile(file)
    if (content.byteLength > SKILL_INSTALL_MAX_FILE_BYTES) {
      throw invalidSkill('file-too-large', `skill file "${file.path}" exceeds ${SKILL_INSTALL_MAX_FILE_BYTES} bytes`)
    }
    totalBytes += content.byteLength
    if (totalBytes > SKILL_INSTALL_MAX_TOTAL_BYTES) {
      throw invalidSkill('folder-too-large', `skill folder exceeds ${SKILL_INSTALL_MAX_TOTAL_BYTES} bytes`)
    }
    const decoded = { path: file.path, content }
    decodedFiles.push(decoded)
    if (file.path === 'SKILL.md') skillFile = decoded
  }
  if (skillFile === undefined) throw invalidSkill('missing-skill-file', 'the skill folder root requires SKILL.md')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(skillFile.content)
  } catch (error: unknown) {
    throw new RemoteError(
      'skill/invalid',
      'SKILL.md must contain valid UTF-8 text',
      { reason: 'skill-file-not-text' },
      { cause: error },
    )
  }
  const parsed = parseInstallSkill(content)
  // Publish SKILL.md last so an interrupted copy is not discovered as an installed skill.
  const ordered = decodedFiles.sort((left, right) => {
    if (left.path === 'SKILL.md') return 1
    if (right.path === 'SKILL.md') return -1
    return left.path.localeCompare(right.path)
  })
  return { ...parsed, files: ordered }
}

/** Decode the canonical padded Base64 carried by the JSON Remote request. */
function decodeInstallFile(file: SkillInstallFile): Uint8Array {
  const encoded = file.contentBase64
  const maxEncodedLength = Math.ceil(SKILL_INSTALL_MAX_FILE_BYTES / 3) * 4
  if (encoded.length > maxEncodedLength) {
    throw invalidSkill('file-too-large', `skill file "${file.path}" exceeds ${SKILL_INSTALL_MAX_FILE_BYTES} bytes`)
  }
  if (encoded.length % 4 !== 0) {
    throw invalidSkill('invalid-file-content', `skill file "${file.path}" is not canonical Base64`)
  }
  const content = Buffer.from(encoded, 'base64')
  if (content.toString('base64') !== encoded) {
    throw invalidSkill('invalid-file-content', `skill file "${file.path}" is not canonical Base64`)
  }
  return content
}

/** Accept only normalized slash-separated paths below the selected folder root. */
function isInstallFilePath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) return false
  return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
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
