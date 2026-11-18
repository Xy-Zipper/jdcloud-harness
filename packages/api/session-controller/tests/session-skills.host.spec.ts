import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, type SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  provideWorkingDirectoryFixture(ctx, '/catalog/default')
  return ctx
}

describe('SessionSkillCatalog', () => {
  it('rejects account operations without authenticated Skill access', async () => {
    const ctx = await context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const catalog = new SessionSkillCatalog(ctx)
    const signal = new AbortController().signal
    await expect(catalog.listAccount(signal)).rejects.toMatchObject({ code: 'skill/forbidden' })
    await expect(catalog.createAccount({ scope: 'personal', files: [] }, signal))
      .rejects.toMatchObject({ code: 'skill/forbidden' })
    await expect(catalog.deleteAccount({ scope: 'personal', name: 'account-helper' }, signal))
      .rejects.toMatchObject({ code: 'skill/forbidden' })
  })

  it.each([false, true])('manages account folders without a Session (administrator: %s)', async (administrator) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-account-skills-')))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const ctx = await context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LocalFileSystem, { cwd: root }).await()
    const observeSession = vi.fn(() => { throw new Error('Account operations must not inspect a Session') })
    ctx.provide('sessionQuery', { observeSession } as never)
    const owns = vi.fn(() => { throw new Error('Account operations must not require a Session owner') })
    ctx.provide('ontologyAuthController', {
      owns,
      assertWorkspacePath: () => Promise.resolve(),
      currentSkillAccess: () => Promise.resolve({
        userId: 'account', administrator, workspaceRoot: root,
        personalSkillDirectory: join(root, '.dsh', 'skills'),
        managedSkillDirectory: join(root, 'shared'),
      }),
    } as never)
    const catalog = new SessionSkillCatalog(ctx)
    expect(remoteMethods(catalog).map(marker => marker.method)).toEqual(expect.arrayContaining([
      'listAccount', 'createAccount', 'deleteAccount',
    ]))
    const text = '---\nname: account-helper\ndescription: Account helper\n---\nInstructions.\n'
    const files = [{ path: 'SKILL.md', contentBase64: Buffer.from(text).toString('base64') }]
    const signal = new AbortController().signal
    await catalog.createAccount({ scope: 'personal', files }, signal)
    expect(await readFile(join(root, '.dsh', 'skills', 'account-helper', 'SKILL.md'), 'utf8')).toBe(text)
    await expect(catalog.listAccount(signal)).resolves.toMatchObject({
      skills: [{ name: 'account-helper', scope: 'personal' }],
      installScopes: administrator ? ['personal', 'built-in'] : ['personal'],
    })
    if (administrator) {
      await catalog.createAccount({ scope: 'built-in', files }, signal)
      expect(await readFile(join(root, 'shared', 'account-helper', 'SKILL.md'), 'utf8')).toBe(text)
      await catalog.deleteAccount({ scope: 'built-in', name: 'account-helper' }, signal)
    } else {
      await expect(catalog.createAccount({ scope: 'built-in', files }, signal))
        .rejects.toMatchObject({ code: 'skill/forbidden' })
      await expect(catalog.deleteAccount({ scope: 'built-in', name: 'account-helper' }, signal))
        .rejects.toMatchObject({ code: 'skill/forbidden' })
    }
    await catalog.deleteAccount({ scope: 'personal', name: 'account-helper' }, signal)
    await expect(catalog.listAccount(signal)).resolves.toMatchObject({ skills: [] })
    expect(observeSession).not.toHaveBeenCalled()
    expect(owns).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
  })

  it('reads a moved cold Session catalog from its recorded current directory without resuming an Agent', async () => {
    const ctx = await context()
    const sessionId = brandString<SessionId>('cold-skills')
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
      installScopes: ['project'], managedSkills: [],
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
      const sessionId = brandString<SessionId>('cold-directory-fallback')
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
        .resolves.toEqual({ skills: [], installScopes: ['project'], managedSkills: [] })
      expect(list).toHaveBeenCalledWith({ cwd: expected, scope: undefined })
      expect(ensure).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses a live Agent to address a preset-owned registry', async () => {
    const ctx = await context()
    const sessionId = brandString<SessionId>('live-skills')
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
      installScopes: ['project'], managedSkills: [],
      skills: [{
        name: 'preset-owned',
        description: 'Composed for this Agent.',
        modelInvocable: false,
      }],
    })
    expect(scopedList).toHaveBeenCalledWith({ cwd: '/live/project', scope: agent })
    expect(ensureDirectory).not.toHaveBeenCalled()
    expect(session.header.cwd).toBe('/live/project')
    expect(acquireScope).not.toHaveBeenCalled()
  })

  it('uses the recorded preset standing scope for a cold Session', async () => {
    const ctx = await context()
    const sessionId = brandString<SessionId>('standing-skills')
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

    await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({ skills: [], installScopes: ['project'], managedSkills: [] })
    expect(acquireScope).toHaveBeenCalledWith('minimal')
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope })
    expect(ctx.agents.list()).toEqual([])
  })

  it('falls back to the global registry when the recorded preset is unavailable', async () => {
    const ctx = await context()
    const sessionId = brandString<SessionId>('gone-preset')
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

    await expect(catalog.list({ sessionId }, new AbortController().signal)).resolves.toEqual({ skills: [], installScopes: ['project'], managedSkills: [] })
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
      { sessionId: brandString<SessionId>('missing-skills') },
      new AbortController().signal,
    )).rejects.toMatchObject({ code })
  })

  it('reports an absent skill registry instead of an empty catalog', async () => {
    const ctx = await context()
    const sessionId = brandString<SessionId>('no-skills')
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
    const sessionId = brandString<SessionId>('incomplete-skills')
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
    const sessionId = brandString<SessionId>('failed-skills')
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
})
