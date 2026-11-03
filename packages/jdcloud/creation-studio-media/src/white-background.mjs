/** 即梦白底商品图：原素材保留，单图任务与上传进度落盘，恢复不重新付费提交。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import signerModule from '@volcengine/openapi/lib/base/sign.js'
import sharp from 'sharp'

// 官方签名模块是 CommonJS，Node ESM 与打包器的 default 解包层数不同。
const Signer = typeof signerModule === 'function' ? signerModule : signerModule.default
/** 视觉 API 要求 content-type 参与签名，通用 OpenAPI 签名器默认排除该头。 */
class VisualSigner extends Signer {
  isSignableHeader(key) {
    return key.toLowerCase() === 'content-type' || super.isSignableHeader(key)
  }
}
const MATERIAL = '6ad81c871f280486bb45ac43'
const RELATION = '6ad81c871f280486bb45ac45'
const PROJECT = '6ad81c131f280486bb45ac3f'
const SPACE = '6adb0fbec3ca9f3dcdaf499a'
const MEMBER = '6adb0fbec3ca9f3dcdaf499d'
const MODEL = 'jimeng_t2i_v40'
const recordId = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const eq = (enCode, value) => ({ enCode, method: 'eq', type: 'custom', value })
/** 海报文案和悬浮标识必须移除；只保留实际印在商品或包装上的文字。 */
const instruction = '从参考图片中只提取商品主体，制作干净的纯白底商品图。保留原商品的形状、材质、颜色和结构，保留商品本体上的文字与标识（例如键盘键帽字符、瓶身标签或包装印刷）。删除原图中商品之外的所有文字，包括宣传标题、型号说明、卖点文案、字幕、角标、水印、悬浮Logo及平台标识；即使这些文字与商品品牌或型号有关也必须删除。移除原背景、无关物品和人物，不沿用海报排版，不新增任何悬浮文字、标识、商品或装饰。商品主体完整居中并占据画面主要区域，其余区域为纯白色。只输出一张白底商品图片。'

