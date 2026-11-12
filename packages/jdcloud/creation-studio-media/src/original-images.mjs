/** Resolve original Seedream text-to-image outputs from Host receipts, never caller-supplied URLs. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageGenerationSource } from './image-generation.mjs'
import { SEEDREAM_MODELS } from './seedream.mjs'

/**
 * Read the generated file binding, original URL validity, and original provider account.
 * @param config - The owning Host state directory and tenant.
 * @returns A reader returning null for ordinary pictures and verified metadata for text-to-image outputs.
 */
export function createOriginalImageReader(config) {
  return async (input, reference, source) => {
    const generation = imageGenerationSource(source.sourceDescription)
    if (source.sourceKind !== 'generated' || !SEEDREAM_MODELS.includes(generation?.model))
      return null
    const fail = (message, code) => Object.assign(new Error(`参考图“${reference.name}”${message}`), { code, status: 400 })
    if (!Array.isArray(generation.referenceIds))
      throw fail('缺少生图输入方式记录，请核对原始生图任务。', 'image/original-invalid')
    if (generation.referenceIds.length) return null
    if (!/^[a-zA-Z0-9-]{8,100}$/u.test(generation.requestId))
      throw fail('缺少原始生图回执，请在分镜中重新规划人像文生图并确认。', 'image/original-missing')
    const identity = [config.tenantId, input.spaceId, input.projectId, input.planId, generation.requestId]
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    let task
    let uploaded
    try {
      [task, uploaded] = await Promise.all([
        readFile(join(config.stateDirectory, 'images', `${hash(identity)}.json`), 'utf8').then(JSON.parse),
        readFile(join(config.stateDirectory, 'uploads', `${hash([...identity, 'image'])}.json`), 'utf8').then(JSON.parse),
      ])
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw fail('缺少 Host 原始生图回执，不能使用平台地址代替原始人像产物。请在分镜中重新规划并确认。', 'image/original-missing')
    }
    const original = task.result?.source
    if (task.status !== 'succeeded' || task.tenantId !== config.tenantId || task.spaceId !== input.spaceId
      || task.projectId !== input.projectId || task.planId !== input.planId
      || !SEEDREAM_MODELS.includes(original?.model) || !Array.isArray(original.referenceIds) || original.referenceIds.length
      || original.requestId !== generation.requestId || original.model !== generation.model
      || uploaded.result?.relationId !== reference.relationId || uploaded.result.fileId !== source.fileId
      || typeof task.providerAccountId !== 'string' || !task.providerAccountId
      || typeof original.originalUrl !== 'string' || task.result.url !== original.originalUrl) {
      throw fail('原始产物、平台文件或生成账号无法核对，请在分镜中检查原图，不能改地址继续提交。', 'image/original-invalid')
    }
    const url = new URL(original.originalUrl)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.volces.com'))
      throw fail('原始图片链接无效，请核对原始生图任务。', 'image/original-invalid')
    const generated = Date.parse(original.generatedAt)
    const expires = Date.parse(original.originalUrlExpiresAt)
    const now = Date.now()
    if (!Number.isFinite(generated) || generated > now || now - generated >= 30 * 24 * 60 * 60 * 1000
      || !Number.isFinite(expires) || expires <= now) {
      throw fail('原始图片链接已过期，不能用平台文件替代。请返回分镜重新规划并确认文生图，不会自动扣费重生成。', 'image/original-expired')
    }
    return { url: original.originalUrl, providerAccountId: task.providerAccountId }
  }
}
