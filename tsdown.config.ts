import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Exclude manifest-less directories left by renamed or moved packages. A stale
 * checkout can still carry them with only generated residue (lib, node_modules);
 * once that residue is ignored — as .dockerignore does for image builds — the
 * empty directory still matches the package glob, inherits this root config, and
 * fails entry resolution as `@deepseek-ai/dsh-root`.
 */
const workspaceExcludes = [
  '!packages/api/ontology-auth-controller',
  '!packages/bundle/ontology-login',
  '!packages/client/ui-ontology-login',
  '!packages/fs/tool-present',
  '!packages/identity/browser-user-scope',
  '!packages/ontology/tool-ontology',
]

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: client
      ? ['vendor/*', 'packages/*/*', 'apps/cli', ...workspaceExcludes]
      : ['vendor/*', 'packages/*/*', 'apps/cli', 'apps/desktop', 'apps/desktop-host', ...workspaceExcludes],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