/** 授权和供应商签名均在 Host 执行；接口不接收任意图片地址或供应商密钥。 */
export function createWhiteBackgroundService(config, auth, keys, billing, fetcher = fetch) {
  const directory = join(config.stateDirectory, 'white-background')
  const active = new Map()
  const base = config.platformURL.replace(/\/$/u, '')
  const detail = (menuId, _id) => platform('/api/visualdev/form/info', { menuId, _id })
  async function platform(path, body) {
    return auth.requestAuthenticated({ path, method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body }) }, AbortSignal.timeout(60_000))
  }
  const pathOf = input => join(directory, `${digest([config.tenantId, input.spaceId, input.projectId, input.requestId])}.json`)
  async function read(path) {
    try { return JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  async function persist(input, state, exclusive = false) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = pathOf(input)
    if (exclusive) return writeFile(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, path)
  }
  /** 每次请求重读项目、空间及真实成员角色；查看者不能发起付费生成或上传。 */
  async function authorize(input, write) {
    if (![input.projectId, input.spaceId].every(recordId)) throw new Error('白底图需要有效项目和团队空间。')
    const status = await auth.status()
    if (!status.authenticated || status.corpId !== config.tenantId || status.baseUrl.replace(/\/$/u, '') !== base)
      throw new Error('白底图请求的登录服务或租户不匹配。')
    const user = (await platform('/api/oauth/currentUser')).userInfo
    if (!user?.id || user.corpId !== config.tenantId) throw new Error('白底图操作人无效。')
    const [project, space] = await Promise.all([detail(PROJECT, input.projectId), detail(SPACE, input.spaceId)])
    if (project?._id !== input.projectId || project.spaceId !== input.spaceId || (project.deletedAt && Number(project.deletedAt) !== 0)
      || space?._id !== input.spaceId || space.status === 'inactive') throw new Error('项目不属于当前可用团队空间。')
    let role = space.ownerUserId === user.id ? 'owner' : ''
    if (!role) {
      const members = await platform('/api/visualdev/form/list', { menuId: MEMBER, currentPage: 1, pageSize: 100,
        connect: 'and', filter: [eq('spaceId', input.spaceId), eq('userId', user.id)], association: false, userInfoConvert: false })
      role = members.list?.find(member => member.spaceId === input.spaceId && member.userId === user.id && member.status === 'active')?.role || ''
    }
    if (!role || (write && !['owner', 'admin', 'editor'].includes(role))) throw new Error('当前空间角色没有白底图操作权限。')
    if (write) {
      const menus = await auth.writableMenus(AbortSignal.timeout(30_000))
      if ([MATERIAL, RELATION].some(menuId => !menus.menus.some(menu => menu.menuId === menuId && menu.agentPermissions.includes('addData'))))
        throw new Error('当前账号没有保存白底图素材和引用的权限。')
    }
  }
  async function credentials() {
    const [accessKeyId, secretKey] = await Promise.all([keys(config.jimengAccessKeyRef), keys(config.jimengSecretKeyRef)])
    if (!accessKeyId || !secretKey) throw new Error('即梦白底图尚未配置 JIMENG_ACCESS_KEY_ID / JIMENG_SECRET_ACCESS_KEY。')
    return { accessKeyId, secretKey }
  }
  /** 使用火山官方签名器；发送给供应商的请求始终固定为 cv / cn-north-1。 */
  async function provider(action, body, credential) {
    const request = { region: 'cn-north-1', method: 'POST', pathname: '/',
      params: { Action: action, Version: '2022-08-31' },
      headers: { Host: 'visual.volcengineapi.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    new VisualSigner(request, 'cv').addAuthorization(credential)
    const response = await fetcher(`https://visual.volcengineapi.com/?${new URLSearchParams(request.params)}`, {
      method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json()
    if (!response.ok || result.code !== 10000)
      throw Object.assign(new Error(`即梦请求失败：${result.message || result.ResponseMetadata?.Error?.Message || response.status}`),
        { rejected: response.status >= 400 && response.status < 500,
          terminal: [50215, 50411, 50412, 50413, 50511, 50512, 50518, 50519].includes(result.code),
          providerRequestId: result.request_id })
    return result.data
  }
  async function upload(bytes, name, mime) {
    const data = await auth.requestAuthenticated({ path: '/api/file/uploader', method: 'POST',
      multipartFile: { name, mediaType: mime, data: bytes } }, AbortSignal.timeout(180_000))
    const url = new URL(data?.url, base)
    const match = /^\/api\/file\/(?:previewImage|dowloadFile)\/([a-f0-9]{24})\/([a-f0-9]{24})$/iu.exec(url.pathname)
    if (url.origin !== new URL(base).origin || !match || match[1] !== config.tenantId)
      throw new Error('白底图上传未返回当前租户的文件。')
    return match[2]
  }
  async function create(menuId, data) {
    const id = await platform('/api/visualdev/form/create', { menuId, data: JSON.stringify(data) })
    if (!recordId(id)) throw new Error('白底图保存未返回有效记录 ID。')
    return id
  }
  /** 建档响应丢失时先查询原始生成来源，不能靠再次创建猜测上一次是否成功。 */
  async function createOnce(input, state, key, menuId, data, filters) {
    if (state[key]) return
    const marker = `${key}Unknown`
    if (state[marker]) {
      const found = await platform('/api/visualdev/form/list', { menuId, currentPage: 1, pageSize: 2, connect: 'and',
        filter: [eq('spaceId', input.spaceId), ...filters], association: false, userInfoConvert: false })
      if (found.list?.length !== 1 || !recordId(found.list[0]._id)) throw new Error('上次素材建档回执待核对，不会重复创建；请稍后继续获取。')
      state[key] = found.list[0]._id
    } else {
      state[marker] = true
      await persist(input, state)
      try { state[key] = await create(menuId, data) }
      catch (error) {
        if ([401, 403, 'jdcloud/auth-required'].includes(error.code)) state[marker] = false
        await persist(input, state)
        throw error
      }
    }
    delete state[marker]
    await persist(input, state)
  }
  function view(state) {
    return { requestId: state.requestId, taskId: state.taskId, projectId: state.projectId, sourceMaterialId: state.source.id,
      name: state.source.name, prompt: state.prompt, status: state.status, error: state.error,
      ...(state.result ? { result: state.result } : {}) }
  }
  async function meter(input, state) {
    if (!billing || !state.binding) return
    try {
      await billing.media(input, state.binding, 'image', { ...view(state), provider: 'jimeng', model: MODEL,
        createdAt: state.createdAt, result: state.result }, { imageOperation: 'edit', imageQuality: 'white-background', imageSize: '2048x2048' })
    } catch (error) { state.billingWarning = `白底图用量待恢复：${error.message}` }
  }
  /** JPEG/PNG/WebP 等可解码图片统一生成受限 JPEG 参考，原始文件不变。 */
  async function prepareReference(input, state) {
    if (state.referenceFileId) return
    const response = await auth.downloadFileAuthenticated(state.source.fileId, AbortSignal.timeout(60_000))
    if (!response.ok || Number(response.headers.get('content-length')) > 50 * 1024 * 1024) throw new Error('原图读取失败或超过50MB。')
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > 50 * 1024 * 1024) throw new Error('原图超过50MB。')
      chunks.push(chunk)
    }
    const image = sharp(Buffer.concat(chunks), { limitInputPixels: 64 * 1024 * 1024 }).rotate()
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height || metadata.width / metadata.height < 1 / 3 || metadata.width / metadata.height > 3)
      throw new Error('即梦参考图的宽高比须在1:3至3:1之间。')
    const bytes = await image.resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer()
    if (bytes.length > 15 * 1024 * 1024) throw new Error('即梦参考图超过15MB，请使用较小的图片。')
    state.referenceFileId = await upload(bytes, 'white-background-reference.jpg', 'image/jpeg')
    await persist(input, state)
  }
  /** 供应商结果先落盘；上传失败沿原步骤恢复，不重新请求图片生成。 */
  async function deliver(input, state) {
    const bytes = Buffer.from(state.image, 'base64')
    const metadata = await sharp(bytes, { limitInputPixels: 32 * 1024 * 1024 }).metadata()
    if (!['png', 'jpeg'].includes(metadata.format) || !metadata.width || !metadata.height) throw new Error('即梦未返回有效图片。')
    await sharp(bytes, { limitInputPixels: 32 * 1024 * 1024 }).stats()
    const mime = metadata.format === 'png' ? 'image/png' : 'image/jpeg'
    const name = `${state.source.name.replace(/\.[^.]+$/u, '')}-白底图.${metadata.format === 'png' ? 'png' : 'jpg'}`
    const generation = { requestId: state.requestId, taskId: state.taskId, model: MODEL, prompt: state.prompt,
      size: '2048x2048', referenceIds: [], createdAt: state.createdAt, confirmedAt: '' }
    const data = { spaceId: input.spaceId, name, library: 'project', category: '参考图片', sourceKind: 'generated',
      authorization: state.source.authorization, revision: 1, originalName: name, mime, width: metadata.width,
      height: metadata.height, sizeBytes: bytes.length, provider: 'jimeng',
      sourceDescription: JSON.stringify({ generatedImage: generation, whiteBackground: {
        sourceMaterialId: state.source.id, sourceFileId: state.source.fileId, sourceRevision: state.source.revision, taskId: state.taskId } }) }
    if (!state.fileId) {
      state.fileId = await upload(bytes, name, mime)
      await persist(input, state)
    }
    data.fileId = state.fileId
    await createOnce(input, state, 'materialId', MATERIAL, data, [eq('sourceDescription', data.sourceDescription)])
    await createOnce(input, state, 'relationId', RELATION, { spaceId: input.spaceId, projectId: input.projectId, materialId: state.materialId,
      purpose: '需求附件', sourceRevision: 1, usageSnapshot: JSON.stringify(data) },
    [eq('projectId', input.projectId), eq('materialId', state.materialId), eq('purpose', '需求附件')])
    state.result = { materialId: state.materialId, relationId: state.relationId, fileId: state.fileId, name, mime }
    state.status = 'succeeded'
    delete state.image
    delete state.error
    await meter(input, state)
    await persist(input, state)
  }
  async function run(operation, input) {
      await authorize(input, operation !== 'list')
      if (operation === 'list') {
        let files
        try { files = await readdir(directory) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
        const states = await Promise.all(files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file)).map(file => read(join(directory, file))))
        return states.filter(state => state.projectId === input.projectId && state.spaceId === input.spaceId).map(view)
      }
      if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(input.requestId)) throw new Error('白底图请求编号无效。')
      let state = await read(pathOf(input))
      if (operation === 'tasks') {
        if (!recordId(input.materialId) || typeof input.prompt !== 'string' || input.prompt.length > 500) throw new Error('白底图素材或提示词无效。')
        const fingerprint = digest([input.materialId, input.prompt.trim()])
        if (state && state.fingerprint !== fingerprint) throw new Error('该白底图请求编号已用于其他图片或提示词。')
        if (!state) {
          const source = await detail(MATERIAL, input.materialId)
          if (source?._id !== input.materialId || source.spaceId !== input.spaceId || !recordId(source.fileId)
            || (!String(source.mime).startsWith('image/') && !/\.(?:png|jpe?g|webp|gif|bmp|avif)$/iu.test(source.originalName || source.name || '')) || source.sourceKind === 'demo'
            || !['自有', '可商用'].includes(source.authorization)) throw new Error('请选择当前空间内可用于生成的自有或可商用图片。')
          await credentials()
          state = { requestId: input.requestId, projectId: input.projectId, spaceId: input.spaceId, fingerprint,
            prompt: input.prompt.trim(), status: 'preparing', createdAt: new Date().toISOString(),
            source: { id: source._id, fileId: source.fileId, name: source.name || source.originalName, revision: source.revision, authorization: source.authorization },
            binding: billing ? await billing.beginMedia(input) : undefined }
          try { await persist(input, state, true) }
          catch (error) { if (error.code === 'EEXIST') return view(await read(pathOf(input))); throw error }
        }
        if (state.status === 'preparing') {
          await prepareReference(input, state)
          state.status = 'submitting'
          await persist(input, state)
          try {
            const data = await provider('CVSync2AsyncSubmitTask', { req_key: MODEL,
              image_urls: [`${base}/api/file/previewImage/${config.tenantId}/${state.referenceFileId}`],
              prompt: `${instruction}${state.prompt ? `用户指定主体与要求：${state.prompt}` : ''}`,
              force_single: true, width: 2048, height: 2048 }, await credentials())
            if (typeof data?.task_id !== 'string' || !data.task_id) throw new Error('即梦提交未返回任务编号。')
            state.taskId = data.task_id
            state.status = 'in_queue'
          } catch (error) {
            state.status = error.rejected ? 'failed' : 'unknown'
            state.error = error.rejected ? error.message : '提交结果未确认，请核对原任务；不会自动重复付费提交。'
          }
          await meter(input, state)
          await persist(input, state)
        }
      } else if (operation === 'refresh') {
        if (!state) throw new Error('没有找到白底图任务。')
        if (state.status === 'submitting') return { ...view(state), status: 'unknown', error: '原提交结果待核对，不会重复提交。' }
        if (state.taskId && ['in_queue', 'generating'].includes(state.status)) {
          let data
          try {
            data = await provider('CVSync2AsyncGetResult', { req_key: MODEL, task_id: state.taskId,
              req_json: JSON.stringify({ return_url: false }) }, await credentials())
          } catch (error) {
            // 查询限流和网络故障不代表原生成任务失败，保留原任务状态供继续获取。
            if (!error.terminal) throw error
            state.status = 'failed'
            state.error = error.message
            await meter(input, state)
            await persist(input, state)
            return view(state)
          }
          if (!['in_queue', 'generating', 'done', 'not_found', 'expired'].includes(data?.status)) throw new Error('即梦任务返回未知状态。')
          state.status = data.status
          if (data.status === 'done') {
            if (data.binary_data_base64?.length !== 1 || typeof data.binary_data_base64[0] !== 'string'
              || data.binary_data_base64[0].length > 70 * 1024 * 1024) throw new Error('即梦未返回单张有效图片，请核对原任务。')
            state.image = data.binary_data_base64[0]
          }
          if (['not_found', 'expired'].includes(data.status)) state.error = '即梦任务不存在或已过期，请核对后重新发起生成。'
          await persist(input, state)
        }
        if (state.image && !state.result) {
          try { await deliver(input, state) }
          catch (error) { state.status = 'upload_failed'; state.error = `白底图已生成，保存未完成：${error.message}`; await persist(input, state) }
        }
        if (state.result) await meter(input, state)
      } else throw new Error('白底图操作不存在。')
      return view(state)
  }
  return {
    /** 提交、查询与上传共享同一任务锁，多个窗口查询不能重复提交或创建素材。 */
    async run(operation, input) {
      const key = pathOf(input)
      const previous = active.get(key) || Promise.resolve()
      const pending = previous.catch(() => undefined).then(() => run(operation, input))
      active.set(key, pending)
      try { return await pending }
      finally { if (active.get(key) === pending) active.delete(key) }
    },
  }
}
