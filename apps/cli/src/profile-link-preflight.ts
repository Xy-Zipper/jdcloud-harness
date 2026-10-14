/** Validate local profile dependencies before Web startup. */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readProfileManifest, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** One profile dependency whose local link target is unavailable. */
export interface BrokenProfileLink {
  /** Dependency name from the profile manifest. */
  readonly packageName: string
  /** Absolute directory named by the `link:` dependency. */
  readonly target: string
}

/**
 * Find `link:` dependencies whose target directory disappeared after a checkout change.
 * @param profile - Profile name under the Harness home.
 * @param home - Harness home containing the profile directory.
 * @returns Missing local dependency targets in manifest order.
 */
export function findBrokenProfileLinks(
  profile: string,
  home: string = resolveDshHome(),
): BrokenProfileLink[] {
  const profileDir = resolveProfileDir(profile, home)
  if (!existsSync(join(profileDir, 'package.json'))) return []
  const dependencies = readProfileManifest('dsh', profileDir).dependencies ?? {}
  const broken: BrokenProfileLink[] = []
  for (const [packageName, specification] of Object.entries(dependencies)) {
    if (typeof specification !== 'string' || !specification.startsWith('link:')) continue
    const declared = specification.slice('link:'.length)
    const target = isAbsolute(declared) ? resolve(declared) : resolve(profileDir, declared)
    if (!existsSync(join(target, 'package.json'))) broken.push({ packageName, target })
  }
  return broken
}

/**
 * Format the startup failure for broken local profile dependencies.
 * @param profile - Profile whose local dependencies are unavailable.
 * @param broken - Missing dependency targets returned by {@link findBrokenProfileLinks}.
 * @returns Actionable diagnostic ending with one newline.
 */
export function formatBrokenProfileLinks(profile: string, broken: readonly BrokenProfileLink[]): string {
  const targets = broken
    .map(link => `  - ${JSON.stringify(link.packageName)}: ${JSON.stringify(link.target)}`)
    .join('\n')
  const packages = broken.map(link => JSON.stringify(link.packageName)).join(' ')
  return `dsh: profile ${JSON.stringify(profile)} has local dependencies missing from the current checkout:\n`
    + `${targets}\n`
    + 'Switch to a checkout that provides these directories, or remove the stale dependencies with:\n'
    + `  dsh plugin --profile ${JSON.stringify(profile)} remove ${packages}\n`
    + 'Install the bundle required by this checkout before starting the profile again.\n'
}
