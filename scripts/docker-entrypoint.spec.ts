/** Linux container startup owns its data directory until the launched process exits. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawnEntrypoint>>()
const entrypoint = resolve(import.meta.dirname, '../docker-entrypoint.sh')

function spawnEntrypoint(home: string, bin: string, script: string) {
  return execa('/bin/sh', [entrypoint, process.execPath, '-e', script], {
    env: { DSH_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdin: 'pipe',
    reject: false,
  })
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  await Promise.allSettled(children)
  children.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-docker-entrypoint-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  await mkdir(bin)
  await mkdir(profile, { recursive: true })
  // Only package installation is replaced; the entrypoint, flock and final Node process are real.
  await writeFile(join(bin, 'node'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DSH_HOME/install-calls"
test ! -e "$DSH_HOME/profiles/web/package.json.lock" || exit 22
test ! -e "$DSH_HOME/fail-install" || exit 23
`, { mode: 0o755 })
  const launch = (script = 'process.stdout.write("READY\\n")') => {
    const child = spawnEntrypoint(home, bin, script)
    children.add(child)
    return child
  }
  return { home, profile, launch }
}

async function ready(child: ReturnType<typeof spawnEntrypoint>): Promise<void> {
  let output = ''
  const reached = Promise.withResolvers<undefined>()
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (output.includes('READY\n')) reached.resolve(undefined)
  })
  await Promise.race([
    reached.promise,
    child.then((result) => {
      throw new Error(`entrypoint exited before readiness: ${String(result.exitCode)} ${result.stderr}`)
    }),
  ])
}

// The shipped image runs Linux sh/flock; Windows exercises this suite inside that image.
describe.skipIf(process.platform !== 'linux')('Docker entrypoint', () => {
  it('removes orphaned install locks while retaining profile and Session files', async () => {
    const { home, profile, launch } = await fixture()
    await writeFile(join(profile, 'package.json.lock'), `${process.pid}\n`)
    await writeFile(join(profile, 'package.json.lock.takeover-stale'), '8\n')
    await writeFile(join(profile, 'package.json'), '{"keep":true}\n')
    await writeFile(join(home, 'session.jsonl'), 'keep session\n')
    const result = await launch()
    expect(result).toMatchObject({ exitCode: 0, timedOut: false })
    expect(result.signal).toBeUndefined()
    await expect(readFile(join(profile, 'package.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(profile, 'package.json.lock.takeover-stale'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe('{"keep":true}\n')
    expect(await readFile(join(home, 'session.jsonl'), 'utf8')).toBe('keep session\n')
  })

  it('rejects another instance before touching the active instance’s install lock', async () => {
    const { home, profile, launch } = await fixture()
    const first = launch('process.stdout.write("READY\\n"); process.stdin.once("data", () => process.exit(0))')
    await ready(first)
    await writeFile(join(profile, 'package.json.lock'), 'active writer\n')
    const second = await launch()
    expect(second).toMatchObject({ exitCode: 1, timedOut: false })
    expect(second.stderr).toContain('already in use')
    expect(await readFile(join(profile, 'package.json.lock'), 'utf8')).toBe('active writer\n')
    expect((await readFile(join(home, 'install-calls'), 'utf8')).trim().split('\n')).toHaveLength(1)
    first.stdin?.end('stop\n')
    expect(await first).toMatchObject({ exitCode: 0, timedOut: false })
    expect(await launch()).toMatchObject({ exitCode: 0, timedOut: false })
  })

  it('releases the runtime lock after a killed process or failed installation', async () => {
    const { home, profile, launch } = await fixture()
    const first = launch('process.stdout.write("READY\\n"); process.stdin.resume()')
    await ready(first)
    await writeFile(join(profile, 'package.json.lock'), '8\n')
    first.kill('SIGKILL')
    expect((await first).signal).toBe('SIGKILL')
    await writeFile(join(home, 'fail-install'), '')
    expect(await launch()).toMatchObject({ exitCode: 23, timedOut: false })
    await rm(join(home, 'fail-install'))
    expect(await launch()).toMatchObject({ exitCode: 0, timedOut: false })
  })
})
