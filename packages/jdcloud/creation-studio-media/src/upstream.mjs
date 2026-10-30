/** Mirror the current frontend confirmation payloads without network access or business writes. */
import { createHash } from 'node:crypto'

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const text = value => typeof value === 'string' && value.trim().length > 0
export const recordId = value => typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)
export const parse = (value, fallback) => value === undefined || value === null || value === '' ? fallback : typeof value === 'string' ? JSON.parse(value) : value
const string = value => typeof value === 'string' ? value : ''
const integer = value => Number.isSafeInteger(value) && value >= 0
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const sha256 = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const same = (left, right) => sha256(left) === sha256(right)
const requireValue = (value, message) => { if (!value) throw new Error(message) }
/** 确认失效保留稳定错误码，调用方停止提交并引导用户重新确认对应阶段。 */
const requireConfirmation = (value, stage) => {
  if (value) return
  const error = new Error(`${stage}确认已失效，请返回${stage}重新确认后再生成图片。`)
  error.code = 'creation-studio/stale-confirmation'
  throw error
}

/** FNV uses JavaScript code units and property order, matching src/api/flow/map.ts. */
export function frontendHash(value) {
  let hash = 2166136261
  const serialized = JSON.stringify(value)
  for (let index = 0; index < serialized.length; index += 1)
    hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Validate requirement → adopted plan → current saved shots, ignoring unrelated production fields. */
export function confirmedStoryboardUpstream(requirement, project, row, rows) {
  requireValue(object(requirement?._meta) && object(project) && object(row) && Array.isArray(rows) && rows.length, 'Confirmed upstream records and shots are required')
  const meta = requirement._meta
  const revision = Number(project.formRevision)
  requireValue(meta.schemaVersion === '1.0' && meta.artifactType === 'creation-studio-requirement-intake'
    && meta.tenantId === '6ad80f2f1f280486bb45ac3a' && meta.syncStatus === 'synced'
    && meta.revision === revision && meta.baseRevision === revision, 'Requirement file is stale or unsynced')
  requireValue(recordId(project._id) && recordId(project.spaceId) && meta.projectId === project._id
    && meta.spaceId === project.spaceId && !(Number(project.deletedAt) > 0), 'Project identity/space is invalid')
  requireValue(project.formRevision !== '' && project.formRevision != null && project.confirmedFormRevision !== ''
    && project.confirmedFormRevision != null && integer(revision) && Number(project.confirmedFormRevision) === revision
    && Number(project.requirementConfirmedAt) > 0, 'Requirement is not confirmed')
  requireValue(recordId(row._id) && project.adoptedPlanId === row._id
    && row.projectId === project._id && row.spaceId === project.spaceId, 'Adopted plan identity/space differs')
  const rawSpec = parse(project.specification, {})
  const specKeys = ['family', 'primary', 'secondary', 'objective', 'presentation', 'duration', 'ratio']
  requireValue(object(rawSpec) && specKeys.every(key => typeof rawSpec[key] === 'string') && object(rawSpec.styles)
    && Object.values(rawSpec.styles).every(axis => Array.isArray(axis) && axis.length <= 1 && axis.every(text)), 'Invalid specification')
  const specification = { ...Object.fromEntries(specKeys.map(key => [key, rawSpec[key]])), styles: rawSpec.styles }
  const formKeys = ['productName', 'productCategory', 'platform', 'audience', 'intent', 'avoid', 'sellingPoints']
  requireValue(formKeys.every(key => typeof project[key] === 'string'), 'Missing requirement fields')
  const form = Object.fromEntries(formKeys.map(key => [key, project[key]]))
  const rawCases = parse(project.caseIds, [])
  requireValue(Array.isArray(rawCases) && rawCases.every(recordId), 'Invalid selected cases')
  const caseIds = [...new Set(rawCases)]
  const business = { name: string(project.name), ...form, caseIds: [...caseIds].sort(), specification }
  requireValue(same(business, { ...Object.fromEntries(Object.keys(business).map(key => [key, requirement[key]])),
    caseIds: [...new Set(requirement.caseIds ?? [])].sort() }), 'Requirement content differs from project')
  const opening = parse(row.opening, {})
  const numberCard = parse(row.numberCard, {})
  const scores = parse(row.scores, {})
  const plan = {
    title: string(row.title) || '未命名方案', seconds: Number(row.expectedSeconds), tone: string(row.tone),
    referenceCaseIds: [...new Set(parse(row.referenceCaseIds, []))],
    assessed: scores.assessed !== false && (scores.assessed === true || ['referenceFit', 'goalFit', 'presentationFit', 'complianceSafety', 'composite'].some(key => key in scores)),
    riskLevel: string(row.riskLevel), riskNote: string(row.riskNote),
    opening: Object.fromEntries(['attract', 'attractHint', 'bridge', 'bridgeHint'].map(key => [key, string(opening[key])])),
    hookType: string(row.hookType) || '疑问式', hookCopy: string(row.hookCopy),
    sellingPoints: parse(row.sellingPoints, []), narrative: string(row.narrative), description: string(row.description),
    numberCard: Object.fromEntries(['timing', 'font', 'size', 'color', 'position'].map(key => [key, string(numberCard[key])])),
    feedback: string(row.feedback),
    ...(object(scores.review) ? { creativeDetail: { beats: scores.creativeDetail?.beats ?? [], execution: scores.creativeDetail?.execution ?? {} } } : {}),
  }
  requireValue(integer(plan.seconds) && plan.seconds > 0 && plan.referenceCaseIds.every(recordId)
    && Array.isArray(plan.sellingPoints) && plan.sellingPoints.every(text), 'Invalid confirmed plan')
  const ids = new Set()
  const shots = rows.map((shot, index) => {
    requireValue(object(shot) && recordId(shot._id) && !ids.has(shot._id)
      && shot.projectId === project._id && shot.planId === row._id && shot.spaceId === project.spaceId
      && Number(shot.sortOrder) === index && shot.code === `SHOT-${String(index + 1).padStart(2, '0')}`, 'Shot identity/space/order is invalid')
    ids.add(shot._id)
    const detail = parse(shot.scriptDetail, undefined)
    requireValue(detail === undefined || object(detail), 'Malformed scriptDetail')
    const seconds = Number(shot.expectedSeconds)
    requireValue(integer(seconds) && seconds > 0 && ['shotSize', 'cameraMove', 'visual', 'scene'].every(key => text(shot[key])), 'Invalid confirmed shot')
    requireValue(seconds <= 30, 'Each shot must be at most 30 seconds; return to script and split it')
    return {
      code: shot.code, shotSize: shot.shotSize, camera: shot.cameraMove, visual: shot.visual,
      voiceover: string(shot.voiceover), seconds, scene: shot.scene, emotion: string(shot.emotion),
      ...(detail ? { scriptDetail: detail } : {}),
    }
  })
  requireValue(shots.reduce((sum, shot) => sum + shot.seconds, 0) === plan.seconds, 'Confirmed shot duration differs from plan')
  requireValue(plan.seconds >= 4, 'Shot total duration must be at least 4 seconds')
  const stamps = parse(row.stageConfirmations, {})
  const revisions = stamps.revisions
  const formHash = frontendHash({ ...form, specification: JSON.stringify(specification), caseIds })
  requireValue(stamps.schemaVersion === 1 && object(revisions) && integer(revisions.plan)
    && integer(revisions.script) && Number(row.revision) === revisions.plan, 'Invalid stage revision file')
  for (const stage of ['creative', 'script']) {
    const stamp = stamps[stage]
    requireConfirmation(object(stamp) && Number.isFinite(stamp.at) && stamp.at > 0
      && stamp.formRevision === revision && stamp.formHash === formHash
      && stamp.planRevision === revisions.plan && stamp.planHash === frontendHash(plan), stage === 'creative' ? '创意方案' : '视频脚本')
    if (stage === 'script')
      requireConfirmation(stamp.scriptRevision === revisions.script && stamp.scriptHash === frontendHash(shots), '视频脚本')
  }
  return {
    schemaVersion: '1.1', artifactType: 'creation-studio-storyboard-assets', tenantId: meta.tenantId,
    spaceId: project.spaceId, projectId: project._id, planId: row._id,
    requirementRevision: revision, planRevision: revisions.plan, scriptRevision: revisions.script,
    scriptConfirmedAt: stamps.script.at,
    upstreamSha256: sha256({ business, plan, shots, requirementConfirmedAt: Number(project.requirementConfirmedAt), creative: stamps.creative.at, script: stamps.script.at }),
  }
}
