/** Exercise the real model waterfall without a paid provider or any balance writes. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { registerModelPointsGuard } from '../src/project-points.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  const session = { id: 'session' }
  ctx.provide('agents', { get: id => id === 'session' ? { session } : undefined })
  let positive = true
  const billing = { checkPoints: vi.fn(async () => {
    if (!positive) throw Object.assign(new Error('当前空间积分不足，请先充值后继续使用。'), { code: 'creation-studio/insufficient-points' })
  }) }
  const fiber = ctx.plugin({ name: 'model-points-test', apply(child) { registerModelPointsGuard(child, billing) } })
  await fiber
  const provider = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
  async function run(sessionId = 'session') {
    const result = []
    for await (const chunk of ctx.waterfall('llm/stream', { sessionId }, provider)) result.push(chunk)
    return result
  }
  return { billing, provider, run, fiber, points(value) { positive = value > 0 } }
}

it('rechecks points for each Skill model round and resumes only after points become positive', async () => {
  const f = await setup()
  await f.run()
  f.points(0)
  expect(await f.run()).toEqual([{ type: 'finish', reason: { kind: 'error',
    failure: { code: 'creation-studio/insufficient-points', message: '当前空间积分不足，请先充值后继续使用。' } } }])
  f.points(-1)
  await f.run()
  expect(f.provider).toHaveBeenCalledTimes(1)
  f.points(0.001)
  await f.run()
  expect(f.provider).toHaveBeenCalledTimes(2)
  expect(f.billing.checkPoints).toHaveBeenCalledTimes(4)
})
it('leaves unbound calls available and removes its listener when unloaded', async () => {
  const f = await setup()
  f.points(0)
  await f.run('unrelated')
  expect(f.billing.checkPoints).not.toHaveBeenCalled()
  await f.fiber.dispose()
  await f.run()
  expect(f.provider).toHaveBeenCalledTimes(2)
})
