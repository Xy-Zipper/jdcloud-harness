/** Project creation goes through the actual tool pipeline even without a frontend. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'

/** URL loading keeps these JavaScript regressions on source, independent of built declarations. */
interface ProjectPointsModule {
  registerProjectPointsGuard: (ctx: Context, config: { tenantId: string; platformURL: string }, auth: object) => void
}
const { registerProjectPointsGuard } = await import(new URL('../src/project-points.mjs', import.meta.url).href) as ProjectPointsModule
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const spaceId = 'a'.repeat(24)
const projectMenuId = '6ad81c131f280486bb45ac3f'
const tenantId = 'b'.repeat(24)

async function setup(points: unknown = '20') {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const write = vi.fn(async () => 'created')
  ctx.tools.register(defineTool({
    name: 'jdcloud_lowcode_create',
    description: 'Create the requested record.',
    parameters: {
      menu_id: { type: 'string', required: true },
      data: { type: 'object', required: true, additionalProperties: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: write,
  }))
  let currentPoints = points
  let scopeKey = 'user'
  let ownerUserId = 'actor'
  let role = 'editor'
  const auth = {
    status: vi.fn(async () => ({ authenticated: true, corpId: tenantId, baseUrl: 'https://platform.example' })),
    currentScopeKey: vi.fn(async () => scopeKey),
    requestAuthenticated: vi.fn(async (request: { path: string; body?: { menuId: string; _id?: string } }) => {
      if (request.path.endsWith('currentUser')) return { userInfo: { id: 'actor', corpId: tenantId } }
      if (request.path.endsWith('/info')) return { _id: spaceId, status: 'active', ownerUserId, points: currentPoints }
      if (request.path.endsWith('/list')) return { list: [{ spaceId, userId: 'actor', status: 'active', role }] }
      throw new Error('Unexpected platform write')
    }),
  }
  const fiber = ctx.plugin({
    name: 'project-points-test',
    apply(child) {
      registerProjectPointsGuard(child, { tenantId, platformURL: 'https://platform.example' }, auth)
    },
  })
  await fiber
  return {
    ctx, auth, write, fiber,
    setPoints(value: unknown) { currentPoints = value },
    changeScope() { scopeKey = 'another-user' },
    membership(value: string) { ownerUserId = 'other-owner'; role = value },
    run(menuId = projectMenuId, data: Record<string, string> = { spaceId }) {
      return ctx.tools.execute({
        callId: ToolCallId('create'),
        name: 'jdcloud_lowcode_create',
        arguments: { menu_id: menuId, data },
        signal: new AbortController().signal,
      })
    },
  }
}

it.each(['0', '-1', '-0.00001', 0])('denies a direct creation with %s points before the tool body writes', async (points) => {
  const f = await setup(points)
  expect(await f.run()).toMatchObject({
    isError: true,
    error: { message: '当前空间积分不足，请先充值后再新建项目。', info: { code: 'creation-studio/insufficient-points' } },
  })
  expect(f.write).not.toHaveBeenCalled()
})

it.each(['0.00001', '20', 1])('accepts positive points without writing the balance: %s', async (points) => {
  const f = await setup(points)
  expect((await f.run()).isError).not.toBe(true)
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.auth.requestAuthenticated.mock.calls.every(([request]) => !/create|update|delete/u.test(request.path))).toBe(true)
})

it('reads the latest points for every attempt, including after a recharge', async () => {
  const f = await setup('0')
  expect((await f.run()).isError).toBe(true)
  f.setPoints('1')
  expect((await f.run()).isError).not.toBe(true)
  f.setPoints('-1')
  expect((await f.run()).isError).toBe(true)
  expect(f.write).toHaveBeenCalledTimes(1)
})

it.each([undefined, '', null, 'NaN', '0x20'])('refuses unreadable point values: %s', async (points) => {
  const f = await setup('20')
  f.setPoints(points)
  expect(await f.run()).toMatchObject({ isError: true, error: { info: { code: 'creation-studio/points-unavailable' } } })
  expect(f.write).not.toHaveBeenCalled()
})

it('checks a current editor membership and refuses read-only members', async () => {
  const f = await setup()
  f.membership('editor')
  expect((await f.run()).isError).not.toBe(true)
  f.membership('viewer')
  expect((await f.run()).isError).toBe(true)
  expect(f.write).toHaveBeenCalledTimes(1)
})

it('denies a scope change while points are being read', async () => {
  const f = await setup()
  const original = f.auth.requestAuthenticated.getMockImplementation()!
  f.auth.requestAuthenticated.mockImplementation(async (request) => {
    const value = await original(request)
    if (request.path.endsWith('/info')) f.changeScope()
    return value
  })
  expect((await f.run()).isError).toBe(true)
  expect(f.write).not.toHaveBeenCalled()
})

it('stops when the platform cannot be read or the space id is absent', async () => {
  const f = await setup()
  f.auth.requestAuthenticated.mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 403 }))
  expect(await f.run()).toMatchObject({ isError: true, error: { info: { code: 'creation-studio/points-unavailable' } } })
  expect((await f.run(projectMenuId, {})).isError).toBe(true)
  expect(f.write).not.toHaveBeenCalled()
})

it('does not intercept other tables and removes its policy when unloaded', async () => {
  const f = await setup('0')
  expect((await f.run('c'.repeat(24))).isError).not.toBe(true)
  expect(f.auth.requestAuthenticated).not.toHaveBeenCalled()
  await f.fiber.dispose()
  expect((await f.run()).isError).not.toBe(true)
  expect(f.write).toHaveBeenCalledTimes(2)
})
