import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-settings-general host', () => {
  it('keeps the Host loader entry inert', () => {
    expect(apply).not.toThrow()
  })
})
