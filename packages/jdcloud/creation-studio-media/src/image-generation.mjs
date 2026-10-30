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
        && Array.isArray(request.referenceIds) && request.referenceIds.length <= 16
        && new Set(request.referenceIds).size === request.referenceIds.length
        && request.referenceIds.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/iu.test(id))
        && ['1024x1024', '1024x1536', '1536x1024'].includes(String(request.size))
        && Object.keys(request).every(key => ['prompt', 'referenceIds', 'size'].includes(key));
}
