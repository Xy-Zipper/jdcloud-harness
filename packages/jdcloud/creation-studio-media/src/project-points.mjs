/** 创建造物片场项目前直读空间积分，策略与媒体插件一起挂载和卸载。 */
const PROJECT = '6ad81c131f280486bb45ac3f'
const SPACE = '6adb0fbec3ca9f3dcdaf499a'
const MEMBER = '6adb0fbec3ca9f3dcdaf499d'
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)

const unavailable = () => Object.assign(new Error('当前空间积分读取失败，暂不能新建项目，请重试或联系空间所有者。'),
  { code: 'creation-studio/points-unavailable' })

/** 所有付费入口使用相同的十进制判断，不把空值、非法值或读取失败当作可用积分。 */
function positivePoints(raw, action) {
  const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) || !Number.isFinite(Number(value))) {
    throw Object.assign(new Error(`当前空间积分读取失败，暂不能${action}，请重试或联系空间所有者。`),
      { code: 'creation-studio/points-unavailable', status: 503 })
  }
  if (Number(value) <= 0) {
    throw Object.assign(new Error(`当前空间积分不足，请先充值后${action}。`),
      { code: 'creation-studio/insufficient-points', status: 402 })
  }
}

/**
 * Read current points before one already-authorized paid operation; never cache or write the balance.
 * @param auth - The initiating caller's authenticated platform service.
 * @param spaceId - Previously authorized team-space record ID.
 * @param signal - Cancellation for this read, or a bounded read timeout when absent.
 */
export async function assertSpacePoints(auth, spaceId, signal = AbortSignal.timeout(30_000)) {
  const failure = () => Object.assign(new Error('当前空间积分读取失败，暂不能继续使用，请重试或联系空间所有者。'),
    { code: 'creation-studio/points-unavailable', status: 503 })
  if (!id(spaceId)) throw failure()
  const scope = await auth.currentScopeKey()
  if (!scope) throw failure()
  let space
  try {
    space = await auth.requestAuthenticated({ path: '/api/visualdev/form/info', method: 'POST',
      body: { menuId: SPACE, _id: spaceId } }, signal)
  } catch (cause) {
    throw Object.assign(failure(), { cause })
  }
  if (scope !== await auth.currentScopeKey() || space?._id !== spaceId || space.status === 'inactive') throw failure()
  positivePoints(space.points, '继续使用')
}

/**
 * Check verified Creation Studio bindings before each actual model stream, including retries.
 * @param ctx - Loader-owned model middleware registration.
 * @param billing - Owner of authenticated, persisted Session-to-space bindings.
 */
export function registerModelPointsGuard(ctx, billing) {
  ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId ? ctx.get('agents')?.get(options.sessionId) : undefined
    try {
      if (agent) await billing.checkPoints(agent.session, options.signal)
    } catch (cause) {
      const error = typeof cause?.code === 'string' && cause.code.startsWith('creation-studio/') ? cause
        : { code: 'creation-studio/points-unavailable', message: '当前空间积分读取失败，暂不能继续使用，请重试或联系空间所有者。' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code, message: error.message } } }
      return
    }
    yield* next()
  })
}

/**
 * Register a fresh space-points check on every project-create tool execution.
 * @param ctx - Host tool middleware registration owner.
 * @param config - Creation Studio platform origin and tenant.
 * @param auth - Current caller's JDCloud authenticated request service.
 */
export function registerProjectPointsGuard(ctx, config, auth) {
  async function check(spaceId, signal) {
    if (!id(spaceId)) throw unavailable()
    const scope = await auth.currentScopeKey()
    const status = await auth.status()
    if (!scope || !status.authenticated || status.corpId !== config.tenantId
      || status.baseUrl.replace(/\/$/u, '') !== config.platformURL.replace(/\/$/u, '')) throw unavailable()
    const call = (path, body) => auth.requestAuthenticated({
      path, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }),
    }, signal)
    const [current, space] = await Promise.all([
      call('/api/oauth/currentUser'),
      call('/api/visualdev/form/info', { menuId: SPACE, _id: spaceId }),
    ])
    if (!current?.userInfo?.id || current.userInfo.corpId !== config.tenantId
      || space?._id !== spaceId || space.status === 'inactive') throw unavailable()
    if (space.ownerUserId !== current.userInfo.id) {
      const members = await call('/api/visualdev/form/list', { menuId: MEMBER, currentPage: 1, pageSize: 200,
        association: false, userInfoConvert: false, connect: 'and',
        filter: ['spaceId', 'userId'].map(enCode => ({ enCode, method: 'eq', type: 'custom', value: enCode === 'spaceId' ? spaceId : current.userInfo.id })) })
      if (!members?.list?.some(member => member.spaceId === spaceId && member.userId === current.userInfo.id
        && member.status === 'active' && ['admin', 'editor'].includes(member.role))) throw unavailable()
    }
    if (scope !== await auth.currentScopeKey()) throw unavailable()
    positivePoints(space.points, '再新建项目')
  }
  // 执行入口再次查余额，普通 Harness 对话、PTC 子调用和前端灵感创建均不能跳过。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.name !== 'jdcloud_lowcode_create' || exec.arguments?.menu_id !== PROJECT) return decision
    try {
      await check(exec.arguments.data?.spaceId, exec.signal)
      return decision
    }
    catch (cause) {
      const error = typeof cause?.code === 'string' && cause.code.startsWith('creation-studio/') ? cause : unavailable()
      return { kind: 'deny', reason: error.message, info: { name: 'ProjectPointsError', code: error.code } }
    }
  })
}
