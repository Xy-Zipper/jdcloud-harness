/** Admit a bounded number of connected video uploads in arrival order. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { AnalysisError } from './analysis.ts'

type SpaceId = Branded<'CreationStudioSpaceId'>
type Waiter = { resume: () => void; space: SpaceId | undefined }

/**
 * Limit uploads and worker operations without reading queued request bodies.
 * @param initialConcurrency - Number of available slots before a worker reports capacity.
 * @param maxQueued - Maximum number of requests waiting for a slot.
 * @returns A queue that serializes paid requests per space and can change its total capacity.
 */
export function createUploadQueue(initialConcurrency: number, maxQueued: number) {
  const waiting = new Set<Waiter>()
  const paidSpaces = new Set<SpaceId>()
  let concurrency = initialConcurrency
  let occupied = 0

  function reserve(space: SpaceId | undefined) {
    occupied++
    if (space !== undefined) paidSpaces.add(space)
  }

  function dispatch() {
    for (const waiter of waiting) {
      if (occupied >= concurrency) break
      if (waiter.space !== undefined && paidSpaces.has(waiter.space)) continue
      waiting.delete(waiter)
      reserve(waiter.space)
      waiter.resume()
    }
  }

  async function run<Result>(signal: AbortSignal, operation: () => Promise<Result>, space?: SpaceId): Promise<Result> {
    signal.throwIfAborted()
    if (occupied < concurrency && (space === undefined || !paidSpaces.has(space))) {
      reserve(space)
    } else {
      if (waiting.size >= maxQueued)
        throw new AnalysisError(503, 'queue-full', '拆解排队已满，请稍后重试。')
      await new Promise<void>((resolve, reject) => {
        function resume() {
          signal.removeEventListener('abort', cancel)
          resolve()
        }
        function cancel() {
          waiting.delete(waiter)
          reject(new AnalysisError(504, 'queue-timeout', '等待拆解空位超时，本次请求尚未开始，请稍后重试。'))
        }
        const waiter = { resume, space }
        waiting.add(waiter)
        signal.addEventListener('abort', cancel, { once: true })
      })
    }

    try {
      signal.throwIfAborted()
      return await operation()
    } finally {
      occupied--
      if (space !== undefined) paidSpaces.delete(space)
      dispatch()
    }
  }

  return {
    run,
    setConcurrency(value: number) {
      concurrency = value
      dispatch()
    },
  }
}
