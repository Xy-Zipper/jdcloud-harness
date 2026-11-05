import { expect, it } from 'vitest'

const { calculateShadowCharge, normalizeAgentUsage } = await import(new URL('../src/billing-price.mjs', import.meta.url).href)
const price = { _id: 'price', pricingStatus: 'published', currency: 'CNY', provider: 'ark',
  scenario: 'video', modelKey: 'seedance', billingUnit: 'million_tokens', videoPerMillionYuan: '100' }
const video = { payer: 'customer', status: 'succeeded', provider: 'ark', scenario: 'video', modelKey: 'seedance',
  usageStatus: 'reported', videoOutputTokens: 144512, totalTokens: 144512, delivered: true, occurredAt: 10 }

it('prices 144512 video tokens exactly once and waits for delivery', () => {
  expect(calculateShadowCharge(video, [price]).customerChargeMicros).toBe('14451200')
  expect(calculateShadowCharge({ ...video, delivered: false }, [price]).chargeStatus).toBe('pending')
})
it('selects the actual image pixel tier and charges only references beyond the free first image', () => {
  const row = { ...video, scenario: 'image', modelKey: 'seedream', imageCount: 1, imageInputCount: 3, parameters: { imagePixels: 2610000 } }
  const imagePrice = { ...price, scenario: 'image', modelKey: 'seedream', billingUnit: 'image', imagePerUnitYuan: '0.3', imageInputPerUnitYuan: '0.02', imageFreeInputCount: 1, imageMinPixels: 0, imageMaxPixels: 2610000 }
  const high = { ...imagePrice, imageMinPixels: 2610001, imageMaxPixels: 4624220, imagePerUnitYuan: '0.6' }
  expect(calculateShadowCharge(row, [imagePrice, high]).customerChargeMicros).toBe('340000')
  expect(calculateShadowCharge({ ...row, parameters: { imagePixels: 2610001 } }, [imagePrice, high]).customerChargeMicros).toBe('640000')
  expect(calculateShadowCharge({ ...row, imageInputCount: undefined }, [imagePrice, high]).chargeStatus).toBe('pending')
  expect(calculateShadowCharge({ ...row, status: 'failed' }, [imagePrice, high]).customerChargeMicros).toBe('0')
})
it('does not infer free prices, select an overlapping version, or bill estimated usage', () => {
  for (const prices of [[], [price, price], [{ ...price, videoPerMillionYuan: '' }]])
    expect(calculateShadowCharge(video, prices).customerChargeMicros).toBeUndefined()
  expect(calculateShadowCharge({ ...video, usageStatus: 'pending' }, [price]).chargeStatus).toBe('pending')
  expect(calculateShadowCharge({ ...video, payer: 'platform' }, []).customerChargeMicros).toBe('0')
})
it('sums disjoint agent buckets, ignores reasoning as a separate fee, and never invents missing cache', () => {
  const usage = normalizeAgentUsage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500,
    cacheWriteTokens: 0, reasoningTokens: 100, totalTokens: 1700 })
  const agentPrice = { ...price, provider: 'llm', scenario: 'agent', modelKey: 'model', inputPerMillionYuan: '10', cacheReadPerMillionYuan: '1', outputPerMillionYuan: '20' }
  expect(calculateShadowCharge({ ...video, ...usage, provider: 'llm', scenario: 'agent', modelKey: 'model' }, [agentPrice]).customerChargeMicros).toBe('14500')
  expect(calculateShadowCharge({ ...video, ...normalizeAgentUsage({ inputTokens: 1000, outputTokens: 200 }), provider: 'llm', scenario: 'agent', modelKey: 'model' }, [agentPrice]).chargeStatus).toBe('pending')
  expect(normalizeAgentUsage({ inputTokens: 100, outputTokens: 10, totalTokens: 50 }).usageStatus).toBe('pending')
  expect(normalizeAgentUsage({ inputTokens: 100, outputTokens: 10, totalTokens: 110 })).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, usageStatus: 'reported' })
})
