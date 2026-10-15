import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'
import { SKILL_INSTALL_MAX_BYTES } from '../src/types.ts'

function observation(
  sessionId: SessionId,
  options: { readonly cwd?: string; readonly agentPreset?: string } = {},
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
  return ctx
}

function skillDocument(
  name = 'workspace-helper',
  description = 'Guide work in this project.',
  metadata = '',
): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${metadata}---\n\nFollow the project workflow.\n`
}

async function installFixture(options: {
  readonly git?: boolean
  readonly owner?: { owns: boolean; workspace?: string }
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
  const assertWorkspacePath = vi.fn((path: string) => {
    if (options.owner?.workspace !== undefined && path !== options.owner.workspace) {
      return Promise.reject(new Error('outside user workspace'))
    }
    return Promise.resolve()
  })
  if (options.owner !== undefined) {
    ctx.provide('ontologyAuthController', {
      owns: vi.fn(() => Promise.resolve(options.owner?.owns ?? false)),
      assertWorkspacePath,
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
    catalog: new SessionSkillCatalog(ctx),
  }
}

describe('SessionSkillCatalog', () => {
  it('reads a cold Session catalog without resuming an Agent', async () => {
    const ctx = await context()
    const sessionId = SessionId('cold-skills')
    const observed = observation(sessionId, { cwd: '/cold/project' })
    const dispose = vi.spyOn(observed, Symbol.dispose)
    const observeSession = vi.fn(() => Promise.resolve(observed))
    ctx.provide('sessionQuery', { observeSession } as never)
    const resume = vi.spyOn(ctx.agents, 'resume')
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
    })
    expect(observeSession).toHaveBeenCalledWith(sessionId)
    expect(dispose).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
  })

  it('uses a live Agent to address a preset-owned registry', async () => {
    const ctx = await context()
    const sessionId = SessionId('live-skills')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/live/project' } })
    const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
    await ctx.agents.register(agent)
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
    })
    expect(scopedList).toHaveBeenCalledWith({ cwd: '/live/project', scope: agent })
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

    await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({ skills: [] })
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

    await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({ skills: [] })
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

  it('rejects observations without projections or a project cwd', async () => {
    const ctx = await context()
    const sessionId = SessionId('incomplete-skills')
    const withoutProjections = { ...observation(sessionId, { cwd: '/project' }), projections: undefined }
    const observeSession = vi.fn()
      .mockResolvedValueOnce(withoutProjections)
      .mockResolvedValueOnce(observation(sessionId))
    ctx.provide('sessionQuery', { observeSession } as never)
    const catalog = new SessionSkillCatalog(ctx)

    const unprojected = catalog.list({ sessionId }, new AbortController().signal)
    await expect(unprojected).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(unprojected).rejects.toThrow('projected Session observation')
    const cwdless = catalog.list({ sessionId }, new AbortController().signal)
    await expect(cwdless).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(cwdless).rejects.toThrow('has no project cwd')
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

  it('installs a validated SKILL.md at the nearest project root without overwriting', async () => {
    const b = await installFixture({ owner: { owns: true } })
    const content = skillDocument('workspace-helper', 'Guide work in this project.', 'disable-model-invocation: yes\n')

    await expect(b.catalog.create({ sessionId: b.sessionId, content }, new AbortController().signal))
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
    expect(b.observeSession).toHaveBeenCalledWith(b.sessionId)
    expect(b.assertWorkspacePath).toHaveBeenCalledWith(b.project)

    await expect(b.catalog.create({ sessionId: b.sessionId, content }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'skill/already-exists', details: { name: 'workspace-helper' } })
    await expect(readFile(target, 'utf8')).resolves.toBe(content)
  })

  it('uses the Session cwd when no git project marker exists', async () => {
    const b = await installFixture({ git: false })
    const content = skillDocument('cwd-helper')

    await expect(b.catalog.create({ sessionId: b.sessionId, content }, new AbortController().signal))
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
      { sessionId: SessionId('invalid-skill'), content },
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
      { sessionId: SessionId('cwdless'), content: skillDocument() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason: 'project-cwd' } })
  })

  it('checks Session ownership before inspecting or writing the project', async () => {
    const b = await installFixture({ owner: { owns: false } })

    await expect(b.catalog.create(
      { sessionId: b.sessionId, content: skillDocument() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/not-found' })
    expect(b.observeSession).not.toHaveBeenCalled()
  })

  it('rejects a project root outside the authenticated user workspace', async () => {
    const b = await installFixture({ owner: { owns: true, workspace: join('different', 'project') } })

    await expect(b.catalog.create(
      { sessionId: b.sessionId, content: skillDocument() },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason: 'path' } })
  })

  it('rejects a resolved skill target that leaves the project', async () => {
    const b = await installFixture()
    vi.spyOn(b.ctx.fs, 'contains').mockReturnValue(false)

    await expect(b.catalog.create(
      { sessionId: b.sessionId, content: skillDocument('escaped-skill') },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'skill/invalid', details: { reason: 'path' } })
  })

  it('preserves an existing skill file after a guarded create conflict', async () => {
    const b = await installFixture()
    const target = join(b.project, '.dsh', 'skills', 'workspace-helper', 'SKILL.md')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'existing content', 'utf8')

    await expect(b.catalog.create(
      { sessionId: b.sessionId, content: skillDocument() },
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
      { sessionId: SessionId('cancelled-skill'), content: skillDocument() },
      abort.signal,
    )).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(observeSession).not.toHaveBeenCalled()
  })
})
