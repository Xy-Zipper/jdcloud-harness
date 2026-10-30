/** Permanent deletion uses the real JSONL provider and preserves unrelated storage. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createSessionTestController } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-controller-delete-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const forgetSession = vi.fn(async () => {})
  ctx.provide('workspaceRegistry', { forgetSession } as never)
  const controller = createSessionTestController(ctx, {
    cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
  })
  const id = SessionId('target')
  const handle = await ctx.sessionPersistence.create({
    id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false,
  })
  await handle.flush()
  await handle.close()
  return { ctx, controller, id, forgetSession }
}

it('removes cold Session storage and then announces the committed removal', async () => {
  const { ctx, controller, id, forgetSession } = await harness()
  const removed = vi.fn()
  ctx.on('api-session/removed', removed)
  await expect(controller.delete({ sessionId: id })).resolves.toEqual({ deleted: true })
  expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  expect(forgetSession).toHaveBeenCalledWith(id)
  expect(removed).toHaveBeenCalledWith(id)
})

it('refuses running work before deleting files or navigation records', async () => {
  const { ctx, controller, id, forgetSession } = await harness()
  ctx.on('workspace/session-activity', async (_request, next) => [...await next(), { kind: 'turn' }])
  await expect(controller.delete({ sessionId: id })).rejects.toMatchObject({ code: 'session/delete-active' })
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
  expect(forgetSession).not.toHaveBeenCalled()
})

it('refuses a foreign Session before reading or deleting its storage', async () => {
  const { ctx, controller, id, forgetSession } = await harness()
  ctx.provide('jdcloudAuthController', { owns: async () => false } as never)
  const remove = vi.spyOn(ctx.sessionPersistence, 'delete')
  await expect(controller.delete({ sessionId: id })).rejects.toMatchObject({ code: 'session/not-found' })
  expect(remove).not.toHaveBeenCalled()
  expect(forgetSession).not.toHaveBeenCalled()
})

it('keeps navigation records and emits no removal if storage deletion fails', async () => {
  const { ctx, controller, id, forgetSession } = await harness()
  vi.spyOn(ctx.sessionPersistence, 'delete').mockRejectedValueOnce(new Error('disk unavailable'))
  const removed = vi.fn()
  ctx.on('api-session/removed', removed)
  await expect(controller.delete({ sessionId: id })).rejects.toThrow('disk unavailable')
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
  expect(forgetSession).not.toHaveBeenCalled()
  expect(removed).not.toHaveBeenCalled()
  await expect(controller.delete({ sessionId: id })).resolves.toEqual({ deleted: true })
})
