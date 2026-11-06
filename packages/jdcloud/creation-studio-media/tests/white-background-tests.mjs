import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createWhiteBackgroundService } from '../src/white-background.mjs'
import { createProviderAccountPool } from '../src/provider-accounts.mjs'

const roots = []
const MATERIAL = '6ad81c871f280486bb45ac43'
const RELATION = '6ad81c871f280486bb45ac45'
const PROJECT = '6ad81c131f280486bb45ac3f'
const SPACE = '6adb0fbec3ca9f3dcdaf499a'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'jimeng-white-'))
  roots.push(directory)
  const input = { projectId: 'a'.repeat(24), spaceId: 'b'.repeat(24), materialId: 'c'.repeat(24), prompt: '只保留红色水杯', requestId: 'white-request' }
  const config = { platformURL: 'https://platform.example', tenantId: 'd'.repeat(24), stateDirectory: directory,
    jimengAccessKeyRef: 'AK', jimengSecretKeyRef: 'SK' }
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()
  const source = { _id: input.materialId, spaceId: input.spaceId, name: '商品.png', originalName: '商品.png',
    fileId: 'e'.repeat(24), mime: 'image/png', revision: 1, authorization: '自有', sourceKind: 'uploaded' }
  const rows = []
  const uploads = []
  let lostRelation = false
  const auth = {
    currentScopeKey: async () => 'actor',
    status: async () => ({ authenticated: true, corpId: config.tenantId, baseUrl: config.platformURL }),
    writableMenus: async () => ({ menus: [MATERIAL, RELATION].map(menuId => ({ menuId, agentPermissions: ['addData'] })) }),
    downloadFileAuthenticated: vi.fn(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } })),
    requestAuthenticated: vi.fn(async ({ path, body, multipartFile }) => {
      if (path === '/api/oauth/currentUser') return { userInfo: { id: 'actor', corpId: config.tenantId } }
      if (path.endsWith('/info')) {
        if (body.menuId === PROJECT) return { _id: input.projectId, spaceId: input.spaceId }
        if (body.menuId === SPACE) return { _id: input.spaceId, ownerUserId: 'actor', status: 'active', points: '20' }
        if (body.menuId === MATERIAL) return source
      }
      if (path === '/api/file/uploader') {
        uploads.push(multipartFile)
        return { url: `/api/file/previewImage/${config.tenantId}/${String(uploads.length).padStart(24, 'f')}` }
      }
      if (path.endsWith('/list')) return { list: rows.filter(row => row.menuId === body.menuId
        && body.filter.every(filter => row[filter.enCode] === filter.value)) }
      if (path.endsWith('/create')) {
        const row = { _id: String(rows.length).padStart(24, 'a'), menuId: body.menuId, ...JSON.parse(body.data) }
        rows.push(row)
        if (lostRelation && body.menuId === RELATION) { lostRelation = false; throw new Error('connection lost after create') }
        return row._id
      }
      throw new Error(`Unexpected platform path: ${path}`)
    }),
  }
  const provider = vi.fn(async (url, init) => {
    expect(url).toContain('https://visual.volcengineapi.com/')
    expect(init.headers.Authorization).toContain('Credential=access-key/')
    expect(init.headers.Authorization).toContain('/cn-north-1/cv/request')
    expect(init.headers).not.toHaveProperty('token')
    if (url.includes('CVSync2AsyncSubmitTask')) return Response.json({ code: 10000, data: { task_id: 'jimeng-task' } })
    return Response.json({ code: 10000, data: { status: 'done', binary_data_base64: [png.toString('base64')] } })
  })
  const keys = async key => key === 'AK' ? 'access-key' : key === 'SK' ? 'secret-key' : ''
  const billing = { beginMedia: vi.fn(async () => ({ initiatedByUserId: 'actor', prices: [] })), media: vi.fn() }
  const service = accounts => createWhiteBackgroundService(config, auth, keys, billing, provider, accounts)
  return { input, config, source, auth, provider, billing, rows, uploads, service, directory, keys, png,
    loseNextRelationAcknowledgement() { lostRelation = true } }
}

