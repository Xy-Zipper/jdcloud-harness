/** Transcribe saved reference videos and recover preexisting local assembly plans. */
import { createHash } from 'node:crypto'

const MIB = 1024 * 1024
const captionSettingsLimit = 256 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Read a bounded MP4-family response without using its untrusted length as an allocation size.
 * @param response - Authenticated platform file, provider file or private worker result.
 * @param maximum - Byte limit for the full file.
 * @param message - Localized failure for this operation.
 * @returns Verified MP4-family bytes.
 */
export async function readRemakeVideoBytes(response, maximum, message) {
  const bytes = await boundedBytes(response, maximum, message)
  if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error(message)
  return bytes
}

async function boundedBytes(response, maximum, message) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maximum
    || response.headers.get('content-type')?.includes('text/html')) {
    await response.body?.cancel()
    throw new Error(message)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maximum) throw new Error(message)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/**
 * Read authorized project files for transcription and legacy video assembly.
 * @param config - Worker endpoint and fixed authenticated media origin and tenant.
 * @param transport - Request-scoped authenticated platform and private worker transport.
 * @returns Local transcription and assembly operations, when a worker is configured.
 */
export function createRemakeClipEditor(config, transport) {
  const workerURL = config.videoRemake?.workerURL
  if (!workerURL) return undefined
  const mergeURL = new URL('./merge-edit', workerURL).href
  async function fileResponse(fileId) {
    if (typeof fileId !== 'string' || !/^[a-f0-9]{24}$/iu.test(fileId))
      throw new Error('原任务没有可读取的参考视频编号。')
    const path = `/api/file/dowloadFile/${config.tenantId}/${fileId}`
    return transport(new URL(path, config.platformURL).href, { redirect: 'error', signal: AbortSignal.timeout(45_000) })
  }
  const sourceBytes = async fileId => readRemakeVideoBytes(await fileResponse(fileId), 30 * MIB, '参考视频下载失败，无法按镜头复刻。')
  const musicBytes = async fileId => boundedBytes(await fileResponse(fileId), 30 * MIB, '背景音乐无法下载，请重新上传。')
  const outputSettingsHeader = 'X-Remake-Output-Settings'
  const submit = (url, body, ranges, sourceLength, output, music, timeout = 125_000) => transport(url, {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(ranges === undefined ? {} : { 'X-Remake-Ranges': JSON.stringify(ranges) }),
      ...(sourceLength === undefined ? {} : { 'X-Remake-Source-Length': String(sourceLength) }),
      ...(output === undefined ? {} : { [outputSettingsHeader]: JSON.stringify(output) }),
      ...(music === undefined ? {} : { 'X-Remake-Music': JSON.stringify(music) }),
    },
  })
  return {
    async merge(plan, edited) {
      const original = await sourceBytes(plan.sourceFileId)
      if (digest(original) !== plan.sourceDigest)
        throw new Error('参考视频已变化，原任务不能按旧时间轴拼回。')
      const response = await submit(mergeURL, Buffer.concat([original, edited]), plan.ranges, original.length, plan.output,
        undefined, plan.output?.audio === 'keep-music' ? 300_000 : 125_000)
      if (plan.output && response.headers.get(outputSettingsHeader) !== '1') {
        await response.body?.cancel()
        throw new Error('剪辑 Worker 未确认应用本次成片设置。')
      }
      return readRemakeVideoBytes(response, 30 * MIB, '成片无法按原时间轴合成或超过入库大小限制。')
    },
    async transcript(sourceFileId, cuts) {
      const response = await submit(new URL('./transcript', workerURL).href, await sourceBytes(sourceFileId), cuts)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('原对白识别未完成，可以重试或手动添加对白。')
      }
      return response.json()
    },
    async syncCaptions(plan, video) {
      const settings = Buffer.from(JSON.stringify(plan))
      if (settings.length > captionSettingsLimit) throw new Error('字幕计划超过合成限制。')
      const response = await submit(new URL('./sync-captions', workerURL).href, Buffer.concat([video, settings]),
        undefined, video.length, undefined, undefined, 215_000)
      return readRemakeVideoBytes(response, 120 * MIB, '对白字幕未合成，请检查剪辑 Worker 后查询原任务。')
    },
    async mixMusic(plan, video) {
      const music = await musicBytes(plan.fileId)
      if (digest(music) !== plan.digest) throw new Error('背景音乐文件已变化，请核对原任务使用的文件。')
      const response = await submit(new URL('./mix-bgm', workerURL).href, Buffer.concat([video, music]),
        undefined, video.length, undefined, plan.settings)
      return readRemakeVideoBytes(response, 120 * MIB, '背景音乐未合成，请恢复剪辑 Worker 后查询原任务。')
    },
  }
}
