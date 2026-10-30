import { AsyncLocalStorage } from 'node:async_hooks'
/** 图片和视频生成在 Harness 的已认证 Host 中执行，模型与浏览器只接收平台引用。 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createImageService } from './images.mjs'
import { createSeedanceService } from './seedance.mjs'
import { generatedImagePending, imageGenerationSource } from './image-generation.mjs'

const MATERIAL = '6ad81c871f280486bb45ac43'
const RELATION = '6ad81c871f280486bb45ac45'
const recordId = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)

/** 已成功的文件、素材与引用 ID 逐步落盘，失败后继续原步骤，不重新付费生成。 */
export function createHarnessMediaRuntime(config, auth, keys, inspectImage, fetcher = fetch) {
  const active = new Map()
  const owners = new AsyncLocalStorage()
  let closing = false
  const platform = config.platformURL.replace(/\/$/u, '')
  async function transport(url, init = {}) {
    if (await auth.currentScopeKey() !== owners.getStore())
      throw new Error('媒体执行期间账号已变化，已停止后续请求和写入；已生成结果可用原编号恢复。')
    if (!url.startsWith(`${platform}/api/`))
      return fetcher(url, init)
    const path = url.slice(platform.length)
    const signal = init.signal ?? AbortSignal.timeout(180_000)
    const file = /^\/api\/file\/dowloadFile\/([^/]+)\/([a-f0-9]{24})$/iu.exec(path)
    if (file) {
      if (file[1] !== config.tenantId)
        throw new Error('文件不属于当前租户。')
      return auth.downloadFileAuthenticated(file[2], signal)
    }
    const upload = init.body instanceof FormData ? init.body.get('file') : null
    const data = await auth.requestAuthenticated({
      path,
      method: init.method || 'GET',
      ...(upload
        ? { multipartFile: { name: upload.name, mediaType: upload.type, data: new Uint8Array(await upload.arrayBuffer()) } }
        : init.body === undefined ? {} : { body: JSON.parse(init.body) }),
    }, signal)
    return Response.json({ code: 200, data })
  }
  async function platformCall(path, data) {
    return (await (await transport(`${platform}${path}`, { method: 'POST', body: JSON.stringify(data) })).json()).data
  }
  const detail = (menuId, _id) => platformCall('/api/visualdev/form/info', { menuId, _id })
  async function create(menuId, data) {
    const id = await platformCall('/api/visualdev/form/create', { menuId, data: JSON.stringify(data) })
    if (!recordId(id))
      throw new Error('平台创建接口未返回有效记录 ID。')
    return id
  }
  async function authorizeWrites(input) {
    // 空间角色由生成服务核对，表写权限由 Host 菜单快照和平台接口共同检查。
    const status = await auth.status()
    if (!status.authenticated || status.corpId !== config.tenantId || status.baseUrl.replace(/\/$/u, '') !== platform)
      throw new Error('当前登录服务或租户与媒体插件配置不一致。')
    const menus = await auth.writableMenus(AbortSignal.timeout(30_000))
    for (const menuId of [MATERIAL, RELATION]) {
      if (!menus.menus.some(menu => menu.menuId === menuId && menu.agentPermissions.includes('addData')))
        throw new Error('当前账号没有创建项目素材或引用的权限。')
    }
    if (![input.projectId, input.planId, input.spaceId].every(recordId))
      throw new Error('项目、方案或空间 ID 无效。')
  }
  async function persist(path, data) {
    await writeFile(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }
  const uploadPath = (input, kind) => join(config.stateDirectory, 'uploads', `${createHash('sha256').update(JSON.stringify([config.tenantId, input.spaceId, input.projectId, input.planId, input.requestId, kind])).digest('hex')}.json`)
  async function saveResult(input, kind, source, getBytes) {
    const directory = join(config.stateDirectory, 'uploads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = uploadPath(input, kind)
    let progress = {}
    try {
      progress = JSON.parse(await readFile(path, 'utf8'))
    }
    catch (error) {
      if (error.code !== 'ENOENT')
        throw error
    }
    if (progress.result) {
      const relation = await detail(RELATION, progress.relationId)
      const material = await detail(MATERIAL, progress.materialId)
      if (relation?.projectId !== input.projectId || relation.spaceId !== input.spaceId
        || relation.materialId !== progress.materialId || material?.spaceId !== input.spaceId) {
        throw new Error('已保存的生成素材引用已失效，请核对后处理。')
      }
      return kind === 'image'
        ? { ...progress.result, generation: imageGenerationSource(material.sourceDescription), needsConfirmation: generatedImagePending(material.sourceKind, material.sourceDescription) }
        : progress.result
    }
    if (!progress.fileId) {
      const { bytes, mime, dimensions } = await getBytes()
      const name = `${kind === 'image' ? 'AI' : 'Seedance'}-${input.requestId}.${kind === 'image' ? mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png' : 'mp4'}`
      const body = new FormData()
      body.set('file', new Blob([bytes], { type: mime }), name)
      const uploaded = await (await transport(`${platform}/api/file/uploader`, { method: 'POST', body })).json()
      const url = new URL(uploaded.data?.url, platform)
      const match = /^\/api\/file\/(?:previewImage|dowloadFile)\/([a-f0-9]{24})\/([a-f0-9]{24})$/iu.exec(url.pathname)
      if (url.origin !== new URL(platform).origin || !match || match[1] !== config.tenantId)
        throw new Error('上传结果不是当前平台的有效文件引用。')
      Object.assign(progress, { fileId: match[2], name, mime, bytes: bytes.length, ...dimensions })
      await persist(path, progress)
    }
    const data = { name: progress.name, spaceId: input.spaceId, library: 'project', category: kind === 'image' ? '镜头图片' : '镜头视频', sourceKind: 'generated', authorization: '自有', fileId: progress.fileId, originalName: progress.name, mime: progress.mime, sizeBytes: progress.bytes, width: progress.width, height: progress.height, durationSeconds: kind === 'image' ? 0 : source.duration, revision: 1, sourceDescription: JSON.stringify(kind === 'image' ? { generatedImage: source } : { generatedVideo: source }) }
    if (!progress.materialId) {
      progress.materialId = await create(MATERIAL, data)
      await persist(path, progress)
    }
    if (!progress.relationId) {
      progress.relationId = await create(RELATION, { spaceId: input.spaceId, projectId: input.projectId, materialId: progress.materialId, purpose: kind === 'image' ? '分镜图' : '镜头视频', sourceRevision: 1, usageSnapshot: JSON.stringify(data) })
      await persist(path, progress)
    }
    progress.result = { relationId: progress.relationId, materialId: progress.materialId, fileId: progress.fileId, sourceRevision: 1, name: progress.name, mime: progress.mime, width: progress.width || 0, height: progress.height || 0, authorization: '自有', ...(kind === 'image' ? { origin: 'generated', generation: source, needsConfirmation: true } : {}) }
    await persist(path, progress)
    return progress.result
  }
  /** 对外只投影任务状态和平台引用，供应商内容、密钥和 Base64 留在 Host。 */
  async function imageTaskView(task, input, upload) {
    const source = task.source ?? task.result?.source
    const view = { requestId: task.requestId ?? input.requestId,
      status: task.status === 'submitting' ? 'unknown' : task.status,
      ...(task.taskId === undefined ? {} : { taskId: task.taskId }),
      ...(task.fingerprint === undefined ? {} : { fingerprint: task.fingerprint }),
      ...(source?.createdAt === undefined ? {} : { createdAt: source.createdAt }),
      ...(task.error === undefined ? {} : { error: task.error }) }
    if (task.errorCode !== undefined)
      view.errorCode = task.errorCode
    if (task.retryCount !== undefined)
      view.retryCount = task.retryCount
    if (task.status === 'submitting')
      view.error = '图片提交回执尚未确认，请稍后用原请求查询；不会重新付费提交。'
    if (task.status !== 'succeeded') return view
    view.status = 'upload_pending'
    let progress
    try { progress = JSON.parse(await readFile(uploadPath(input, 'image'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!upload && !progress?.result) return view
    try {
      if (upload) await authorizeWrites(input)
      const result = await saveResult(input, 'image', task.result.source, async () => {
        const bytes = Buffer.from(task.result.b64, 'base64')
        return { bytes, mime: task.result.mime, dimensions: await inspectImage(bytes, task.result.mime) }
      })
      return { ...view, status: 'succeeded', result }
    }
    catch (error) {
      return { ...view, status: 'upload_failed', error: `图片已生成但上传未完成：${error.message} 请用原请求继续上传，不要重新生成。` }
    }
  }
  async function execute(operation, input) {
    const env = { CREATION_STUDIO_PLATFORM_URL: platform, CREATION_STUDIO_TENANT_ID: config.tenantId, CREATION_STUDIO_IMAGE_STATE_DIR: join(config.stateDirectory, 'images'), CREATION_STUDIO_IMAGE_RETRY_LIMIT: config.imageRetryLimit, CREATION_STUDIO_VIDEO_STATE_DIR: join(config.stateDirectory, 'seedance'), GPT_IMAGE_MODEL: config.imageModel, GPT_IMAGE_API_KEY: await keys(config.imageKeyRef), ARK_API_KEY: await keys(config.arkKeyRef) }
    if (operation === 'config') {
      return { image: { configured: Boolean(env.GPT_IMAGE_API_KEY), model: config.imageModel }, video: { configured: Boolean(env.ARK_API_KEY), model: 'doubao-seedance-2-5-260628' } }
    }
    const images = createImageService(env, transport)
    const videos = createSeedanceService(env, transport)
    if (operation === 'images/tasks') {
      await authorizeWrites(input)
      return imageTaskView(await images.submit('host-authenticated', input), input, true)
    }
    if (operation === 'images/refresh') {
      /** 批量入口先核对全部任务归属，再复用单任务锁；各图下载和上传独立完成。 */
      if (input.taskIds !== undefined) {
        if (!Array.isArray(input.taskIds) || !input.taskIds.length
          || input.taskIds.some(taskId => typeof taskId !== 'string' || !taskId.trim())
          || new Set(input.taskIds).size !== input.taskIds.length) {
          throw new Error('请传入非空且不重复的 taskIds 数组。')
        }
        await authorizeWrites(input)
        const saved = await images.list('host-authenticated', input)
        const tasks = input.taskIds.map(taskId => saved.find(task => task.taskId === taskId || task.previousTaskIds?.includes(taskId)))
        if (tasks.some(task => !task) || new Set(tasks.map(task => task?.requestId)).size !== tasks.length)
          throw new Error('图片任务不属于当前项目、方案或空间，或重复引用了同一任务。')
        return Promise.all(tasks.map(async task => {
          const request = { projectId: input.projectId, planId: input.planId, spaceId: input.spaceId, requestId: task.requestId }
          try { return await runtime.run(operation, request) }
          catch (error) {
            return { requestId: task.requestId, taskId: task.taskId, status: 'refresh_failed',
              errorCode: error.code || 'image/refresh-failed', error: error.message }
          }
        }))
      }
      // 查询可能触发供应商明确失败后的受控重提，仍需当前素材及引用写权限。
      await authorizeWrites(input)
      return imageTaskView(await images.refresh('host-authenticated', input), input, true)
    }
    if (operation === 'images/list') {
      const tasks = await images.list('host-authenticated', input)
      return Promise.all(tasks.map(task => imageTaskView(task, { ...input, requestId: task.requestId }, false)))
    }
    if (operation === 'images/generate') {
      await authorizeWrites(input)
      const result = await images.generate('host-authenticated', input)
      return saveResult(input, 'image', result.source, async () => {
        const bytes = Buffer.from(result.b64, 'base64')
        return { bytes, mime: result.mime, dimensions: await inspectImage(bytes, result.mime) }
      })
    }
    if (operation === 'video/tasks') {
      await authorizeWrites(input)
      return videos.submit('host-authenticated', input)
    }
    if (operation === 'video/list') {
      const tasks = await videos.list('host-authenticated', input)
      return Promise.all(tasks.map(async (task) => {
        if (task.status !== 'succeeded')
          return task
        let result
        try {
          result = JSON.parse(await readFile(uploadPath({ ...input, requestId: task.requestId }, 'video'), 'utf8')).result
        }
        catch (error) {
          if (error.code !== 'ENOENT')
            throw error
        }
        return result
          ? { ...task, videoUrl: `${platform}/api/file/dowloadFile/${config.tenantId}/${result.fileId}`, videoRefId: result.relationId, videoFileId: result.fileId }
          : { ...task, videoUrl: '', status: 'upload_pending', error: '视频生成完成，请刷新任务继续上传到项目素材。' }
      }))
    }
    if (operation === 'video/refresh') {
      const result = await videos.refresh('host-authenticated', input)
      if (result.status !== 'succeeded')
        return result
      try {
        await authorizeWrites(input)
        const saved = await saveResult(input, 'video', { requestId: result.requestId, taskId: result.id, duration: result.duration, model: result.model, createdAt: result.createdAt, confirmedAt: '' }, async () => {
          const url = new URL(result.videoUrl)
          if (url.protocol !== 'https:' || !['.volces.com', '.volccdn.com', '.volcengine.com'].some(domain => url.hostname.endsWith(domain)))
            throw new Error('方舟结果地址不在受信任的视频存储域名中。')
          const response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(180_000) })
          if (!response.ok || Number(response.headers.get('content-length')) > 250 * 1024 * 1024)
            throw new Error('生成视频下载失败或超过250MB。')
          const chunks = []
          let total = 0
          for await (const chunk of response.body) {
            total += chunk.length
            if (total > 250 * 1024 * 1024)
              throw new Error('生成视频超过250MB。')
            chunks.push(chunk)
          }
          const bytes = Buffer.concat(chunks)
          if (bytes.toString('ascii', 4, 8) !== 'ftyp' || response.headers.get('content-type')?.includes('text/html'))
            throw new Error('生成视频内容不是有效的 MP4。')
          return { bytes, mime: 'video/mp4', dimensions: {} }
        })
        return { ...result, videoUrl: `${platform}/api/file/dowloadFile/${config.tenantId}/${saved.fileId}`, videoRefId: saved.relationId, videoFileId: saved.fileId }
      }
      catch (error) { return { ...result, videoUrl: '', status: 'upload_failed', error: `视频已生成但上传未完成：${error.message} 请刷新任务继续上传，不要重新生成。` } }
    }
    throw new Error('媒体操作不存在。')
  }
  const runtime = {
    /** 同一项目请求在进程内串行复用，落盘记录负责重启后的付费请求和上传恢复。 */
    async run(operation, input = {}) {
      if (closing)
        throw new Error('Harness 媒体插件正在停止，请稍后重试。')
      const scope = await auth.currentScopeKey()
      if (closing)
        throw new Error('Harness 媒体插件正在停止，请稍后重试。')
      if (!scope)
        throw new Error('请先登录 Harness。')
      const key = JSON.stringify([scope, operation, input.projectId, input.planId, input.spaceId, input.requestId, input.taskIds, ...(['images/generate', 'images/tasks'].includes(operation) ? [input.prompt, input.size, input.referenceIds] : []), ...(operation === 'video/tasks' ? [input.batchId] : [])])
      if (!active.has(key))
        active.set(key, owners.run(scope, () => execute(operation, input)).finally(() => active.delete(key)))
      return active.get(key)
    },
    /** 卸载先拒绝新操作，再等待在途生成和上传落盘，不把未完成回执丢成成功。 */
    async close() {
      closing = true
      await Promise.allSettled([...active.values()])
    },
  }
  return runtime
}
