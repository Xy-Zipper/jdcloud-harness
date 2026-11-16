/** Switch the Web profile to JDCloud, stopping at the first failed command. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 需要卸载的 Ontology 组合包；后续插件直接追加到清单。
const pluginsToRemove = [
  '@deepseek-ai/dsh-ontology-login',
]

// 需要装载的 JDCloud 组合包；路径相对于仓库根目录。
const pluginsToInstall = [
  './packages/bundle/jdcloud-login',
]

const root = fileURLToPath(new URL('../', import.meta.url))
for (const [command, plugins] of [
  ['remove', pluginsToRemove],
  ['add', pluginsToInstall],
]) {
  if (plugins.length === 0) continue
  const result = spawnSync(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'plugin', '--profile', 'web', command, ...plugins,
  ], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
