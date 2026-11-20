/** Copy an owned Workspace into its account directory before publishing its registration. */

import { constants, createWriteStream, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'workspace/copy-failed': {}
    'workspace/copy-cleanup-failed': {}
    'workspace/copy-registration-failed': {}
    'workspace/copy-source-changed': {}
    'workspace/copy-unsupported-entry': { readonly path: string }
  }
}

/**
 * Copy files without following links. Each copy has an exclusive parent so repeated titles cannot collide.
 * @param root - Canonical directory of the authenticated account.
 * @param source - Canonical directory recorded for the owned Workspace.
 * @param name - Validated single directory name and initial Workspace title.
 * @param signal - Cancels before Workspace registration and removes incomplete files.
 * @returns The fully copied child directory, ready for registration.
 */
export async function copyWorkspaceDirectory(root: string, source: string, name: string, signal: AbortSignal): Promise<string> {
  const location = relative(root, source)
  if (location === '' || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new RemoteError('gateway/bad-request', 'Source Workspace must be inside the authenticated Workspace root', {})
  }

  let parent: string | undefined
  try {
    signal.throwIfAborted()
    const sourceInfo = await lstat(source, { bigint: true })
    if (!sourceInfo.isDirectory() || relative(source, await realpath(source)) !== '') throw sourceChanged()
    parent = await mkdtemp(join(root, '.workspace-copy-'))
    const destination = join(parent, name)
    await copyEntry(source, destination, '', sourceInfo, signal)
    signal.throwIfAborted()
    return destination
  } catch (error) {
    if (parent !== undefined) {
      try {
        await rm(parent, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new RemoteError('workspace/copy-cleanup-failed', 'Workspace copy failed and temporary files may remain', {}, {
          cause: new AggregateError([error, cleanupError], 'Workspace copy and cleanup both failed'),
        })
      }
    }
    if (remoteErrorOf(error) !== undefined) throw error
    if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) {
      throw new RemoteError('gateway/cancelled', 'Workspace copy was cancelled', {}, { cause: error })
    }
    throw new RemoteError('workspace/copy-failed', 'Could not copy the Workspace files', {}, { cause: error })
  }
}

async function copyEntry(source: string, destination: string, displayPath: string, info: BigIntStats, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!info.isDirectory() && !info.isFile()) {
    throw new RemoteError('workspace/copy-unsupported-entry', 'Workspace copy requires ordinary files and directories', { path: displayPath })
  }
  if (relative(source, await realpath(source)) !== '') throw sourceChanged()

  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    for (const name of await readdir(source)) {
      const child = join(source, name)
      await copyEntry(child, join(destination, name), displayPath === '' ? name : `${displayPath}/${name}`, await lstat(child, { bigint: true }), signal)
    }
  } else {
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await input.stat({ bigint: true })
      if (!opened.isFile() || !sameEntry(info, opened) || relative(source, await realpath(source)) !== '') throw sourceChanged()
      const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 | Number(info.mode & 0o100n) })
      await pipeline(input.createReadStream({ autoClose: false }), output, { signal })
    } finally {
      await input.close()
    }
  }
  if (!sameEntry(info, await lstat(source, { bigint: true })) || relative(source, await realpath(source)) !== '') throw sourceChanged()
}

function sameEntry(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

function sourceChanged(): RemoteError<'workspace/copy-source-changed'> {
  return new RemoteError('workspace/copy-source-changed', 'Source Workspace changed while it was being copied', {})
}
