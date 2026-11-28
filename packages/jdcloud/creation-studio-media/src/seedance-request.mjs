/** Seedance 全模态参考的浏览器／服务端共同契约，无密钥和运行环境依赖。 */
export const SEEDANCE_MODEL = 'doubao-seedance-2-5-260628';
const seedance20Limits = { maxSeconds: 15, maxImages: 9, maxVideos: 3, maxAudio: 3, maxReferenceAssets: 15, maxVideoPixels: 3326 * 2494 };
/** 按官方能力限制每批参数；2.0 系列不沿用 2.5 的时长和参考素材上限。 */
export const SEEDANCE_MODELS = [
    { label: 'Doubao-Seedance-2.5', value: SEEDANCE_MODEL, resolutions: ['480p', '720p', '1080p'], maxSeconds: 30, maxImages: 30, maxVideos: 10, maxVideoPixels: 4096 * 2160, maxAudio: 10, maxReferenceAssets: 50 },
    { label: 'Doubao-Seedance-2.0', value: 'doubao-seedance-2-0-260128', resolutions: ['480p', '720p', '1080p', '4k'], ...seedance20Limits },
    { label: 'Doubao-Seedance-2.0-fast', value: 'doubao-seedance-2-0-fast-260128', resolutions: ['480p', '720p'], ...seedance20Limits },
    { label: 'Doubao-Seedance-2.0-mini', value: 'doubao-seedance-2-0-mini-260615', resolutions: ['480p', '720p'], ...seedance20Limits },
];
/** 缺少模型的历史草稿沿用原默认值；未知模型不自动替换为其他付费模型。 */
export function seedanceModel(value = SEEDANCE_MODEL) {
    const model = SEEDANCE_MODELS.find(model => model.value === value);
    if (!model)
        throw new Error('请选择已支持的视频模型。');
    return model;
}
export const SEEDANCE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
export const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p', '4k'];
export const MAX_REFERENCE_VIDEO_BYTES = 200_000_000;
export const REFERENCE_VIDEO_FORMATS = ['video/mp4', 'video/quicktime'];
export const MAX_REFERENCE_AUDIO_BYTES = 15_000_000;
export const REFERENCE_AUDIO_FORMATS = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'];
export const MIN_REFERENCE_AUDIO_SECONDS = 2;
export const MAX_REFERENCE_AUDIO_SECONDS = seedanceModel().maxSeconds;
const audioDurationTolerance = 1e-9;

/** Report the model selection or trim needed for a batch of reference audio. */
export function referenceAudioDurationIssue(seconds, model) {
    if (seconds > MAX_REFERENCE_AUDIO_SECONDS + audioDurationTolerance)
        return `本批参考音频超过 ${MAX_REFERENCE_AUDIO_SECONDS} 秒，请裁剪音频或减少参考素材。`;
    if (seconds > model.maxSeconds + audioDurationTolerance)
        return `本批参考音频超过 ${model.maxSeconds} 秒，请选择 Seedance 2.5。`;
    return '';
}
const isReference = ref => ref && typeof ref.relationId === 'string' && typeof ref.name === 'string' && typeof ref.purpose === 'string';
const isClipReference = ref => isReference(ref) && Number.isFinite(ref.durationSeconds) && ref.durationSeconds > 0;
const isAudioClipReference = ref => ref && typeof ref === 'object' && ('voiceId' in ref
    ? !('relationId' in ref) && typeof ref.voiceId === 'string' && typeof ref.name === 'string' && typeof ref.purpose === 'string'
        && Number.isFinite(ref.durationSeconds) && ref.durationSeconds > 0
    : isClipReference(ref));
const audioClipKey = ref => 'voiceId' in ref ? `system:${ref.voiceId}` : `clip:${ref.relationId}`;

/**
 * Match a video receipt to the saved per-speaker overrides.
 * @param config - The saved video generation settings.
 * @returns The ordered speaker and sample identities, or undefined for inherited voices.
 */
