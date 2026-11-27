/** Run a plan-free remake through the authenticated Web profile and the real media recorder. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const tenantId = 'a'.repeat(24)
const spaceId = 'b'.repeat(24)
const projectId = 'c'.repeat(24)
const sourceRefId = 'd'.repeat(24)
const subjectRefId = 'e'.repeat(24)
const sourceMaterialId = 'f'.repeat(24)
const subjectMaterialId = '1'.repeat(24)
const sourceFileId = '2'.repeat(24)
const subjectFileId = '3'.repeat(24)
const outputFileId = '4'.repeat(24)
const legacyProjectId = '5'.repeat(24)
const userId = '6'.repeat(24)
const generatedFileId = '7'.repeat(24)
const legacyFileId = '8'.repeat(24)
const selectedFileId = '9'.repeat(24)
const storyboardFileId = '0'.repeat(24)
const fittedFileId = 'a1'.repeat(12)
const musicRefId = 'b1'.repeat(12)
const musicMaterialId = 'c1'.repeat(12)
const musicFileId = 'd1'.repeat(12)
const dubbedFileId = 'e1'.repeat(12)
const imageModel = 'doubao-seedream-5-0-pro-260628'
const materialMenu = '6ad81c871f280486bb45ac43'
const relationMenu = '6ad81c871f280486bb45ac45'
const usageMenu = '6ad81c871f280486bb45ac5b'
const requestId = `remake-${subjectRefId}`
const origin = 'https://creation-studio-remake.example'
const clipWorker = 'http://remake-edits.example'
const bundleManifest = fileURLToPath(new URL('../../../packages/bundle/jdcloud-login/package.json', import.meta.url))

function jsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') throw new Error('Expected JSON text.')
  const value: unknown = JSON.parse(body)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a record.')
  return value as Record<string, unknown>
}

function wavFixture(seconds: number): ArrayBuffer {
  const samples = 8_000 * seconds
  const wav = new ArrayBuffer(44 + samples * 2)
  const bytes = Buffer.from(wav)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8_000, 24)
  bytes.writeUInt32LE(16_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  return wav
}

it('archives new Seedance remakes directly and resumes legacy local assembly from its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-remake-generation-'))
  const music = wavFixture(8)
  const rows = new Map<string, Record<string, unknown>>([
    [spaceId, { _id: spaceId, ownerUserId: userId, status: 'active', points: '50.00' }],
    [legacyProjectId, { _id: legacyProjectId, spaceId }],
    [projectId, { _id: projectId, spaceId, specification: JSON.stringify({
      videoRemake: { version: 1, duration: 6.25, sourceRefId, subjectRefId, shots: [{ start: 0, end: 6.25 }] },
    }) }],
    [sourceRefId, { _id: sourceRefId, spaceId, projectId, sourceRevision: 1, materialId: sourceMaterialId, purpose: '需求附件' }],
    [subjectRefId, { _id: subjectRefId, spaceId, projectId, sourceRevision: 1, materialId: subjectMaterialId, purpose: '分镜图' }],
    [sourceMaterialId, { _id: sourceMaterialId, spaceId, fileId: sourceFileId, revision: 1, mime: 'video/mp4', library: 'project', sizeBytes: 12, sourceKind: 'uploaded', authorization: '自有' }],
    [subjectMaterialId, { _id: subjectMaterialId, spaceId, fileId: subjectFileId, revision: 1, mime: 'image/png', width: 720, height: 720, sourceKind: 'uploaded', authorization: '自有' }],
    [musicRefId, { _id: musicRefId, spaceId, projectId, sourceRevision: 1, materialId: musicMaterialId, purpose: '需求附件' }],
    [musicMaterialId, { _id: musicMaterialId, spaceId, fileId: musicFileId, revision: 1, mime: 'audio/wav', library: 'project', sizeBytes: music.byteLength, sourceKind: 'uploaded', authorization: '自有' }],
  ])
  const usage: Record<string, unknown>[] = []
  const outputs: Record<string, unknown>[] = []
  const providerCalls: Record<string, unknown>[] = []
  const imageCalls: Record<string, unknown>[] = []
  const clipCalls: string[] = []
  const uploadedVideos: string[] = []
  let writes = 0
  let sourceReads = 0
  let assembleLegacy = false
  let denyPortrait = false
  let outputUnavailable = false
  const reply = (data: unknown) => Response.json({ code: 200, data })
  const clip = '0000ftypisom'
  const providerVideo = '0000ftypedit'
  let publicMusic = music
  const originalLine = { start: 1.1, end: 2, original: 'Good morning.', shotNumber: 1 }
  const oldCaption = { start: 1, end: 2.1, text: 'GOOD MORNING.', box: [0.21, 0.48, 0.58, 0.05] }
  let captionRenderFailed = true
  const musicSettings = { format: 'wav', start: 4, end: 7 }
  const captions = { mode: 'burned', cues: [oldCaption], originalEdit: true, scale: 1,
    lines: [{ start: 1.1, end: 2, text: '早上好。' }, { start: 3, end: 4, text: '欢迎。' }] }
  const outputUrl = 'https://result.tos-cn-beijing.volces.com/studio-remake.mp4'
  const generatedUrl = 'https://result.tos-cn-beijing.volces.com/studio-subject.png'
  const generatedBytes = await readFile(new URL('../public/icon-512.png', import.meta.url))
  const ark = 'https://ark.cn-beijing.volces.com'
  const mediaRoot = '/api/external/v1/creation-studio/media/'
  try {
    const overlay = join(root, 'studio-remake-generation.yml')
    await writeFile(overlay, `- insert:
    - id: jdcloud-auth-controller
      name: '@deepseek-ai/dsh-api-jdcloud-auth-controller'
    - id: creation-studio-media
      name: '@deepseek-ai/dsh-creation-studio-media'
      config:
        platformURL: ${origin}
        tenantId: ${tenantId}
        stateDirectory: ${JSON.stringify(join(root, 'media'))}
        arkKeyRef: STUDIO_REMAKE_FIXTURE_KEY
        accountPoolUsernameRef: STUDIO_REMAKE_FIXTURE_NO_USERNAME
        accountPoolPasswordRef: STUDIO_REMAKE_FIXTURE_NO_PASSWORD
        accountPoolKeyRef: STUDIO_REMAKE_FIXTURE_NO_POOL_TOKEN
        billingWriterKeyRef: STUDIO_REMAKE_FIXTURE_NO_WRITER
        videoRemake:
          workerURL: ${clipWorker}/analyze
`)
    vi.stubEnv('STUDIO_REMAKE_FIXTURE_KEY', 'fixture-ark')
    const fetcher = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.href === outputUrl) return outputUnavailable
        ? new Response(null, { status: 503 }) : new Response(providerVideo, { headers: { 'content-type': 'video/mp4' } })
      if (url.href === generatedUrl) return new Response(generatedBytes, { headers: { 'content-type': 'image/png' } })
      if (url.origin === clipWorker) {
        expect(init?.method).toBe('POST')
        if (!Buffer.isBuffer(init?.body)) throw new Error('Expected local worker input bytes.')
        const headers = new Headers(init?.headers)
        clipCalls.push(url.pathname)
        if (url.pathname === '/transcript') {
          expect(String(init?.body)).toBe(clip)
          expect(headers.get('X-Remake-Ranges')).toBe('[0,2.25,4.75,6.25]')
          return Response.json({ lines: [originalLine] })
        }
        if (!assembleLegacy) throw new Error(`New remake unexpectedly called ${url.pathname}`)
        expect(headers.get('X-Remake-Source-Length')).toBe('12')
        if (url.pathname === '/sync-captions') {
          expect(init.body.subarray(0, 12).toString()).toBe('0000ftypbgm!')
          expect(JSON.parse(init.body.subarray(12).toString())).toEqual(captions)
          if (captionRenderFailed) return Response.json({}, { status: 503 })
          return new Response('0000ftypsubs', { headers: { 'content-type': 'video/mp4' } })
        }
        if (url.pathname === '/mix-bgm') {
          expect(JSON.parse(headers.get('X-Remake-Music')!)).toEqual(musicSettings)
          expect(init.body.subarray(0, 12).toString()).toBe('0000ftypfull')
          expect(init.body.subarray(12)).toEqual(Buffer.from(music))
          return new Response('0000ftypbgm!', { headers: { 'content-type': 'video/mp4' } })
        }
        expect(url.pathname).toBe('/merge-edit')
        expect(headers.get('X-Remake-Ranges')).toBe('null')
        expect(headers.get('X-Remake-Output-Settings')).toBe('{"audio":"generated"}')
        expect(String(init.body)).toBe(clip + providerVideo)
        return new Response('0000ftypfull', { headers: { 'content-type': 'video/mp4', 'X-Remake-Output-Settings': '1' } })
      }
      if (url.origin === ark) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-ark')
        if (url.pathname.endsWith('/images/generations')) {
          imageCalls.push(jsonBody(init?.body))
          return Response.json({ data: [{ url: generatedUrl }] })
        }
        if (init?.method === 'POST') {
          providerCalls.push(jsonBody(init.body))
          if (denyPortrait)
            return Response.json({ error: { code: 'InputVideoSensitiveContentDetected.PrivacyInformation', message: 'Input video content[3] may contain a real person.' } }, { status: 400 })
          if (providerCalls.length === 1)
            return Response.json({ error: { code: 'RequestRejected', message: 'Unsupported source format' } }, { status: 400 })
          return Response.json({ id: `cgt-studio-remake-${providerCalls.length}` })
        }
        const requested = providerCalls[Number(url.pathname.split('-').at(-1)) - 1]?.duration
        expect(typeof requested).toBe('number')
        return Response.json({ status: 'succeeded', duration: requested === -1 ? 6.22 : requested,
          usage: { completion_tokens: 10_000 }, content: { video_url: outputUrl } })
      }
      if (url.origin !== origin) return fetcher(input, init)
      if (url.pathname.endsWith(`/${musicFileId}`)) {
        const authorization = new Headers(init?.headers).get('authorization')
        expect(authorization).toBe(assembleLegacy ? 'bearer remake-fixture' : null)
        return new Response(publicMusic, { headers: { 'content-type': 'audio/wav' } })
      }
      if (url.pathname.endsWith(`/${sourceFileId}`)) {
        sourceReads++
        if (new Headers(init?.headers).get('authorization') === 'bearer remake-fixture')
          return new Response(clip, { headers: { 'content-type': 'video/mp4' } })
        expect(new Headers(init?.headers).get('range')).toBe('bytes=0-11')
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        return new Response(clip, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-11/12' } })
      }
      if (url.pathname.endsWith(`/${subjectFileId}`))
        return new Response('image', { headers: { 'content-type': 'image/png' } })
      if (url.pathname === `/api/file/previewImage/${tenantId}/${generatedFileId}`) {
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        return new Response(generatedBytes, { headers: { 'content-type': 'image/png' } })
      }
      const publicFile = url.pathname.includes(`/${sourceFileId}`) || url.pathname.includes(`/${subjectFileId}`)
      if (!publicFile)
        expect(new Headers(init?.headers).get('authorization')).toBe('bearer remake-fixture')
      if (url.pathname === '/api/file/uploader') {
        if (!(init?.body instanceof FormData)) throw new Error('Expected media form data.')
        const file = init.body.get('file')
        if (!(file instanceof File)) throw new Error('Expected a media upload file.')
        if (file.type === 'video/mp4') uploadedVideos.push(await file.text())
        writes++
        const fileId = [
          outputFileId, generatedFileId, selectedFileId, storyboardFileId, fittedFileId, dubbedFileId, legacyFileId,
        ][writes - 1]
        return reply({ url: `/api/file/dowloadFile/${tenantId}/${fileId}` })
      }
      const data = init?.body === undefined ? {} : jsonBody(init.body)
      switch (url.pathname) {
        case '/api/system/corp/getCorpList':
          return reply({ corpId: tenantId, corpList: [{ corpId: tenantId, corpName: 'Studio' }], joinCorpList: [] })
        case '/api/oauth/currentUser':
          return reply({ userInfo: { id: userId, userName: 'fixture', corpId: tenantId },
            menuList: [materialMenu, relationMenu].map(id => ({ id, parentId: '-1', fullName: id, type: 3, agentPermissions: ['addData'] })) })
        case '/api/visualdev/form/info':
          expect(typeof data._id).toBe('string')
          return reply(rows.get(String(data._id)))
        case '/api/visualdev/form/list': {
          if (data.menuId === '6ad81c871f280486bb45ac59')
            return reply({ list: [{ scenario: 'video', provider: 'ark', modelKey: 'doubao-seedance-2-5-260628',
              currency: 'CNY', billingUnit: 'million_tokens', pricingStatus: 'published',
              inputVideoMode: 'present', videoPerMillionYuan: '80' },
            { scenario: 'video', provider: 'ark', modelKey: 'doubao-seedance-2-5-260628',
              currency: 'CNY', billingUnit: 'million_tokens', pricingStatus: 'published',
              inputVideoMode: 'none', videoPerMillionYuan: '140' },
            { scenario: 'video', provider: 'ark', modelKey: 'doubao-seedance-2-0-fast-260128',
              currency: 'CNY', billingUnit: 'million_tokens', pricingStatus: 'published',
              inputVideoMode: 'none', videoPerMillionYuan: '120' },
            { scenario: 'image', provider: 'ark', modelKey: imageModel,
              currency: 'CNY', billingUnit: 'image', pricingStatus: 'published', imagePerUnitYuan: '0.30' }] })
          expect(data.menuId).toBe(usageMenu)
          const filters = data.filter as { enCode: string; value: unknown }[]
          return reply({ list: usage.filter(row => filters.every(filter => row[filter.enCode] === filter.value)) })
        }
        case '/api/visualdev/form/create': {
          const row = { ...jsonBody(data.data), _id: (10 + rows.size).toString(16).padStart(24, '0') }
          rows.set(row._id, row)
          if (data.menuId === usageMenu) usage.push(row)
          else if (data.menuId === relationMenu) outputs.push(row)
          else expect(data.menuId).toBe(materialMenu)
          return reply(row._id)
        }
        case '/api/visualdev/form/update': {
          expect(data.menuId).toBe(usageMenu)
          Object.assign(rows.get(String(data._id))!, jsonBody(data.data))
          return reply(data._id)
        }
        default:
          throw new Error(`Unexpected fixture request ${url.pathname}`)
      }
    })
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, extraInstallAnchors: [bundleManifest] })
    try {
      const headers = { 'authorization': 'Bearer bearer remake-fixture', 'x-tenant-id': tenantId, 'x-jdcloud-base-url': origin, 'content-type': 'application/json' }
      const call = (action: string, data: object = {}) => scaffold.hostFetch(mediaRoot + (action.includes('/') ? action : `video/${action}`), {
        method: 'POST', headers, body: JSON.stringify({ projectId, spaceId, ...data }), signal: AbortSignal.timeout(5000),
      })
      expect((await call('list', { projectId: legacyProjectId })).status).toBe(401)
      expect((await call('tasks', { requestId: 'remake-missing-subject' })).status).toBe(409)
      const reference = rows.get(sourceRefId)!
      reference.projectId = legacyProjectId
      expect((await call('tasks', { requestId })).status).toBe(400)
      expect(providerCalls).toHaveLength(0)
      reference.projectId = projectId
      const retryId = `${requestId}-1`
      expect((await call('tasks', { requestId: retryId })).status).toBe(409)
      const unavailableProvider = await call('tasks', { requestId, expectedProvider: 'malanshan' })
      expect(unavailableProvider.status).toBe(409)
      expect(await unavailableProvider.json()).toMatchObject({ errorCode: 'video/provider-changed', submissionState: 'not-submitted' })
      expect(providerCalls).toHaveLength(0)
      expect(await (await call('tasks', { requestId })).json()).toMatchObject({ data: {
        status: 'failed', errorCode: 'RequestRejected',
      } })
      const submitted = await call('tasks', { requestId: retryId })
      expect(submitted.status, await submitted.clone().text()).toBe(200)
      const accepted = await submitted.json()
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ data: { requestId: retryId, duration: 6.25, status: 'queued', billingParameters: { inputVideoMode: 'present' } } })
      expect((await call('tasks', { requestId: retryId })).status).toBe(200)
      expect((await call('tasks', { requestId: `${requestId}-2` })).status).toBe(409)
      expect(providerCalls).toHaveLength(2)
      expect(providerCalls[1]).toMatchObject({
        ratio: 'adaptive', duration: -1, omni_reference_task_type: 'edit', output_format: 'mp4', generate_audio: true,
        content: [
          { type: 'text', text: expect.stringContaining('把 @视频1 中贯穿镜头的主要主体替换为 @图片1') },
          { type: 'image_url', role: 'reference_image', image_url: { url: `${origin}/api/file/previewImage/${tenantId}/${subjectFileId}` } },
          { type: 'video_url', role: 'reference_video', video_url: { url: `${origin}/api/file/dowloadFile/${tenantId}/${sourceFileId}` } },
        ],
      })
      const originalPrompt = (providerCalls[1]?.content as { text?: string }[])[0]?.text
      expect(originalPrompt).toContain('保留未指定修改的对白、发言时机、语气、环境声和音效')
      expect(originalPrompt).toContain('保留 @视频1 的原背景音乐')
      const refreshed = await call('refresh', { requestId: retryId })
      expect(await refreshed.json()).toMatchObject({ data: { status: 'succeeded', videoFileId: outputFileId, duration: 6.22, consumption: { credits: '0.80' } } })
      expect(clipCalls).toEqual([])
      expect(outputs).toEqual([expect.objectContaining({ projectId, spaceId, purpose: '成片' })])
      expect(await (await call('list')).json()).toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ requestId: retryId, videoFileId: outputFileId })]),
      })
      expect(writes).toBe(1)
      expect(usage.filter(row => row.customerCharge === '0.80')).toHaveLength(1)

      const imageRequestId = 'remake-subject-fixture'
      const imageParams = { requestId: imageRequestId, model: imageModel, prompt: '蓝色保温杯', size: '2048x2048', referenceIds: [] }
      expect((await call('images/tasks', { ...imageParams, projectId: legacyProjectId })).status).toBe(403)
      expect(await (await call('images/quote', imageParams)).json()).toMatchObject({ data: { estimatedCredits: '0.30' } })
      expect(imageCalls).toHaveLength(0)
      const imageSubmitted = await call('images/tasks', imageParams)
      expect(imageSubmitted.status, await imageSubmitted.clone().text()).toBe(200)
      await expect.poll(async () => (await (await call('images/refresh', { requestId: imageRequestId })).json()).data.status).toBe('succeeded')
      expect(imageCalls).toEqual([expect.objectContaining({ model: imageModel, prompt: expect.stringContaining(imageParams.prompt) })])
      expect(await (await call('images/list')).json()).toMatchObject({
        data: [{ requestId: imageRequestId, result: { needsConfirmation: true }, consumption: { credits: '0.30' } }],
      })
      const generatedRef = outputs.find(output => output.purpose === '分镜图')!
      const generatedMaterial = rows.get(String(generatedRef.materialId))!
      const subjects = [
        { relationId: String(generatedRef._id), target: '画面左侧的白杯', shotNumbers: [1] },
        { relationId: subjectRefId, target: '右边棕色礼盒', shotNumbers: [2, 3] },
      ]
      const settings = { version: 1, duration: 6.25, sourceRefId, subjects, shots: [
        { start: 0, end: 2.25 }, { start: 2.25, end: 4.75 }, { start: 4.75, end: 6.25 },
      ] }
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: settings })
      const digest = createHash('sha256').update(JSON.stringify([sourceRefId, subjects.map(subject => [subject.relationId, subject.target, subject.shotNumbers])])).digest('hex')
      const mappedId = `remake-${digest}`
      const unconfirmed = await call('tasks', { requestId: mappedId })
      expect(unconfirmed.status).toBe(400)
      expect(await unconfirmed.json()).toMatchObject({ message: expect.stringContaining('尚待人工确认') })
      expect(providerCalls).toHaveLength(2)
      const metadata = JSON.parse(String(generatedMaterial.sourceDescription))
      metadata.generatedImage.confirmedAt = new Date().toISOString()
      generatedMaterial.sourceDescription = JSON.stringify(metadata)
      const mapped = await call('tasks', { requestId: mappedId })
      expect(mapped.status, await mapped.clone().text()).toBe(200)
      expect(await mapped.json()).toMatchObject({ data: { requestId: mappedId, status: 'queued' } })
      expect(providerCalls).toHaveLength(3)
      const mappedPrompt = (providerCalls.at(-1)?.content as { text?: string }[])[0]?.text
      expect(mappedPrompt).toContain('只替换指定范围内原本出现的对象')
      expect(mappedPrompt).toContain('同一道具换手后沿用同一参考外观')
      expect(mappedPrompt).toContain('保留未指定修改的人物、道具、场景、字幕和画面文字')
      expect(providerCalls.at(-1)).toMatchObject({ content: [
        { type: 'text', text: expect.stringMatching(/@图片1.*0\.00–2\.25 秒.*画面左侧的白杯[\s\S]*@图片2.*2\.25–6\.25 秒.*右边棕色礼盒/u) },
        { type: 'image_url', role: 'reference_image', image_url: { url: generatedUrl } },
        { type: 'image_url', role: 'reference_image', image_url: { url: `${origin}/api/file/previewImage/${tenantId}/${subjectFileId}` } },
        { type: 'video_url', role: 'reference_video' },
      ] })
      subjects[0]!.target = '镜头中另一只杯子'
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: settings })
      expect((await call('tasks', { requestId: mappedId })).status).toBe(409)
      expect(providerCalls).toHaveLength(3)
      subjects[1]!.shotNumbers = [3]
      const selectedDialogue = { start: 1.1, end: 2, shotNumber: 1, original: 'Good morning.', replacement: '早上好。' }
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: {
        ...settings, redoSelected: true, dialogue: [selectedDialogue], bgm: { mode: 'generate' },
      } })
      const clipId = `remake-${createHash('sha256').update(JSON.stringify([
        sourceRefId, subjects.map(subject => [subject.relationId, subject.target, subject.shotNumbers]), 'selected-shots',
        ['dialogue', [[1.1, 2, '', '早上好。', 1]]], ['bgm', 'generate'],
      ])).digest('hex')}`
      const submittedClip = await call('tasks', { requestId: clipId })
      expect(submittedClip.status, await submittedClip.clone().text()).toBe(200)
      expect(await submittedClip.json()).toMatchObject({ data: { status: 'queued' } })
      expect(providerCalls.at(-1)).toMatchObject({ duration: -1, generate_audio: true, content: [
        { type: 'text', text: expect.stringMatching(/逐镜保留未选镜头的原画面和剪辑[\s\S]*镜头 1 · 1\.100–2\.000 秒："早上好。"[\s\S]*只替换 @视频1 的背景音乐[\s\S]*@图片1.*0\.00–2\.25 秒[\s\S]*@图片2.*4\.75–6\.25 秒/u) },
        { type: 'image_url' }, { type: 'image_url' },
        { type: 'video_url', video_url: { url: `${origin}/api/file/dowloadFile/${tenantId}/${sourceFileId}` } },
      ] })
      expect((await call('tasks', { requestId: clipId })).status).toBe(200)
      expect(providerCalls).toHaveLength(4)
      expect(await (await call('refresh', { requestId: clipId })).json()).toMatchObject({
        data: { status: 'succeeded', videoFileId: selectedFileId },
      })

      const assetId = 'asset-20261123070000-demo'
      const assetUrl = `asset://${assetId}`
      const portraitSubjects = subjects.map((subject, index) => index === 0 ? { ...subject, portrait: true } : subject)
      const portraitSubjectIdentity = portraitSubjects.map(subject => [
        subject.relationId, subject.target, subject.shotNumbers, ...('portrait' in subject ? [true] : []),
      ])
      const assetRequestId = `remake-${createHash('sha256').update(JSON.stringify([
        sourceRefId, portraitSubjectIdentity, assetUrl,
      ])).digest('hex')}`
      for (const incompatible of [{ sourceVideoAssetId: 'https://example.com/video.mp4' }, { sourceVideoAssetId: assetId, redoSelected: true }]) {
        rows.get(projectId)!.specification = JSON.stringify({ videoRemake: { ...settings, ...incompatible } })
        const rejected = await call('tasks', { requestId: assetRequestId })
        expect(rejected.status).toBe(400)
        expect(await rejected.json()).toMatchObject({ errorCode: 'video/remake-asset-invalid', submissionState: 'not-submitted' })
      }
      expect(providerCalls).toHaveLength(4)
      rows.get(projectId)!.specification = JSON.stringify({
        videoRemake: { ...settings, subjects: portraitSubjects, sourceVideoAssetId: assetId },
      })
      reference.projectId = legacyProjectId
      expect((await call('tasks', { requestId: assetRequestId })).status).toBe(400)
      expect(providerCalls).toHaveLength(4)
      reference.projectId = projectId
      const submittedAsset = await call('tasks', { requestId: assetRequestId })
      expect(submittedAsset.status, await submittedAsset.clone().text()).toBe(200)
      expect(await submittedAsset.json()).toMatchObject({ data: { requestId: assetRequestId, status: 'queued' } })
      expect(providerCalls).toHaveLength(5)
      expect(providerCalls.at(-1)).toMatchObject({ content: [
        { type: 'text' },
        { type: 'image_url', role: 'reference_image', image_url: { url: generatedUrl } },
        { type: 'image_url', role: 'reference_image', image_url: { url: `${origin}/api/file/previewImage/${tenantId}/${subjectFileId}` } },
        { type: 'video_url', role: 'reference_video', video_url: { url: assetUrl } },
      ] })

      const currentSubjects = subjects.map(subject => [subject.relationId, subject.target, subject.shotNumbers])
      const editId = `remake-${createHash('sha256').update(JSON.stringify([sourceRefId, currentSubjects])).digest('hex')}`
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: settings })
      denyPortrait = true
      const rejectedVideo = await (await call('tasks', { requestId: editId })).json()
      expect(rejectedVideo).toMatchObject({ data: {
        status: 'failed', errorCode: 'InputVideoSensitiveContentDetected.PrivacyInformation', rejectedSourceRefId: sourceRefId,
        error: 'InputVideoSensitiveContentDetected.PrivacyInformation：原片：Input video content[3] may contain a real person.',
      } })
      denyPortrait = false
      const blockedRetry = await call('tasks', { requestId: `${editId}-1` })
      expect(blockedRetry.status).toBe(409)
      expect(await blockedRetry.json()).toMatchObject({ errorCode: 'video/remake-portrait-mode', submissionState: 'not-submitted' })
      expect(providerCalls).toHaveLength(6)

      const storyboardGeneration = { ratio: '9:16', prompt: '窗边摆一只杯子，切到礼盒的特写，保持自然光。', model: 'doubao-seedance-2-0-fast-260128', seconds: 5 }
      const storyboardId = `remake-${createHash('sha256').update(JSON.stringify([
        sourceRefId, portraitSubjectIdentity,
        ['storyboard', storyboardGeneration.ratio, storyboardGeneration.prompt, storyboardGeneration.model, storyboardGeneration.seconds],
      ])).digest('hex')}`
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: { ...settings, subjects: portraitSubjects } })
      const rawPortraitId = `remake-${createHash('sha256').update(JSON.stringify([sourceRefId, portraitSubjectIdentity])).digest('hex')}`
      const blockedPortrait = await call('tasks', { requestId: rawPortraitId })
      expect(blockedPortrait.status).toBe(409)
      expect(await blockedPortrait.json()).toMatchObject({ errorCode: 'video/remake-portrait-mode', submissionState: 'not-submitted' })
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: { ...settings, storyboardGeneration, redoSelected: true } })
      const rejectedStoryboard = await call('tasks', { requestId: storyboardId })
      expect(rejectedStoryboard.status).toBe(400)
      expect(await rejectedStoryboard.json()).toMatchObject({ errorCode: 'video/remake-storyboard-invalid', submissionState: 'not-submitted' })
      expect(providerCalls).toHaveLength(6)

      const readsBeforeStoryboard = sourceReads
      rows.get(projectId)!.specification = JSON.stringify({
        videoRemake: { ...settings, subjects: portraitSubjects, storyboardGeneration },
      })
      const storyboard = await call('tasks', { requestId: storyboardId })
      expect(storyboard.status, await storyboard.clone().text()).toBe(200)
      expect(await storyboard.json()).toMatchObject({ data: {
        status: 'queued', model: storyboardGeneration.model, duration: 5, billingParameters: { inputVideoMode: 'none' },
      } })
      expect(providerCalls).toHaveLength(7)
      expect(providerCalls.at(-1)).toMatchObject({ model: storyboardGeneration.model, ratio: '9:16', duration: 5, content: [
        { type: 'text', text: expect.stringMatching(/镜头时段（秒）：0\.00–1\.80、1\.80–3\.80、3\.80–5\.00/u) },
        { type: 'image_url', role: 'reference_image', image_url: { url: generatedUrl } },
        { type: 'image_url', role: 'reference_image' },
      ] })
      expect(await (await call('refresh', { requestId: storyboardId })).json()).toMatchObject({ data: {
        status: 'succeeded', videoFileId: storyboardFileId, consumption: { credits: '1.20' },
      } })
      expect(sourceReads).toBe(readsBeforeStoryboard)
      expect(clipCalls).toEqual([])

      const editModel = storyboardGeneration.model
      const resolution = '480p'
      const fittedId = `remake-${createHash('sha256').update(JSON.stringify([
        sourceRefId, currentSubjects, assetUrl, ['output', editModel, resolution],
      ])).digest('hex')}`
      const editedSettings = { ...settings, editModel, resolution, sourceVideoAssetId: assetId }
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: { ...editedSettings, resolution: '1080p' } })
      expect(await (await call('tasks', { requestId: fittedId })).json()).toMatchObject({ errorCode: 'video/remake-output-invalid' })
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: {
        ...editedSettings, duration: 16, shots: [...settings.shots.slice(0, -1), { start: 4.75, end: 16 }],
      } })
      expect(await (await call('tasks', { requestId: fittedId })).json()).toMatchObject({ errorCode: 'video/remake-model-duration' })
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: editedSettings })
      const stale = await call('tasks', { requestId: editId })
      expect(stale.status).toBe(409)
      expect(providerCalls).toHaveLength(7)

      const fitted = await call('tasks', { requestId: fittedId })
      expect(fitted.status, await fitted.clone().text()).toBe(200)
      expect(await fitted.json()).toMatchObject({ data: {
        status: 'queued', model: editModel, duration: 6, billingParameters: { resolution, inputVideoMode: 'present' },
      } })
      expect(providerCalls.at(-1)).toMatchObject({ model: editModel, resolution, duration: 6, ratio: 'adaptive', content: [
        { type: 'text', text: expect.stringMatching(/@图片1.*镜头 1（0\.00–2\.25 秒）[\s\S]*@图片2.*镜头 3（4\.75–6\.25 秒）/u) },
        { type: 'image_url' }, { type: 'image_url' }, { type: 'video_url' },
      ] })
      expect(providerCalls.at(-1)).not.toHaveProperty('omni_reference_task_type')
      expect(await (await call('refresh', { requestId: fittedId })).json()).toMatchObject({ data: {
        status: 'succeeded', videoFileId: fittedFileId,
      } })

      const imageReceiptName = createHash('sha256').update(JSON.stringify([tenantId, spaceId, projectId, null, imageRequestId])).digest('hex')
      const imageReceiptPath = join(root, 'media', 'images', `${imageReceiptName}.json`)
      const imageReceipt = JSON.parse(await readFile(imageReceiptPath, 'utf8'))
      const day = 24 * 60 * 60 * 1000
      imageReceipt.result.source.generatedAt = new Date(Date.now() - 2 * day).toISOString()
      imageReceipt.result.source.originalUrlExpiresAt = new Date(Date.now() - day).toISOString()
      await writeFile(imageReceiptPath, JSON.stringify(imageReceipt))
      const storyboardWithOutput = `remake-${createHash('sha256').update(JSON.stringify([
        sourceRefId, portraitSubjectIdentity,
        ['storyboard', storyboardGeneration.ratio, storyboardGeneration.prompt, storyboardGeneration.model, storyboardGeneration.seconds],
        ['output', storyboardGeneration.model, resolution],
      ])).digest('hex')}`
      rows.get(projectId)!.specification = JSON.stringify({
        videoRemake: { ...settings, subjects: portraitSubjects, storyboardGeneration, resolution },
      })
      expect(await (await call('tasks', { requestId: storyboardWithOutput })).json()).toMatchObject({ data: {
        status: 'queued', model: storyboardGeneration.model, billingParameters: { resolution, inputVideoMode: 'none' },
      } })
      expect(providerCalls.at(-1)).toMatchObject({ model: storyboardGeneration.model, resolution, duration: 5, content: [
        { type: 'text' },
        { type: 'image_url', role: 'reference_image', image_url: { url: `${origin}/api/file/previewImage/${tenantId}/${generatedFileId}` } },
        { type: 'image_url', role: 'reference_image', image_url: { url: `${origin}/api/file/previewImage/${tenantId}/${subjectFileId}` } },
      ] })
      expect(imageCalls).toHaveLength(1)

      expect(await (await call('remake-transcript')).json()).toMatchObject({ data: { lines: [originalLine] } })
      const dialogue = [
        { ...originalLine, speaker: '主体1', replacement: '早上好。' },
        { shotNumber: 2, start: 3, end: 4, original: 'Welcome.', speaker: '场外旁白', replacement: '欢迎。' },
      ]
      const bgm = { mode: 'upload', relationId: musicRefId, start: 4, end: 7 }
      const dubbedId = `remake-${createHash('sha256').update(JSON.stringify([
        sourceRefId, portraitSubjectIdentity, `asset://${assetId}`, ['dialogue', [[1.1, 2, '主体1', '早上好。', 1], [3, 4, '场外旁白', '欢迎。', 2]]],
        ['bgm', 'upload', musicRefId, 4, 7],
      ])).digest('hex')}`
      const audioSettings = { ...settings, subjects: portraitSubjects, sourceVideoAssetId: assetId, dialogue, bgm }
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: { ...audioSettings, dialogue: [{ ...dialogue[0], end: 3 }] } })
      expect(await (await call('tasks', { requestId: dubbedId })).json()).toMatchObject({ errorCode: 'video/remake-details-invalid', submissionState: 'not-submitted' })
      rows.get(projectId)!.specification = JSON.stringify({ videoRemake: audioSettings })
      rows.get(musicRefId)!.projectId = legacyProjectId
      const priorCalls = providerCalls.length
      expect(await (await call('tasks', { requestId: dubbedId })).json()).toMatchObject({ submissionState: 'not-submitted' })
      expect(providerCalls).toHaveLength(priorCalls)
      rows.get(musicRefId)!.projectId = projectId
      rows.get(musicMaterialId)!.mime = 'audio/mp4'
      expect(await (await call('tasks', { requestId: dubbedId })).json()).toMatchObject({ errorCode: 'video/reference-audio-invalid', submissionState: 'not-submitted' })
      rows.get(musicMaterialId)!.mime = 'audio/wav'
      publicMusic = wavFixture(1)
      expect(await (await call('tasks', { requestId: dubbedId })).json()).toMatchObject({ errorCode: 'video/reference-audio-duration', submissionState: 'not-submitted' })
      publicMusic = wavFixture(6)
      expect(await (await call('tasks', { requestId: dubbedId })).json()).toMatchObject({ errorCode: 'video/remake-bgm-invalid', submissionState: 'not-submitted' })
      expect(providerCalls).toHaveLength(priorCalls)
      publicMusic = music
      expect(await (await call('tasks', { requestId: dubbedId })).json()).toMatchObject({ data: {
        status: 'queued', billingParameters: { audioMode: 'enabled' },
      } })
      expect(providerCalls.at(-1)).toMatchObject({ generate_audio: true, omni_reference_task_type: 'edit', content: [
        { type: 'text', text: expect.stringMatching(/镜头 1 · 1\.100–2\.000 秒，发言人 @图片1 对应的角色："早上好。"\n镜头 2 · 3\.000–4\.000 秒，发言人 场外旁白："欢迎。"[\s\S]*只将原对白字幕替换为对应新台词[\s\S]*@音频1：背景音乐[\s\S]*4\.00–7\.00 秒/u) },
        { type: 'image_url' }, { type: 'image_url' }, { type: 'video_url', role: 'reference_video' },
        { type: 'audio_url', role: 'reference_audio', audio_url: { url: `${origin}/api/file/dowloadFile/${tenantId}/${musicFileId}` } },
      ] })
      await expect(`${(providerCalls.at(-1)?.content as { text: string }[])[0]!.text}\n`)
        .toMatchFileSnapshot('./expected/creation-studio-remake/combined-prompt.expected.txt')
      const providerCallsBeforeAssembly = providerCalls.length
      outputUnavailable = true
      expect(await (await call('refresh', { requestId: dubbedId })).json()).toMatchObject({ data: { status: 'upload_failed' } })
      outputUnavailable = false
      expect(await (await call('refresh', { requestId: dubbedId })).json()).toMatchObject({ data: { status: 'succeeded', videoFileId: dubbedFileId } })
      expect(clipCalls).toEqual(['/transcript'])
      expect(uploadedVideos).toEqual(Array(5).fill(providerVideo))

      const receiptPath = (id: string) => join(root, 'media', 'seedance', `${createHash('sha256')
        .update(`${tenantId}:${spaceId}:${projectId}:undefined:${id}`).digest('hex')}.json`)
      const completed = jsonBody(await readFile(receiptPath(dubbedId), 'utf8'))
      expect(completed).not.toHaveProperty('remakeClip')
      expect(completed).not.toHaveProperty('remakeMusic')
      expect(completed).not.toHaveProperty('remakeCaptions')

      const legacyId = 'remake-previously-paid'
      await writeFile(receiptPath(legacyId), JSON.stringify({ ...completed, requestId: legacyId, id: 'cgt-legacy-remake', duration: 6.25,
        remakeClip: { sourceFileId, sourceDigest: createHash('sha256').update(clip).digest('hex'), ranges: null, output: { audio: 'generated' } },
        remakeMusic: { fileId: musicFileId, settings: musicSettings, digest: createHash('sha256').update(Buffer.from(music)).digest('hex') },
        remakeCaptions: captions,
      }))
      assembleLegacy = true
      expect(await (await call('refresh', { requestId: legacyId })).json()).toMatchObject({ data: { status: 'upload_failed' } })
      captionRenderFailed = false
      expect(await (await call('refresh', { requestId: legacyId })).json()).toMatchObject({ data: { status: 'succeeded', videoFileId: legacyFileId, duration: 6.25 } })
      expect(providerCalls).toHaveLength(providerCallsBeforeAssembly)
      expect(clipCalls.slice(1)).toEqual(['/merge-edit', '/mix-bgm', '/sync-captions', '/merge-edit', '/mix-bgm', '/sync-captions'])
      expect(uploadedVideos.at(-1)).toBe('0000ftypsubs')
    }
    finally {
      await scaffold.close()
    }
  }
  finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
