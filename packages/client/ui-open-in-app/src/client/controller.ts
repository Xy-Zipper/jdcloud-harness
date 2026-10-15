/** Browser availability/choice state and the launch carrier for the split button. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_ICON_PREFIX_ROUTE, OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload, type OpenInAppOpenPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type CreateObjectUrl = (blob: Blob) => string
type RevokeObjectUrl = (url: string) => void

/**
 * Owns the once-per-page availability read, the persisted last choice, and
 * the launch POST. Availability and choice publish through uSES-safe sources
 * so every Session header shares one truth.
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
    this.choice.set(appId)
  }

  /**
   * Launch one installed app on a workspace directory.
   * @param appId - catalog id from the availability list.
   * @param path - the session's absolute workspace directory.
   * @returns after the host acknowledged the launch; rejects on any failure.
   */
  async launch(appId: string, path: string): Promise<void> {
    const body: OpenInAppOpenPayload = { app: appId, path }
    const response = await this.fetcher(OPEN_IN_APP_OPEN_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`open failed: HTTP ${String(response.status)}`)
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
    } catch {
      // Swallows network failures: an unreachable host reads as no apps, and
      // the header simply shows no button rather than a broken one.
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