export function batchVoiceSelection(config) {
    const bindings = config.audioReferences?.flatMap(ref =>
        (ref.overrideSpeakerIds ?? []).map(speakerId => [speakerId, audioClipKey(ref)]));
    return bindings?.length ? JSON.stringify(bindings.sort()) : undefined;
}

/**
 * Resolve a batch override or the confirmed storyboard default for a spoken line.
 * @param references - The batch's numbered audio references.
 * @param line - The confirmed line and its speaker and default voice IDs.
 * @returns The zero-based sample index, or -1 if the speaker has no sample.
 */
export function narrationAudioIndex(references, line) {
    const override = references.findIndex(ref => ref.overrideSpeakerIds?.includes(line.speakerId));
    return override >= 0 ? override : references.findIndex(ref =>
        ref.speakerIds.includes(line.speakerId) && ('voiceId' in ref
            ? ref.voiceId === line.voiceId : ref.relationId === line.projectVoice?.relationId));
}

function isVideoAudioReference(ref) {
    if (!ref || typeof ref !== 'object' || typeof ref.name !== 'string'
        || !Array.isArray(ref.speakerIds) || !ref.speakerIds.every(id => typeof id === 'string')
        || !Array.isArray(ref.speakerNames) || !ref.speakerNames.every(name => typeof name === 'string'))
        return false;
    const overrides = ref.overrideSpeakerIds;
    if (overrides !== undefined && (!Array.isArray(overrides) || !overrides.length
        || new Set(overrides).size !== overrides.length || !overrides.every(id => ref.speakerIds.includes(id))))
        return false;
    if ('voiceId' in ref)
        return !('relationId' in ref) && typeof ref.voiceId === 'string'
            && (ref.durationSeconds === undefined || Number.isFinite(ref.durationSeconds) && ref.durationSeconds >= MIN_REFERENCE_AUDIO_SECONDS);
    return typeof ref.relationId === 'string' && /^[a-f0-9]{24}$/iu.test(ref.relationId)
        && Boolean(ref.name.trim()) && Number.isFinite(ref.durationSeconds)
        && ref.durationSeconds >= MIN_REFERENCE_AUDIO_SECONDS && ref.durationSeconds <= MAX_REFERENCE_AUDIO_SECONDS;
}
export function defaultGenerationConfig() {
    return { model: SEEDANCE_MODEL, ratio: '16:9', resolution: '720p', generateAudio: false, watermark: false, references: [] };
}
export function isGenerationConfig(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return (v.model === undefined || SEEDANCE_MODELS.some(model => model.value === v.model))
        && typeof v.ratio === 'string' && typeof v.resolution === 'string' && typeof v.generateAudio === 'boolean'
        && typeof v.watermark === 'boolean' && Array.isArray(v.references) && v.references.every(isReference)
        && (v.videoReferences === undefined || Array.isArray(v.videoReferences) && v.videoReferences.every(isClipReference))
        && (v.audioClips === undefined || Array.isArray(v.audioClips) && v.audioClips.every(isAudioClipReference))
        && (v.trimVoiceSamples === undefined || typeof v.trimVoiceSamples === 'boolean')
        && (v.narrationSource === undefined || (v.narrationSource && typeof v.narrationSource === 'object'
            && !Array.isArray(v.narrationSource) && Object.values(v.narrationSource).every(hash => typeof hash === 'string' && /^[a-f0-9]{8}$/u.test(hash))))
        && (v.audioReferences === undefined || Array.isArray(v.audioReferences) && v.audioReferences.every(isVideoAudioReference));
}
/** 按各自顺序校验实际提交的图片、视频和音色。 */
export function seedanceIssues(config, prompt, duration) {
    const issues = [];
    const model = SEEDANCE_MODELS.find(model => model.value === (config.model ?? SEEDANCE_MODEL));
    if (!model)
        return ['请选择已支持的视频模型。'];
    if (!SEEDANCE_RATIOS.includes(config.ratio) || !model.resolutions.includes(config.resolution))
        issues.push(`请选择 ${model.label} 支持的画幅与分辨率。`);
    if (!Number.isSafeInteger(duration) || duration < 4 || duration > model.maxSeconds)
        issues.push(`生成时长须为 4–${model.maxSeconds} 秒的整数，请拆分批次或选择支持更长时长的模型。`);
    if (!prompt.trim())
        issues.push('请填写本批次提示词。');
    const videos = config.videoReferences ?? [];
    const clips = config.audioClips ?? [];
    const voices = config.audioReferences ?? [];
    const audioCount = voices.length + clips.length;
    const total = config.references.length + videos.length + audioCount;
    if (total > model.maxReferenceAssets)
        issues.push(`本批参考素材合计 ${total} 个，超过 ${model.label} 的 ${model.maxReferenceAssets} 个上限。请移除多余素材或拆分批次。`);
    if (!config.references.length && !videos.length && (!audioCount || model.value !== SEEDANCE_MODEL)) {
        issues.push(audioCount
            ? 'Seedance 2.0 系列使用参考音频时，请同时添加图片或视频。'
            : '请为本批添加至少一张参考图或一段参考视频。');
    }
    if (config.references.length > model.maxImages)
        issues.push(`${model.label} 全模态参考每批最多支持 ${model.maxImages} 张图片，请调整批次或选择其他模型。`);
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
    if (videos.length > model.maxVideos)
        issues.push(`当前模型每批最多支持 ${model.maxVideos} 段参考视频。`);
    if (videos.some(ref => !Number.isFinite(ref.durationSeconds) || ref.durationSeconds < 2 || ref.durationSeconds > model.maxSeconds)
        || videos.reduce((sum, ref) => sum + ref.durationSeconds, 0) > model.maxSeconds)
        issues.push(`每段参考视频至少 2 秒，总时长最多 ${model.maxSeconds} 秒。`);
    videos.forEach((ref, i) => {
        if (!/^[a-f0-9]{24}$/iu.test(ref.relationId) || ids.has(ref.relationId) || !ref.purpose.trim())
            issues.push(`参考视频${i + 1}的项目引用重复、无效或缺少用途。`);
        ids.add(ref.relationId);
    });
    const audioKeys = new Set(voices.map(audioClipKey));
    clips.forEach((ref, i) => {
        const duplicate = audioKeys.has(audioClipKey(ref));
        if ('voiceId' in ref) {
            const number = voices.length + i + 1;
            if (!/^[a-f0-9]{24}$/iu.test(ref.voiceId) || !ref.purpose.trim())
                issues.push(`@音频${number} 的系统音频无效或缺少用途。`);
            else if (duplicate)
                issues.push(`@音频${number} 的系统音频已在本批使用，请移除这一段并引用已有编号。`);
            audioKeys.add(audioClipKey(ref));
            return;
        }
        if (!/^[a-f0-9]{24}$/iu.test(ref.relationId) || ids.has(ref.relationId) || duplicate || !ref.purpose.trim())
            issues.push(`第 ${i + 1} 段项目音频的引用重复、无效或缺少用途。`);
        ids.add(ref.relationId);
    });
    const authoredText = [prompt, ...[...config.references, ...videos, ...clips].map(ref => ref.purpose)].join('\n');
    for (const match of authoredText.matchAll(/@(?:图片|图像|image)\s*(\d+)/giu)) {
        if (Number(match[1]) < 1 || Number(match[1]) > config.references.length)
            issues.push(`提示词中的图片${match[1]}没有对应参考图。`);
    }
    for (const match of authoredText.matchAll(/@(?:视频|video)\s*(\d+)/giu)) {
        if (Number(match[1]) < 1 || Number(match[1]) > videos.length)
            issues.push(`提示词中的视频${match[1]}没有对应参考视频。`);
    }
    if (/@(?:视频|video)\[已移除\]/iu.test(authoredText))
        issues.push('请删除或替换提示词中的 @视频[已移除] 后再生成。');
    if (/@(?:图片|图像|image)\[已移除\]/iu.test(authoredText))
        issues.push('提示词包含已移除的参考图，请替换对应图片说明后再生成。');
    if (audioCount > model.maxAudio)
        issues.push(`旁白音色和参考音频合计最多 ${model.maxAudio} 段。`);
    const overrides = voices.flatMap(ref => ref.overrideSpeakerIds ?? []);
    if (new Set(voices.map(audioClipKey)).size !== voices.length || new Set(overrides).size !== overrides.length
        || voices.some(ref => !/^[a-f0-9]{24}$/iu.test('voiceId' in ref ? ref.voiceId : ref.relationId)
            || !ref.speakerIds.length || ref.speakerNames.length !== ref.speakerIds.length || new Set(ref.speakerIds).size !== ref.speakerIds.length)) {
        issues.push('旁白音色须使用不重复的真实音色。');
    }
    if (clips.some(ref => !Number.isFinite(ref.durationSeconds) || ref.durationSeconds < MIN_REFERENCE_AUDIO_SECONDS))
        issues.push(`每段参考音频至少 ${MIN_REFERENCE_AUDIO_SECONDS} 秒。`);
    const audioIssue = referenceAudioDurationIssue(clips.reduce((sum, ref) => sum + ref.durationSeconds, 0), model);
    if (audioIssue) issues.push(audioIssue);
    if (audioCount && !config.generateAudio)
        issues.push(clips.length ? '已添加参考音频，请开启生成音频。' : '已选择旁白音色，请开启生成音频。');
    for (const match of authoredText.matchAll(/@(?:音频|audio)\s*(\d+)/giu)) {
        if (Number(match[1]) < 1 || Number(match[1]) > audioCount)
            issues.push(`提示词中的音频${match[1]}没有对应参考音频。`);
    }
    if (/@(?:音频|audio)\[已移除\]/iu.test(authoredText))
        issues.push('请删除或替换提示词中的 @音频[已移除] 后再生成。');
    return issues;
}
/** 删除后重排仍存在图片的编号；被删除图片保留醒目标记并阻止生成，不能悄悄指向另一张图。 */
export function promptAfterReferenceRemoval(prompt, removedIndex) {
    return prompt.replace(/@(?:图片|图像|image)\s*(\d+)/giu, (mention, index) => Number(index) === removedIndex + 1
        ? '@图片[已移除]'
        : Number(index) > removedIndex + 1 ? `@图片${Number(index) - 1}` : mention);
}
/** Scene source notes are project metadata. Preserve numbered references, captions, and dialogue. */
function cleanVideoSceneNotes(prompt) {
    return prompt.replace(/\{[^{}]*\}|〖[^〖〗]*〗|^场景[：:][^\r\n]*/gmu, (line) => {
        if (!line.startsWith('场景'))
            return line;
        return line
            .replace(/[（(](?:素材|图片|视频|音频|文件)(?:[ \t]*ID)?[：: \t]+[\da-f]{8}[\da-f-]{0,56}(?=[，,；; \t）)])[^\r\n）)]*[）)]/giu, note =>
                Array.from(note.matchAll(/@(?:图片|图像|image|视频|video|音频|audio)[ \t]*\d+/giu), mention => `（${mention[0]}）`).join(''))
            .replace(/[；;][ \t]*[^，,；;。@]{0,24}由项目内[ \t]*Seedream\b[^；;。@]*?(?:生成|合成)[^；;。@]*?(?=[（(]?@(?:图片|图像|image)|[；;。]|$)/giu, '');
    });
}

