/** 影子计费：仅用已发布售价与实际计量计算微元，不产生余额或流水写入。 */
const integer = value => Number.isSafeInteger(value) && value >= 0
const amount = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/u.test(value)) return undefined
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

/** 按实际规格唯一选价；空条件为不区分，缺价/重叠/不完整用量均不视为零费用。 */
export function calculateShadowCharge(row, prices) {
  if (row.payer === 'platform') return { chargeStatus: 'waived', customerChargeMicros: '0', reason: row.reason || '平台后台调用或故障重试，由平台承担。' }
  if (row.status === 'failed' && row.scenario !== 'agent')
    return { chargeStatus: 'waived', customerChargeMicros: '0', reason: '媒体明确失败，不向客户计费。' }
  if (row.usageStatus !== 'reported')
    return { chargeStatus: 'pending', reason: '实际用量尚未完整返回，暂不计算费用。' }
  const candidates = prices.filter(price => price.pricingStatus === 'published' && price.currency === 'CNY'
    && price.provider === row.provider && price.modelKey === row.modelKey && price.scenario === row.scenario
    && (!price.effectiveFrom || Number(price.effectiveFrom) <= row.occurredAt)
    && (!price.effectiveTo || Number(price.effectiveTo) > row.occurredAt)
    && ['resolution', 'inputVideoMode', 'audioMode', 'serviceTier', 'imageOperation', 'imageSize', 'imageQuality'].every(key =>
      !price[key] || price[key] === 'not_applicable' || price[key] === row.parameters?.[key]))
  if (candidates.length !== 1)
    return { chargeStatus: 'pending', reason: candidates.length ? '匹配到多个售价版本，需要核对配置。' : '未配置匹配的已发布售价，保留真实用量。' }
  const price = candidates[0]
  if (price.billingUnit !== (row.scenario === 'image' ? 'image' : 'million_tokens'))
    return { chargeStatus: 'pending', reason: '售价计费单位与本次服务不一致。' }
  const buckets = row.scenario === 'image' ? [['imageCount', 'imagePerUnitYuan']]
    : row.scenario === 'video' ? [['videoOutputTokens', 'videoPerMillionYuan']]
      : [['inputTokens', 'inputPerMillionYuan'], ['cacheReadTokens', 'cacheReadPerMillionYuan'],
          ['cacheWriteTokens', 'cacheWritePerMillionYuan'], ['outputTokens', 'outputPerMillionYuan']]
  let numerator = 0n
  for (const [quantityKey, priceKey] of buckets) {
    const quantity = row[quantityKey]
    if (!integer(quantity)) return { chargeStatus: 'pending', reason: `${quantityKey} 未核实，不能按零结算。` }
    if (quantity === 0) continue
    const rate = amount(price[priceKey])
    if (rate === undefined) return { chargeStatus: 'pending', reason: `${priceKey} 未填写有效单价。` }
    numerator += BigInt(quantity) * rate
  }
  if (row.scenario !== 'agent' && !row.delivered)
    return { chargeStatus: 'pending', reason: '媒体尚未完成项目入库，暂不计算客户应收。' }
  const denominator = row.scenario === 'image' ? 1n : 1_000_000n
  return { chargeStatus: 'ready', customerChargeMicros: ((numerator + denominator / 2n) / denominator).toString(),
    priceVersionId: price._id, priceSnapshot: JSON.stringify(price), reason: '费用试算，仅核对，未扣余额。' }
}

/** 只接纳安全整数实测桶；推理属于输出子集，总量不重复相加。 */
export function normalizeAgentUsage(usage) {
  if (!usage || !integer(usage.inputTokens) || !integer(usage.outputTokens)) return { usageStatus: 'pending' }
  const result = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']) {
    if (usage[key] !== undefined) {
      if (!integer(usage[key])) return { usageStatus: 'pending' }
      result[key] = usage[key]
    }
  }
  if ((result.reasoningTokens ?? 0) > result.outputTokens) return { usageStatus: 'pending' }
  const known = result.inputTokens + result.outputTokens + (result.cacheReadTokens ?? 0) + (result.cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(known) || (result.totalTokens !== undefined && result.totalTokens < known))
    return { usageStatus: 'pending' }
  // 精确总量与所有已知桶完全相等时，剩余非负缓存桶可证明为零；没有精确总量不推断。
  if (result.totalTokens === known) {
    result.cacheReadTokens ??= 0
    result.cacheWriteTokens ??= 0
  }
  if (result.cacheReadTokens !== undefined && result.cacheWriteTokens !== undefined && result.totalTokens !== undefined && result.totalTokens !== known)
    return { usageStatus: 'pending' }
  return { ...result, usageStatus: 'reported' }
}
