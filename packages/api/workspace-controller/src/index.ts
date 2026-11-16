/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceId,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
  WorkspaceView,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

/** First-use directory policy for the Host account. */
export interface Config {
  /** Override the system Documents directory with a fully qualified path. */
  documentsDirectory?: string
  /** Maximum duration of the operating system's Documents lookup. */
  documentsLookupTimeoutMs?: number
}

/** Directory policy after schema defaults have been applied. */
type ResolvedConfig = Config & { documentsLookupTimeoutMs: number }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}


interface ScopeOwner {
  currentScopeKey(): Promise<string | undefined>
  owns(kind: 'session' | 'workspace', id: string, expectedScopeKey?: string): Promise<boolean>
}


/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['remoteAccess', 'typert', 'workspaceRegistry']

  static Config: z<Config, ResolvedConfig> = z.object({
    documentsDirectory: z.string(),
    documentsLookupTimeoutMs: z.natural().min(1).default(10_000),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - first-use directory policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    ctx.typert.resources.register('workspace', { field: 'workspaceId' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  async create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Initialize or reuse the default Workspace during first-use startup. The
   * directory name is fixed, so the Host never renames or relocates an
   * existing default; its initial title is that same name, which browser
   * consumers label in the reader's language.
   * @param signal - caller lifetime; cancels native directory lookup.
   * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
   */
  @Remote('initializeDefault')
  async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
    // JDCloud users select their own account-contained Workspace directories.
    if (this.ctx.get('jdcloudAuthController') !== undefined) return undefined
    const workspace = await this.ctx.workspaceRegistry.initializeDefault(async () => {
      const timeout = AbortSignal.timeout(this.config.documentsLookupTimeoutMs)
      return await defaultWorkspaceDirectory(
        this.config.documentsDirectory, AbortSignal.any([signal, timeout]),
      )
    })
    return workspace === undefined ? undefined : { workspace: workspaceView(workspace) }
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  async rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    await this.assertOwned('workspace', String(request.workspaceId))
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  async delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    await this.assertOwned('workspace', String(request.workspaceId))
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    await this.assertOwned('workspace', String(request.workspaceId))
    if (request.beforeWorkspaceId !== undefined) await this.assertOwned('workspace', request.beforeWorkspaceId)
    const result = await this.commands.insertBefore(request)
    return { workspaceIds: await this.ownedIds('workspace', result.workspaceIds) }
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    await this.assertOwned('workspace', String(request.workspaceId))
    await this.assertOwned('session', request.sessionId)
    if (request.beforeSessionId !== undefined) await this.assertOwned('session', request.beforeSessionId)
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.assertOwned('session', String(request.sessionId))
    const result = await this.commands.archiveSession(request)
    return { archivedSessionIds: await this.ownedIds('session', result.archivedSessionIds) }
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.assertOwned('session', String(request.sessionId))
    const result = await this.commands.unarchiveSession(request)
    return { archivedSessionIds: await this.ownedIds('session', result.archivedSessionIds) }
  }

  /**
   * Surface one known unarchived Session ahead of unpinned Sessions.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('pinSession')
  async pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    await this.assertOwned('session', String(request.sessionId))
    const result = await this.commands.pinSession(request)
    return { pinnedSessionIds: await this.ownedIds('session', result.pinnedSessionIds) }
  }

  /**
   * Remove one Session's pin without changing its saved Session order.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('unpinSession')
  async unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    await this.assertOwned('session', String(request.sessionId))
    const result = await this.commands.unpinSession(request)
    return { pinnedSessionIds: await this.ownedIds('session', result.pinnedSessionIds) }
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments. A
   * non-owner receives only the Workspaces and Sessions `allows()` admits.
   * When a delivered Workspace is no longer admitted at its next change or
   * the next order change, the stream sends a `replace` frame with the
   * complete filtered state instead of a `remove`, because a Client never
   * resurrects a removed Workspace; a `remove` frame reports a deletion and
   * reaches only a Client that received that Workspace.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    const access = this.ctx.remoteAccess
    const visible = (workspaceId: WorkspaceId): boolean => access.allows({ kind: 'workspace', id: workspaceId })
    const sessions = (sessionIds: readonly SessionId[]): SessionId[] =>
      sessionIds.filter(sessionId => access.allows({ kind: 'session', id: sessionId }))
    /** Workspaces this generation has delivered and not yet removed. */
    const delivered = new Set<WorkspaceId>()
    /** The admitted part of `value`; it becomes the delivered set. */
    const filtered = (value: WorkspaceBaseline): WorkspaceBaseline => {
      const items = value.items.filter(item => visible(item.workspaceId))
      delivered.clear()
      for (const item of items) delivered.add(item.workspaceId)
      return {
        items: items.map(item => ({ ...item, sessionIds: sessions(item.sessionIds) })),
        archivedSessionIds: sessions(value.archivedSessionIds),
        pinnedSessionIds: sessions(value.pinnedSessionIds),
      }
    }
    const owner = this.ctx.get('jdcloudAuthController') as ScopeOwner | undefined
    const scopeKey = await owner?.currentScopeKey()
    for await (let frame of this.feed.follow(signal)) {
      if (owner !== undefined) {
        const owned = async (kind: 'workspace' | 'session', id: string): Promise<boolean> => scopeKey !== undefined && owner.owns(kind, id, scopeKey)
        if (frame.type === 'baseline') {
          const items = []
          for (const item of frame.value.items) if (await owned('workspace', item.workspaceId)) items.push({ ...item, sessionIds: await this.ownedIds('session', item.sessionIds, scopeKey) })
          const archivedSessionIds = []
          for (const id of frame.value.archivedSessionIds) if (await owned('session', id)) archivedSessionIds.push(id)
          const pinnedSessionIds = []
          for (const id of frame.value.pinnedSessionIds) if (await owned('session', id)) pinnedSessionIds.push(id)
          frame = { type: 'baseline', value: { items, archivedSessionIds, pinnedSessionIds } }
        } else if (frame.type === 'upsert') {
          if (!await owned('workspace', frame.workspace.workspaceId)) continue
          frame = { ...frame, workspace: { ...frame.workspace, sessionIds: await this.ownedIds('session', frame.workspace.sessionIds, scopeKey) } }
        }
        else if (frame.type === 'remove' && !await owned('workspace', frame.workspaceId)) continue
        else if (frame.type === 'order') {
          const workspaceIds = []
          for (const id of frame.workspaceIds) if (await owned('workspace', id)) workspaceIds.push(id)
          frame = { type: 'order', workspaceIds }
        } else if (frame.type === 'archived') {
          const archivedSessionIds = []
          for (const id of frame.archivedSessionIds) if (await owned('session', id)) archivedSessionIds.push(id)
          frame = { type: 'archived', archivedSessionIds }
        } else if (frame.type === 'pinned') {
          const pinnedSessionIds = []
          for (const id of frame.pinnedSessionIds) if (await owned('session', id)) pinnedSessionIds.push(id)
          frame = { type: 'pinned', pinnedSessionIds }
        }
      }
      switch (frame.type) {
        case 'baseline':
          yield { type: 'baseline', value: filtered(frame.value) }
          break
        case 'upsert': {
          const workspaceId = frame.workspace.workspaceId
          if (visible(workspaceId)) {
            delivered.add(workspaceId)
            yield { type: 'upsert', workspace: { ...frame.workspace, sessionIds: sessions(frame.workspace.sessionIds) } }
          } else if (delivered.has(workspaceId)) {
            yield { type: 'replace', value: filtered(this.feed.baseline()) }
          }
          break
        }
        case 'remove':
          if (delivered.delete(frame.workspaceId)) yield frame
          break
        case 'order':
          if (frame.workspaceIds.some(workspaceId => delivered.has(workspaceId) && !visible(workspaceId))) {
            yield { type: 'replace', value: filtered(this.feed.baseline()) }
          } else {
            yield { type: 'order', workspaceIds: frame.workspaceIds.filter(visible) }
          }
          break
        case 'archived':
          yield { type: 'archived', archivedSessionIds: sessions(frame.archivedSessionIds) }
          break
        case 'pinned':
          yield { type: 'pinned', pinnedSessionIds: sessions(frame.pinnedSessionIds) }
          break
        /* v8 ignore next -- closed follow-frame union. */
        default:
          assertNever(frame)
      }
    }
  }


  /**
   * Read the Workspaces owned by the current authenticated account scope.
   * @returns Detached Workspace projections in durable registry order.
   */
  async listVisible(): Promise<readonly WorkspaceView[]> {
    const owner = this.ctx.get('jdcloudAuthController') as ScopeOwner | undefined
    if (owner === undefined) return this.ctx.workspaceRegistry.list().map(workspaceView)
    const scopeKey = await owner.currentScopeKey()
    if (scopeKey === undefined) return []
    const visible: WorkspaceView[] = []
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (await owner.owns('workspace', String(workspace.id), scopeKey)) visible.push({ ...workspaceView(workspace), sessionIds: await this.ownedIds('session', workspace.sessionIds, scopeKey) })
    }
    return visible
  }

  /** Retain only ids owned by the opening JDCloud account. */
  private async ownedIds<T extends string>(kind: 'session' | 'workspace', ids: readonly T[], scopeKey?: string): Promise<T[]> {
    const owner = this.ctx.get('jdcloudAuthController') as ScopeOwner | undefined
    if (owner === undefined) return [...ids]
    const visible: T[] = []
    for (const id of ids) if (await owner.owns(kind, id, scopeKey)) visible.push(id)
    return visible
  }

  /** Refuse resource ids outside the signed-in JDCloud account. */
  private async assertOwned(kind: 'session' | 'workspace', id: string): Promise<void> {
    const owner = this.ctx.get('jdcloudAuthController') as ScopeOwner | undefined
    if (owner !== undefined && !await owner.owns(kind, id)) throw kind === 'session'
      ? new RemoteError('session/not-found', `session "${id}" not found`, { sessionId: id as SessionId })
      : new RemoteError('workspace/not-found', `workspace "${id}" not found`, { workspaceId: id as WorkspaceId })
  }
}

/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`unreachable Workspace follow frame: ${JSON.stringify(value)}`)
}

export default WorkspaceController
