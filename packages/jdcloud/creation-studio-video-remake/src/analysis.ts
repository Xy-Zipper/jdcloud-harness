/** Validate media uploads and results from the private shot and speech analysis worker. */
import type { IncomingMessage } from 'node:http'
import { HarnessError } from '@deepseek-ai/dsh-error'

/** Highest slot count supported by the private worker protocol. */
export const MAX_WORKER_CONCURRENCY = 4

/** Original text recognized during one interval of the source timeline. */
export interface RemakeSourceLine {
  /** One-based shot index. Receipts from earlier workers omit it. */
  shotNumber?: number
  start: number
  end: number
  original: string
}

/** An analysis failure whose message can be shown to the caller. */
export class AnalysisError extends HarnessError {
  constructor(readonly status: number, code: string, message: string) {
    super(message, `video-remake/${code}`)
  }
}

function invalidVideo(): AnalysisError {
  return new AnalysisError(422, 'invalid-video', '请上传可播放的 MP4 或 MOV 视频，时长 4–30 秒，最高 1080p、60 fps。')
}

function exceedsLimit(): AnalysisError {
  return new AnalysisError(413, 'too-large', '参考视频超过上传大小限制。')
}

function unusableDialogue(): AnalysisError {
  return new AnalysisError(503, 'transcript-unavailable', '全片对白识别未完成，本次拆解暂未扣费。请重试，或联系管理员检查拆解服务。')
}

/**
 * Read a bounded MP4-family upload.
 * @param req - Authenticated browser upload.
 * @param maxBytes - Maximum size of the complete upload.
 * @param signal - Upload and worker cancellation.
 * @returns Complete uploaded bytes.
 */
export async function readUpload(req: IncomingMessage, maxBytes: number, signal: AbortSignal) {
  if (!['application/octet-stream', 'video/mp4', 'video/quicktime'].includes(req.headers['content-type'] ?? '')) {
    throw invalidVideo()
  }
  if (Number(req.headers['content-length']) > maxBytes) throw exceedsLimit()

  const stopReading = () => req.destroy()
  signal.throwIfAborted()
  signal.addEventListener('abort', stopReading, { once: true })
  try {
    return await readVideoBytes(req.iterator({ destroyOnReturn: false }), maxBytes)
  } finally {
    signal.removeEventListener('abort', stopReading)
  }
}

async function readVideoBytes(stream: AsyncIterable<unknown>, maxBytes: number): Promise<Buffer<ArrayBuffer>> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw invalidVideo()
    size += chunk.length
    if (size > maxBytes) throw exceedsLimit()
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks, size)
  if (size < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw invalidVideo()

  return bytes
}

/**
 * Send bounded media to a fixed worker and decode its small JSON response.
 * @param bytes - Validated upload bytes.
 * @param worker - Fixed, deployment-owned analysis or probe endpoint.
 * @param signal - Worker cancellation.
 * @returns Untrusted result data and any validated worker slot count.
 */
export async function requestWorker(
  bytes: Buffer<ArrayBuffer>, worker: URL, signal: AbortSignal,
): Promise<{ data: unknown; concurrency: number | undefined }> {
  const response = await sendToWorker(bytes, worker, signal)
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 503 && response.headers.get('x-remake-error') === 'speech-recognition') throw unusableDialogue()
    if (response.status === 422) throw invalidVideo()
    if (response.status === 504) throw new AnalysisError(504, 'timeout', '拆解超时，请用较短的视频重试。')
    throw new AnalysisError(503, 'unavailable', '视频拆解服务暂不可用，请稍后重试。')
  }
  const advertised = response.headers.get('x-remake-worker-concurrency')
  const concurrency = advertised === null ? undefined : Number(advertised)
  if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKER_CONCURRENCY)) {
    await response.body?.cancel()
    throw new AnalysisError(502, 'worker-result', '拆解 Worker 返回了无效的并发配置。')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new AnalysisError(502, 'worker-result', '拆解服务未返回结果，请重试。')
  const parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 256 * 1024) throw new AnalysisError(502, 'worker-result', '拆解结果超过大小限制。')
      parts.push(part.value)
    }
  } finally {
    await reader.cancel()
  }
  let data: unknown
  try {
    data = JSON.parse(Buffer.concat(parts, length).toString('utf8'))
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new AnalysisError(502, 'worker-result', '拆解服务未返回可用结果，请重试。')
    throw cause
  }
  return { data, concurrency }
}

function sendToWorker(bytes: Buffer<ArrayBuffer>, worker: URL, signal: AbortSignal) {
  return fetch(worker, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
    signal,
  })
}

