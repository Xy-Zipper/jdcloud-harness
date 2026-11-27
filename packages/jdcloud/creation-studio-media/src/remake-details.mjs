/** Interpret saved remake settings used by Seedance video generation. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, limit) => typeof value === 'string' && value.length <= limit

/**
 * Validate saved remake details and derive the effective generation inputs.
 * @param remake - Saved source timing and editable details.
 * @param shots - Measured cuts on the original timeline.
 * @returns Normalized dialogue, music, and task identity fields.
 */
export function readRemakeDetails(remake, shots) {
  const { shotNotes = {}, dialogue = [], bgm } = remake
  if (!record(shotNotes) || Object.entries(shotNotes).some(([key, note]) => !/^[1-9]\d*$/u.test(key)
    || Number(key) > shots.length || !text(note, 300))) throw new Error('请检查逐镜画面描述。')
  if (!Array.isArray(dialogue) || dialogue.length > 120 || dialogue.some(line => !record(line)
    || !Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < 0
    || line.start >= line.end || line.end > remake.duration || !text(line.original, 500)
    || line.shotNumber !== undefined && (!Number.isInteger(line.shotNumber) || line.shotNumber < 1 || line.shotNumber > shots.length
      || line.start < (line.shotNumber === 1 ? 0 : shots[line.shotNumber - 1].start)
      || line.end > (shots[line.shotNumber]?.start ?? remake.duration))
    || line.speaker !== undefined && !text(line.speaker, 80)
    || line.replacement !== undefined && !text(line.replacement, 300))) throw new Error('请检查对白内容和起止时间。')
  if (bgm !== undefined && (!record(bgm) || (bgm.mode !== 'generate' && (bgm.mode !== 'upload'
    || typeof bgm.relationId !== 'string' || !/^[a-f0-9]{24}$/iu.test(bgm.relationId)
    || !Number.isFinite(bgm.start) || !Number.isFinite(bgm.end) || bgm.start < 0
    || bgm.end - bgm.start < 0.049)))) throw new Error('请上传背景音乐并选择有效剪辑片段。')
  const notes = remake.storyboardGeneration
    ? Object.entries(shotNotes).map(([key, note]) => [Number(key), note.trim()]).filter(([, note]) => note) : []
  const lines = dialogue.filter(line => line.replacement?.trim())
    .map(line => [line.start, line.end, line.speaker?.trim() ?? '', line.replacement.trim(), ...(line.shotNumber ? [line.shotNumber] : [])])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  if ([...notes.map(note => note[1]), ...lines.map(line => line[3])].join('').length > 2400)
    throw new Error('请将逐镜描述和成片对白合计控制在 2400 字以内。')
  const identity = [
    ...(notes.length ? [['shot-notes', notes]] : []),
    ...(lines.length ? [['dialogue', lines]] : []),
    ...(bgm ? [['bgm', bgm.mode, ...(bgm.mode === 'upload' ? [bgm.relationId, bgm.start, bgm.end] : [])]] : []),
  ]
  return { notes, lines, bgm, identity }
}

/**
 * Format the requested visual and audio changes on the model's timeline.
 * @param details - Validated remake details.
 * @param storyboard - Whether the model receives a storyboard without the original video.
 * @param scale - Ratio of requested output time to reference time.
 * @param subjectCount - Number of submitted subject images in display order.
 * @returns Prompt suffix, including its leading separation when nonempty.
 */
export function remakeDetailsPrompt(details, storyboard, scale, subjectCount) {
  const sections = []
  if (details.notes.length)
    sections.push(`逐镜画面描述：\n${details.notes.map(([shot, note]) => `镜头 ${shot}：${note}`).join('\n')}`)
  if (!storyboard)
    sections.push('以 @视频1 的原声为基准。保留未指定修改的对白、发言时机、语气、环境声和音效。')
  if (details.lines.length) {
    const lines = details.lines.map(([start, end, speaker, line, shot]) => {
      const precision = shot ? 3 : 2
      const subject = /^主体\s*([1-9]\d*)$/u.exec(speaker)?.[1]
      const role = subject && Number(subject) <= subjectCount ? `@图片${subject} 对应的角色` : speaker
      return `${shot ? `镜头 ${shot} · ` : ''}${(start * scale).toFixed(precision)}–${(end * scale).toFixed(precision)} 秒${role ? `，发言人 ${role}` : ''}：${JSON.stringify(line)}`
    })
    const shotConstraint = details.lines.some(line => line[4]) ? '带镜头编号的台词只在对应镜头和时段说一次，不在相邻镜头重复。' : ''
    sections.push(`${storyboard ? '按下列发言生成对白。' : '只替换下列时段的相应对白。'}逐字朗读引号内的台词，并让对应人物的口型与台词同步。${shotConstraint}\n${lines.join('\n')}`)
    sections.push(storyboard
      ? '为这些台词生成与对白逐字一致的同步字幕。'
      : '若 @视频1 的对应时段已有对白字幕，只将原对白字幕替换为对应新台词，与新对白同步，沿用原字幕的位置和样式。无原对白字幕的时段保持无对白字幕。保留其他时段的字幕、商品文字和标识。')
  } else if (storyboard) sections.push('不要添加字幕。')
  if (details.bgm?.mode === 'generate') {
    sections.push(storyboard
      ? '为全片生成符合画面节奏的新配乐，配乐音量低于对白。'
      : '只替换 @视频1 的背景音乐，为全片生成符合画面节奏的新配乐，配乐音量低于对白。')
  } else if (!details.bgm && !storyboard) {
    sections.push('保留 @视频1 的原背景音乐、节奏和出现时段。原片无配乐时不要新增配乐。')
  } else if (!details.bgm) sections.push('保留场景所需的环境声，不添加背景音乐。')
  return sections.length ? `\n\n${sections.join('\n\n')}` : ''
}
