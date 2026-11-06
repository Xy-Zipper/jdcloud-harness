/** The registered image tools must reject paid submissions from a planning-only turn. */
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/plugin.mjs'

const cleanups = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(dispose => dispose())) })

it.each(['creation_studio_image_generate', 'creation_studio_image_task'])('blocks %s before any provider or platform request during planning', async (name) => {
  const tools = new Map()
  const platform = vi.fn()
  const effects = []
  const ctx = {
    jdcloudAuthController: { requestAuthenticated: platform, currentScopeKey: vi.fn() },
    credentials: { resolve: vi.fn() },
    webServer: { register: () => () => {} },
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    on: () => () => {},
    effect: callback => { const dispose = callback(); effects.push(dispose); return dispose },
  }
  cleanups.push(async () => { for (const dispose of effects.reverse()) await dispose?.() })
  const config = { platformURL: 'https://platform.example', tenantId: 'a'.repeat(24), stateDirectory: '.unused-planning-state' }
  apply(ctx, config)
  const args = { projectId: 'project', planId: 'plan', spaceId: 'space', action: 'submit',
    prompt: 'product', model: 'doubao-seedream-5-0-pro-260628', referenceIds: [], size: '1024x1024', requestId: 'planning-request' }
  const exec = { agent: { session: { snapshotEvents: () => [{ type: 'user/message', data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({
      context: { tenantId: config.tenantId, projectId: args.projectId, planId: args.planId, spaceId: args.spaceId },
      request: { generateImages: false },
    }) }],
  } }] } } }
  await expect(Promise.resolve().then(() => tools.get(name).execute(args, exec))).rejects.toThrow('页面确认积分')
  expect(platform).not.toHaveBeenCalled()
})
