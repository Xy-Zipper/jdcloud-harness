/** 同源生图代理：核对项目权限、读取平台参考图，外部密钥只保留在服务端。 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { confirmedStoryboardUpstream } from './upstream.mjs'
import { isImageGenerationRequest } from './image-generation.mjs'
import { imagePrompt } from './image-prompts.mjs'
import { createSeedreamTasks, SEEDREAM_MODELS } from './seedream.mjs'
import { normalizeMaterialAuthorization } from './material-authorization.mjs'

const MENU = { project: '6ad81c131f280486bb45ac3f', plan: '6ad81c871f280486bb45ac49', shot: '6ad81c871f280486bb45ac4b', material: '6ad81c871f280486bb45ac43', relation: '6ad81c871f280486bb45ac45', space: '6adb0fbec3ca9f3dcdaf499a', member: '6adb0fbec3ca9f3dcdaf499d' }
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
class ApiError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const authorization = apiKey => `Bearer ${apiKey.trim().replace(/^Bearer\s+/iu, '')}`
const providerError = data => typeof data.error === 'string' ? data.error : data.error?.message || data.message || '图片服务未接受请求。'

/** 有参考图按已验证协议传 images URL，不沿用 multipart 或 JSON Content-Type。 */
async function postImage(apiKey, model, input, references, asynchronous, transport) {
  const fields = { model, prompt: imagePrompt(input.prompt), size: input.size, quality: 'high',
    response_format: asynchronous ? 'url' : 'b64_json', ...(asynchronous ? { async: true, n: 1 } : {}),
    ...(references.length ? { images: references.map(reference => reference.url) } : {}) }
  const response = await transport(`https://api.kbsfdxc.net/v1/images/${references.length ? 'edits' : 'generations'}`, {
    method: 'POST',
    headers: { Authorization: authorization(apiKey), ...(references.length ? {} : { 'Content-Type': 'application/json' }) },
    // 字节请求体避免 Fetch 自动为字符串补 text/plain，编辑接口不显式指定 Content-Type。
    body: Buffer.from(JSON.stringify(fields)),
    redirect: 'error',
    signal: AbortSignal.timeout(300_000),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new ApiError(providerError(data), 502)
    error.providerRejected = response.status >= 400 && response.status < 500
    throw error
  }
  return data
}

/** 根据实际文件头识别图片，最终解码与尺寸检查仍由 Harness 附件服务执行。 */
function encodedImage(bytes) {
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : ''
  if (!mime)
    throw new ApiError('返回内容不是 PNG、JPEG 或 WebP 图片。', 502)
  return { b64: bytes.toString('base64'), mime }
}

/** 保留单图同步入口；批量补图使用 submit/refresh 的供应商异步任务。 */
export async function requestGptImage(apiKey, model, input, references, transport = fetch) {
  const data = await postImage(apiKey, model, input, references, false, transport)
  const encoded = data.data?.[0]?.b64_json
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 70 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/u.test(encoded))
    throw new ApiError('图片服务未返回有效的 b64_json，未保存为图片。', 502)
  return encodedImage(Buffer.from(encoded, 'base64'))
}

