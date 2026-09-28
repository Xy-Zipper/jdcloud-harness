// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JdcloudBrandMark, JdcloudBrandName } from '../src/client/Brand.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('JDCloud brand artwork', () => {
  it('keeps the host-requested mark size and uses instance-safe gradients', () => {
    const first = render(<JdcloudBrandMark size={24} />)
    const second = render(<JdcloudBrandMark size={34} />)
    const firstSvg = first.container.querySelector('svg')
    const secondSvg = second.container.querySelector('svg')

    expect(firstSvg?.getAttribute('width')).toBe('24')
    expect(firstSvg?.getAttribute('height')).toBe('24')
    expect(secondSvg?.getAttribute('width')).toBe('34')
    expect(firstSvg?.querySelector('linearGradient')?.id)
      .not.toBe(secondSvg?.querySelector('linearGradient')?.id)
  })

  it('renders the configured client title independently from the mark', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Configured Agent')
    const rendered = render(<JdcloudBrandName t={() => 'LSY-Agent'} />)
    expect(rendered.getByText('Configured Agent')).toBeTruthy()
    expect(rendered.container.querySelector('svg')).toBeNull()
  })

  it('uses the locale product name when a client title is absent', () => {
    const rendered = render(<JdcloudBrandName t={() => 'LSY-Agent'} />)
    expect(rendered.getByText('LSY-Agent')).toBeTruthy()
    expect(rendered.container.querySelector('svg')).toBeNull()
  })
})
