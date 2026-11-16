/** Switch the Web profile to Ontology, stopping at the first failed command. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 需要卸载的 JDCloud 组合包；后续插件直接追加到清单。
const pluginsToRemove = [
  '@deepseek-ai/dsh-jdcloud-login',
]

// 需要装载的 Ontology 组合包；路径相对于仓库根目录。
const pluginsToInstall = [
  './packages/bundle/ontology-login',
]

const root = fileURLToPath(new URL('../', import.meta.url))
function runPlugin(args, capture = false) {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'plugin', '--profile', 'web', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

// 只卸载 profile 中已声明的依赖，允许首次切换和重复运行。
const [profile] = JSON.parse(runPlugin(['list', '--depth', '0', '--json'], true))
const installedToRemove = pluginsToRemove.filter(plugin => {
  if (Object.hasOwn(profile.dependencies ?? {}, plugin)) return true
  console.log(`跳过未安装的插件：${plugin}`)
  return false
})
for (const [command, plugins] of [
  ['remove', installedToRemove],
  ['add', pluginsToInstall],
]) {
  if (plugins.length > 0) runPlugin([command, ...plugins])
}