/** 用途声明与图片顺序由同一数组生成，悬空编号会阻止提交。 */
export function buildSeedanceRequest(config, prompt, duration, urls, audioUrls = [], videoUrls = []) {
    const issues = seedanceIssues(config, prompt, duration);
    if (issues.length || urls.length !== config.references.length || audioUrls.length !== (config.audioReferences?.length ?? 0) + (config.audioClips?.length ?? 0)
        || videoUrls.length !== (config.videoReferences?.length ?? 0))
        throw new Error(issues[0] || '参考媒体数量与提交内容不一致。');
    const voiceText = config.audioReferences?.length
        ? `\n\n旁白音色（仅参考音色，不朗读样音中的示例台词）：\n${config.audioReferences.map((ref, i) => 'relationId' in ref || ref.overrideSpeakerIds?.length
            ? `@音频${i + 1}：${ref.speakerNames.join('、')}使用此样音的音色，按逐镜台词朗读。`
            : `@音频${i + 1}：参考${ref.name}的音色，按逐镜提示朗读。`).join('\n')}`
        : '';
    const fileLabel = /\.(?:jpe?g|png|webp|gif|bmp|tiff?|heic|heif|mp4|mov|mp3|wav)$|^[\da-f]{8}[\da-f-]{0,56}$/iu;
    const uses = (label, references, offset = 0) => references.length
        ? `\n\n参考${label}用途（编号严格对应本次提交顺序）：\n${references.map((ref, i) => {
            const name = ref.name.trim();
            return `@${label}${offset + i + 1}：${name && !fileLabel.test(name) ? `${name}；` : ''}${ref.purpose}`;
        }).join('\n')}`
        : '';
    const text = `${cleanVideoSceneNotes(prompt).trim()}${uses('图片', config.references)}${uses('视频', config.videoReferences ?? [])}${voiceText}${uses('音频', config.audioClips ?? [], config.audioReferences?.length ?? 0)}`;
    const model = seedanceModel(config.model);
    // 任务类型引导和输出格式参数仅适用于 2.5，2.0 系列使用其默认 MP4 输出。
    return { model: model.value, ...(model.value === SEEDANCE_MODEL ? { omni_reference_task_type: 'reference', output_format: 'mp4' } : {}), content: [
            { type: 'text', text },
            ...urls.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
            ...videoUrls.map(url => ({ type: 'video_url', video_url: { url }, role: 'reference_video' })),
            ...audioUrls.map(url => ({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })),
        ], duration, resolution: config.resolution, ratio: config.ratio, generate_audio: config.generateAudio, watermark: config.watermark };
}
const modelConfigVersions = ['seedance-models-1', 'seedance-video-references-1', 'seedance-audio-references-1'];
const batchVoiceVersion = 'seedance-voice-overrides-1';
const usesBatchVoiceFormat = generation => generation.audioReferences?.some(ref => 'relationId' in ref || ref.overrideSpeakerIds?.length) ?? false;
/** 既有批次 prompt 字段使用版本化扩展，界面仍展示纯正文，旧记录原样读取。 */
export function encodeGenerationPrompt(prompt, generation) {
    if (!generation)
        return prompt;
    const schemaVersion = usesBatchVoiceFormat(generation) ? batchVoiceVersion : generation.audioClips?.length
        ? 'seedance-audio-references-1'
        : generation.videoReferences?.length ? 'seedance-video-references-1' : 'seedance-models-1';
    return JSON.stringify({ schemaVersion, prompt, generation: { ...generation, model: generation.model ?? SEEDANCE_MODEL } });
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
    const batchVoices = value?.schemaVersion === batchVoiceVersion;
    if (!batchVoices && ![...modelConfigVersions, 'seedance-2.0-1', 'seedance-2.5-1'].includes(value?.schemaVersion))
        return { prompt: raw };
    if (typeof value.prompt !== 'string' || !isGenerationConfig(value.generation)
        || ((batchVoices || modelConfigVersions.includes(value.schemaVersion)) && !value.generation.model)
        || batchVoices !== usesBatchVoiceFormat(value.generation)
        || (!batchVoices && ((value.schemaVersion === 'seedance-audio-references-1') !== !!value.generation.audioClips?.length
            || (value.schemaVersion !== 'seedance-audio-references-1'
                && (value.schemaVersion === 'seedance-video-references-1') !== !!value.generation.videoReferences?.length))))
        throw new Error('视频批次参考配置格式无效，已停止载入。');
    return { prompt: value.prompt, generation: value.generation };
}
