/** Seedance 2.5 全能参考的浏览器／服务端共同契约，无密钥和运行环境依赖。 */
export const SEEDANCE_MODEL = 'doubao-seedance-2-5-260628';
export const SEEDANCE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
export const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p'];
export function defaultGenerationConfig() {
    return { ratio: '16:9', resolution: '720p', generateAudio: false, watermark: false, references: [] };
}
export function isGenerationConfig(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.ratio === 'string' && typeof v.resolution === 'string' && typeof v.generateAudio === 'boolean'
        && typeof v.watermark === 'boolean' && Array.isArray(v.references) && v.references.every(ref => ref
        && typeof ref.relationId === 'string' && typeof ref.name === 'string' && typeof ref.purpose === 'string')
        && (v.audioReferences === undefined || Array.isArray(v.audioReferences) && v.audioReferences.every(ref => ref
            && typeof ref.voiceId === 'string' && typeof ref.name === 'string'
            && Array.isArray(ref.speakerIds) && ref.speakerIds.every(id => typeof id === 'string')
            && Array.isArray(ref.speakerNames) && ref.speakerNames.every(name => typeof name === 'string')));
}
/** 草稿允许缺图；提交生成时必须校验完整，编号只能引用实际提交的图片。 */
export function seedanceIssues(config, prompt, duration) {
    const issues = [];
    if (!SEEDANCE_RATIOS.includes(config.ratio) || !SEEDANCE_RESOLUTIONS.includes(config.resolution))
        issues.push('请选择 Seedance 2.5 支持的画幅与分辨率。');
    if (!Number.isSafeInteger(duration) || duration < 4 || duration > 30)
        issues.push('生成时长须为 4–30 秒的整数。');
    if (!prompt.trim())
        issues.push('请填写本批次提示词。');
    if (!config.references.length || config.references.length > 30)
        issues.push('全能参考每批需要 1–30 张图片。');
    const ids = new Set();
    config.references.forEach((ref, i) => {
        if (!/^[a-f0-9]{24}$/iu.test(ref.relationId))
            issues.push(`图片${i + 1}尚未上传到当前项目。`);
        if (ids.has(ref.relationId))
            issues.push(`图片${i + 1}重复，请保留一份并在用途里说明。`);
        ids.add(ref.relationId);
        if (!ref.purpose.trim())
            issues.push(`请填写图片${i + 1}的用途或对应镜头。`);
    });
    const authoredText = [prompt, ...config.references.map(reference => reference.purpose)].join('\n');
    for (const match of authoredText.matchAll(/@(?:图片|图像|image)\s*(\d+)/giu)) {
        if (Number(match[1]) < 1 || Number(match[1]) > config.references.length)
            issues.push(`提示词中的图片${match[1]}没有对应参考图。`);
    }
    if (/@(?:图片|图像|image)\[已移除\]/iu.test(authoredText))
        issues.push('提示词包含已移除的参考图，请替换对应图片说明后再生成。');
    const audio = config.audioReferences ?? [];
    if (audio.length > 10 || new Set(audio.map(ref => ref.voiceId)).size !== audio.length
        || audio.some(ref => !/^[a-f0-9]{24}$/iu.test(ref.voiceId) || !ref.speakerIds.length || !ref.speakerNames.length))
        issues.push('旁白参考音频须为最多10个不重复的真实音色。');
    if (audio.length && !config.generateAudio)
        issues.push('已选择旁白音色，请开启生成音频。');
    for (const match of prompt.matchAll(/@音频\s*(\d+)/gu)) {
        if (Number(match[1]) < 1 || Number(match[1]) > audio.length)
            issues.push(`提示词中的音频${match[1]}没有对应音色。`);
    }
    return issues;
}
/** 删除后重排仍存在图片的编号；被删除图片保留醒目标记并阻止生成，不能悄悄指向另一张图。 */
export function promptAfterReferenceRemoval(prompt, removedIndex) {
    return prompt.replace(/@(?:图片|图像|image)\s*(\d+)/giu, (mention, index) => Number(index) === removedIndex + 1
        ? '@图片[已移除]' : Number(index) > removedIndex + 1 ? `@图片${Number(index) - 1}` : mention);
}
/** 用途声明与图片顺序由同一数组生成，移除图片后不默默重写用户正文，悬空编号会阻止提交。 */
export function buildSeedanceRequest(config, prompt, duration, urls, audioUrls = []) {
    const issues = seedanceIssues(config, prompt, duration);
    if (issues.length || urls.length !== config.references.length || audioUrls.length !== (config.audioReferences?.length ?? 0))
        throw new Error(issues[0] || '参考媒体数量与提交内容不一致。');
    const voiceText = config.audioReferences?.length
        ? `\n\n旁白音色（仅参考音色，不朗读样音中的示例台词）：\n${config.audioReferences.map((ref, i) => `@音频${i + 1}：${ref.speakerNames.join('、')}使用${ref.name}的音色，按每镜指定台词和时间朗读。`).join('\n')}` : '';
    const text = `${prompt.trim()}\n\n参考图片用途（编号严格对应本次提交顺序）：\n${config.references.map((ref, i) => `@图片${i + 1}：${ref.name}；${ref.purpose}`).join('\n')}${voiceText}`;
    return { model: SEEDANCE_MODEL, omni_reference_task_type: 'reference', output_format: 'mp4', content: [
            { type: 'text', text },
            ...urls.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
            ...audioUrls.map(url => ({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })),
        ], duration, resolution: config.resolution, ratio: config.ratio,
        generate_audio: config.generateAudio, watermark: config.watermark };
}
/** 既有批次 prompt 字段使用版本化扩展，界面仍展示纯正文，旧记录原样读取。 */
export function encodeGenerationPrompt(prompt, generation) {
    return generation ? JSON.stringify({ schemaVersion: 'seedance-2.5-1', prompt, generation }) : prompt;
}
export function decodeGenerationPrompt(raw) {
    if (!raw.trimStart().startsWith('{'))
        return { prompt: raw };
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return { prompt: raw };
    }
    if (!['seedance-2.0-1', 'seedance-2.5-1'].includes(value?.schemaVersion))
        return { prompt: raw };
    if (typeof value.prompt !== 'string' || !isGenerationConfig(value.generation))
        throw new Error('视频批次参考配置格式无效，已停止载入。');
    return { prompt: value.prompt, generation: value.generation };
}
