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
 * @returns The original provider response including image bytes and usage.
 */
export async function requestSeedreamImage(apiKey, model, input, references, transport = fetch) {
  const response = await transport('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/iu, '')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, prompt: imagePrompt(input.prompt), size: input.size, response_format: 'b64_json', output_format: 'png',
      watermark: false, ...(references.length ? { image: references.map(reference => reference.url) } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const data = await response.json()
  if (!response.ok) {
    throw Object.assign(new Error('即梦生图请求失败，请查看调用记录并核对账号或提示词。'), {
      providerRejected: response.status >= 400 && response.status < 500,
    })
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
  async function submit(token, input) {
    if (!validate({ prompt: input.prompt, size: input.size, referenceIds: input.referenceIds, ...(input.model ? { model: input.model } : {}) }))
      throw new Error('图片提示词、模型、尺寸或参考图参数无效。')
    await authorize(token, input)
    const previous = await readTask(input)
    if (previous) {
      const legacyFingerprint = createHash('sha256').update(JSON.stringify([input.prompt, input.size, input.referenceIds])).digest('hex')
      const originalModel = previous.source?.model || previous.result?.source?.model
      if (previous.fingerprint !== fingerprint(input) && !(originalModel?.startsWith('gpt-image-') && !input.model && previous.fingerprint === legacyFingerprint))
        throw new Error('该请求编号已用于其他参数，请新建生成请求。')
      return previous
    }
    const references = []
    for (const relationId of input.referenceIds) references.push(await referenceData(token, input, relationId))
    const model = input.model || defaultModel
    const task = {
      requestId: input.requestId, taskId: `seedream-${input.requestId}`, tenantId: input.tenantId,
      projectId: input.projectId, planId: input.planId, spaceId: input.spaceId,
      fingerprint: fingerprint(input), status: 'submitting', provider: 'ark', model,
      source: { requestId: input.requestId, model, prompt: input.prompt, size: input.size,
        referenceIds: [...input.referenceIds], createdAt: new Date().toISOString(), confirmedAt: '' },
    }
    if (!await createTask(input, task)) {
      const saved = await readTask(input)
      if (saved.fingerprint !== fingerprint(input))
        throw new Error('该请求编号已用于其他参数，请新建生成请求。')
      return saved
    }
    let selected
    try {
      selected = await pool.acquire('ark', { ...input, scenario: 'image', model })
      Object.assign(task, selected.receipt)
      task.status = 'pending'
      task.taskId = `seedream-${input.requestId}`
      task.source.providerAccountRef = task.providerAccountRef
      await storeTask(input, task)
    }
    catch (error) {
      task.status = 'failed'
      task.errorCode = error.code || 'image/account-unavailable'
      task.error = error.message
      await storeTask(input, task)
      if (selected) await pool.settle(task, 'failed')
      return task
    }
    const run = async () => {
      try {
        const image = await requestSeedreamImage(selected.account.apiKey, model, input, references, transport)
        task.result = { b64: image.b64, mime: image.mime, source: { ...task.source, taskId: task.taskId } }
        task.usage = image.usage
        task.status = 'succeeded'
      }
      catch (error) {
        task.status = error.providerRejected ? 'failed' : 'unknown'
        task.errorCode = error.providerRejected ? 'image/provider-rejected' : 'image/submission-unknown'
        task.error = error.providerRejected ? error.message : '即梦提交结果未确认，请核对原请求；不会自动重复付费提交。'
      }
      await storeTask(input, task)
      await pool.settle(task, task.status, task.taskId)
    }
    background.start(input, run)
    // The background operation owns its mutable receipt; the submit response is a stable snapshot.
    return structuredClone(task)
  }
  return {
    submit,
    async refresh(input, task) {
      if (['pending', 'submitting'].includes(task.status) && !background.has(input)) {
        task.status = 'unknown'
        task.errorCode = 'image/submission-unknown'
        task.error = '服务重启后原即梦请求结果待核对，不会重新提交；请联系管理员核对该账号。'
        await storeTask(input, task)
        await pool.settle(task, 'unknown', task.taskId)
      }
      return task
    },
  }
}
