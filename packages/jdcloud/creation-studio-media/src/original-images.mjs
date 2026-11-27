/** Resolve original Seedream outputs from Host receipts, never caller-supplied URLs. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { imageGenerationSource } from './image-generation.mjs'
import { SEEDREAM_MODELS } from './seedream.mjs'
import { recordId } from './upstream.mjs'

const receiptName = identity => `${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}.json`

async function readReceipt(directory, name) {
  try {
    return JSON.parse(await readFile(join(directory, name), 'utf8'))
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
}

/**
 * Resolve the same uploaded file and the account required for text-to-image originals.
 * @param config - The owning Host state directory and tenant.
 * @returns A reader for an authorized material version in the original tenant and space. An expired URL is omitted so the caller can use the bound platform file. Text-to-image retains the generating account within the provider trust window.
 */
export function createOriginalImageReader(config) {
  const images = join(config.stateDirectory, 'images')
  const uploads = join(config.stateDirectory, 'uploads')
  const identityOf = (scope, requestId) => [config.tenantId, scope.spaceId, scope.projectId, scope.planId, requestId]
  const uploadedFor = identity => readReceipt(uploads, receiptName([...identity, 'image']))

  /** Reused project references keep the material ID and file version while receiving a new relation ID. */
  async function findSharedTask(input, requestId, currentName, matchesUpload) {
    let names
    try {
      names = await readdir(images)
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      return undefined
    }
    for (const name of names) {
      if (name === currentName || !/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const candidate = await readReceipt(images, name)
      if (candidate?.status !== 'succeeded' || candidate.tenantId !== config.tenantId || candidate.spaceId !== input.spaceId
        || candidate.requestId !== requestId || !recordId(candidate.projectId)
        || (candidate.planId !== undefined && !recordId(candidate.planId))) continue
      const identity = identityOf(candidate, requestId)
      if (receiptName(identity) === name && matchesUpload(await uploadedFor(identity))) return candidate
    }
    return undefined
  }

  return async (input, label, source, materialId) => {
    const generation = imageGenerationSource(source.sourceDescription)
    if (source.sourceKind !== 'generated' || !SEEDREAM_MODELS.includes(generation?.model))
      return null
    const fail = (message, code) => Object.assign(new Error(`${label}${message}`), { code, status: 400, submissionState: 'not-submitted' })
    if (!Array.isArray(generation.referenceIds))
      throw fail('缺少生图输入方式记录，请核对原始生图任务。', 'image/original-invalid')
    // 历史编辑任务没有原始 URL 时仍可用平台文件；文生人脸不能走此回退。
    if (generation.referenceIds.length && !generation.originalUrl) return null
    if (!/^[a-zA-Z0-9-]{8,100}$/u.test(generation.requestId))
      throw fail('缺少原始生图回执，请在分镜中重新规划人像文生图并确认。', 'image/original-missing')
    const identity = identityOf(input, generation.requestId)
    const currentName = receiptName(identity)
    const [current, uploaded] = await Promise.all([readReceipt(images, currentName), uploadedFor(identity)])
    const matchesUpload = (upload) => {
      const picture = upload?.result
      return picture && picture.materialId === materialId && picture.fileId === source.fileId
        && Number(picture.sourceRevision) === Number(source.revision)
    }
    const invalid = () => fail('原始产物、平台文件或生成账号无法核对，请在分镜中检查原图，不能改地址继续提交。', 'image/original-invalid')
    if (current && (current.projectId !== input.projectId || current.planId !== input.planId)) throw invalid()
    const task = current && matchesUpload(uploaded) ? current
      : await findSharedTask(input, generation.requestId, currentName, matchesUpload)
    if (!task) {
      if (current && uploaded) throw invalid()
      throw fail('缺少 Host 原始生图回执，不能使用平台地址代替原始人像产物。请在分镜中重新规划并确认。', 'image/original-missing')
    }
    const original = task.result?.source
    if (task.status !== 'succeeded' || task.tenantId !== config.tenantId || task.spaceId !== input.spaceId
      || !SEEDREAM_MODELS.includes(original?.model) || !Array.isArray(original.referenceIds)
      || JSON.stringify(original.referenceIds) !== JSON.stringify(generation.referenceIds)
      || original.requestId !== generation.requestId || original.model !== generation.model
      || typeof task.providerAccountId !== 'string' || !task.providerAccountId
      || typeof original.originalUrl !== 'string' || task.result.url !== original.originalUrl) {
      throw invalid()
    }
    const url = new URL(original.originalUrl)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.volces.com'))
      throw fail('原始图片链接无效，请核对原始生图任务。', 'image/original-invalid')
    const generated = Date.parse(original.generatedAt)
    const expires = Date.parse(original.originalUrlExpiresAt)
    const now = Date.now()
    if (!Number.isFinite(generated) || generated > now || !Number.isFinite(expires)) {
      throw fail('的火山原图有效期无法核对，请查看原始生图任务。', 'image/original-invalid')
    }
    const textToImage = original.referenceIds.length === 0
    const trustExpiry = generated + 30 * 24 * 60 * 60 * 1000
    if (textToImage && trustExpiry <= now)
      throw fail('的火山原图受信期已过期，请返回分镜更换参考图或重新生图并确认。', 'image/original-expired')
    return {
      ...(expires > now && { url: original.originalUrl }),
      ...(textToImage && { providerAccountId: task.providerAccountId }),
    }
  }
}
