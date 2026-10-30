/** Built Web-profile startup with the same authentication overlay used by Docker Compose. */
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

it('boots the Docker overlay and honors the invocation trusted host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-docker-overlay-'))
  const child = execa(process.execPath, [
    join(repoRoot, 'apps/cli/lib/bin.js'), 'web',
    '--patch', join(repoRoot, 'docker.no-browser-auth.patch.yml'),
    '--no-open', '--port', '0', '--trusted-host', 'harness.example:3080',
  ], {
    cwd: root,
    env: {
      ...clearedProxyEnv(),
      DSH_HOME: join(root, 'home'),
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      NODE_NO_WARNINGS: '1',
    },
    input: '',
    reject: false,
    timeout: 90_000,
    killSignal: 'SIGKILL',
  })
  let output = ''
  const ready = Promise.withResolvers<string>()
  const append = (chunk: Buffer | string): void => {
    output += String(chunk)
    const url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
    if (url !== undefined) ready.resolve(url)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  try {
    const url = await Promise.race([
      ready.promise,
      child.then((result) => {
        throw new Error(`Docker Web profile exited before readiness: code=${String(result.exitCode)}, `
          + `signal=${String(result.signal)}, timedOut=${String(result.timedOut)}\n${output}`)
      }),
    ])
    const page = await fetch(url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('__DSH_BOOT__')

    // The public Host comes from --trusted-host; the browser identity remains Bearer-based.
    for (const [host, status] of [['harness.example:3080', 200], ['untrusted.example:3080', 403]] as const) {
      const receivedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(new URL('/api/browser-session', url), {
          method: 'POST',
          headers: { host, origin: `http://${host}` },
        }, (res) => {
          res.resume()
          res.once('end', () => { resolve(res.statusCode) })
          res.once('error', reject)
        })
        req.once('error', reject)
        req.end()
      })
      expect(receivedStatus).toBe(status)
    }
  } finally {
    child.kill('SIGTERM')
    await child
    await rm(root, { recursive: true, force: true })
  }
})
