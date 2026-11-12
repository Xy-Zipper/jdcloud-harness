/** Seedream uses a synchronous provider POST and durable Host tasks; unknown paid outcomes never resubmit. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { imagePrompt } from './image-prompts.mjs'

export const SEEDREAM_MODELS = ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915']
export const DEFAULT_IMAGE_MODEL = SEEDREAM_MODELS[0]

/**
 * Send one Seedream request with verified platform references.
 * @param apiKey - Host-only Ark credential.
 * @param model - Allowed Seedream model ID.
 * @param input - Validated prompt and dimensions.
 * @param references - Authorized platform image URLs in the user's selected order.
 * @param transport - Provider transport.
 * @returns An original text-to-image URL and creation time, or image-edit bytes, with reported usage.
 */
export async function requestSeedreamImage(apiKey, model, input, references, transport = fetch) {
  const response = await transport('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/iu, '')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // 文生图保留原始 URL；图生图不具备原始人像产物信任资格，仍沿用字节输出。
      model, prompt: imagePrompt(input.prompt), size: input.size, response_format: references.length ? 'b64_json' : 'url', output_format: 'png',
      watermark: false, ...(references.length ? { image: references.map(reference => reference.url) } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const data = await response.json()
  if (!response.ok) {
    throw Object.assign(new Error(`${data.error?.code || 'image/provider-rejected'}：即梦生图请求失败，请查看调用记录并核对账号或提示词。`), {
      code: data.error?.code,
      providerRejected: response.status >= 400 && response.status < 500,
    })
  }
  if (!references.length) {
    const raw = data.data?.[0]?.url
    const url = typeof raw === 'string' ? new URL(raw) : undefined
    if (data.data?.length !== 1 || !url || url.protocol !== 'https:' || url.username || url.password
      || !url.hostname.endsWith('.volces.com'))
      throw new Error('即梦未返回有效的原始图片 URL，请核对原请求，勿重复提交。')
    const generatedAt = new Date(Number.isFinite(data.created) ? data.created * 1000 : Date.now()).toISOString()
    return { url: raw, mime: 'image/png', usage: data.usage, generatedAt }
  }
  const encoded = data.data?.[0]?.b64_json
  if (data.data?.length !== 1 || typeof encoded !== 'string' || !encoded.length
    || encoded.length > 70 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/u.test(encoded))
    throw new Error('即梦未返回单张有效图片，请核对原请求，勿重复提交。')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('即梦返回内容不是 PNG 图片，请核对原请求。')
  return { b64: encoded, mime: 'image/png', usage: data.usage }
}

/**
 * Bind Seedream submission to existing project authorization and task persistence.
 * @param dependencies - Authorized storage, reference readers, pool, and Host-owned background lifecycle.
 * @returns New task submission and safe refresh operations.
 */
export function createSeedreamTasks({ authorize, referenceData, readTask, createTask, storeTask, pool, background, transport, validate, defaultModel = DEFAULT_IMAGE_MODEL }) {
  const fingerprint = input => createHash('sha256').update(JSON.stringify([
    input.prompt, input.size, input.referenceIds, input.model || defaultModel,
  ])).digest('hex')
  /** Queued receipts have no paid submission; only the background owner can advance them to pending. */
  function start(token, input, task) {
    if (background.has(input)) return Promise.resolve(structuredClone(task))
    const accepted = Promise.withResolvers()
    const job = background.start(input, async () => {
      let selected
      let submitted = false
      try {
        // A refresh can finish reading an old queued receipt after its original job has settled.
        const saved = await readTask(input)
        if (saved.status !== 'queued') {
          Object.assign(task, saved)
          return
        }
        if (!validate({ prompt: input.prompt, size: input.size, referenceIds: input.referenceIds, model: input.model })
          || fingerprint(input) !== task.fingerprint)
          throw new Error('排队图片参数与原任务不一致，请核对原请求后处理。')
        const model = task.source.model
        try {
          selected = await pool.acquire('ark', { ...input, scenario: 'image', model })
        }
        catch (error) {
          if (error.code !== 'accounts/busy') throw error
          accepted.resolve(structuredClone(task))
          selected = await pool.waitForAccount('ark', { ...input, scenario: 'image', model })
        }
        // Permissions may change while waiting for another image to finish.
        const caller = await authorize(token, input)
        if (caller !== task.initiatedByUserId || selected.receipt.initiatedByUserId !== task.initiatedByUserId)
          throw Object.assign(new Error('排队图片的提交账号已变化，请使用原账号恢复该任务。'), { code: 'image/queue-owner-mismatch' })
        await background.authorize(input)
        const references = []
        for (const relationId of input.referenceIds) references.push(await referenceData(token, input, relationId))
        Object.assign(task, selected.receipt)
        task.status = 'pending'
        task.taskId = `seedream-${input.requestId}`
        task.source.providerAccountRef = task.providerAccountRef
        await storeTask(input, task)
        accepted.resolve(structuredClone(task))
        submitted = true
        const image = await requestSeedreamImage(selected.account.apiKey, model, input, references, transport)
        if (image.url) Object.assign(task.source, { originalUrl: image.url, generatedAt: image.generatedAt,
          originalUrlExpiresAt: new Date(Date.parse(image.generatedAt) + 24 * 60 * 60 * 1000).toISOString() })
        task.result = { ...(image.url ? { url: image.url } : { b64: image.b64 }), mime: image.mime, source: { ...task.source, taskId: task.taskId } }
        task.usage = image.usage
        task.status = 'succeeded'
      }
      catch (error) {
        if (error.code === 'accounts/queue-stopped') return
        task.status = !submitted || error.providerRejected ? 'failed' : 'unknown'
        task.errorCode = !submitted ? error.code || 'image/account-unavailable'
          : error.providerRejected ? error.code || 'image/provider-rejected' : 'image/submission-unknown'
        task.error = !submitted || error.providerRejected ? error.message : '即梦提交结果未确认，请核对原请求；不会自动重复付费提交。'
      }
      await storeTask(input, task)
      if (selected) await pool.settle(selected.receipt, task.status, task.taskId)
    })
    void job.then(() => accepted.resolve(structuredClone(task)), accepted.reject)
    return accepted.promise
  }
  async function submit(token, input) {
    if (!validate({ prompt: input.prompt, size: input.size, referenceIds: input.referenceIds, ...(input.model ? { model: input.model } : {}) }))
      throw new Error('图片提示词、模型、尺寸或参考图参数无效。')
    const initiatedByUserId = await authorize(token, input)
    const previous = await readTask(input)
    if (previous) {
      const legacyFingerprint = createHash('sha256').update(JSON.stringify([input.prompt, input.size, input.referenceIds])).digest('hex')
      const originalModel = previous.source?.model || previous.result?.source?.model
      if (previous.fingerprint !== fingerprint(input) && !(originalModel?.startsWith('gpt-image-') && !input.model && previous.fingerprint === legacyFingerprint))
        throw new Error('该请求编号已用于其他参数，请新建生成请求。')
      return previous.status === 'queued' ? start(token, input, previous) : previous
    }
    for (const relationId of input.referenceIds) await referenceData(token, input, relationId)
    const model = input.model || defaultModel
    const task = {
      requestId: input.requestId, taskId: `seedream-${input.requestId}`, tenantId: input.tenantId,
      initiatedByUserId,
      projectId: input.projectId, planId: input.planId, spaceId: input.spaceId,
      fingerprint: fingerprint(input), status: 'queued', provider: 'ark', model,
      source: { requestId: input.requestId, model, prompt: input.prompt, size: input.size,
        referenceIds: [...input.referenceIds], createdAt: new Date().toISOString(), confirmedAt: '' },
    }
    if (!await createTask(input, task)) {
      const saved = await readTask(input)
      if (saved.fingerprint !== fingerprint(input))
        throw new Error('该请求编号已用于其他参数，请新建生成请求。')
      return saved.status === 'queued' ? start(token, input, saved) : saved
    }
    return start(token, input, task)
  }
  return {
    submit,
    async refresh(token, input, task) {
      if (task.status === 'queued')
        return start(token, { ...input, tenantId: task.tenantId, prompt: task.source.prompt, size: task.source.size,
          referenceIds: task.source.referenceIds, model: task.source.model }, task)
      if (['pending', 'submitting'].includes(task.status) && !background.has(input)) {
        task.status = 'unknown'
        task.errorCode = 'image/submission-unknown'
        task.error = '服务重启后原即梦请求结果待核对，不会重新提交；请联系管理员核对该账号。'
        await storeTask(input, task)
        await pool.settle(task, 'unknown', task.taskId)
      }
      return structuredClone(task)
    },
  }
}