it('generates white-background images with the selected Seedream model and records the Ark account', async () => {
  const f = await setup()
  const pool = createProviderAccountPool(f.config, f.auth, async key => key === 'ARK_API_KEY' ? 'ark-test-key' : '')
  f.provider.mockImplementation(async (url, init) => {
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: 'doubao-seedream-5-0-flash-260915', size: '1536x864' })
    expect(body.prompt).toContain('只编辑背景，不重新设计或重绘商品')
    expect(body.prompt).toContain('不修改包装文字、图案、按钮及接口')
    expect(body.prompt).toContain('不增加原图中不存在的配件')
    return Response.json({ data: [{ b64_json: f.png.toString('base64') }] })
  })
  f.input.model = 'doubao-seedream-5-0-flash-260915'
  f.input.size = '1536x864'
  const task = await f.service(pool).run('tasks', f.input)
  expect(task.providerAccountRef).toBe('ENV-ARK')
  const result = await f.service(pool).run('refresh', f.input)
  expect(result.status).toBe('succeeded')
  expect(f.billing.media.mock.calls.at(-1)[3]).toMatchObject({ providerAccountRef: 'ENV-ARK', provider: 'ark', imageInputCount: 1 })
  expect(f.billing.media.mock.calls.at(-1)[4]).toMatchObject({ imagePixels: 1024 })
  const files = await readdir(join(f.directory, 'provider-calls'))
  const audit = await readFile(join(f.directory, 'provider-calls', files[0]), 'utf8')
  expect(JSON.parse(audit)).toMatchObject({ providerAccountRef: 'ENV-ARK', initiatedByUserId: 'actor', status: 'succeeded' })
  expect(audit).not.toMatch(/access-key|secret-key/u)
})
it('blocks a new white-background submission at zero points while preserving a paid task for recovery', async () => {
  const f = await setup()
  const original = f.auth.requestAuthenticated.getMockImplementation()
  let points = '0'
  f.auth.requestAuthenticated.mockImplementation(async request => {
    const data = await original(request)
    return request.path.endsWith('/info') && request.body.menuId === SPACE ? { ...data, points } : data
  })
  const service = f.service()
  await expect(service.run('tasks', f.input)).rejects.toMatchObject({ code: 'creation-studio/insufficient-points' })
  expect(f.provider).not.toHaveBeenCalled()
  points = '0.001'
  expect((await service.run('tasks', f.input)).status).toBe('in_queue')
  points = '-1'
  expect((await service.run('refresh', f.input)).status).toBe('succeeded')
  expect(f.provider.mock.calls.filter(([url]) => url.includes('SubmitTask'))).toHaveLength(1)
})

it('signs a forced single-image edit, preserves the original and uploads a reusable project material', async () => {
  const f = await setup()
  const runtime = f.service()
  const submitted = await runtime.run('tasks', f.input)
  expect(submitted).toMatchObject({ status: 'in_queue', taskId: 'jimeng-task' })
  const body = JSON.parse(f.provider.mock.calls[0][1].body)
  expect(f.provider.mock.calls[0][1].headers.Authorization).toContain('SignedHeaders=content-type;host;x-content-sha256;x-date')
  expect(body).toMatchObject({ req_key: 'jimeng_t2i_v40', force_single: true, width: 2048, height: 2048 })
  expect(body.prompt).toContain('只保留红色水杯')
  expect(body.prompt).toContain('纯白背景（#FFFFFF）')
  expect(body.image_urls).toHaveLength(1)
  const result = await runtime.run('refresh', f.input)
  expect(result.status).toBe('succeeded')
  const material = f.rows.find(row => row.menuId === MATERIAL)
  expect(material).toMatchObject({ library: 'project', sourceKind: 'generated', authorization: '自有', mime: 'image/png', width: 32 })
  expect(JSON.parse(material.sourceDescription)).toMatchObject({ whiteBackground: { sourceMaterialId: f.input.materialId },
    generatedImage: { model: 'jimeng_t2i_v40', confirmedAt: '' } })
  expect(f.source.name).toBe('商品.png')
  expect(f.rows.find(row => row.menuId === RELATION)).toMatchObject({ projectId: f.input.projectId, materialId: material._id, purpose: '参考图' })
  expect(JSON.stringify(result)).not.toMatch(/binary_data|secret-key|access-key|prices/u)
  expect(f.billing.media.mock.calls.at(-1)[3]).toMatchObject({ provider: 'jimeng', model: 'jimeng_t2i_v40', status: 'succeeded' })
})

it('removes poster text while preserving product lettering when subject instructions are blank', async () => {
  const f = await setup()
  await f.service().run('tasks', { ...f.input, prompt: '' })
  const { prompt } = JSON.parse(f.provider.mock.calls[0][1].body)
  expect(prompt).toContain('删除原图中商品之外的所有文字')
  expect(prompt).toContain('保留商品本体上的文字与标识')
  expect(prompt).toContain('保留商品轮廓、比例、颜色与材质')
  expect(prompt).toContain('不修改包装文字、图案、按钮及接口')
  expect(prompt).toContain('保留自然接触阴影')
  expect(prompt).toContain('保留原图视角、朝向、商品数量及可见结构')
  expect(prompt).toContain('看不清或被遮挡的细节不得猜测、补写或重构')
  expect(prompt).toContain('不增加原图中不存在的配件')
  await expect(`${prompt}\n`).toMatchFileSnapshot('./expected/white-background-prompt.txt')
})

