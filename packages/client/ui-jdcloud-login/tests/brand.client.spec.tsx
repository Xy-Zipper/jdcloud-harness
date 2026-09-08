// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JdcloudBrandMark, JdcloudBrandName } from '../src/client/Brand.tsx'

afterEach(cleanup)

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

  it('renders the localized product name independently from the mark', () => {
    const rendered = render(<JdcloudBrandName t={() => 'JDCloud Harness'} />)
    expect(rendered.getByText('JDCloud Harness')).toBeTruthy()
    expect(rendered.container.querySelector('svg')).toBeNull()
  })
})