export function createImageService(env, transport = fetch) {
  const apiKey = env.GPT_IMAGE_API_KEY?.trim()
  const platform = (env.CREATION_STUDIO_PLATFORM_URL || env.VITE_SERVE || '').replace(/\/$/u, '')
  const tenant = env.CREATION_STUDIO_TENANT_ID || env.VITE_TENANT_ID
  const directory = resolve(env.CREATION_STUDIO_IMAGE_STATE_DIR || '.creation-studio/images')
  const retryLimit = env.CREATION_STUDIO_IMAGE_RETRY_LIMIT ?? 4
  const taskPath = input => {
    if (!/^[a-zA-Z0-9-]{8,100}$/u.test(input.requestId || ''))
      throw new ApiError('图片请求编号无效。')
    return join(directory, `${createHash('sha256').update(JSON.stringify([tenant, input.spaceId, input.projectId, input.planId, input.requestId])).digest('hex')}.json`)
  }
  async function readTask(input) {
    try { return JSON.parse(await readFile(taskPath(input), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function storeTask(input, task) {
    // 批量查询与后台写回会重叠，使用已有的 Windows 原子替换重试。
    await writeFileAtomic(taskPath(input), JSON.stringify(task), { mode: 0o600, dirMode: 0o700 })
  }
  async function platformCall(token, path, body) {
    const response = await transport(`${platform}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Authorization': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) })
    const data = await response.json()
    if (!response.ok || data.code !== 200)
      throw new ApiError(data.msg || '平台权限或数据读取失败。', 403)
    return data.data
  }
  const detail = (token, menuId, recordId) => platformCall(token, '/api/visualdev/form/info', { menuId, _id: recordId })
  const filter = (enCode, value) => ({ enCode, method: 'eq', type: 'custom', value })
  async function rows(token, menuId, filters) {
    const result = []
    for (let page = 1; page <= 20; page++) {
      const data = await platformCall(token, '/api/visualdev/form/list', { menuId, currentPage: page, pageSize: 200, connect: 'and', association: false, userInfoConvert: false, filter: filters })
      if (!Array.isArray(data?.list))
        throw new ApiError('平台列表格式无效。')
      result.push(...data.list)
      if (data.list.length < 200 || result.length >= Number(data.pagination?.total))
        return result
    }
    throw new ApiError('项目记录超过读取上限。')
  }
  async function authorize(token, input) {
    if (!platform || !tenant)
      throw new ApiError('生图服务缺少平台地址或租户配置。', 503)
    if (!token || !id(input.projectId) || !id(input.spaceId) || !id(input.planId))
      throw new ApiError('请登录并打开已保存的项目。', 401)
    const user = (await platformCall(token, '/api/oauth/currentUser')).userInfo
    if (!user?.id || user.corpId !== tenant)
      throw new ApiError('账号不属于当前租户。', 403)
    const [project, space, plan] = await Promise.all([detail(token, MENU.project, input.projectId), detail(token, MENU.space, input.spaceId), detail(token, MENU.plan, input.planId)])
    if (project?._id !== input.projectId || project.spaceId !== input.spaceId || project.deletedAt
      || space?._id !== input.spaceId || space.status === 'inactive' || project.adoptedPlanId !== input.planId
      || plan?._id !== input.planId || plan.projectId !== input.projectId || plan.spaceId !== input.spaceId) {
      throw new ApiError('项目、空间或当前采纳方案不可用。', 403)
    }
    if (space.ownerUserId !== user.id) {
      const members = await rows(token, MENU.member, [filter('spaceId', input.spaceId), filter('userId', user.id)])
      if (!members.some(member => member.spaceId === input.spaceId && member.userId === user.id
        && member.status === 'active' && ['admin', 'editor'].includes(member.role))) {
        throw new ApiError('当前角色不能生成图片。', 403)
      }
    }
    const shots = (await rows(token, MENU.shot, [filter('spaceId', input.spaceId), filter('projectId', input.projectId), filter('planId', input.planId)]))
      .sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder))
    const requirement = { ...project, specification: parse(project.specification), caseIds: parse(project.caseIds || '[]'), _meta: { schemaVersion: '1.0', artifactType: 'creation-studio-requirement-intake', syncStatus: 'synced', tenantId: tenant, projectId: input.projectId, spaceId: input.spaceId, revision: Number(project.formRevision), baseRevision: Number(project.formRevision) } }
    confirmedStoryboardUpstream(requirement, project, plan, shots)
    return user.id
  }
  /** 生图参考允许待确认画面，仅传已核验项目文件 URL；视频仍单独核验画面确认。 */
  async function referenceData(token, input, relationId) {
    const relation = await detail(token, MENU.relation, relationId)
    if (relation?._id !== relationId || relation.projectId !== input.projectId || relation.spaceId !== input.spaceId || !id(relation.materialId))
      throw new ApiError('参考图不属于当前项目。', 403)
    const material = await detail(token, MENU.material, relation.materialId)
    const source = Number(material?.revision) === Number(relation.sourceRevision) ? material : parse(relation.usageSnapshot)
    if (material?._id !== relation.materialId || material.spaceId !== input.spaceId || !['自有', '可商用'].includes(normalizeMaterialAuthorization(material.authorization))
      || !source || !id(source.fileId) || Number(source.revision) !== Number(relation.sourceRevision)
      || !['uploaded', 'referenced', 'generated'].includes(source.sourceKind) || !['自有', '可商用'].includes(normalizeMaterialAuthorization(source.authorization))
      || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mime)) {
      throw new ApiError('参考图文件或使用范围无效。')
    }
    return { url: `${platform}/api/file/previewImage/${tenant}/${source.fileId}`,
      mime: source.mime, name: source.originalName || 'reference.png', fileId: source.fileId, revision: source.revision }
  }
  // Seedream 的同步供应商请求由 Host 托管，页面仍使用原来的异步任务与上传入口。
  const seedream = createSeedreamTasks({
    authorize, referenceData, readTask, storeTask, pool: env.PROVIDER_ACCOUNTS,
    background: env.IMAGE_BACKGROUND, transport, validate: isImageGenerationRequest, defaultModel: env.SEEDREAM_MODEL,
    async createTask(input, task) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try { await writeFile(taskPath(input), JSON.stringify(task), { flag: 'wx', mode: 0o600 }); return true }
      catch (error) { if (error.code === 'EEXIST') return false; throw error }
    },
  })
  const submit = (token, input) => seedream.submit(token, { ...input, tenantId: tenant })
  async function generate(token, input) {
    await submit(token, input)
    await env.IMAGE_BACKGROUND.wait(input)
    const result = await readTask(input)
    if (result.status !== 'succeeded')
      throw Object.assign(new ApiError(result.error || '图片尚未完成，请查询原请求。', 502), { task: result })
    return result.result
  }

  /** 提交拒绝与未知付费结果分开持久化；任何 POST 前均已有 submitting 回执。 */
  async function sendTask(input, task, references) {
    try {
      const data = await postImage(apiKey, task.source.model, task.source, references, true, transport)
      if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/u.test(data.id))
        throw new ApiError('供应商未返回有效的图片任务编号。', 502)
      task.taskId = data.id
      task.status = 'pending'
    }
    catch (error) {
      task.status = error.providerRejected ? 'failed' : 'unknown'
      task.errorCode = error.providerRejected ? 'image/provider-rejected' : 'image/submission-unknown'
      task.error = error.providerRejected ? error.message
        : `图片提交结果未确认：${error.message} 请核对供应商记录，原请求不会重新付费提交。`
    }
    await storeTask(input, task)
    return task
  }

  /** 仅供应商明确失败且允许重试才重提；次数和旧任务编号落盘，跨进程不重复 POST。 */
  async function retryTask(token, input, task) {
    const count = task.retryCount ?? 0
    if (!task.retryable || count >= retryLimit) return task
    // 历史 GPT 失败重提会新增供应商费用，余额不足时只保留原回执供核对。
    if (env.CHECK_POINTS) await env.CHECK_POINTS(input.spaceId)
    if (!apiKey) throw new ApiError('生图服务尚未配置 GPT_IMAGE_API_KEY。', 503)
    const references = []
    for (const relationId of task.source.referenceIds) references.push(await referenceData(token, input, relationId))
    try { await mkdir(`${taskPath(input)}.retry-${count + 1}.lock`) }
    catch (error) {
      if (error.code === 'EEXIST') {
        const latest = await readTask(input)
        return (latest.retryCount ?? 0) > count ? latest : { ...latest, status: 'unknown',
          error: '原任务失败后的重提回执尚未确认，请稍后查询并核对供应商记录；不会重复提交。' }
      }
      throw error
    }
    task.previousTaskIds = [...(task.previousTaskIds ?? []), task.taskId]
    task.retryCount = count + 1
    task.status = 'submitting'
    delete task.taskId
    delete task.error
    delete task.errorCode
    delete task.retryable
    await storeTask(input, task)
    return sendTask(input, task, references)
  }

  /** 只跟踪已有任务；completed 后读取内容，跨域跳转不转发供应商密钥。 */
  async function refresh(token, input) {
    await authorize(token, input)
    const task = await readTask(input)
    if (!task) throw new ApiError('没有找到当前项目的图片任务。', 404)
    if (SEEDREAM_MODELS.includes(task.source?.model)) return seedream.refresh(token, input, task)
    if (task.status === 'failed') return retryTask(token, input, task)
    if (!task.taskId || ['succeeded', 'unknown'].includes(task.status)) return task
    if (!apiKey) throw new ApiError('生图服务尚未配置 GPT_IMAGE_API_KEY。', 503)
    const endpoint = `https://api.kbsfdxc.net/v1/images/${encodeURIComponent(task.taskId)}`
    const response = await transport(endpoint, {
      headers: { Authorization: authorization(apiKey) }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    const data = await response.json()
    if (!response.ok || data.id !== task.taskId || !['pending', 'completed', 'failed'].includes(data.status))
      throw new ApiError('图片任务查询失败或返回了未知状态，请用原请求编号继续查询。', 502)
    if (data.status === 'failed') {
      task.status = 'failed'
      task.error = providerError(data)
      // 该精确错误值是供应商给出的可重试条件，不对其他失败或超时作此推断。
      task.retryable = task.error === 'image generation failed; please retry'
      if (task.retryable && (task.retryCount ?? 0) < retryLimit)
        return retryTask(token, input, task)
    }
    if (data.status === 'completed') {
      // 内容地址由已保存的任务编号构造，不接受模型或响应中的任意下载地址。
      let url = new URL(`${endpoint}/content`)
      let downloaded
      for (let redirects = 0; redirects <= 5; redirects++) {
        downloaded = await transport(url.href, {
          headers: url.origin === 'https://api.kbsfdxc.net' ? { Authorization: authorization(apiKey) } : {},
          redirect: 'manual', signal: AbortSignal.timeout(60_000),
        })
        if (![301, 302, 303, 307, 308].includes(downloaded.status)) break
        const location = downloaded.headers.get('location')
        await downloaded.body?.cancel()
        if (!location) throw new ApiError('图片下载跳转缺少目标地址。', 502)
        url = new URL(location, url)
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new ApiError('图片下载跳转必须使用 HTTPS。', 502)
      }
      if (!downloaded.ok || !downloaded.body || downloaded.headers.get('content-type')?.includes('text/html'))
        throw new ApiError('生成图片尚未下载成功，请用原请求继续查询，不要重新生成。', 502)
      const chunks = []
      let bytes = 0
      for await (const chunk of downloaded.body) {
        bytes += chunk.length
        if (bytes > 50 * 1024 * 1024) throw new ApiError('生成图片超过50MB。', 502)
        chunks.push(chunk)
      }
      task.result = { ...encodedImage(Buffer.concat(chunks)), source: { ...task.source, taskId: task.taskId } }
      task.status = 'succeeded'
    }
    await storeTask(input, task)
    return task
  }

  /** 只列当前项目已保存回执，不提交付费请求；供页面刷新后恢复。 */
  async function list(token, input) {
    await authorize(token, input)
    let files
    try { files = await readdir(directory) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const tasks = []
    for (const file of files.filter(value => /^[a-f0-9]{64}\.json$/u.test(value))) {
      const task = JSON.parse(await readFile(join(directory, file), 'utf8'))
      if (task.tenantId === tenant && task.projectId === input.projectId && task.planId === input.planId && task.spaceId === input.spaceId)
        tasks.push({ ...task, result: task.result ? { source: task.result.source } : undefined })
    }
    return tasks
  }
  /** 报价重读项目确认与参考图权限，不创建任务、不占用账号、不调用供应商。 */
  async function quote(token, input) {
    if (!isImageGenerationRequest({ prompt: input.prompt, size: input.size, referenceIds: input.referenceIds, ...(input.model ? { model: input.model } : {}) }))
      throw new ApiError('报价图片参数无效。')
    await authorize(token, input)
    for (const relationId of input.referenceIds) await referenceData(token, input, relationId)
    return { model: input.model || env.SEEDREAM_MODEL, size: input.size, referenceCount: input.referenceIds.length }
  }
  return { generate, submit, refresh, list, quote }
}
