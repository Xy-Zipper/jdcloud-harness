import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'
import {
  SKILL_INSTALL_MAX_BYTES,
  SKILL_INSTALL_MAX_FILES,
  SKILL_INSTALL_MAX_FILE_BYTES,
  SKILL_INSTALL_MAX_TOTAL_BYTES,
  type SkillInstallFile,
} from '../src/types.ts'

function observation(
  sessionId: SessionId,
  options: { readonly cwd?: string; readonly workingDirectory?: string | null; readonly agentPreset?: string } = {},
): SessionObservation {
  const events = Object.freeze([])
  const lease = (): SessionObservation => ({
    source: 'live',
    header: {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
    },
    events,
    inheritedEventCount: SessionLogOffset(0),
    cursor: -1,
    projections: {
      asOfSeq: -1,
      values: {
        ...options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
        ...options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory },
      },
    },
    retain: lease,
    [Symbol.dispose]: () => {},
  })
  return lease()
}

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  provideWorkingDirectoryFixture(ctx, '/catalog/default')
  return ctx
}

function skillDocument(
  name = 'workspace-helper',
  description = 'Guide work in this project.',
  metadata = '',
): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${metadata}---\n\nFollow the project workflow.\n`
}

/** Encode one root SKILL.md plus optional folder files for the install Remote. */
function skillFiles(content = skillDocument(), extras: readonly SkillInstallFile[] = []): readonly SkillInstallFile[] {
  return [{ path: 'SKILL.md', contentBase64: Buffer.from(content).toString('base64') }, ...extras]
}

async function installFixture(options: {
  readonly git?: boolean
  readonly owner?: {
    owns: boolean
    service?: 'ontology' | 'jdcloud'
    workspace?: string
    role?: 'admin' | 'member' | 'unavailable'
  }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-skills-'))
  const project = join(root, 'project')
  const cwd = join(project, 'nested')
  await mkdir(cwd, { recursive: true })
  if (options.git !== false) await mkdir(join(project, '.git'))
  const ctx = await context()
  const filesystem = await ctx.plugin(LocalFileSystem, { cwd: root })
  const sessionId = SessionId('install-skills')
  const observeSession = vi.fn(() => Promise.resolve(observation(sessionId, { cwd })))
  ctx.provide('sessionQuery', { observeSession } as never)
  const workspaceRoot = join(root, 'users', 'a'.repeat(64))
  const access = options.owner?.role === undefined || options.owner.role === 'unavailable'
    ? undefined
    : {
      userId: 'user-a',
      administrator: options.owner.role === 'admin',
      workspaceRoot,
      personalSkillDirectory: join(workspaceRoot, '.dsh', 'skills'),
      managedSkillDirectory: join(root, 'users', '.dsh', 'skills'),
    }
  if (access !== undefined) await mkdir(workspaceRoot, { recursive: true })
  const assertWorkspacePath = vi.fn((path: string) => {
    if (options.owner?.workspace !== undefined && path !== options.owner.workspace) {
      return Promise.reject(new Error('outside user workspace'))
    }
    return Promise.resolve()
  })
  if (options.owner !== undefined) {
    ctx.provide(options.owner.service === 'jdcloud' ? 'jdcloudAuthController' : 'ontologyAuthController', {
      owns: vi.fn(() => Promise.resolve(options.owner?.owns ?? false)),
      assertWorkspacePath,
      ...options.owner.role === undefined
        ? {}
        : { currentSkillAccess: vi.fn(() => Promise.resolve(access)) },
    } as never)
  }
  onTestFinished(async () => {
    await filesystem.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    project,
    cwd,
    ctx,
    sessionId,
    observeSession,
    assertWorkspacePath,
    access,
    catalog: new SessionSkillCatalog(ctx),
  }
}

describe('SessionSkillCatalog', () => {
  it('reads a moved cold Session catalog from its recorded current directory without resuming an Agent', async () => {
    const ctx = await context()
    const sessionId = SessionId('cold-skills')
    const observed = observation(sessionId, { cwd: '/cold/original', workingDirectory: '/cold/project' })
    const dispose = vi.spyOn(observed, Symbol.dispose)
    const observeSession = vi.fn(() => Promise.resolve(observed))
    ctx.provide('sessionQuery', { observeSession } as never)
    const resume = vi.spyOn(ctx.agents, 'resume')
    const ensureDirectory = vi.spyOn(ctx.workingDirectory, 'ensure')
    const list = vi.fn(() => Promise.resolve([
      {
        name: 'review',
        description: 'Review the current change.',
        whenToUse: 'Before publishing.',
        path: '/cold/project/.agents/skills/review/SKILL.md',
        invocation: { modelInvocable: true, userInvocable: true },
      },
      {
        name: 'model-only',
        description: 'Not shown to the user.',
        invocation: { modelInvocable: true, userInvocable: false },
      },
    ]))
    ctx.provide('skills', { list } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({
      skills: [{
        name: 'review',
        description: 'Review the current change.',
        whenToUse: 'Before publishing.',
        path: '/cold/project/.agents/skills/review/SKILL.md',
        modelInvocable: true,
      }],
      installScopes: ['project'],
      managedSkills: [],
    })
    expect(observeSession).toHaveBeenCalledWith(sessionId)
    expect(dispose).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    expect(ensureDirectory).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
  })

  it.each([
    { cwd: undefined, workingDirectory: '/cold/current', expected: '/cold/current' },
    { cwd: '/cold/original', workingDirectory: null, expected: '/cold/original' },
    { cwd: undefined, workingDirectory: null, expected: '/catalog/default' },
    { cwd: undefined, workingDirectory: undefined, expected: '/catalog/default' },
  ])('resolves cold directory metadata $cwd / $workingDirectory to $expected without filesystem checks', async ({ cwd, workingDirectory, expected }) => {
    const ctx = await context()
    try {
      const sessionId = SessionId('cold-directory-fallback')
      ctx.provide('sessionQuery', {
        observeSession: () => Promise.resolve(observation(sessionId, {
          ...cwd === undefined ? {} : { cwd },
          ...workingDirectory === undefined ? {} : { workingDirectory },
        })),
      } as never)
      const list = vi.fn(() => Promise.resolve([]))
      ctx.provide('skills', { list } as never)
      const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
      const resume = vi.spyOn(ctx.agents, 'resume')
      await expect(new SessionSkillCatalog(ctx).list({ sessionId }, new AbortController().signal))
        .resolves.toEqual({ skills: [] })
      expect(list).toHaveBeenCalledWith({ cwd: expected, scope: undefined })
      expect(ensure).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses a live Agent to address a preset-owned registry', async () => {
    const ctx = await context()
    const sessionId = SessionId('live-skills')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/live/project' } })
    const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
    await ctx.agents.register(agent)
    const ensureDirectory = vi.spyOn(ctx.workingDirectory, 'ensure').mockResolvedValue('/live/current')
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(observation(sessionId, { cwd: '/live/project' })),
    } as never)
    const scopedList = vi.fn(() => Promise.resolve([{
      name: 'preset-owned',
      description: 'Composed for this Agent.',
      invocation: { modelInvocable: false, userInvocable: true },
    }]))
    const acquireScope = vi.fn()
    ctx.provide('agentPresets', {
      serviceFor: () => ({ list: scopedList }),
      acquireScope,
    } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({
      skills: [{
        name: 'preset-owned',
        description: 'Composed for this Agent.',
        modelInvocable: false,
      }],
      installScopes: ['project'],
      managedSkills: [],
    })
    expect(scopedList).toHaveBeenCalledWith({ cwd: '/live/current', scope: agent })
    expect(ensureDirectory).toHaveBeenCalledWith(agent, expect.any(AbortSignal))
    expect(session.header.cwd).toBe('/live/project')
    expect(acquireScope).not.toHaveBeenCalled()
  })

  it('uses the recorded preset standing scope for a cold Session', async () => {
    const ctx = await context()
    const sessionId = SessionId('standing-skills')
    const scope = { agentPreset: 'minimal' }
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(observation(sessionId, {
        cwd: '/cold/project',
        agentPreset: 'minimal',
      })),
    } as never)
    const acquireScope = vi.fn(() => Promise.resolve({ key: scope, [Symbol.asyncDispose]: async () => {} }))
    ctx.provide('agentPresets', { acquireScope } as never)
    const list = vi.fn(() => Promise.resolve([]))
    ctx.provide('skills', { list } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.list({ sessionId }, new AbortController().signal))
      .resolves.toEqual({ skills: [], installScopes: ['project'], managedSkills: [] })
    expect(acquireScope).toHaveBeenCalledWith('minimal')
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope })
    expect(ctx.agents.list()).toEqual([])
  })

  it('falls back to the global registry when the recorded preset is unavailable', async () => {
    const ctx = await context()
    const sessionId = SessionId('gone-preset')
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(observation(sessionId, {
        cwd: '/cold/project',
        agentPreset: 'gone',
      })),
    } as never)
    ctx.provide('agentPresets', {
      acquireScope: () => Promise.reject(new Error('unknown preset')),
    } as never)
    const list = vi.fn(() => Promise.resolve([]))
    ctx.provide('skills', { list } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.list({ sessionId }, new AbortController().signal))
      .resolves.toEqual({ skills: [], installScopes: ['project'], managedSkills: [] })
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
  })

  it.each([
    {
      error: new SessionQueryError(
        'session "missing-skills" not found',
        'SESSION_QUERY_SESSION_NOT_FOUND',
      ),
      code: 'session/not-found',
    },
    { error: new Error('storage offline'), code: 'gateway/internal' },
  ] as const)('classifies failed Session inspection as $code', async ({ error, code }) => {
    const ctx = await context()
    ctx.provide('sessionQuery', { observeSession: () => Promise.reject(error) } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.list(
      { sessionId: SessionId('missing-skills') },
      new AbortController().signal,
    )).rejects.toMatchObject({ code })
  })

  it('rejects a list request cancelled before Session inspection', async () => {
    const ctx = await context()
    const observeSession = vi.fn()
    ctx.provide('sessionQuery', { observeSession } as never)
    const catalog = new SessionSkillCatalog(ctx)
    const abort = new AbortController()
    abort.abort()

    await expect(catalog.list(
      { sessionId: SessionId('cancelled-list') },
      abort.signal,
    )).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(observeSession).not.toHaveBeenCalled()
  })

  it('reports an absent skill registry instead of an empty catalog', async () => {
    const ctx = await context()
    const sessionId = SessionId('no-skills')
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(observation(sessionId, { cwd: '/project' })),
    } as never)
    const catalog = new SessionSkillCatalog(ctx)

    const failed = catalog.list({ sessionId }, new AbortController().signal)
    await expect(failed).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(failed).rejects.toThrow('skill registry is absent')
  })

  it('rejects observations without projections', async () => {
    const ctx = await context()
    const sessionId = SessionId('incomplete-skills')
    const withoutProjections = { ...observation(sessionId, { cwd: '/project' }), projections: undefined }
    const observeSession = vi.fn()
      .mockResolvedValueOnce(withoutProjections)
    ctx.provide('sessionQuery', { observeSession } as never)
    const catalog = new SessionSkillCatalog(ctx)

    const unprojected = catalog.list({ sessionId }, new AbortController().signal)
    await expect(unprojected).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(unprojected).rejects.toThrow('projected Session observation')
  })

  it('classifies a provider listing failure', async () => {
    const ctx = await context()
    const sessionId = SessionId('failed-skills')
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(observation(sessionId, { cwd: '/project' })),
    } as never)
    ctx.provide('skills', {
      list: () => Promise.reject(new Error('catalog offline')),
    } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.list({ sessionId }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'gateway/internal', message: 'skill listing failed: Error: catalog offline',
      })
  })

  it('exposes personal installs to members and shared installs only to administrators', async () => {
    const member = await installFixture({ owner: { owns: true, role: 'member' } })
    member.ctx.provide('skills', { list: () => Promise.resolve([]) } as never)
    await expect(member.catalog.list({ sessionId: member.sessionId }, new AbortController().signal))
      .resolves.toEqual({ skills: [], installScopes: ['personal'], managedSkills: [] })

    const administrator = await installFixture({ owner: { owns: true, role: 'admin' } })
    administrator.ctx.provide('skills', { list: () => Promise.resolve([]) } as never)
    await expect(administrator.catalog.list(
      { sessionId: administrator.sessionId },
      new AbortController().signal,
    )).resolves.toEqual({ skills: [], installScopes: ['personal', 'built-in'], managedSkills: [] })
  })

  it('does not fall back to project installation when account Skill access is unavailable', async () => {
    const b = await installFixture({ owner: { owns: true, role: 'unavailable' } })
    b.ctx.provide('skills', { list: () => Promise.resolve([]) } as never)

    await expect(b.catalog.list({ sessionId: b.sessionId }, new AbortController().signal))
      .resolves.toEqual({ skills: [], installScopes: [], managedSkills: [] })
    await expect(b.catalog.create({
      sessionId: b.sessionId,
      files: skillFiles(skillDocument('unavailable-helper')),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill/forbidden',
      details: { scope: 'project' },
    })
  })

  it('accepts the JDCloud authentication controller through the shared Skill access interface', async () => {
    const b = await installFixture({ owner: { owns: true, role: 'member', service: 'jdcloud' } })
    b.ctx.provide('skills', { list: () => Promise.resolve([]) } as never)

    await expect(b.catalog.list({ sessionId: b.sessionId }, new AbortController().signal))
      .resolves.toEqual({ skills: [], installScopes: ['personal'], managedSkills: [] })
  })

  it('lists account-managed Skills and enforces scope-specific deletion', async () => {
    const member = await installFixture({ owner: { owns: true, role: 'member' } })
    if (member.access === undefined) throw new Error('member fixture did not create Skill access')
    member.ctx.provide('skills', { list: () => Promise.resolve([]) } as never)
    await member.catalog.create({
      sessionId: member.sessionId,
      scope: 'personal',
      files: skillFiles(skillDocument('personal-helper', 'Private account helper.')),
    }, new AbortController().signal)

    await expect(member.catalog.list({ sessionId: member.sessionId }, new AbortController().signal))
      .resolves.toMatchObject({
        managedSkills: [{
          name: 'personal-helper',
          description: 'Private account helper.',
          scope: 'personal',
        }],
      })
    await expect(member.catalog.delete({
      sessionId: member.sessionId,
      scope: 'built-in',
      name: 'shared-helper',
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill/forbidden',
      details: { scope: 'built-in' },
    })
    await expect(member.catalog.delete({
      sessionId: member.sessionId,
      scope: 'personal',
      name: 'personal-helper',
    }, new AbortController().signal)).resolves.toEqual({
      deleted: true,
      name: 'personal-helper',
      scope: 'personal',
    })
    await expect(readFile(join(member.access.personalSkillDirectory, 'personal-helper', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const administrator = await installFixture({ owner: { owns: true, role: 'admin' } })
    if (administrator.access === undefined) throw new Error('administrator fixture did not create Skill access')
    administrator.ctx.provide('skills', { list: () => Promise.resolve([]) } as never)
    await administrator.catalog.create({
      sessionId: administrator.sessionId,
      scope: 'built-in',
      files: skillFiles(skillDocument('shared-helper', 'Shared administrator helper.')),
    }, new AbortController().signal)

    await expect(administrator.catalog.list({
      sessionId: administrator.sessionId,
    }, new AbortController().signal)).resolves.toMatchObject({
      managedSkills: [{
        name: 'shared-helper',
        description: 'Shared administrator helper.',
        scope: 'built-in',
      }],
    })
    await expect(administrator.catalog.delete({
      sessionId: administrator.sessionId,
      scope: 'built-in',
      name: 'shared-helper',
    }, new AbortController().signal)).resolves.toEqual({
      deleted: true,
      name: 'shared-helper',
      scope: 'built-in',
    })
  })

  it('manages personal and shared Skills without requiring a Session', async () => {
    const member = await installFixture({ owner: { owns: false, role: 'member' } })
    if (member.access === undefined) throw new Error('member fixture did not create Skill access')
    await mkdir(join(member.access.managedSkillDirectory, 'shared-helper'), { recursive: true })
    await writeFile(
      join(member.access.managedSkillDirectory, 'shared-helper', 'SKILL.md'),
      skillDocument('shared-helper', 'Shared administrator helper.'),
      'utf8',
    )

    await expect(member.catalog.createAccount({
      scope: 'personal',
      files: skillFiles(skillDocument('personal-helper', 'Private account helper.')),
    }, new AbortController().signal)).resolves.toMatchObject({
      skill: { name: 'personal-helper' },
    })
    await expect(member.catalog.listAccount(new AbortController().signal)).resolves.toMatchObject({
      skills: [
        { name: 'personal-helper', scope: 'personal' },
        { name: 'shared-helper', scope: 'built-in' },
      ],
      installScopes: ['personal'],
    })
    await expect(member.catalog.createAccount({
      scope: 'built-in',
      files: skillFiles(skillDocument('member-shared-helper')),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill/forbidden',
      details: { scope: 'built-in' },
    })
    await expect(member.catalog.deleteAccount({
      scope: 'built-in',
      name: 'shared-helper',
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill/forbidden',
      details: { scope: 'built-in' },
    })
    await expect(member.catalog.deleteAccount({
      scope: 'personal',
      name: 'personal-helper',
    }, new AbortController().signal)).resolves.toEqual({
      deleted: true,
      name: 'personal-helper',
      scope: 'personal',
    })

    const administrator = await installFixture({ owner: { owns: false, role: 'admin' } })
    await expect(administrator.catalog.createAccount({
      scope: 'built-in',
      files: skillFiles(skillDocument('administrator-helper')),
    }, new AbortController().signal)).resolves.toMatchObject({
      skill: { name: 'administrator-helper' },
    })
    await expect(administrator.catalog.deleteAccount({
      scope: 'built-in',
      name: 'administrator-helper',
    }, new AbortController().signal)).resolves.toEqual({
      deleted: true,
      name: 'administrator-helper',
      scope: 'built-in',
    })
  })

  it('installs personal Skills under the authenticated user workspace', async () => {
    const b = await installFixture({ owner: { owns: true, role: 'member' } })
    if (b.access === undefined) throw new Error('member fixture did not create Skill access')
    const content = skillDocument('personal-helper', 'Private account helper.')

    await expect(b.catalog.create({
      sessionId: b.sessionId,
      scope: 'personal',
      files: skillFiles(content),
    }, new AbortController().signal)).resolves.toMatchObject({
      skill: {
        name: 'personal-helper',
        path: join(b.access.personalSkillDirectory, 'personal-helper', 'SKILL.md'),
      },
    })
    await expect(readFile(join(b.access.personalSkillDirectory, 'personal-helper', 'SKILL.md'), 'utf8'))
      .resolves.toBe(content)
  })

  it('restricts shared built-in Skill installs to administrators', async () => {
    const member = await installFixture({ owner: { owns: true, role: 'member' } })
    await expect(member.catalog.create({
      sessionId: member.sessionId,
      scope: 'built-in',
      files: skillFiles(skillDocument('shared-helper')),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'skill/forbidden',
      details: { scope: 'built-in' },
    })

    const administrator = await installFixture({ owner: { owns: true, role: 'admin' } })
    if (administrator.access === undefined) throw new Error('administrator fixture did not create Skill access')
    const content = skillDocument('shared-helper', 'Shared administrator helper.')
    await expect(administrator.catalog.create({
      sessionId: administrator.sessionId,
      scope: 'built-in',
      files: skillFiles(content),
    }, new AbortController().signal)).resolves.toMatchObject({
      skill: {
        name: 'shared-helper',
        path: join(administrator.access.managedSkillDirectory, 'shared-helper', 'SKILL.md'),
      },
    })
    await expect(readFile(join(administrator.access.managedSkillDirectory, 'shared-helper', 'SKILL.md'), 'utf8'))
      .resolves.toBe(content)
  })

  it('installs a validated SKILL.md at the nearest project root without overwriting', async () => {
    const b = await installFixture({ owner: { owns: true } })
    const content = skillDocument('workspace-helper', 'Guide work in this project.', 'disable-model-invocation: yes\n')

    const files = skillFiles(content, [
      { path: 'references/example.md', contentBase64: Buffer.from('Reference text.\n').toString('base64') },
      { path: 'assets/icon.bin', contentBase64: Buffer.from([0, 255, 7]).toString('base64') },
    ])
    await expect(b.catalog.create({ sessionId: b.sessionId, files }, new AbortController().signal))
      .resolves.toEqual({
        skill: {
          name: 'workspace-helper',
          description: 'Guide work in this project.',
          modelInvocable: false,
          path: join(b.project, '.dsh', 'skills', 'workspace-helper', 'SKILL.md'),
        },
      })
    const target = join(b.project, '.dsh', 'skills', 'workspace-helper', 'SKILL.md')
    await expect(readFile(target, 'utf8')).resolves.toBe(content)
    await expect(readFile(join(target, '..', 'references', 'example.md'), 'utf8')).resolves.toBe('Reference text.\n')
    await expect(readFile(join(target, '..', 'assets', 'icon.bin'))).resolves.toEqual(Buffer.from([0, 255, 7]))
    expect(b.observeSession).toHaveBeenCalledWith(b.sessionId)
    expect(b.assertWorkspacePath).toHaveBeenCalledWith(b.project)

    await expect(b.catalog.create({ sessionId: b.sessionId, files }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'skill/already-exists', details: { name: 'workspace-helper' } })
    await expect(readFile(target, 'utf8')).resolves.toBe(content)
  })

  it('uses the Session cwd when no git project marker exists', async () => {
    const b = await installFixture({ git: false })
    const content = skillDocument('cwd-helper')

    await expect(b.catalog.create({ sessionId: b.sessionId, files: skillFiles(content) }, new AbortController().signal))
      .resolves.toMatchObject({
        skill: { path: join(b.cwd, '.dsh', 'skills', 'cwd-helper', 'SKILL.md') },
      })
  })

  it.each([
    { content: '', reason: 'frontmatter' },
    { content: 'plain markdown', reason: 'frontmatter' },
    { content: '---\nname: test\n', reason: 'frontmatter' },
    { content: '---\n- item\n---\nbody', reason: 'frontmatter' },
    { content: '---\nname: [\n---\nbody', reason: 'frontmatter' },
    { content: skillDocument('Bad_Name'), reason: 'name' },
    { content: skillDocument('test', '   '), reason: 'description' },
    { content: skillDocument('test', 'test', 'user-invocable: false\n'), reason: 'user-invocable' },
    { content: skillDocument('test', 'test', 'user-invocable: maybe\n'), reason: 'frontmatter' },
    {
      content: `${skillDocument('large')}\n${'x'.repeat(SKILL_INSTALL_MAX_BYTES)}`,
      reason: 'content-too-large',
    },
  ])('rejects invalid imported content: $reason', async ({ content, reason }) => {
    const ctx = await context()
    const catalog = new SessionSkillCatalog(ctx)
    await expect(catalog.create(
      { sessionId: SessionId('invalid-skill'), files: skillFiles(content) },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason } })
  })

  it.each([
    { files: [], reason: 'empty-folder' },
    {
      files: [{ path: 'references/guide.md', contentBase64: '' }],
      reason: 'missing-skill-file',
    },
    {
      files: skillFiles(skillDocument(), [{ path: '../escape.txt', contentBase64: '' }]),
      reason: 'invalid-file-path',
    },
    {
      files: skillFiles(skillDocument(), [{ path: 'skill.md', contentBase64: '' }]),
      reason: 'invalid-file-path',
    },
    {
      files: skillFiles(skillDocument(), [{
        path: 'assets/large.bin',
        contentBase64: Buffer.alloc(SKILL_INSTALL_MAX_FILE_BYTES + 1).toString('base64'),
      }]),
      reason: 'file-too-large',
    },
    {
      files: skillFiles(skillDocument(), Array.from({ length: 5 }, (_, index) => ({
        path: `assets/${index}.bin`,
        contentBase64: Buffer.alloc(SKILL_INSTALL_MAX_TOTAL_BYTES / 4).toString('base64'),
      }))),
      reason: 'folder-too-large',
    },
    {
      files: Array.from({ length: SKILL_INSTALL_MAX_FILES + 1 }, (_, index) => ({
        path: index === 0 ? 'SKILL.md' : `references/${index}.md`,
        contentBase64: index === 0 ? Buffer.from(skillDocument()).toString('base64') : '',
      })),
      reason: 'too-many-files',
    },
    {
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from([0xff, 0xfe]).toString('base64') }],
      reason: 'skill-file-not-text',
    },
    {
      files: [{ path: 'SKILL.md', contentBase64: 'not base64' }],
      reason: 'invalid-file-content',
    },
  ])('rejects an invalid imported folder: $reason', async ({ files, reason }) => {
    const ctx = await context()
    const catalog = new SessionSkillCatalog(ctx)
    await expect(catalog.create(
      { sessionId: SessionId('invalid-folder'), files },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason } })
  })

  it('rejects a Session without a project cwd', async () => {
    const ctx = await context()
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(observation(SessionId('cwdless'))),
    } as never)
    const catalog = new SessionSkillCatalog(ctx)

    await expect(catalog.create(
      { sessionId: SessionId('cwdless'), files: skillFiles() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason: 'project-cwd' } })
  })

  it('checks Session ownership before inspecting or writing the project', async () => {
    const b = await installFixture({ owner: { owns: false } })

    await expect(b.catalog.create(
      { sessionId: b.sessionId, files: skillFiles() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/not-found' })
    expect(b.observeSession).not.toHaveBeenCalled()
  })

  it('rejects a project root outside the authenticated user workspace', async () => {
    const b = await installFixture({ owner: { owns: true, workspace: join('different', 'project') } })

    await expect(b.catalog.create(
      { sessionId: b.sessionId, files: skillFiles() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason: 'path' } })
  })

  it('rejects a resolved skill target that leaves the project', async () => {
    const b = await installFixture()
    vi.spyOn(b.ctx.fs, 'contains').mockReturnValue(false)

    await expect(b.catalog.create(
      { sessionId: b.sessionId, files: skillFiles(skillDocument('escaped-skill')) },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason: 'path' } })
  })

  it('preserves an existing skill file after a guarded create conflict', async () => {
    const b = await installFixture()
    const target = join(b.project, '.dsh', 'skills', 'workspace-helper', 'SKILL.md')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'existing content', 'utf8')

    await expect(b.catalog.create(
      { sessionId: b.sessionId, files: skillFiles() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/already-exists' })
    await expect(readFile(target, 'utf8')).resolves.toBe('existing content')
  })

  it('rejects a request cancelled before validation or Session inspection', async () => {
    const ctx = await context()
    const observeSession = vi.fn()
    ctx.provide('sessionQuery', { observeSession } as never)
    const catalog = new SessionSkillCatalog(ctx)
    const abort = new AbortController()
    abort.abort()

    await expect(catalog.create(
      { sessionId: SessionId('cancelled-skill'), files: skillFiles() },
      abort.signal,
    )).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(observeSession).not.toHaveBeenCalled()
  })
})
