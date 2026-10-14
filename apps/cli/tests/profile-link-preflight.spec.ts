import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findBrokenProfileLinks, formatBrokenProfileLinks } from '../src/profile-link-preflight.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profile(dependencies?: Readonly<Record<string, string>>): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-link-preflight-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    ...(dependencies === undefined ? {} : { dependencies }),
  }))
  return { home, dir }
}

describe('Web profile local-link preflight', () => {
  it('accepts absent profiles, registry dependencies, and existing relative links', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-profile-link-empty-'))
    roots.push(emptyHome)
    expect(findBrokenProfileLinks('web', emptyHome)).toEqual([])

    const noDependencies = profile()
    expect(findBrokenProfileLinks('web', noDependencies.home)).toEqual([])

    const absolutePackage = join(emptyHome, 'absolute-package')
    const fixture = profile({
      registry: '^1.0.0',
      local: 'link:./local-package',
      absolute: `link:${absolutePackage}`,
    })
    mkdirSync(join(fixture.dir, 'local-package'), { recursive: true })
    writeFileSync(join(fixture.dir, 'local-package/package.json'), '{"name":"local"}')
    mkdirSync(absolutePackage)
    writeFileSync(join(absolutePackage, 'package.json'), '{"name":"absolute"}')
    expect(findBrokenProfileLinks('web', fixture.home)).toEqual([])
  })

  it('reports every missing link with a profile repair command', () => {
    const fixture = profile({
      '@example/first-bundle': 'link:./missing-first',
      '@example/second-bundle': 'link:./missing-second',
    })
    const broken = findBrokenProfileLinks('web', fixture.home)
    expect(broken).toEqual([
      { packageName: '@example/first-bundle', target: join(fixture.dir, 'missing-first') },
      { packageName: '@example/second-bundle', target: join(fixture.dir, 'missing-second') },
    ])
    expect(formatBrokenProfileLinks('web', broken)).toContain(
      'dsh plugin --profile "web" remove "@example/first-bundle" "@example/second-bundle"',
    )
  })
})
