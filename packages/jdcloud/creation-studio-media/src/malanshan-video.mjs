/** Malanshan's Seedance 2.5 gateway exposes Ark-style task results under its own routes. */
const endpoint = 'https://maas.mlsvcloud.com:8559/maas/ai/aiFactoryServer/v1/apis/1/seedance-2-5FromBot:1.1/ark/api/v3/contents/generations'
const model = 'doubao-seedance-2-5-bot-THD'
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const rejectionCodes = /^(?:InvalidParameter|MissingParameter|AuthenticationError|AccessDenied|Forbidden|Input(?:Text|Image|Video|Audio)(?:SensitiveContentDetected|RiskDetection))(?:\.|$)/u
const safeMessage = (value, apiKey) => typeof value === 'string'
  ? value.replaceAll(apiKey, '[已隐藏]').replace(/https?:\/\/[^\s"'<>]+/giu, '[链接]').replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [已隐藏]').replace(/\s+/gu, ' ').trim().slice(0, 500)
  : undefined

/**
 * Read the Ark-style receipt and the gateway's numeric business status.
 * @param payload - Parsed JSON response.
 * @param apiKey - Active credential to redact from provider messages.
 * @returns Validated task identity and safe failure details.
 */
export function decodeMalanshanVideoResponse(payload, apiKey) {
  const code = payload?.code
  const gatewayCode = (typeof code === 'number' || typeof code === 'string') && /^\d{1,8}$/u.test(String(code)) ? Number(code) : undefined
  const gatewayOK = gatewayCode === 0 || gatewayCode === 200
  const data = gatewayCode !== undefined && record(payload.data) ? payload.data : payload
  const id = typeof data?.id === 'string' ? data.id.trim() : ''
  const taskId = (code === undefined || gatewayOK) && /^[a-z0-9][a-z0-9_-]{0,199}$/iu.test(id) ? id : undefined
  const rawError = data?.error ?? payload?.error
  let error
  if (typeof rawError?.code === 'string' && rawError.code !== apiKey && /^[a-z0-9_.-]{1,96}$/iu.test(rawError.code)) {
    const param = typeof rawError.param === 'string' ? /content\[\d+\]/u.exec(rawError.param)?.[0] : undefined
    error = { code: rawError.code, message: safeMessage(rawError.message, apiKey), param }
  }
  if (gatewayCode === 16067)
    error = { code: 'video/malanshan-signature-mismatch', message: '马栏山网关签名校验未通过，请核对账号密钥及接口授权。' }
  return {
    data,
    taskId,
    error,
    gatewayCode,
    gatewayMessage: gatewayCode !== undefined && !gatewayOK && !error?.message
      ? safeMessage(payload.msg ?? payload.message, apiKey) : undefined,
    rejected: gatewayCode === 16067 || Boolean(error && rejectionCodes.test(error.code)),
  }
}

/**
 * Forward text, reference images, and reference audio with the gateway's model ID.
 * @param request - Prepared Seedance 2.5 request.
 * @param apiKey - Credential from the Malanshan account pool.
 * @param transport - Host provider transport.
 * @returns The provider's submission response.
 */
export function submitMalanshanVideo(request, apiKey, transport) {
  const { content, duration, resolution, ratio, output_format, generate_audio } = request
  return transport(`${endpoint}/tasks`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, content, duration, resolution, ratio, output_format, generate_audio }),
    signal: AbortSignal.timeout(90_000),
  })
}

/**
 * Query the original Malanshan task with its reserved account.
 * @param id - The opaque task ID returned by the gateway.
 * @param apiKey - Credential from the original Malanshan account.
 * @param transport - Host provider transport.
 * @returns The provider's task response.
 */
export function queryMalanshanVideo(id, apiKey, transport) {
  return transport(`${endpoint}/tasksGet/${encodeURIComponent(id)}`, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  })
}
