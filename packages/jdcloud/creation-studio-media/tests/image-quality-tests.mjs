import { expect, it } from 'vitest'
import { requestGptImage } from '../src/images.mjs'

it('adds structure constraints to the actual image provider request without replacing user composition', async () => {
  let sent
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
  await requestGptImage('test-key', 'test-model', {
    prompt: '生成一张白底的道具多视角参考图', size: '1024x1024',
  }, [], async (_url, init) => {
    sent = JSON.parse(String(init.body))
    return Response.json({ data: [{ b64_json: png }] })
  })
  expect(sent?.prompt).toContain('生成一张白底的道具多视角参考图')
  expect(sent?.prompt).toContain('避免畸形、扭曲')
  expect(sent?.prompt).toContain('不要只复制同一个角度')
  await expect(`${sent?.prompt}\n`).toMatchFileSnapshot('./expected/image-quality-prompt.txt')
})
