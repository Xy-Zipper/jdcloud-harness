/** Allowed explicit Seedream sizes retain three released dimensions for task recovery. */
export const IMAGE_SIZES = ['1024x1024', '1536x1536', '2048x2048', '864x1152', '1344x1792', '1776x2368', '1536x864', '2048x1152', '2816x1584', '1152x864', '1792x1344', '2368x1776', '864x1536', '1152x2048', '1584x2816', '1024x1536', '1248x1872', '1664x2496', '1536x1024', '1872x1248', '2496x1664', '1792x768', '2352x1008', '3136x1344']
export function imageGenerationSource(description) {
    try {
        const value = typeof description === 'string' ? JSON.parse(description) : description;
        const source = value?.generatedImage;
        return source && typeof source === 'object' && typeof source.requestId === 'string' ? source : undefined;
    }
    catch {
        return undefined;
    }
}
/** 没有有效确认记录的生成素材始终待确认，不能靠默认“自有”放行。 */
export function generatedImagePending(sourceKind, description) {
    const at = imageGenerationSource(description)?.confirmedAt;
    return sourceKind === 'generated' && !(typeof at === 'string' && Number.isFinite(Date.parse(at)));
}
/** Agent 请求只接受平台引用；不接受任意 URL、路径、Base64 或额外参数。 */
export function isImageGenerationRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const request = value;
    return typeof request.prompt === 'string' && Boolean(request.prompt.trim()) && request.prompt.length <= 32000
        && Array.isArray(request.referenceIds) && request.referenceIds.length <= 10
        && new Set(request.referenceIds).size === request.referenceIds.length
        && request.referenceIds.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/iu.test(id))
        && IMAGE_SIZES.includes(String(request.size))
        && (request.model === undefined || ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'].includes(request.model))
        && Object.keys(request).every(key => ['prompt', 'referenceIds', 'size', 'model'].includes(key));
}
