/** Exercise the upload queue without network or clock dependencies. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it } from 'vitest'
import { createUploadQueue } from '../src/upload-queue.ts'

it('gives the released slot to the oldest waiting upload', async () => {
  const { run } = createUploadQueue(1, 2)
  const signal = new AbortController().signal
  const first = Promise.withResolvers<undefined>()
  const order: number[] = []
  const requests = [
    run(signal, async () => {
      order.push(1)
      await first.promise
    }),
    run(signal, async () => { order.push(2) }),
    run(signal, async () => { order.push(3) }),
  ]

  try {
    expect(order).toEqual([1])
  } finally {
    first.resolve(undefined)
    await Promise.all(requests)
  }
  expect(order).toEqual([1, 2, 3])
})

it('removes an aborted upload before it can read its body or run the worker', async () => {
  const { run } = createUploadQueue(1, 1)
  const signal = new AbortController().signal
  const first = Promise.withResolvers<undefined>()
  const running = run(signal, () => first.promise)
  const disconnect = new AbortController()
  let started = false
  const abandoned = run(disconnect.signal, async () => { started = true })
  const rejection = expect(abandoned).rejects.toMatchObject({ status: 504, code: 'video-remake/queue-timeout' })
  let replacement: Promise<string> | undefined
  try {
    await expect(run(signal, () => Promise.resolve('overflow')))
      .rejects.toMatchObject({ status: 503, code: 'video-remake/queue-full' })
    disconnect.abort()
    await rejection
    replacement = run(signal, () => Promise.resolve('admitted'))
  } finally {
    disconnect.abort()
    first.resolve(undefined)
    await Promise.allSettled([running, rejection, replacement])
  }
  await expect(replacement).resolves.toBe('admitted')
  expect(started).toBe(false)
})

it('updates capacity while preserving one paid analysis per space', async () => {
  const { run, setConcurrency } = createUploadQueue(1, 2)
  const signal = new AbortController().signal
  const space = brandString<Branded<'CreationStudioSpaceId'>>('first-space')
  const otherSpace = brandString<Branded<'CreationStudioSpaceId'>>('other-space')
  const releaseFirst = Promise.withResolvers<undefined>()
  const releaseOther = Promise.withResolvers<undefined>()
  const otherStarted = Promise.withResolvers<undefined>()
  const order: string[] = []
  const first = run(signal, () => releaseFirst.promise, space)
  const sameSpace = run(signal, async () => { order.push('first space') }, space)
  const other = run(signal, async () => {
    order.push('other space')
    otherStarted.resolve(undefined)
    await releaseOther.promise
  }, otherSpace)

  try {
    setConcurrency(2)
    await otherStarted.promise
    expect(order).toEqual(['other space'])
    setConcurrency(1)
    releaseFirst.resolve(undefined)
    await first
    expect(order).toEqual(['other space'])
  } finally {
    releaseFirst.resolve(undefined)
    releaseOther.resolve(undefined)
    await Promise.all([first, sameSpace, other])
  }
  expect(order).toEqual(['other space', 'first space'])
})
