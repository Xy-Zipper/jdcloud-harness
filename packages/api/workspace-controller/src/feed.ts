/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState,
  workspaceRecord,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

interface ScopeOwner {
  currentScopeKey(): Promise<string | undefined>
  owns(kind: 'session' | 'workspace', id: string, expectedScopeKey?: string): Promise<boolean>
}

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Owns Workspace domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private knownIds: Set<string>
  private order: readonly string[]
  private archived: readonly string[]
  private pinned: readonly string[]

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    const baseline = ctx.workspaceRegistry.list()
    this.knownIds = new Set(baseline.map(workspace => String(workspace.id)))
    this.order = baseline.map(workspace => String(workspace.id))
    this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    this.pinned = ctx.workspaceRegistry.pinnedSessionIds.map(String)
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all active Workspaces plus archived and pinned Session identities.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: this.ctx.workspaceRegistry.list().map(workspaceView),
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds],
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    signal.throwIfAborted()
    const owner = this.ctx.get('jdcloudAuthController') as ScopeOwner | undefined
    const scopeKey = owner === undefined ? undefined : await owner.currentScopeKey()
    const follower = new WorkspaceFollower(owner, scopeKey)
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: await this.scopedBaseline(owner, scopeKey) }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private async scopedBaseline(
    owner: ScopeOwner | undefined,
    scopeKey: string | undefined,
  ): Promise<WorkspaceBaseline> {
    if (owner === undefined) return this.baseline()
    if (scopeKey === undefined) return { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
    const items = []
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (await owner.owns('workspace', String(workspace.id), scopeKey)) items.push(workspaceView(workspace))
    }
    const archivedSessionIds: string[] = []
    for (const sessionId of this.ctx.workspaceRegistry.archivedSessionIds) {
      if (await owner.owns('session', String(sessionId), scopeKey)) archivedSessionIds.push(String(sessionId))
    }
    const pinnedSessionIds: WorkspaceBaseline['pinnedSessionIds'][number][] = []
    for (const sessionId of this.ctx.workspaceRegistry.pinnedSessionIds) {
      if (await owner.owns('session', String(sessionId), scopeKey)) pinnedSessionIds.push(sessionId)
    }
    return {
      items,
      archivedSessionIds: archivedSessionIds as unknown as WorkspaceBaseline['archivedSessionIds'],
      pinnedSessionIds,
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace') return
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceDomainState.parse(change.value)
      const nextOrder = state.workspaceIds.map(String)
      const orderChanged = !sameStrings(this.order, nextOrder)
      for (const id of state.workspaceIds) {
        if (this.knownIds.has(id)) continue
        const workspace = this.ctx.workspaceRegistry.get(id)
        if (workspace === undefined) {
          throw new Error(`committed Workspace registry references missing Workspace "${id}"`)
        }
        this.knownIds.add(id)
        this.publish({ type: 'upsert', workspace: workspaceView(workspace) })
      }
      this.order = nextOrder
      if (orderChanged) this.publish({ type: 'order', workspaceIds: [...state.workspaceIds] })
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(this.archived, nextArchived)) {
        this.archived = nextArchived
        this.publish({ type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(this.pinned, nextPinned)) {
        this.pinned = nextPinned
        this.publish({ type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      if (!this.knownIds.delete(change.key)) return
      this.publish({ type: 'remove', workspaceId: WorkspaceId(change.key) })
      return
    }
    if (!this.knownIds.has(change.key)) return
    this.publish({
      type: 'upsert',
      workspace: changedWorkspaceView(change.key, change.value),
    })
  }

  private publish(frame: Exclude<WorkspaceFollowFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) void follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFollowFrame>()
  private waiting: (() => void) | undefined
  private closed = false
  private pending = Promise.resolve()

  constructor(
    private readonly owner: ScopeOwner | undefined,
    private readonly scopeKey: string | undefined,
  ) {}

  async push(frame: WorkspaceFollowFrame): Promise<void> {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.pending = this.pending.then(async () => {
      if (this.closed) return
      if (this.owner !== undefined && this.scopeKey !== undefined) {
        if (frame.type === 'upsert' && !(await this.owner.owns('workspace', String(frame.workspace.workspaceId), this.scopeKey))) return
        if (frame.type === 'remove' && !(await this.owner.owns('workspace', String(frame.workspaceId), this.scopeKey))) return
        if (frame.type === 'order') {
          const workspaceIds = []
          for (const id of frame.workspaceIds) {
            if (await this.owner.owns('workspace', String(id), this.scopeKey)) workspaceIds.push(id)
          }
          frame = { type: 'order', workspaceIds }
        }
        if (frame.type === 'archived') {
          const archivedSessionIds = []
          for (const id of frame.archivedSessionIds) {
            if (await this.owner.owns('session', String(id), this.scopeKey)) archivedSessionIds.push(id)
          }
          frame = { type: 'archived', archivedSessionIds }
        }
        if (frame.type === 'pinned') {
          const pinnedSessionIds = []
          for (const id of frame.pinnedSessionIds) {
            if (await this.owner.owns('session', String(id), this.scopeKey)) pinnedSessionIds.push(id)
          }
          frame = { type: 'pinned', pinnedSessionIds }
        }
      }
      /* oxlint-disable-next-line no-unnecessary-condition -- close() may run while queued ownership checks await. */
      if (this.closed) return
      this.frames.pushBack(frame)
      this.waiting?.()
    })
    await this.pending
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}
