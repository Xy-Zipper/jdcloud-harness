/** 单旁白默认一个说话人；明确的逐行角色标签保留多人对白，不把字幕当成旁白。 */
export function scriptSpeech(shot) {
    const text = shot.detail?.narration.trim() ?? '';
    if (!text)
        return [];
    const lines = text.split('\n').filter(line => line.trim());
    const labelled = lines.map(line => /^([^：:\n]{1,24})[：:]\s*(.+)$/u.exec(line));
    return labelled.every(Boolean)
        ? labelled.map(match => ({ speakerId: match[1].trim(), speakerName: match[1].trim(), text: match[2].trim(), voiceId: '' }))
        : [{ speakerId: 'narrator', speakerName: '旁白', text, voiceId: '' }];
}
/** 只有内容与当前脚本一致的说话人设置才能继续使用；改过的台词重新选择音色。 */
export function narrationForShot(shot, speech) {
    const expected = scriptSpeech(shot);
    if (!speech?.length)
        return expected;
    const normalize = (text) => text.replace(/\s/gu, '');
    return normalize(speech.map(line => line.text).join('')) === normalize(expected.map(line => line.text).join(''))
        ? speech
        : expected;
}
/** 解析扩展时校验真实音色 ID，普通补充文字及旧 JSON 不作解释。 */
export function decodeStoryboardSupplement(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return { supplement: raw };
    }
    if (value?.schemaVersion !== 'storyboard-speech-1')
        return { supplement: raw };
    if (typeof value.supplement !== 'string' || !isSpeechLines(value.speech))
        throw new Error('分镜旁白设置无效，请重新载入并选择音色。');
    return { supplement: value.supplement, speech: value.speech };
}
/** 未配置旁白时保持旧摘要；音色与台词有变化时分镜及下游确认自然失效。 */
export function encodeStoryboardSupplement(supplement, speech) {
    return speech?.length ? JSON.stringify({ schemaVersion: 'storyboard-speech-1', supplement, speech }) : supplement;
}
/** Agent 与持久记录共用的旁白字段校验。 */
export function isSpeechLines(value) {
    return Array.isArray(value) && value.length <= 30 && value.every(line => line && typeof line === 'object'
        && ['speakerId', 'speakerName', 'text'].every(key => typeof line[key] === 'string' && line[key].trim())
        && typeof line.voiceId === 'string' && (line.voiceId === '' || /^[a-f0-9]{24}$/iu.test(line.voiceId)));
}
