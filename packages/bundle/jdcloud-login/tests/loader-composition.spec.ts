/** JDCloud bundle rows must activate through the real Cordis Loader. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import JdcloudAuthController from '../../../api/jdcloud-auth-controller/src/index.ts'

let directory: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('JDCloud login through a real Loader composition', () => {
  it('activates the credentials, Host controller, and browser node half', async () => {
    const clientNodeEntry = pathToFileURL(join(
      import.meta.dirname,
      '../../../client/ui-jdcloud-login/src/index.ts',
    )).href
    const jdcloudLoginUi = await import(clientNodeEntry) as Record<string, unknown>
    expect('default' in jdcloudLoginUi).toBe(false)

    directory = await mkdtemp(join(tmpdir(), 'dsh-jdcloud-login-loader-'))
    const configPath = join(directory, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@fixture/memory-credentials'",
      "- name: '@deepseek-ai/dsh-api-jdcloud-auth-controller'",
      '  config:',
      '    defaultBaseUrl: https://kindoucloud.com',
      '    requestTimeoutMs: 15000',
      "- name: '@deepseek-ai/dsh-client-ui-jdcloud-login'",
      '',
    ].join('\n'))

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@fixture/memory-credentials', MemoryCredentials],
      ['@deepseek-ai/dsh-api-jdcloud-auth-controller', JdcloudAuthController],
      ['@deepseek-ai/dsh-client-ui-jdcloud-login', jdcloudLoginUi],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    await expect(ctx.jdcloudAuthController.status()).resolves.toEqual({
      authenticated: false,
      baseUrl: 'https://kindoucloud.com',
    })
  })
})
