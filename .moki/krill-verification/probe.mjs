import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createImageService } from '../../packages/jdcloud/creation-studio-media/src/images.mjs'
const directory = resolve('.moki/krill-verification', String(Date.now()))
await mkdir(directory, { recursive: true })
const dotenv = await readFile('.env', 'utf8')
const apiKey = /^\s*GPT_IMAGE_API_KEY\s*=\s*(.*)$/mu.exec(dotenv)?.[1].replace(/^['"]|['"]$/gu, '').trim()
if (!apiKey) throw new Error('GPT_IMAGE_API_KEY is not configured')
const fixture = JSON.parse(await readFile('packages/jdcloud/creation-studio-media/tests/project.fixture.json', 'utf8'))
const platform = 'https://mi.kindoucloud.com'
const reference = fixture.imageReferences[0]
const records = new Map([
  [fixture.project._id, fixture.project], [fixture.plan._id, fixture.plan],
  [fixture.project.spaceId, { _id: fixture.project.spaceId, ownerUserId: 'owner', status: 'active' }],
  [reference.relationId, { _id: reference.relationId, materialId: reference.materialId, projectId: fixture.project._id, spaceId: fixture.project.spaceId, sourceRevision: 1 }],
  [reference.materialId, { _id: reference.materialId, spaceId: fixture.project.spaceId, revision: 1, sourceKind: 'uploaded', authorization: '自有', mime: 'image/jpeg', fileId: '6ae2f000913cb8fd4bc77656' }],
])
const transport = async (url, init = {}) => {
  if (!url.startsWith(platform + '/api/')) return fetch(url, init)
  if (url.endsWith('/currentUser')) return Response.json({ code: 200, data: { userInfo: { id: 'owner', corpId: fixture.requirement._meta.tenantId } } })
  const body = JSON.parse(init.body)
  return Response.json({ code: 200, data: url.endsWith('/form/list') ? { list: fixture.rows } : records.get(body._id) })
}
const service = createImageService({ GPT_IMAGE_API_KEY: apiKey, GPT_IMAGE_MODEL: 'gpt-image-2.5', CREATION_STUDIO_PLATFORM_URL: platform,
  CREATION_STUDIO_TENANT_ID: fixture.requirement._meta.tenantId, CREATION_STUDIO_IMAGE_STATE_DIR: directory, CREATION_STUDIO_IMAGE_RETRY_LIMIT: 2 }, transport)
const input = { projectId: fixture.project._id, planId: fixture.plan._id, spaceId: fixture.project.spaceId, requestId: 'krill-reference-check-' + Date.now(),
  prompt: '图1为真实产品的正面参考，只用来确认表壳、镂空盘面、钢带与表冠的外形和比例。生成一张实拍风格参考图：一名通勤者的右手腕戴着与图1同款的黑色钢带腕表，深灰色西装袖口停在表耳上方，露出完整表盘；保留皮肤与布料真实质感，冷白单侧硬光，低饱和冷灰室内虚化背景。保持手表结构与已有标识不变，不添加新文字、参数或装饰，不出现面部。',
  referenceIds: [reference.relationId], size: '1024x1024' }
await writeFile(join(directory, 'input.json'), JSON.stringify(input, null, 2))
let task = await service.submit('synthetic-platform-auth', input)
const report = async () => {
  const value = { requestId: input.requestId, status: task.status, taskId: task.taskId, retryCount: task.retryCount ?? 0,
    errorCode: task.errorCode, error: task.error, receiptDirectory: directory }
  await writeFile(join(directory, 'report.json'), JSON.stringify(value, null, 2))
  console.log(JSON.stringify(value))
}
await report()
const deadline = Date.now() + 240000
while (task.status === 'pending' && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 3000))
  task = await service.refresh('synthetic-platform-auth', input)
  await report()
}
if (task.status === 'succeeded') {
  const bytes = Buffer.from(task.result.b64, 'base64')
  const file = join(directory, 'reference-edit.' + (task.result.mime === 'image/jpeg' ? 'jpg' : task.result.mime === 'image/webp' ? 'webp' : 'png'))
  await writeFile(file, bytes)
  console.log(JSON.stringify({ generated: true, file, mime: task.result.mime, bytes: bytes.length, taskId: task.taskId }))
} else if (task.status !== 'pending') process.exitCode = 1
