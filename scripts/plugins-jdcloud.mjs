/** Switch the Web profile to JDCloud, stopping at the first failed command. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProfileManifest, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'

// 需要卸载的 Ontology 组合包；后续插件直接追加到清单。
const pluginsToRemove = [
  '@deepseek-ai/dsh-ontology-login',
]

// 需要装载的 JDCloud 组合包；路径相对于仓库根目录。
const pluginsToInstall = [
  './packages/bundle/jdcloud-login',
]

const root = fileURLToPath(new URL('../', import.meta.url))
// 只检查依赖声明，不解析切换分支后可能已失效的旧插件链接。
const profileDir = resolveProfileDir('web')
const dependencies = existsSync(join(profileDir, 'package.json'))
  ? readProfileManifest('dsh', profileDir).dependencies ?? {}
  : {}
const installedToRemove = pluginsToRemove.filter(plugin => {
  if (Object.hasOwn(dependencies, plugin)) return true
  console.log(`跳过未安装的插件：${plugin}`)
  return false
})
for (const [command, plugins] of [
  ['remove', installedToRemove],
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