/**
 * Convert a paid original into a video accepted by the platform file uploader.
 * @param bytes - Original bytes matched to the paid receipt.
 * @param worker - Fixed source preparation endpoint on the private worker.
 * @param maxBytes - Maximum prepared video size.
 * @param signal - Conversion cancellation.
 * @returns Bounded MP4 bytes.
 */
export async function prepareSource(
  bytes: Buffer<ArrayBuffer>, worker: URL, maxBytes: number, signal: AbortSignal,
): Promise<Buffer<ArrayBuffer>> {
  const response = await sendToWorker(bytes, worker, signal)
  if (!response.ok || !response.body || response.headers.get('content-type') !== 'video/mp4') {
    await response.body?.cancel()
    if (response.status === 422)
      throw new AnalysisError(422, 'source-format', '参考视频无法转换为 MP4。原拆解结果已保留。')
    if (response.status === 504)
      throw new AnalysisError(504, 'source-timeout', '转换参考视频超时，请重试进入分镜资产。')
    throw new AnalysisError(503, 'source-unavailable', '参考视频转存服务暂不可用，请检查拆解 Worker 后重试进入分镜资产。')
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel()
    throw exceedsLimit()
  }
  const prepared = await readVideoBytes(response.body, maxBytes)
  if (prepared.toString('ascii', 8, 12) === 'qt  ') throw invalidVideo()
  return prepared
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read the verified duration from either worker response.
 * @param value - Worker data.
 * @returns Measured source duration in seconds.
 */
export function durationOf(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('duration' in value) || !isNumber(value.duration)
    || value.duration < 4 || value.duration > 30) {
    throw new AnalysisError(502, 'worker-result', '拆解服务未返回可用的视频时长，请重试。')
  }
  return value.duration
}

/**
 * Validate ordered, contiguous shot times against the duration used for quoting.
 * @param value - Analysis worker data.
 * @param duration - Duration measured before analysis.
 * @returns Measured shot start and end times.
 */
export function shotsOf(value: unknown, duration: number): { start: number; end: number }[] {
  const invalid = () => new AnalysisError(502, 'worker-result', '拆解服务未返回可用的镜头时间，请重试。')
  if (durationOf(value) !== duration || typeof value !== 'object' || value === null || !('shots' in value)
    || !Array.isArray(value.shots) || value.shots.length < 1 || value.shots.length > 120) throw invalid()
  let previousEnd = 0
  const shots: unknown[] = value.shots
  const result = shots.map((shot) => {
    if (typeof shot !== 'object' || shot === null || !('start' in shot) || !('end' in shot)
      || !isNumber(shot.start) || !isNumber(shot.end) || shot.start < 0
      || Math.abs(shot.start - previousEnd) > 0.15 || shot.end <= shot.start
      || shot.end > duration + 0.15) throw invalid()
    previousEnd = shot.end
    return { start: shot.start, end: shot.end }
  })
  if (Math.abs(previousEnd - duration) > 0.15) throw invalid()
  return result
}

/**
 * Validate the full-source transcript before it becomes part of a billable analysis.
 * @param value - The worker's dialogue array, including an empty array for no detected speech.
 * @param duration - The measured source duration, in seconds.
 * @param shots - Shot starts define contiguous transcript intervals until the end of the video.
 * @returns Recognized lines on the source timeline in time order.
 */
export function dialogueOf(value: unknown, duration: number, shots: readonly { start: number }[]): RemakeSourceLine[] {
  if (!Array.isArray(value) || value.length > 120) throw unusableDialogue()
  const lines: unknown[] = value
  return lines.map((line) => {
    if (typeof line !== 'object' || line === null || !('start' in line) || !('end' in line) || !('original' in line) || !('shotNumber' in line)
      || !isNumber(line.start) || !isNumber(line.end) || line.start < 0 || line.end <= line.start || line.end > duration
      || typeof line.original !== 'string' || !line.original.trim() || line.original.length > 500) throw unusableDialogue()
    const shot = line.shotNumber
    if (!isNumber(shot) || !Number.isInteger(shot) || shot < 1) throw unusableDialogue()
    const owningShot = shots[shot - 1]
    if (!owningShot || line.start < (shot === 1 ? 0 : owningShot.start)
      || line.end > (shots[shot]?.start ?? duration)) throw unusableDialogue()
    return { start: line.start, end: line.end, original: line.original.trim(), shotNumber: shot }
  }).sort((left, right) => left.start - right.start || left.end - right.end)
}
