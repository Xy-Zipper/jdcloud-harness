/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. JDCloud-authenticated requests are
 * restricted to roots owned by the current tenant-user; generic deployments
 * retain the connection service's existing filesystem policy.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

async function serveFile(
  request: Request,
  fs: FileSystem,
  maxBytes: number,
  allowedRoots?: readonly FsTarget[],
): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    if (allowedRoots !== undefined && !allowedRoots.some(root => fs.contains(root, target))) {
      return fail(403, 'workspace access denied')
    }
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
    }
    if (request.method === 'HEAD') {
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        if (info.size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(info.size)
      }
      return new Response(null, { headers })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async request => serveFile(request, ctx.fs, maxBytes, await authorizedRoots(ctx)),
    }), 'session-controller: /api/file')
  },
}

interface ScopeOwner {
  owns(kind: 'session' | 'workspace', id: string): Promise<boolean>
}

interface WorkspaceLike {
  readonly id: string
  readonly path: string
}

interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

/** Resolve roots visible to the current tenant-user; absent auth keeps generic deployments unchanged. */
async function authorizedRoots(ctx: Context): Promise<readonly FsTarget[] | undefined> {
  const owner = ctx.get('jdcloudAuthController') as ScopeOwner | undefined
  if (owner === undefined) return undefined
  const roots: FsTarget[] = []
  const fs = ctx.fs
  const registry = ctx.get('workspaceRegistry') as { list(): readonly WorkspaceLike[] } | undefined
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      if (await owner.owns('workspace', String(workspace.id))) roots.push(await fs.resolve(workspace.path))
    }
  }
  const sessions = ctx.get('sessions') as { list(): readonly SessionLike[] } | undefined
  if (sessions !== undefined) {
    for (const session of sessions.list()) {
      if (session.header.cwd !== undefined && await owner.owns('session', String(session.id))) {
        roots.push(await fs.resolve(session.header.cwd))
      }
    }
  }
  return roots
}