it('sends the user multi-view request with layout and structure constraints rather than a single-view override', async () => {
  const f = await setup()
  const prompt = '生成一张白底的道具多视角参考图'
  await f.service().run('tasks', { ...f.input, prompt })
  const body = JSON.parse(f.provider.mock.calls[0][1].body)
  expect(body.prompt).toContain(`用户本次生成要求：\n${prompt}`)
  expect(body.prompt).toContain('不限制其中的视角数量')
  expect(body.prompt).toContain('正面、侧面、四分之三视角')
  expect(body.prompt).toContain('避免畸形、扭曲')
  expect(body.prompt).toContain('不得以多视角要求为由改变商品结构或编造未见细节')
  expect(body.force_single).toBe(true)
  await expect(`${body.prompt}\n`).toMatchFileSnapshot('./expected/white-background-multiview-prompt.txt')
})

it('recovers a lost low-code create response after restart without another paid request or duplicate material', async () => {
  const f = await setup()
  await f.service().run('tasks', f.input)
  f.loseNextRelationAcknowledgement()
  expect((await f.service().run('refresh', f.input)).status).toBe('upload_failed')
  const recovered = await f.service().run('refresh', f.input)
  expect(recovered.status).toBe('succeeded')
  expect(f.provider.mock.calls.filter(([url]) => url.includes('SubmitTask'))).toHaveLength(1)
  expect(f.rows.filter(row => row.menuId === MATERIAL)).toHaveLength(1)
  expect(f.rows.filter(row => row.menuId === RELATION)).toHaveLength(1)
  expect(f.uploads).toHaveLength(2)
})

it('does not resubmit unknown paid tasks and refuses a changed prompt under the same request ID', async () => {
  const f = await setup()
  f.provider.mockRejectedValue(new Error('connection lost'))
  const runtime = f.service()
  expect((await runtime.run('tasks', f.input)).status).toBe('unknown')
  expect((await runtime.run('tasks', f.input)).status).toBe('unknown')
  await runtime.run('refresh', f.input)
  expect(f.provider).toHaveBeenCalledTimes(1)
  await expect(runtime.run('tasks', { ...f.input, prompt: '换成蓝色瓶子' })).rejects.toThrow('其他图片或提示词')
})

it('serializes concurrent submit and refresh and keeps credentials outside persisted receipts', async () => {
  const f = await setup()
  const runtime = f.service()
  await Promise.all([runtime.run('tasks', f.input), runtime.run('tasks', f.input)])
  await Promise.all([runtime.run('refresh', f.input), runtime.run('refresh', f.input)])
  expect(f.provider.mock.calls.filter(([url]) => url.includes('SubmitTask'))).toHaveLength(1)
  expect(f.rows.filter(row => row.menuId === MATERIAL)).toHaveLength(1)
  const path = join(f.directory, 'white-background', (await readdir(join(f.directory, 'white-background')))[0])
  expect(await readFile(path, 'utf8')).not.toMatch(/access-key|secret-key|Authorization/u)
  expect((await runtime.run('list', f.input))).toHaveLength(1)
})

it('rejects other-space materials and missing write permission before contacting the provider', async () => {
  const f = await setup()
  f.source.spaceId = '9'.repeat(24)
  await expect(f.service().run('tasks', f.input)).rejects.toThrow('当前空间')
  expect(f.provider).not.toHaveBeenCalled()
  f.source.spaceId = f.input.spaceId
  f.auth.writableMenus = async () => ({ menus: [] })
  await expect(f.service().run('tasks', f.input)).rejects.toThrow('权限')
  expect(f.provider).not.toHaveBeenCalled()
})

it('retains a queued task after a query rate limit and refuses multiple output images', async () => {
  const f = await setup()
  const runtime = f.service()
  await runtime.run('tasks', f.input)
  f.provider.mockResolvedValueOnce(Response.json({ code: 50429, message: 'API limit' }, { status: 429 }))
  await expect(runtime.run('refresh', f.input)).rejects.toThrow('API limit')
  expect((await runtime.run('list', f.input))[0].status).toBe('in_queue')
  f.provider.mockResolvedValueOnce(Response.json({ code: 10000, data: { status: 'done', binary_data_base64: ['one', 'two'] } }))
  await expect(runtime.run('refresh', f.input)).rejects.toThrow('单张有效图片')
  expect(f.rows).toHaveLength(0)
  expect(f.provider.mock.calls.filter(([url]) => url.includes('SubmitTask'))).toHaveLength(1)
})
