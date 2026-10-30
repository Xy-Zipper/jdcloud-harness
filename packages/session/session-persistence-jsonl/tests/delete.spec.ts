/** Physical deletion of one Session must preserve its neighbours and project files. */
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { sessionDir } from '../src/format.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('deletes every file in one Session directory and survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
  roots.push(root)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await writeFile(join(cwd, 'user.txt'), 'keep')
  const storage = join(root, 'sessions')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root: storage, compression: 'none' })
  const id = SessionId('removed')
  for (const sessionId of [id, SessionId('kept')]) {
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 1, isSeeded: false,
    })
    await handle.flush()
    await handle.close()
  }
  const directory = sessionDir(storage, cwd, id)
  await mkdir(join(directory, 'files'))
  await writeFile(join(directory, 'files', 'output.txt'), 'delete')
  await ctx.sessionPersistence.delete(id)
  await expect(readFile(join(directory, 'files', 'output.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  expect((await ctx.sessionPersistence.list()).map(item => item.header.id)).toEqual(['kept'])
  expect(await readFile(join(cwd, 'user.txt'), 'utf8')).toBe('keep')
  await expect(ctx.sessionPersistence.delete(id)).resolves.toBeUndefined()
  await ctx.fiber.dispose()
  const restarted = new Context()
  contexts.push(restarted)
  await restarted.plugin(JsonlPersistence, { root: storage, compression: 'none' })
  expect((await restarted.sessionPersistence.list()).map(item => item.header.id)).toEqual(['kept'])
})

it('refuses another backend instance’s active writer without removing its files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-owned-session-'))
  roots.push(root)
  const owner = new Context()
  const remover = new Context()
  contexts.push(owner, remover)
  await owner.plugin(JsonlPersistence, { root, compression: 'none' })
  await remover.plugin(JsonlPersistence, { root, compression: 'none' })
  const id = SessionId('owned')
  const handle = await owner.sessionPersistence.create({
    id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false,
  })
  await handle.flush()
  await expect(remover.sessionPersistence.delete(id)).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
  expect(await remover.sessionPersistence.stat(id)).toBeDefined()
  await handle.close()
  await remover.sessionPersistence.delete(id)
  expect(await owner.sessionPersistence.stat(id)).toBeUndefined()
})

it('closes a local writer before deleting so a later flush cannot recreate the log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-local-writer-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const id = SessionId('local')
  const handle = await ctx.sessionPersistence.create({
    id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false,
  })
  await handle.flush()
  await ctx.sessionPersistence.delete(id)
  await expect(handle.flush()).rejects.toMatchObject({ name: 'SessionHandleClosedError' })
  expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
})

it('refuses a Session directory redirected outside the configured storage root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-linked-session-'))
  roots.push(root)
  const storage = join(root, 'sessions')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root: storage, compression: 'none' })
  const id = SessionId('linked')
  const handle = await ctx.sessionPersistence.create({
    id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false,
  })
  await handle.flush()
  await handle.close()
  const directory = sessionDir(storage, undefined, id)
  const external = join(root, 'external')
  await rename(directory, external)
  await writeFile(join(external, 'keep.txt'), 'keep')
  await symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(ctx.sessionPersistence.delete(id)).rejects.toThrow('outside its root')
  expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep')
})
