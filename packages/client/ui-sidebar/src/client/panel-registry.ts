import { Service, type Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Client-side visibility policy for global sidebar panels. */
export class SidebarPanelRuntime extends Service {
  private readonly filters = new Set<(id: MainPanelId) => boolean>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'sidebarPanels')
  }

  /** Register one reversible panel visibility policy. */
  registerAvailabilityFilter(filter: (id: MainPanelId) => boolean): () => void {
    const dispose = this.ctx.effect(() => {
      this.filters.add(filter)
      this.notify()
      return () => {
        this.filters.delete(filter)
        this.notify()
      }
    }, 'sidebarPanels.registerAvailabilityFilter()')
    return () => { void dispose() }
  }

  /** Return whether every active policy allows a panel. */
  isAvailable(id: MainPanelId): boolean {
    return [...this.filters].every(filter => filter(id))
  }

  /** Observe policy changes so the sidebar projection stays current. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
