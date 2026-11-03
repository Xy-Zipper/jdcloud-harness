/** 影子账单持久回执与低代码同步；不写钱包、预留或消费流水，不把账单送给模型。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { calculateShadowCharge, normalizeAgentUsage } from './billing-price.mjs'

const PRICE = '6ad81c871f280486bb45ac59'
const USAGE = '6ad81c871f280486bb45ac5b'
const SPACE = '6adb0fbec3ca9f3dcdaf499a'
const MEMBER = '6adb0fbec3ca9f3dcdaf499d'
const PROJECT = '6ad81c131f280486bb45ac3f'
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const filter = (enCode, value) => ({ enCode, method: 'eq', type: 'custom', value })
const read = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** 单 Host 状态目录串行去重；平台创建回执未知时只查原事件，不盲目再次创建。 */
export function createBillingRecorder(config, auth, keys, fetcher = fetch) {
  const directory = join(config.stateDirectory, 'billing')
  const active = new Map()
  const bindings = new Map()
  const observed = new Set()
  let stopping = false
  async function persist(name, data) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, name)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 })
    await rename(temporary, path)
  }
  async function platform(path, body, method = body === undefined ? 'GET' : 'POST') {
    return auth.requestAuthenticated({ path, method, ...(body === undefined ? {} : { body }) }, AbortSignal.timeout(30_000))
  }
  async function rows(menuId, filters) {
    const result = []
    for (let page = 1; page <= 20; page++) {
      const data = await platform('/api/visualdev/form/list', { menuId, currentPage: page, pageSize: 200, connect: 'and', filter: filters, association: false, userInfoConvert: false })
      if (!Array.isArray(data?.list)) throw new Error('影子计费列表返回异常。')
      result.push(...data.list)
      if (data.list.length < 200) return result
    }
    throw new Error('影子计费配置超过读取上限。')
  }
  async function identity(input) {
    if (!id(input.spaceId)) throw new Error('计费记录缺少团队空间。')
    const status = await auth.status()
    if (!status.authenticated || status.corpId !== config.tenantId || status.baseUrl.replace(/\/$/u, '') !== config.platformURL.replace(/\/$/u, ''))
      throw new Error('计费服务租户或服务地址不匹配。')
    const user = (await platform('/api/oauth/currentUser')).userInfo
    if (!user?.id || user.corpId !== config.tenantId) throw new Error('计费操作人身份无效。')
    const scopeKey = await auth.currentScopeKey()
    const space = await platform('/api/visualdev/form/info', { menuId: SPACE, _id: input.spaceId })
    if (space?._id !== input.spaceId || space.status === 'inactive') throw new Error('计费空间不可用。')
    if (space.ownerUserId !== user.id) {
      const members = await rows(MEMBER, [filter('spaceId', input.spaceId), filter('userId', user.id)])
      if (!members.some(member => member.spaceId === input.spaceId && member.userId === user.id && member.status === 'active'))
        throw new Error('不能访问其他团队空间的计费记录。')
    }
    if (input.projectId) {
      if (!id(input.projectId)) throw new Error('计费项目编号无效。')
      const project = await platform('/api/visualdev/form/info', { menuId: PROJECT, _id: input.projectId })
      if (project?._id !== input.projectId || project.spaceId !== input.spaceId) throw new Error('计费项目不属于当前空间。')
    }
    return { scopeKey, initiatedByUserId: user.id, spaceId: input.spaceId, projectId: input.projectId || '' }
  }
  async function prices() {
    return rows(PRICE, [filter('pricingStatus', 'published')])
  }
  async function serialize(key, operation) {
    const previous = active.get(key) ?? Promise.resolve()
    // 上次失败已由调用方报告；新操作仍可沿同一持久回执恢复。
    const pending = previous.catch(() => undefined).then(operation)
    active.set(key, pending)
    try { return await pending }
    finally { if (active.get(key) === pending) active.delete(key) }
  }
  async function sync(record) {
    let creating = false
    try {
      const token = config.billingWriterKeyRef ? await keys(config.billingWriterKeyRef) : ''
      const scopeKey = token ? undefined : await auth.currentScopeKey()
      // 没有服务凭据时只借用原发起人的当前请求授权，不落盘 Token，也不扩大低代码权限。
      if (!token) {
        const status = await auth.status()
        if (!scopeKey || !status.authenticated || status.corpId !== config.tenantId
          || status.baseUrl.replace(/\/$/u, '') !== config.platformURL.replace(/\/$/u, ''))
          throw new Error('用量回执已保存，请原发起人登录后自动补同步，或配置计量服务凭据。')
      }
      async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
        if (!token) {
          if (scopeKey !== await auth.currentScopeKey())
            throw Object.assign(new Error('用量同步期间账号已变化，回执保留待原账号补同步。'), { code: 'billing/account-changed' })
          return platform(path, body, method)
        }
        const response = await fetcher(`${config.platformURL.replace(/\/$/u, '')}${path}`, {
          method, headers: { Authorization: token, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000),
        })
        const value = await response.json()
        if (!response.ok || value.code !== 200)
          throw Object.assign(new Error('低代码用量同步失败，请检查计量服务凭据和表权限。'), { code: response.ok ? value.code : response.status })
        return value.data
      }
      const writer = await call('/api/oauth/currentUser')
      if (writer.userInfo?.corpId !== config.tenantId) throw new Error('计量服务写入凭据的租户不匹配。')
      if (!token && writer.userInfo?.id !== record.row.initiatedByUserId)
        throw new Error('当前账号不是原发起人，回执保留待原账号或计量服务补同步。')
      const found = await call('/api/visualdev/form/list', { menuId: USAGE, currentPage: 1, pageSize: 2, connect: 'and',
        filter: [filter('usageEventKey', record.row.usageEventKey), filter('spaceId', record.row.spaceId)], association: false, userInfoConvert: false })
      if (!Array.isArray(found?.list) || found.list.length > 1) throw new Error('用量唯一键出现重复，请人工核对。')
      let remoteId = found.list[0]?._id
      if (!remoteId && record.syncStatus === 'unknown')
        return { ...record, syncMessage: '原创建回执未知且尚未查到记录，请核对平台，不自动再次创建。' }
      const { parameters, delivered, ...syncRow } = record.row
      const data = JSON.stringify({ ...syncRow, requestParameters: JSON.stringify(parameters),
        deliveryStatus: delivered ? 'delivered' : 'pending', billingMode: 'shadow' })
      if (remoteId) await call('/api/visualdev/form/update', { menuId: USAGE, _id: remoteId, data }, 'PUT')
      else {
        record = { ...record, syncStatus: 'unknown' }
        await persist(`${record.key}.json`, record)
        creating = true
        remoteId = await call('/api/visualdev/form/create', { menuId: USAGE, data })
      }
      if (!id(remoteId)) throw new Error('用量写入没有返回有效记录编号。')
      return { ...record, remoteId, syncStatus: 'synced', syncMessage: '' }
    } catch (error) {
      // 明确的登录/权限拒绝可安全补写；网络中断等创建结果未知的情况仍只查原事件键。
      const rejected = creating && [401, 403, 'jdcloud/auth-required', 'billing/account-changed'].includes(error.code)
      return { ...record, syncStatus: record.syncStatus === 'unknown' && !rejected ? 'unknown' : 'pending', syncMessage: error.message }
    }
  }
  async function save(row, priceRows, parameters = {}) {
    const key = hash([config.tenantId, row.usageEventKey])
    return serialize(key, async () => {
      const previous = await read(join(directory, `${key}.json`))
      if (previous?.row.delivered && row.scenario !== 'agent' && !row.delivered) return previous.row
      const pinned = previous?.prices ?? priceRows
      // 操作人由首次合法提交固定；他人查询/恢复不能把账单改为自己的消费。
      const normalized = { ...previous?.row, ...row, ...(previous ? { initiatedByUserId: previous.row.initiatedByUserId, occurredAt: previous.row.occurredAt } : {}),
        parameters: { ...previous?.row.parameters, ...parameters } }
      const fee = calculateShadowCharge(normalized, pinned)
      const record = { key, prices: pinned, row: { ...normalized, ...fee, priceSnapshot: fee.priceSnapshot || '',
        usage: JSON.stringify(Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens', 'videoOutputTokens', 'imageCount']
          .filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]]))), receipt: '', schemaVersion: 'shadow-billing-1' },
        syncStatus: previous?.syncStatus === 'synced' ? 'synced' : previous?.syncStatus ?? 'pending' }
      await persist(`${key}.json`, record)
      const synced = await sync(record)
      await persist(`${key}.json`, synced)
      return synced.row
    })
  }
  function contextOf(message) {
    if (message.source?.kind !== 'user') return undefined
    const text = message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    const start = text.indexOf('{')
    if (start < 0) return undefined
    const skillNames = [...text.slice(0, start).matchAll(/\/(creation-studio-[a-z-]+)/gu)].map(match => match[1])
    try {
      const end = text.lastIndexOf('}')
      const value = JSON.parse(text.slice(start, end + 1))
      if (value.context?.tenantId !== config.tenantId || !id(value.context.spaceId)) return undefined
      return { ...value.context, skillNames, payer: skillNames.includes('creation-studio-stage-recommender') ? 'platform' : 'customer' }
    } catch { return undefined }
  }
  const sessionKey = session => hash([session.id, session.header.createdAt])
  /** 只重算未完成的影子账，逐条串行恢复；不会调用模型或重新生成媒体。 */
  async function reconcile(input) {
    await identity(input)
    const priceRows = await prices()
    let files
    try { files = await readdir(directory) }
    catch (error) { if (error.code === 'ENOENT') return { mode: 'shadow', processed: 0 }; throw error }
    let processed = 0
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
      if (processed >= 50) break
      await serialize(file.slice(0, -5), async () => {
        let record = await read(join(directory, file))
        if (record.row.spaceId !== input.spaceId || (input.projectId && record.row.projectId !== input.projectId)
          || (record.syncStatus === 'synced' && record.row.chargeStatus !== 'pending')) return
        if (record.row.chargeStatus === 'pending') {
          const fee = calculateShadowCharge(record.row, priceRows)
          record = { ...record, prices: priceRows, row: { ...record.row, ...fee } }
        }
        record = await sync(record)
        await persist(file, record)
        processed++
      })
    }
    return { mode: 'shadow', processed }
  }
  return {
    /** 在模型运行前固定真实用户/空间和价格；不将采集结果写入消息。 */
    async bind(session, messages, parent, turn) {
      const contexts = messages.map(contextOf).filter(Boolean)
      if (!contexts.length) {
        if (!parent || session.header.origin !== 'subagent' || session.header.parentSession !== parent.id) return
        const key = sessionKey(session)
        const existing = bindings.get(key) ?? await read(join(directory, `${key}.bindings.json`))
        if (existing?.length) return
        const parentBindings = bindings.get(sessionKey(parent)) ?? await read(join(directory, `${sessionKey(parent)}.bindings.json`))
        const inherited = parentBindings?.at(-1)
        if (!inherited) return
        const history = [{ ...inherited, turnNumber: turn, sessionId: session.id, sessionCreatedAt: session.header.createdAt, startSeq: session.snapshotEvents().length }]
        bindings.set(key, history)
        await persist(`${key}.bindings.json`, history)
        return
      }
      const context = contexts.at(-1)
      const owner = await identity(context)
      if (!await auth.owns('session', session.id, owner.scopeKey)) throw new Error('计量会话不属于当前账号。')
      const value = { ...owner, payer: contexts.length > 1 ? 'platform' : context.payer,
        reason: contexts.length > 1 ? '同一步接纳多条用户消息，归属待核对，本次由平台承担。' : '',
        requestId: context.billingRequestId || `session-${session.id}-${session.snapshotEvents().length}`,
        skillNames: context.skillNames, startSeq: session.snapshotEvents().length,
        prices: await prices(), turnNumber: turn, sessionId: session.id, sessionCreatedAt: session.header.createdAt }
      const key = sessionKey(session)
      const history = bindings.get(key) ?? await read(join(directory, `${key}.bindings.json`)) ?? []
      history.push(value)
      bindings.set(key, history)
      await persist(`${key}.bindings.json`, history)
    },
    /** 只记录本 Host 已核验绑定之后的新事件；恢复时事件号固定去重。 */
    async capture(session, event) {
      if (stopping || !['assistant/message', 'assistant/attempt'].includes(event.type)) return
      const observedKey = `${sessionKey(session)}:${event.seq}`
      if (observed.has(observedKey)) return
      const history = bindings.get(sessionKey(session)) ?? await read(join(directory, `${sessionKey(session)}.bindings.json`)) ?? []
      const binding = history.findLast(item => item.startSeq <= event.seq)
      if (!binding) return
      const events = session.snapshotEvents()
      const header = events.findLast(item => item.seq < event.seq && item.type === 'request/header')?.data.header
      const source = event.data.message?.source
      const usage = event.data.usage ?? event.data.stream?.findLast(item => item.type === 'chunk' && item.chunk.type === 'usage')?.chunk.usage
      const finish = event.data.stream?.findLast(item => item.type === 'chunk' && item.chunk.type === 'finish')?.chunk.reason
      const failed = event.type === 'assistant/attempt' && finish?.kind !== 'aborted'
      const background = binding.turnNumber !== undefined && binding.turnNumber !== event.data.turn
      const normalized = normalizeAgentUsage(usage)
      await save({ spaceId: binding.spaceId, projectId: binding.projectId, initiatedByUserId: binding.initiatedByUserId,
        requestId: background ? `background:${session.id}:${event.data.turn}` : binding.requestId, sessionId: session.id, scenario: 'agent', payer: failed || background ? 'platform' : binding.payer,
        reason: failed ? '平台故障或供应商错误尝试，由平台承担。' : background ? '没有本轮用户主动授权的后台调用，由平台承担。' : binding.reason,
        usageEventKey: `agent:${session.id}:${binding.sessionCreatedAt}:${event.seq}`, eventSeq: event.seq,
        turnNumber: event.data.turn, stepNumber: event.data.step,
        provider: source?.provider || header?.config?.provider || '', modelKey: source?.model || header?.config?.model || '',
        skillNames: JSON.stringify(binding.skillNames), ...normalized, status: failed ? 'failed' : event.data.interrupted || finish?.kind === 'aborted' ? 'cancelled' : 'succeeded',
        occurredAt: event.time, completedAt: event.time, usageSource: 'harness-provider-event' }, binding.prices)
      observed.add(observedKey)
    },
    async beginMedia(input) {
      const owner = await identity(input)
      return { ...owner, prices: await prices() }
    },
    async media(input, binding, scenario, task, parameters) {
      if (!binding) return
      const failure = ['failed', 'expired', 'cancelled'].includes(task.status)
      const usage = task.usage
      const validVideo = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0
        && (usage.total_tokens === undefined || usage.total_tokens === usage.completion_tokens)
      return save({ spaceId: binding.spaceId, projectId: input.projectId, initiatedByUserId: binding.initiatedByUserId,
        requestId: input.requestId, scenario, provider: task.provider || (scenario === 'video' ? 'ark' : 'gpt-image'),
        modelKey: task.model || (scenario === 'image' ? config.imageModel : 'doubao-seedance-2-5-260628'),
        usageEventKey: `${scenario}:${input.spaceId}:${input.projectId}:${input.planId}:${input.requestId}`,
        providerRequestId: task.id || task.taskId || '', status: failure ? 'failed' : task.status,
        usageStatus: scenario === 'image' ? (task.result ? 'reported' : 'pending') : validVideo ? 'reported' : 'pending',
        ...(scenario === 'image' && task.result ? { imageCount: 1 } : {}),
        ...(validVideo ? { videoOutputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : {}),
        delivered: Boolean(task.result?.relationId || task.videoRefId), occurredAt: Date.parse(task.createdAt) || Date.now(),
        completedAt: Date.now(), usageSource: scenario === 'video' ? 'ark-task-usage' : 'platform-image-result',
        payer: 'customer' }, binding.prices, parameters)
    },
    reconcile,
    /** 本轮结束时在原账号范围内补同步，其他账号不能替代原发起人写入。 */
    async recover(session) {
      if (stopping) return
      const history = bindings.get(sessionKey(session)) ?? await read(join(directory, `${sessionKey(session)}.bindings.json`))
      const binding = history?.at(-1)
      if (!binding || binding.scopeKey !== await auth.currentScopeKey()) return
      return reconcile({ spaceId: binding.spaceId, projectId: binding.projectId })
    },
    async list(input) {
      // 打开用量页即可恢复已保存回执，用户不需要先点一次手工同步。
      await reconcile(input)
      let files
      try { files = await readdir(directory) }
      catch (error) { if (error.code === 'ENOENT') return { mode: 'shadow', rows: [], total: 0, page: 1 }; throw error }
      const records = []
      for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const record = await read(join(directory, file))
        if (record.row.spaceId !== input.spaceId || (input.projectId && record.row.projectId !== input.projectId)) continue
        records.push({ ...record.row, priceSnapshot: undefined, receipt: undefined,
          syncStatus: record.syncStatus, syncMessage: record.syncMessage })
      }
      records.sort((a, b) => b.occurredAt - a.occurredAt)
      const page = Number.isSafeInteger(input.page) && input.page > 0 ? input.page : 1
      return { mode: 'shadow', rows: records.slice((page - 1) * 50, page * 50), total: records.length, page }
    },
    async close() {
      stopping = true
      await Promise.allSettled([...active.values()])
    },
  }
}
