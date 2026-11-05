/** Private account-table authentication: password login, memory-only tokens, and one read retry after expiry. */
import { createHash } from 'node:crypto'

const failure = (message, code) => Object.assign(new Error(message), { code, status: 503 })

/**
 * Resolve a private platform reader without borrowing the current customer's credentials.
 * @param config - Fixed platform, tenant, and service credential references.
 * @param keys - Host-only secret resolver; no login settings returns an absent reader.
 * @param fetcher - Platform transport.
 * @returns A reader resolver; password login takes priority over an optional legacy token.
 */
export function createAccountPoolReader(config, keys, fetcher = fetch) {
  const base = config.platformURL.replace(/\/$/u, '')
  let session
  async function send(path, body, token) {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
      headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    let result
    try { result = await response.json() }
    catch { throw failure('账号池服务返回格式异常，请核对平台服务。', 'accounts/invalid-response') }
    if (!result || typeof result !== 'object')
      throw failure('账号池服务返回格式异常，请核对平台服务。', 'accounts/invalid-response')
    return { response, result }
  }
  async function login(state, username, password) {
    // One login owns each token refresh; concurrent reads await its result instead of kicking each other out.
    if (!state.pending) {
      state.pending = (async () => {
        const query = new URLSearchParams({ client_id: 'admin', client_secret: '123456',
          scope: 'all', grant_type: 'password', corpId: config.tenantId })
        const { response, result } = await send(`/api/oauth/login?${query}`, {
          username, password: createHash('md5').update(password).digest('hex'),
        })
        if (!response.ok || result.code !== 200 || typeof result.data?.token !== 'string' || !result.data.token.trim())
          throw failure('账号池服务账号登录失败，请核对服务端账号、密码及租户授权。', 'accounts/login-failed')
        state.token = result.data.token
        return state.token
      })().finally(() => { state.pending = undefined })
    }
    return state.pending
  }
  return async () => {
    const [usernameValue, password] = await Promise.all([
      keys(config.accountPoolUsernameRef || 'CREATION_STUDIO_ACCOUNT_POOL_USERNAME'),
      keys(config.accountPoolPasswordRef || 'CREATION_STUDIO_ACCOUNT_POOL_PASSWORD'),
    ])
    const username = usernameValue?.trim()
    if (Boolean(username) !== Boolean(password))
      throw failure('账号池服务账号与密码必须同时配置。', 'accounts/login-incomplete')
    let state, token
    if (username) {
      const identity = createHash('sha256').update(JSON.stringify([username, password])).digest('hex')
      if (session?.identity !== identity) session = { identity, token: '' }
      state = session
      token = state.token || await login(state, username, password)
    }
    else {
      token = await keys(config.accountPoolKeyRef || 'CREATION_STUDIO_ACCOUNT_POOL_TOKEN')
      if (!token) return undefined
    }
    return async (path, body) => {
      let usedToken = state?.token || token
      let value = await send(path, body, usedToken)
      if (state && (value.response.status === 401 || [600, 601, 602].includes(value.result.code))) {
        if (state.token === usedToken) state.token = ''
        usedToken = state.token || await login(state, username, password)
        // Retry only this read. Provider submissions and other writes never pass through this reader.
        value = await send(path, body, usedToken)
      }
      if (!value.response.ok || value.result.code !== 200) {
        if (state && (value.response.status === 401 || [600, 601, 602].includes(value.result.code)) && state.token === usedToken)
          state.token = ''
        throw failure('账号池读取失败，请核对服务账号的登录状态和专用表权限。', 'accounts/read-failed')
      }
      return value.result.data
    }
  }
}
