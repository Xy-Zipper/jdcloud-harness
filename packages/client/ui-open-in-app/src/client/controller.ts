/** Shared directory application catalog, preference, and launch carrier for controls and menus. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_ICON_PREFIX_ROUTE, OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload, type OpenInAppOpenPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'

import { APP_LABEL_KEY } from './applications.ts'
import type { OpenInAppOutcome } from './outcome.ts'

/** Shared launch status for controls targeting the captured workspace path. */
export interface OpenInAppLaunchState {
  readonly phase: 'idle' | 'busy' | 'error'
  readonly path: string | null
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type CreateObjectUrl = (blob: Blob) => string
type RevokeObjectUrl = (url: string) => void

/**
 * Owns the once-per-page availability read, the persisted last choice, and
 * the launch POST. Availability and choice publish through uSES-safe sources
 * so Session menus and directory controls share the same catalog and choice.
 */
export class OpenInAppController {
  /** Installed app ids in host menu order; null until the host answered. */
  readonly apps: SnapshotStore<readonly string[] | null> = createSnapshotStore<readonly string[] | null>(null)
  /** Authenticated application icons keyed by catalog id; null selects the shared fallback glyph. */
  readonly icons: SnapshotStore<Readonly<Record<string, string | null>>> = createSnapshotStore({})
  /** Last chosen app id, or empty before the first choice, shared across sessions and browser restarts. */
  readonly choice: SnapshotStore<string> = createSnapshotStore<string>('', {
    persist: { name: 'dsh.open-in-app.choice' },
  })

  /** Current launch, shared by pointer and keyboard gestures. */
  readonly operation = createSnapshotStore<OpenInAppLaunchState>({ phase: 'idle', path: null })

  /**
   * Resolve the remembered nameable installed application, with the button's first-app fallback.
   * @returns the installed app id, or undefined while unavailable.
   */
  currentApp(): string | undefined {
    const apps = (this.apps.getSnapshot() ?? []).filter(id => APP_LABEL_KEY[id] !== undefined)
    const choice = this.choice.getSnapshot()
    return apps.includes(choice) ? choice : apps[0]
  }

  private loading: Promise<void> | undefined
  private readonly abort = new AbortController()
  private readonly iconUrls = new Set<string>()
  private disposed = false

  /**
   * @param fetcher - HTTP carrier for the apps read and the launch POST.
   * @param createObjectUrl - browser Blob URL factory for authenticated app icons.
   * @param revokeObjectUrl - browser Blob URL release operation.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly createObjectUrl: CreateObjectUrl = blob => URL.createObjectURL(blob),
    private readonly revokeObjectUrl: RevokeObjectUrl = (url) => { URL.revokeObjectURL(url) },
  ) {}

  /**
   * Read availability once per controller life; concurrent calls share the read.
   * A failed read publishes an empty list, which renders no button at all.
   * @returns after availability is published.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.loading ??= this.run()
    return this.loading
  }

  /** Abort pending icon reads and release every page-owned Blob URL. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.abort.abort()
    await Promise.allSettled(this.loading === undefined ? [] : [this.loading])
    for (const url of this.iconUrls) this.revokeObjectUrl(url)
    this.iconUrls.clear()
    this.icons.set({})
  }

  /**
   * Remember one picked app id.
   * @param appId - catalog id from the availability list.
   */
  choose(appId: string): void {
    if (this.operation.getSnapshot().phase !== 'busy') this.choice.set(appId)
  }

  /**
   * Launch one installed app on a workspace directory.
   * @param appId - catalog id from the availability list.
   * @param path - the session's absolute workspace directory.
   * Concurrent gestures are ignored until the current Host request settles.
   * @returns the acknowledged handoff, or `{ kind: 'skipped' }` while another
   * launch holds the operation, or a named failure when the Host refuses or
   * cannot be reached. Host and transport failures resolve without rejecting.
   */
  async launch(appId: string, path: string): Promise<OpenInAppOutcome> {
    if (this.operation.getSnapshot().phase === 'busy') return { kind: 'skipped' }
    this.operation.set({ phase: 'busy', path })
    const body: OpenInAppOpenPayload = { app: appId, path }
    try {
      const response = await this.fetcher(OPEN_IN_APP_OPEN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`open failed: HTTP ${String(response.status)}`)
      this.operation.set({ phase: 'idle', path })
      return { kind: 'opened' }
    } catch (_error) {
      // Refusal and transport failure share the same user-visible outcome.
      this.operation.set({ phase: 'error', path })
      return { kind: 'failed', failure: 'openError' }
    }
  }

  private async run(): Promise<void> {
    let apps: readonly string[] = []
    try {
      const response = await this.fetcher(OPEN_IN_APP_APPS_ROUTE, {
        headers: { accept: 'application/json' },
        signal: this.abort.signal,
      })
      if (response.ok) {
        const payload = await response.json() as OpenInAppAppsPayload
        if (Array.isArray(payload.apps)) apps = payload.apps.filter(id => typeof id === 'string')
      }
    } catch (_error) {
      // An unreachable Host supplies no directory openers in menus or controls.
    }
    this.apps.set(apps)
    const icons = Object.fromEntries(await Promise.all(apps.map(async appId => [
      appId,
      await this.loadIcon(appId),
    ] as const)))
    if (this.disposed) {
      for (const url of Object.values(icons)) if (url !== null) this.revokeObjectUrl(url)
      return
    }
    for (const url of Object.values(icons)) if (url !== null) this.iconUrls.add(url)
    this.icons.set(icons)
  }

  private async loadIcon(appId: string): Promise<string | null> {
    try {
      const response = await this.fetcher(`${OPEN_IN_APP_ICON_PREFIX_ROUTE}/${encodeURIComponent(appId)}`, {
        signal: this.abort.signal,
      })
      return response.ok ? this.createObjectUrl(await response.blob()) : null
    } catch {
      return null
    }
  }
}
