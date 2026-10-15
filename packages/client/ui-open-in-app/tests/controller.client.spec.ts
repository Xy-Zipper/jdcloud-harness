/** Controller wire behavior: document-relative routes, availability filtering, and launch errors. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenInAppController } from '../src/client/controller.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('OpenInAppController availability', () => {
  it('starts without a platform-specific choice', () => {
    const controller = new OpenInAppController(async () => jsonResponse({ apps: [] }))
    expect(controller.choice.getSnapshot()).toBe('')
  })

  it('shares one availability read across concurrent loads', async () => {
    const fetcher = vi.fn(async (input: string | URL) => String(input) === 'open-in-app/apps'
      ? jsonResponse({ apps: ['finder'] })
      : new Response('icon', { headers: { 'content-type': 'image/png' } }))
    const create = vi.fn(() => 'blob:finder')
    const revoke = vi.fn()
    const controller = new OpenInAppController(fetcher, create, revoke)
    await Promise.all([controller.load(), controller.load()])
    await controller.load()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['open-in-app/apps', 'open-in-app/icon/finder'])
    expect(controller.apps.getSnapshot()).toEqual(['finder'])
    expect(controller.icons.getSnapshot()).toEqual({ finder: 'blob:finder' })
    expect(create).toHaveBeenCalledOnce()
    await controller.dispose()
    expect(revoke).toHaveBeenCalledWith('blob:finder')
  })

  it('publishes an empty list for a non-OK availability answer and for a non-array payload', async () => {
    const failing = new OpenInAppController(async () => jsonResponse({}, 500))
    await failing.load()
    expect(failing.apps.getSnapshot()).toEqual([])

    const malformed = new OpenInAppController(async () => jsonResponse({ apps: 'nope' }))
    await malformed.load()
    expect(malformed.apps.getSnapshot()).toEqual([])
  })

  it('uses fallback glyphs for unavailable icons and ignores loads after disposal', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === 'open-in-app/apps') return jsonResponse({ apps: ['finder', 'cursor'] })
      if (String(input).endsWith('/finder')) return new Response('', { status: 404 })
      throw new Error('icon transport failed')
    })
    const controller = new OpenInAppController(fetcher, vi.fn(), vi.fn())
    await controller.load()
    expect(controller.icons.getSnapshot()).toEqual({ finder: null, cursor: null })
    await controller.dispose()
    await controller.load()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('releases an icon that settles while disposal is waiting', async () => {
    const icon = Promise.withResolvers<Response>()
    const fetcher = vi.fn(async (input: string | URL) => String(input) === 'open-in-app/apps'
      ? jsonResponse({ apps: ['finder'] })
      : icon.promise)
    const revoke = vi.fn()
    const controller = new OpenInAppController(fetcher, () => 'blob:late-icon', revoke)
    const loading = controller.load()
    await vi.waitFor(() => { expect(controller.apps.getSnapshot()).toEqual(['finder']) })
    const disposing = controller.dispose()
    icon.resolve(new Response('icon'))
    await Promise.all([loading, disposing])
    expect(controller.icons.getSnapshot()).toEqual({})
    expect(revoke).toHaveBeenCalledWith('blob:late-icon')
  })

  it('requests the document-relative availability route', async () => {
    const fetcher = vi.fn(async (input: string | URL) => { void input; return jsonResponse({ apps: [] }) })
    const controller = new OpenInAppController(fetcher)
    await controller.load()
    expect(fetcher.mock.calls[0]?.[0]).toBe('open-in-app/apps')
  })
})

describe('OpenInAppController launching', () => {
  it('restores the chosen app from the open-in-app storage key', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const controller = new OpenInAppController(async () => jsonResponse({ apps: [] }))
    controller.choose('cursor')
    expect(controller.choice.getSnapshot()).toBe('cursor')
    expect(values.get('dsh.open-in-app.choice')).toBe('"cursor"')
    const reloaded = new OpenInAppController(async () => jsonResponse({ apps: [] }))
    expect(reloaded.choice.getSnapshot()).toBe('cursor')
  })

  it('posts the launch body and surfaces HTTP failures', async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => { void input; void init; return jsonResponse({ ok: true }) })
    const controller = new OpenInAppController(fetcher)
    await controller.launch('cursor', '/w/dir')
    expect(fetcher.mock.calls[0]?.[0]).toBe('open-in-app/open')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: '/w/dir' }),
    })

    const failing = new OpenInAppController(async () => jsonResponse({}, 404))
    await expect(failing.launch('cursor', '/w/dir')).rejects.toThrow('open failed: HTTP 404')
  })
})
