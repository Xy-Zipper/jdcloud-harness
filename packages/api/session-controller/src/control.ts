/** Live Session projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionValues,
} from './types.ts'

interface ScopeOwner {
  currentScopeKey(): Promise<string | undefined>
  owns(kind: 'session' | 'workspace', id: string, expectedScopeKey?: string): Promise<boolean>
}

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()

  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        key,
        value: value as JsonValue,
        seq,
      })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const owner = this.ctx.get('jdcloudAuthController') as ScopeOwner | undefined
    const scopeKey = owner === undefined ? undefined : await owner.currentScopeKey()
    const queue = new ControlQueue(owner, scopeKey)
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: await this.scopedBaseline(owner, scopeKey) }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    return {
      projections: this.projectionBaseline(sessions),
    }
  }

  private async scopedBaseline(
    owner: ScopeOwner | undefined,
    scopeKey: string | undefined,
  ): Promise<SessionControlBaseline> {
    if (owner === undefined) return this.baseline()
    if (scopeKey === undefined) return { jobs: {}, projections: {} }
    const sessions: Session[] = []
    for (const session of this.ctx.sessions.list()) {
      if (await owner.owns('session', String(session.id), scopeKey)) sessions.push(session)
    }
    const jobs = Object.create(null) as Record<SessionId, readonly SessionJob[]>
    for (const session of sessions) {
      const agent = this.ctx.agents.get(session.id)
      jobs[session.id] = this.jobsFor(agent)
    }
    return { jobs, projections: this.projectionBaseline(sessions) }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      blocks[session.id] = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
      }
    }
    return blocks
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) void stream.push(frame)
  }
}

class ControlQueue {
  private readonly buffer = new Deque<SessionControlFrame>()
  private wake: (() => void) | undefined
  private done = false
  private pending = Promise.resolve()

  constructor(
    private readonly owner: ScopeOwner | undefined,
    private readonly scopeKey: string | undefined,
  ) {}

  async push(frame: SessionControlFrame): Promise<void> {
    if (this.done) return
    if (this.owner === undefined || this.scopeKey === undefined) {
      this.buffer.pushBack(frame)
      const wake = this.wake
      this.wake = undefined
      wake?.()
      return
    }
    this.pending = this.pending.then(async () => {
      if (this.done) return
      const owner = this.owner
      const scopeKey = this.scopeKey
      if (frame.type !== 'baseline'
        && owner !== undefined && scopeKey !== undefined
        && !(await owner.owns('session', String(frame.sessionId), scopeKey))) return
      this.buffer.pushBack(frame)
      const wake = this.wake
      this.wake = undefined
      wake?.()
    })
    await this.pending
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.popFront()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as SessionControlFrame
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}
