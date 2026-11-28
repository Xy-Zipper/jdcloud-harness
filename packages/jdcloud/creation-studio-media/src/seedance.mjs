/** Seedance task execution migrated from the standalone media service. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { readRemakeDialogue, readRemakeShots } from '@deepseek-ai/dsh-creation-studio-video-remake'
import { batchVoiceSelection, buildSeedanceRequest, decodeGenerationPrompt, defaultGenerationConfig, MAX_REFERENCE_AUDIO_BYTES, MAX_REFERENCE_AUDIO_SECONDS, MAX_REFERENCE_VIDEO_BYTES, MIN_REFERENCE_AUDIO_SECONDS, REFERENCE_AUDIO_FORMATS, REFERENCE_VIDEO_FORMATS, SEEDANCE_MODEL, SEEDANCE_MODELS, SEEDANCE_RATIOS, narrationAudioIndex, referenceAudioDurationIssue, seedanceIssues, seedanceModel } from './seedance-request.mjs'
import { confirmedStoryboardUpstream, frontendHash } from './upstream.mjs'
import { generatedImagePending } from './image-generation.mjs'
import { normalizeMaterialAuthorization } from './material-authorization.mjs'
import { decodeMalanshanVideoResponse, queryMalanshanVideo, submitMalanshanVideo } from './malanshan-video.mjs'
import { decodeStoryboardSupplement, narrationForShot } from './narration.mjs'
import { readRemakeDetails, remakeDetailsPrompt } from './remake-details.mjs'
import { narrationSampleCap, parseReferenceAudio, trimVoiceSample } from './reference-audio.mjs'
import { parseWebStream, TrackType } from 'music-metadata'

/** Seedance 服务端代理。平台权限逐次核对；方舟密钥只取服务端环境，不返回浏览器。 */
const MENU = {
	project: "6ad81c131f280486bb45ac3f",
	plan: "6ad81c871f280486bb45ac49",
	shot: "6ad81c871f280486bb45ac4b",
	batch: "6ad81c871f280486bb45ac4f",
	asset: "6ad81c871f280486bb45ac4d",
	material: "6ad81c871f280486bb45ac43",
	relation: "6ad81c871f280486bb45ac45",
	space: "6adb0fbec3ca9f3dcdaf499a",
	member: "6adb0fbec3ca9f3dcdaf499d",
	voice: "6ae2eeccc3ca9f3dcdaf4a7f"
};
const id = (value) => typeof value === "string" && /^[a-f0-9]{24}$/iu.test(value);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const parse = (value) => typeof value === "string" ? JSON.parse(value || "{}") : value;
const terminal = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"expired"
]);
const retryable = new Set(["failed", "cancelled", "expired"]);
const videoPortraitError = "InputVideoSensitiveContentDetected.PrivacyInformation";
const originalVideoRejected = task => task.errorCode === videoPortraitError && !task.remakeChanges?.sourceVideoAssetId;
const confirmedCopyRules = "已确认脚本声音与字幕（原文优先于下方画面描述及参考素材）：\n{}内只作朗读台词，〖〗内只作屏幕字幕，分隔符不显示也不朗读。逐字保留原文、字形、标点及顺序，不增删、改写、同音替字或转换简繁体；旁白与对应字幕同步，不把画面文字、说明或样音示例当台词。未指定字幕或旁白的时段不自行补充。";
const audioDataUrl = ({ bytes, mime }) => `data:${mime};base64,${bytes.toString("base64")}`;
const canonicalAudioMime = mime => REFERENCE_AUDIO_FORMATS.includes(mime)
	? mime.includes("wav") ? "audio/wav" : "audio/mp3"
	: undefined;

/** Each numbered label identifies the media item after the leading prompt. */
function formatProviderError(error, mediaLabels, fallback = "") {
	const position = /content\[(\d+)\]/u.exec(error?.param || '')?.[1]
		?? /content\[(\d+)\]/u.exec(error?.message || '')?.[1];
	const label = mediaLabels?.[Number(position) - 1];
	return [error?.code, label, error?.message || fallback].filter(Boolean).join("：");
}

var ApiError = class extends Error {
	constructor(message, status = 400, code = "video/invalid-request") {
		super(message);
		this.status = status;
		this.code = code;
		this.submissionState = "not-submitted";
	}
};

function remakeSelection(remake) {
	const assetId = remake.sourceVideoAssetId;
	const storyboard = remake.storyboardGeneration;
	const modelId = storyboard === undefined ? remake.editModel : storyboard?.model;
	const model = SEEDANCE_MODELS.find(option => option.value === (modelId === undefined ? SEEDANCE_MODEL : modelId));
	const resolution = remake.resolution === undefined ? defaultGenerationConfig().resolution : remake.resolution;
	const outputSelected = remake.editModel !== undefined || remake.resolution !== undefined;
	const seconds = storyboard?.seconds === undefined ? Math.ceil(remake.duration) : storyboard.seconds;
	if (assetId !== undefined && (typeof assetId !== "string" || assetId.length > 100 || assetId.trim() !== assetId
		|| !/^asset-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(assetId) || remake.redoSelected === true || remake.subjects === undefined))
		throw new ApiError("请填写已授权的原片素材 ID，并保存整片复刻设置。", 400, "video/remake-asset-invalid");
	if (storyboard !== undefined && (!object(storyboard) || typeof storyboard.prompt !== "string"
		|| !storyboard.prompt.trim() || storyboard.prompt.length > 1800 || storyboard.ratio === "adaptive"
		|| !SEEDANCE_RATIOS.includes(storyboard.ratio) || !model || !Number.isSafeInteger(seconds) || seconds < 4 || seconds > model.maxSeconds
		|| remake.redoSelected === true || assetId !== undefined || remake.subjects === undefined))
		throw new ApiError("请核对按分镜生成的画面描述、画幅、模型、时长和主体图。", 400, "video/remake-storyboard-invalid");
	if (!model || !model.resolutions.includes(resolution) || (outputSelected && remake.subjects === undefined)
		|| (storyboard !== undefined && remake.editModel !== undefined))
		throw new ApiError("请核对复刻视频的模型和分辨率。", 400, "video/remake-output-invalid");
	if (remake.subjects === undefined) {
		if (!id(remake.subjectRefId) || remake.dialogue !== undefined || remake.bgm !== undefined || remake.shotNotes !== undefined)
			throw new ApiError("请先为复刻项目保存主体图和生成设置。", 409, "video/remake-subject-changed");
		return { key: remake.subjectRefId, legacy: true, model, resolution,
			details: { notes: [], lines: [] },
			subjects: [{ relationId: remake.subjectRefId, target: "原片的主要主体", shotNumbers: [] }] };
	}
	const shots = readRemakeShots(remake, remake.duration);
	let details;
	try { details = readRemakeDetails(remake, shots); }
	catch (cause) { throw new ApiError(cause.message, 400, "video/remake-details-invalid"); }
	const fail = () => new ApiError("请核对每个替换对象的说明、主体图和镜头选择。", 409, "video/remake-subject-changed");
	if (!Array.isArray(remake.subjects) || !remake.subjects.length || remake.subjects.length > model.maxImages) throw fail();
	const refs = new Set();
	const subjects = remake.subjects.map(subject => {
		if (!id(subject?.relationId) || refs.has(subject.relationId)
			|| typeof subject.target !== "string" || !subject.target.trim() || subject.target.trim().length > 120
			|| (subject.portrait !== undefined && subject.portrait !== true)
			|| !Array.isArray(subject.shotNumbers) || subject.shotNumbers.length > shots.length
			|| new Set(subject.shotNumbers).size !== subject.shotNumbers.length
			|| subject.shotNumbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > shots.length))
			throw fail();
		refs.add(subject.relationId);
		return { relationId: subject.relationId, target: subject.target.trim(), shotNumbers: [...subject.shotNumbers].sort((a, b) => a - b),
			...(subject.portrait && { portrait: true }) };
	});
	const key = createHash("sha256").update(JSON.stringify([
		remake.sourceRefId, subjects.map(subject => [subject.relationId, subject.target, subject.shotNumbers, ...(subject.portrait ? [true] : [])]),
		...(remake.redoSelected === true ? ["selected-shots"] : []),
		...(assetId ? [`asset://${assetId}`] : []),
		...(storyboard ? [["storyboard", storyboard.ratio, storyboard.prompt.trim(),
			...(storyboard.model !== undefined || storyboard.seconds !== undefined ? [model.value, seconds] : [])]] : []),
		...(outputSelected ? [["output", model.value, resolution]] : []), ...details.identity
	])).digest("hex");
	return { key, shots, subjects, assetId, storyboard, model, seconds, resolution, details };
}

function targetTimecodes(shotNumbers, shots) {
	const ranges = [];
	for (const number of shotNumbers) {
		const shot = shots[number - 1];
		const previous = ranges.at(-1);
		if (previous?.number === number - 1) {
			previous.end = shot.end;
			previous.number = number;
		} else {
			ranges.push({ number, start: shot.start, end: shot.end });
		}
	}
	return ranges.map(range => `${range.start.toFixed(2)}–${range.end.toFixed(2)} 秒`).join("、");
}

function checkRemakeShotSelection(selection) {
	const { subjects, shots } = selection;
	if (!shots || subjects.some(subject => !subject.shotNumbers.length))
		throw new ApiError("请为每个主体指定镜头，再使用仅重做所选镜头。");
	const numbers = new Set(subjects.flatMap(subject => subject.shotNumbers));
	if (numbers.size >= shots.length)
		throw new ApiError("所选镜头已经覆盖整片，请改用整片复刻。");
}

/** 生成核心由 Harness Host 调用；项目身份、确认链和原请求回执均在执行前核对。 */
export function createSeedanceService(env, transport = fetch) {
	const apiKey = env.ARK_API_KEY?.trim();
	async function selectVideoProvider(model, expectedProvider, inputVideo = false) {
		const provider = !inputVideo && env.PROVIDER_ACCOUNTS ? await env.PROVIDER_ACCOUNTS.videoProvider(model) : 'ark';
		if (expectedProvider !== undefined && expectedProvider !== provider)
			throw new ApiError("媒体账号池的供应商已变化，请重新核对报价后生成。", 409, "video/provider-changed");
		return provider;
	}
	const platform = (env.CREATION_STUDIO_PLATFORM_URL || env.VITE_SERVE || "").replace(/\/$/u, "");
	const tenant = env.CREATION_STUDIO_TENANT_ID || env.VITE_TENANT_ID;
	const directory = resolve(env.CREATION_STUDIO_VIDEO_STATE_DIR || ".creation-studio/seedance");
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	async function platformCall(token, path, body) {
		const response = await transport(`${platform}${path}`, {
			method: body === void 0 ? "GET" : "POST",
			headers: {
				Authorization: token,
				"Content-Type": "application/json"
			},
			...body === void 0 ? {} : { body: JSON.stringify(body) },
			signal: AbortSignal.timeout(3e4)
		});
		const result = await response.json();
		if (!response.ok || result.code !== 200) throw new ApiError(result.msg || "平台权限或数据读取失败。", response.status === 401 ? 401 : 403);
		return result.data;
	}
	const detail = (token, menuId, recordId) => platformCall(token, "/api/visualdev/form/info", {
		menuId,
		_id: recordId
	});
	async function rows(token, menuId, filters) {
		const result = [];
		for (let page = 1; page <= 20; page++) {
			const data = await platformCall(token, "/api/visualdev/form/list", {
				menuId,
				currentPage: page,
				pageSize: 200,
				connect: "and",
				association: false,
				userInfoConvert: false,
				filter: filters
			});
			if (!Array.isArray(data?.list)) throw new ApiError("平台列表格式无效。");
			result.push(...data.list);
			if (data.list.length < 200 || result.length >= Number(data.pagination?.total)) return result;
		}
		throw new ApiError("项目记录超过读取上限。");
	}
	const filter = (enCode, value) => ({
		enCode,
		method: "eq",
		type: "custom",
		value
	});
	async function authorize(token, input, readOnly = false) {
		if (!platform || !tenant) throw new ApiError("视频服务缺少平台地址或租户配置。", 503);
		if (!token || !id(input.projectId) || !id(input.spaceId)) throw new ApiError("请登录并打开已保存的项目。", 401);
		const user = (await platformCall(token, "/api/oauth/currentUser")).userInfo;
		if (!user?.id || user.corpId !== tenant) throw new ApiError("账号不属于当前租户。", 403);
		const [project, space] = await Promise.all([detail(token, MENU.project, input.projectId), detail(token, MENU.space, input.spaceId)]);
		if (project?._id !== input.projectId || project.spaceId !== input.spaceId || project.deletedAt || space?._id !== input.spaceId || space.status === "inactive") throw new ApiError("项目或空间不可用。", 403);
		const remake = parse(project.specification)?.videoRemake;
		if (remake === undefined && !id(input.planId))
			throw new ApiError("请登录并打开已保存的项目。", 401);
		if (remake !== undefined && (remake?.version !== 1 || input.planId !== undefined || Boolean(project.adoptedPlanId)))
			throw new ApiError("项目流程或已采纳方案不匹配。", 403);
		if (space.ownerUserId !== user.id) {
			if (!(await rows(token, MENU.member, [filter("spaceId", input.spaceId), filter("userId", user.id)])).some((member) => member.spaceId === input.spaceId && member.userId === user.id && member.status === "active" && (remake && readOnly || ["admin", "editor"].includes(member.role)))) throw new ApiError("当前角色不能访问此视频任务。", 403);
		}
		if (remake) return { project, remake };
		const plan = await detail(token, MENU.plan, input.planId);
		if (project.adoptedPlanId !== input.planId || plan?.projectId !== input.projectId || plan.spaceId !== input.spaceId) throw new ApiError("方案不是当前项目已采纳的方案。", 403);
		return {
			userId: user.id,
			project,
			plan
		};
	}
	const taskPath = (scope, requestId) => join(directory, `${hash(`${tenant}:${scope.spaceId}:${scope.projectId}:${scope.planId}:${requestId}`)}.json`);
	async function readTask(scope, requestId) {
		try {
			return JSON.parse(await readFile(taskPath(scope, requestId), "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}
	async function store(scope, task) {
		await mkdir(directory, { recursive: true });
		const path = taskPath(scope, task.requestId);
		await writeFile(`${path}.tmp`, JSON.stringify(task), { mode: 384 });
		await rename(`${path}.tmp`, path);
	}
	const view = (task) => ({
		requestId: task.requestId,
		batchId: task.batchId,
		id: task.id,
		model: task.model || "doubao-seedance-2-0-260128",
		provider: task.provider ?? 'ark',
		providerAccountRef: task.providerAccountRef,
		status: task.status,
		videoUrl: task.videoUrl,
		error: task.error,
		errorCode: task.errorCode,
		...(originalVideoRejected(task) && { rejectedSourceRefId: task.remakeChanges?.sourceRefId }),
		createdAt: task.createdAt,
		duration: task.duration,
		usage: task.usage,
		billingParameters: task.billingParameters,
		...(task.storyboardConfirmedAt === undefined ? {} : { storyboardConfirmedAt: task.storyboardConfirmedAt }),
		...(task.voiceSelection === undefined ? {} : { voiceSelection: task.voiceSelection })
	});
	async function projectReference(token, scope, referenceId, label, purpose) {
		const relation = await detail(token, MENU.relation, referenceId);
		if (relation?._id !== referenceId || relation.spaceId !== scope.spaceId || relation.projectId !== scope.projectId
			|| !id(relation.materialId) || (purpose && relation.purpose !== purpose))
			throw new ApiError(`${label}不属于当前项目。`);
		const material = await detail(token, MENU.material, relation.materialId);
		if (material?._id !== relation.materialId || material.spaceId !== scope.spaceId || !["自有", "可商用"].includes(normalizeMaterialAuthorization(material.authorization)))
			throw new ApiError(`${label}尚未确认使用范围。`);
		return { relation, material };
	}
	/** Use a valid original URL or verify the authorized platform image before submitting its URL. */
	async function referenceData(token, scope, { relationId, label }, download = true, purpose) {
		const { relation, material } = await projectReference(token, scope, relationId, label, purpose);
		if (generatedImagePending(material.sourceKind, material.sourceDescription)) throw new ApiError(`${label}尚待人工确认。`);
		const source = Number(material.revision) === Number(relation.sourceRevision) ? material : parse(relation.usageSnapshot);
		if (!object(source) || Number(source.revision) !== Number(relation.sourceRevision) || !id(source.fileId) || !["自有", "可商用"].includes(normalizeMaterialAuthorization(source.authorization)) || ![
			"uploaded",
			"referenced",
			"generated"
		].includes(source.sourceKind) || generatedImagePending(source.sourceKind, source.sourceDescription) || ![
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/bmp",
			"image/tiff",
			"image/gif",
			"image/heic",
			"image/heif"
		].includes(source.mime)) throw new ApiError(`${label}的文件、版本或格式无效。`);
		if (Number(source.width) > 0 && Number(source.height) > 0 && (source.width < 300 || source.width > 6e3 || source.height < 300 || source.height > 6e3 || source.width / source.height < .4 || source.width / source.height > 2.5)) throw new ApiError(`${label}的宽高须为300–6000像素，宽高比须为0.4–2.5。`);
		if (!download) return source;
		const original = env.ORIGINAL_IMAGE ? await env.ORIGINAL_IMAGE(scope, label, source, material._id) : null;
		if (original?.url) return original;
		const url = `${platform}/api/file/previewImage/${tenant}/${source.fileId}`;
		const fail = (message, code) => new ApiError(`${label}${message}，未提交视频。`, 400, code);
		const unreadable = () => fail(original ? "的低代码图片地址无法读取，请检查项目素材" : "公开链接无法读取，请检查图片文件和平台预览接口", "video/reference-unreadable");
		// 用无登录信息的真实 GET 核验可读性和单图大小；不缓冲、不重编码原文件。
		try {
			const response = await (env.PUBLIC_MEDIA_FETCH || transport)(url, {
				redirect: "error",
				signal: AbortSignal.timeout(6e4)
			});
			if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("image/")) {
				await response.body?.cancel();
				throw unreadable();
			}
			if (Number(response.headers.get("content-length")) >= 30 * 1024 * 1024) {
				await response.body.cancel();
				throw fail("超过单张30MB上限，请更换图片", "video/reference-too-large");
			}
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size >= 30 * 1024 * 1024) throw fail("超过单张30MB上限，请更换图片", "video/reference-too-large");
			}
			if (!size) throw original ? unreadable() : fail("返回内容为空，请更换图片", "video/reference-unreadable");
		} catch (cause) {
			if (!original || cause instanceof ApiError) throw cause;
			throw Object.assign(unreadable(), { cause });
		}
		return { ...original, url };
	}
	/** Only the project's pinned MP4 or MOV can supply a reference video URL. */
	async function videoReferenceData(token, scope, reference, label, model) {
		const { relation, material } = await projectReference(token, scope, reference.relationId, label);
		const source = Number(material.revision) === Number(relation.sourceRevision) ? material : parse(relation.usageSnapshot);
		if (!object(source) || Number(source.revision) !== Number(relation.sourceRevision) || !id(source.fileId)
			|| !["project", "brand"].includes(source.library) || !["uploaded", "referenced", "generated"].includes(source.sourceKind)
			|| !REFERENCE_VIDEO_FORMATS.includes(source.mime) || !["自有", "可商用"].includes(normalizeMaterialAuthorization(source.authorization)))
			throw new ApiError(`${label}的版本、格式或使用范围无效，请选择已授权的 MP4 或 MOV。`, 400, "video/reference-video-invalid");
		if (Number(source.sizeBytes) > MAX_REFERENCE_VIDEO_BYTES)
			throw new ApiError(`${label}超过 200 MB，请更换文件。`, 400, "video/reference-video-size");
		const url = `${platform}/api/file/dowloadFile/${tenant}/${source.fileId}`;
		const unreadable = () => new ApiError(`${label}无法读取，请核对视频格式和素材下载地址。`, 400, "video/reference-video-unreadable");
		let format;
		try {
			const response = await (env.PUBLIC_MEDIA_FETCH || transport)(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
			const length = Number(response.headers.get("content-length"));
			if (!response.ok || !response.body || response.headers.get("content-type")?.includes("text/html") || length > MAX_REFERENCE_VIDEO_BYTES) {
				await response.body?.cancel();
				if (length > MAX_REFERENCE_VIDEO_BYTES)
					throw new ApiError(`${label}超过 200 MB，请更换文件。`, 400, "video/reference-video-size");
				throw unreadable();
			}
			let size = 0;
			const bounded = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
				size += chunk.length;
				if (size > MAX_REFERENCE_VIDEO_BYTES)
					throw new ApiError(`${label}超过 200 MB，请更换文件。`, 400, "video/reference-video-size");
				controller.enqueue(chunk);
			} }));
			({ format } = await parseWebStream(bounded, { mimeType: source.mime, ...(length > 0 && { size: length }) }, { skipCovers: true }));
		} catch (cause) {
			if (cause instanceof ApiError) throw cause;
			throw Object.assign(unreadable(), { cause });
		}
		const track = format.trackInfo.find(item => item.type === TrackType.video);
		const duration = format.containerDuration ?? track?.duration;
		if (!track || !["avc1", "avc3", "hvc1", "hev1"].includes(track.codecId))
			throw new ApiError(`${label}需要使用 H.264 或 H.265 编码。`, 400, "video/reference-video-codec");
		if (!Number.isFinite(duration) || duration < 2 || duration > model.maxSeconds)
			throw new ApiError(`${label}须为 2–${model.maxSeconds} 秒，请裁剪后重新添加。`, 400, "video/reference-video-duration");
		const { pixelWidth: width, pixelHeight: height, frameRate } = track.video ?? {};
		if ((width && height && (Math.min(width, height) < 300 || Math.max(width, height) > 6000
			|| width / height < .4 || width / height > 2.5 || width * height < 614 * 664 || width * height > model.maxVideoPixels))
			|| (frameRate && (frameRate < 23.976 || frameRate > 60)))
			throw new ApiError(`${label}的尺寸、画幅或帧率超出模型范围，请选择 480p–4K、24–60 帧且画幅合规的视频。`, 400, "video/reference-video-dimensions");
		return { duration, url };
	}

	/** Resolve authorised catalog audio and measure its actual file before submission. */
	async function catalogAudioData(token, scope, reference, label, byteLimit = MAX_REFERENCE_AUDIO_BYTES) {
		const voice = await detail(token, MENU.voice, reference.voiceId);
		if (voice?._id !== reference.voiceId || (voice.spaceId && voice.spaceId !== scope.spaceId)
			|| !id(voice.fileId) || !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(voice.mime))
			throw new ApiError(`${label}“${reference.name}”在当前空间不可用。`, 403, "video/reference-audio-unavailable");
		const unreadable = () => new ApiError(`${label}“${reference.name}”无法读取，请重新选择。`, 400, "video/reference-audio-unreadable");
		let sample;
		try {
			const response = await transport(`${platform}/api/file/dowloadFile/${tenant}/${voice.fileId}`, {
				headers: { Authorization: token }, redirect: "error", signal: AbortSignal.timeout(60000)
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw unreadable();
			}
			const chunks = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > byteLimit) throw new ApiError(`${label}“${reference.name}”不能超过 15 MB。`, 400, "video/reference-audio-size");
				chunks.push(chunk);
			}
			sample = await parseReferenceAudio(Buffer.concat(chunks, size), voice.mime);
		} catch (cause) {
			if (cause instanceof ApiError) throw cause;
			throw Object.assign(unreadable(), { cause });
		}
		const { duration } = sample;
		if (!Number.isFinite(duration) || duration < MIN_REFERENCE_AUDIO_SECONDS)
			throw new ApiError(`${label}“${reference.name}”至少需要 ${MIN_REFERENCE_AUDIO_SECONDS} 秒。`, 400, "video/reference-audio-duration");
		return sample;
	}

	/** Verify pinned audio. A voice sample keeps its bytes available for confirmed trims. */
	async function projectAudioData(token, scope, reference, label, maxSeconds, { purpose, voiceSample = false } = {}) {
		let projectAudio;
		try {
			projectAudio = await projectReference(token, scope, reference.relationId, label, purpose);
		} catch (error) {
			if (voiceSample && error instanceof ApiError)
				throw new ApiError(`${label}在当前项目不可用，请重新选择样音。`, 400, "video/reference-audio-unavailable");
			throw error;
		}
		const { relation, material } = projectAudio;
		const source = Number(material.revision) === Number(relation.sourceRevision) ? material : parse(relation.usageSnapshot);
		if (!object(source) || Number(source.revision) !== Number(relation.sourceRevision) || !id(source.fileId)
			|| !["project", "brand"].includes(source.library) || !["uploaded", "referenced", "generated"].includes(source.sourceKind)
			|| !REFERENCE_AUDIO_FORMATS.includes(source.mime) || !["自有", "可商用"].includes(normalizeMaterialAuthorization(source.authorization)))
			throw new ApiError(`${label}的版本、格式或使用范围无效，请选择已授权的 MP3 或 WAV。`, 400, "video/reference-audio-invalid");
		const tooLarge = () => new ApiError(`${label}超过 15 MB，请更换文件。`, 400, "video/reference-audio-size");
		if (Number(source.sizeBytes) > MAX_REFERENCE_AUDIO_BYTES) throw tooLarge();
		const url = `${platform}/api/file/dowloadFile/${tenant}/${source.fileId}`;
		const unreadable = () => new ApiError(`${label}下载失败，请在项目素材中检查音频能否播放。`, 400, "video/reference-audio-unreadable");
		let bytes;
		let responseMime;
		try {
			const response = await (env.PUBLIC_MEDIA_FETCH || transport)(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
			responseMime = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
			if (Number(response.headers.get("content-length")) > MAX_REFERENCE_AUDIO_BYTES) {
				await response.body?.cancel();
				throw tooLarge();
			}
			if (!response.ok || !response.body || responseMime === "text/html") {
				await response.body?.cancel();
				throw unreadable();
			}
			const chunks = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > MAX_REFERENCE_AUDIO_BYTES) throw tooLarge();
				chunks.push(chunk);
			}
			bytes = Buffer.concat(chunks, size);
		} catch (cause) {
			if (cause instanceof ApiError) throw cause;
			throw Object.assign(unreadable(), { cause });
		}
		let sample;
		try {
			sample = await parseReferenceAudio(bytes, source.mime);
		} catch (cause) {
			throw Object.assign(new ApiError(`${label}的音频内容无法按 MP3 或 WAV 读取，请重新导出后选用。`,
				400, "video/reference-audio-unreadable"), { cause });
		}
		const { duration, mime } = sample;
		if (!Number.isFinite(duration) || duration < MIN_REFERENCE_AUDIO_SECONDS || duration > maxSeconds)
			throw new ApiError(`${label}须为 ${MIN_REFERENCE_AUDIO_SECONDS}–${maxSeconds} 秒，请调整后重新添加。`, 400, "video/reference-audio-duration");
		// Use typed bytes when the platform or the material advertises a different encoding.
		const urlMatches = mime === canonicalAudioMime(source.mime)
			&& (!responseMime.startsWith("audio/") || mime === canonicalAudioMime(responseMime));
		if (voiceSample) return { ...sample, ...(urlMatches && { url }) };
		return { duration, url: urlMatches ? url : audioDataUrl(sample) };
	}

	/** Measure every batch reference and apply only the confirmed voice sample trims. */
	async function prepareBatchAudio(token, input, generation, model) {
		const voices = [];
		const clipUrls = [];
		const labels = [];
		for (const [index, reference] of (generation.audioReferences ?? []).entries()) {
			const label = `旁白音色${index + 1}`;
			labels.push(label);
			voices.push('voiceId' in reference
				? await catalogAudioData(token, input, reference, label, 15 * 1024 * 1024)
				: await projectAudioData(token, input, reference, label, MAX_REFERENCE_AUDIO_SECONDS, { voiceSample: true }));
		}
		let clipSeconds = 0;
		for (const reference of generation.audioClips ?? []) {
			const label = `${'voiceId' in reference ? '系统音频' : '参考音频'}${labels.length + 1}`;
			const audio = 'voiceId' in reference
				? await catalogAudioData(token, input, reference, label)
				: await projectAudioData(token, input, reference, label, MAX_REFERENCE_AUDIO_SECONDS);
			clipSeconds += audio.duration;
			clipUrls.push('url' in audio ? audio.url : audioDataUrl(audio));
			labels.push(label);
		}
		const issueFor = seconds => referenceAudioDurationIssue(seconds, model);
		const lengths = voices.map(voice => voice.duration);
		const originalSeconds = lengths.reduce((total, seconds) => total + seconds, clipSeconds);
		const issue = issueFor(originalSeconds);
		if (issue) {
			const cap = generation.trimVoiceSamples && model.value === SEEDANCE_MODEL
				? narrationSampleCap(lengths, model.maxSeconds - clipSeconds) : undefined;
			if (cap === undefined)
				throw new ApiError(`${issue} 实测合计 ${Number(originalSeconds.toFixed(3))} 秒。`, 400, "video/reference-audio-duration");
			for (const [index, voice] of voices.entries()) {
				if (voice.duration <= cap) continue;
				try { voices[index] = await trimVoiceSample(voice, cap); }
				catch (cause) {
					throw Object.assign(new ApiError(`${labels[index]}无法自动裁剪，请更换较短的样音。`, 400, "video/reference-audio-trim"), { cause });
				}
			}
			const remainingIssue = issueFor(voices.reduce((total, voice) => total + voice.duration, clipSeconds));
			if (remainingIssue) throw new ApiError(remainingIssue, 400, "video/reference-audio-duration");
		}
		return { urls: [...voices.map(voice => voice.url ?? audioDataUrl(voice)), ...clipUrls], labels };
	}

	async function remakeSourceMaterial(token, input, refId) {
		const { relation, material } = await projectReference(token, input, refId, "参考视频", "需求附件");
		if (material.library !== "project" || material.sourceKind !== "uploaded"
			|| !id(material.fileId) || Number(material.revision) !== Number(relation.sourceRevision)
			|| !["video/mp4", "video/quicktime"].includes(material.mime)
			|| !Number.isSafeInteger(Number(material.sizeBytes)) || Number(material.sizeBytes) <= 0 || Number(material.sizeBytes) > 30 * 1024 * 1024)
			throw new ApiError("参考视频的来源、版本或文件格式已变化，请核对原项目。");
		return material;
	}
	async function transcript(token, input) {
		const { remake } = await authorize(token, input, true);
		if (!id(remake?.sourceRefId)) throw new ApiError("请先保存本项目的参考视频。");
		if (!env.REMAKE_CLIPS) throw new ApiError("原对白识别服务未配置，可以手动填写对白。", 503, "video/remake-transcript-unavailable");
		const source = await remakeSourceMaterial(token, input, remake.sourceRefId);
		const shots = readRemakeShots(remake, remake.duration);
		try {
			const cuts = [0, ...shots.slice(1).map(shot => shot.start), remake.duration];
			const { lines } = await env.REMAKE_CLIPS.transcript(source.fileId, cuts);
			return { lines: readRemakeDialogue(lines, remake.duration, shots) };
		} catch (cause) {
			throw Object.assign(new ApiError("原对白识别未完成，请重试或手动填写。", 502, "video/remake-transcript-failed"), { cause });
		}
	}
	async function remakeVideoUrl(material, assetId) {
		if (assetId) return `asset://${assetId}`;
		const url = `${platform}/api/file/dowloadFile/${tenant}/${material.fileId}`;
		const response = await (env.PUBLIC_MEDIA_FETCH || transport)(url, {
			headers: { Range: "bytes=0-11" }, redirect: "error", signal: AbortSignal.timeout(15000)
		});
		if (!response.ok || !response.body || response.headers.get("content-type")?.includes("text/html")) {
			await response.body?.cancel();
			throw new ApiError("方舟无法读取参考视频，请检查素材的下载地址。", 400, "video/remake-source-unreadable");
		}
		const reader = response.body.getReader();
		const prefix = Buffer.alloc(12);
		let offset = 0;
		try {
			while (offset < prefix.length) {
				const chunk = await reader.read();
				if (chunk.done) break;
				offset += Buffer.from(chunk.value.subarray(0, prefix.length - offset)).copy(prefix, offset);
			}
		} finally {
			await reader.cancel();
		}
		const bytes = Number(/^bytes 0-\d+\/(\d+)$/u.exec(response.headers.get("content-range") || "")?.[1]
			?? (response.status === 200 ? response.headers.get("content-length") : undefined));
		if (offset < prefix.length || prefix.toString("ascii", 4, 8) !== "ftyp"
			|| !Number.isSafeInteger(bytes) || bytes !== Number(material.sizeBytes))
			throw new ApiError("参考视频下载地址未返回 MP4 或 MOV，未提交生成。", 400, "video/remake-source-unreadable");
		return url;
	}
	/** 组装一次 Seedance 成片请求，镜头限制、对白、配乐和字幕都使用模型输入。 */
	async function prepareRemakeRequest(token, input, remake, selection) {
		if (!id(remake.sourceRefId) || !Number.isFinite(remake.duration) || remake.duration < 4 || remake.duration > 30)
			throw new ApiError("参考视频尚未保存，请从原拆解任务进入分镜。");
		const { storyboard, model, resolution, details } = selection;
		const provider = await selectVideoProvider(model.value, input.expectedProvider, !storyboard);
		if (remake.redoSelected === true) checkRemakeShotSelection(selection);
		if (!storyboard && remake.duration > model.maxSeconds)
			throw new ApiError(`${model.label} 最多支持 ${model.maxSeconds} 秒参考视频，请换模型或使用更短的原片。`, 400, "video/remake-model-duration");
		await env.CHECK_POINTS(input.spaceId);
		const source = await remakeSourceMaterial(token, input, remake.sourceRefId);
		if (!storyboard && !selection.assetId && (await projectTasks(input)).some(task =>
			originalVideoRejected(task) && task.remakeChanges?.sourceRefId === remake.sourceRefId))
			throw new ApiError("这段原片未通过方舟的肖像审核，当前无法提交原片替换。", 409, "video/remake-portrait-mode");
		const original = storyboard ? undefined : await remakeVideoUrl(source, selection.assetId);
		const bgm = details.bgm;
		const audioClips = [];
		const audioUrls = [];
		if (bgm?.mode === "upload") {
			const audio = await projectAudioData(token, input, bgm, "背景音乐", model.maxSeconds, { purpose: "需求附件" });
			if (bgm.end > audio.duration + 0.02)
				throw new ApiError("背景音乐选段超过文件时长，请重新选择。", 400, "video/remake-bgm-invalid");
			audioClips.push({ relationId: bgm.relationId, name: "背景音乐", durationSeconds: audio.duration,
				purpose: `${original ? "只替换原片的背景音乐。" : ""}以此音频 ${bgm.start.toFixed(2)}–${bgm.end.toFixed(2)} 秒的选段为成片配乐，从成片开头播放，过短则循环，过长则裁至成片结束。保留对白和环境声，配乐音量低于对白。` });
			audioUrls.push(audio.url);
		}
		const lockedEdit = Boolean(original) && model.value === SEEDANCE_MODEL;
		const generationSeconds = storyboard ? selection.seconds : lockedEdit ? Math.ceil(remake.duration) : Math.round(remake.duration);
		const scale = lockedEdit ? 1 : generationSeconds / remake.duration;
		const sourceShots = selection.shots ?? [];
		const editShots = storyboard ? sourceShots.map(({ start, end }) => ({ start: start * scale, end: end * scale })) : sourceShots;
		const references = selection.subjects.map((subject, index) => {
			const windows = targetTimecodes(subject.shotNumbers, editShots);
			const numberedWindows = !lockedEdit && subject.shotNumbers.length
				? `镜头 ${subject.shotNumbers.join("、")}（${windows}）` : windows;
			return {
				relationId: subject.relationId,
				name: `主体 ${index + 1}`,
				purpose: storyboard
					? `「${subject.target}」以这张图为准${windows ? `，用于 ${windows} 的镜头` : ""}。`
					: `用这张图替换 @视频1 ${numberedWindows ? `中仅在 ${numberedWindows} 出现的` : "中出现的"}「${subject.target}」。`
			};
		});
		const generation = { ...defaultGenerationConfig(), model: model.value, resolution, ratio: storyboard?.ratio ?? "adaptive",
			generateAudio: true, references, audioClips,
			...(original && { videoReferences: [{ relationId: remake.sourceRefId, name: "原片", purpose: "按原片时间线编辑画面和声音。", durationSeconds: remake.duration }] }),
		};
		const imageReferenceLabels = references.map((_, index) => `主体${index + 1}图`);
		const images = [];
		for (const [index, reference] of references.entries()) {
			const label = imageReferenceLabels[index];
			const image = await referenceData(token, input, { relationId: reference.relationId, label }, true, "分镜图");
			if (selection.subjects[index].portrait && !image.providerAccountId)
				throw new ApiError(`请为${label}采用无参考图的 Seedream 文生图产物。`, 400, "video/remake-portrait-image");
			images.push(image);
		}
		const accounts = new Set(images.flatMap(image => image.providerAccountId ? [image.providerAccountId] : []));
		if (accounts.size > 1)
			throw new ApiError("这些主体图由不同方舟账号生成，无法用于同一视频。请在本项目内重新生成或改用上传图。");
		const [requiredAccountId] = accounts;
		if (requiredAccountId && !env.PROVIDER_ACCOUNTS)
			throw new ApiError("缺少原始生图账号解析能力，未提交视频。");
		const editPrompt = selection.legacy
			? "视频编辑：把 @视频1 中贯穿镜头的主要主体替换为 @图片1 中的主体。保留原片的镜头顺序、切点、机位、运动和场景。"
			: "视频编辑：按下列图片用途逐条编辑 @视频1，只替换指定范围内原本出现的对象。对象未出现时不添加。替换整个角色时，头部和身体统一使用对应参考图的角色外观。同一道具换手后沿用同一参考外观。输出完整视频，保留原片的分屏、构图、镜头顺序、切点、机位、动作和转场。保留未指定修改的人物、道具、场景、字幕和画面文字，替换区域按原光线、透视与遮挡融合。";
		const prompt = storyboard
			? `按以下画面描述生成一段新视频。遵循镜头顺序和节奏，统一主体外观。\n镜头时段（秒）：${editShots.map(shot => `${shot.start.toFixed(2)}–${shot.end.toFixed(2)}`).join("、")}。\n画面描述：${storyboard.prompt.trim()}`
			: editPrompt + (remake.redoSelected ? "逐镜保留未选镜头的原画面和剪辑。对白、字幕及配乐按各自的时间说明处理。" : "");
		const text = prompt + remakeDetailsPrompt(details, Boolean(storyboard), scale, references.length);
		const request = buildSeedanceRequest(generation, text, generationSeconds, images.map(image => image.url),
			audioUrls, original ? [original] : []);
		// 2.5 的原片编辑模式使用参考片时长，2.0 接受整数秒。
		if (lockedEdit) {
			request.duration = -1;
			request.omni_reference_task_type = "edit";
		}
		return {
			provider, request, duration: lockedEdit ? remake.duration : generationSeconds, imageReferenceLabels, requiredAccountId,
			...(original && { videoReferenceLabels: ["原片"] }), ...(audioClips.length && { audioReferenceLabels: ["背景音乐"] }),
		};
	}
	async function prepareStoryboardRequest(token, input, project, plan) {
		const stamps = parse(plan.stageConfirmations);
		if (!stamps?.storyboard?.at || stamps.storyboard.formRevision !== Number(project.formRevision) || Number(project.formRevision) !== Number(project.confirmedFormRevision)) throw new ApiError("请先确认当前需求、脚本和分镜。");
		const batch = await detail(token, MENU.batch, input.batchId);
		if (batch?.spaceId !== input.spaceId || batch.projectId !== input.projectId || batch.planId !== input.planId) throw new ApiError("生成批次不属于当前方案。", 403);
		const { prompt, generation } = decodeGenerationPrompt(batch.prompt || "");
		if (!generation) throw new ApiError("请先保存本批次参考素材、用途与生成设置。");
		if (!prompt.trim()) throw new ApiError("请填写本批次提示词。");
		const selectedModel = seedanceModel(generation.model);
		const videoReferences = generation.videoReferences ?? [];
		const provider = await selectVideoProvider(selectedModel.value, input.expectedProvider, videoReferences.length > 0);
		const global = plan.globalPrompt?.trim();
		const body = global ? `全局风格限定词和约束提示词：\n${global}\n\n${prompt}` : prompt;
		const fullPrompt = `${confirmedCopyRules}\n\n${body}`;
		const filters = [
			filter("projectId", input.projectId),
			filter("spaceId", input.spaceId),
			filter("planId", input.planId)
		];
		const [allShots, assets] = await Promise.all([rows(token, MENU.shot, filters), rows(token, MENU.asset, filters)]);
		allShots.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
		assets.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
		if (allShots.some((shot) => shot.spaceId !== input.spaceId || shot.planId !== input.planId) || assets.some((asset) => asset.spaceId !== input.spaceId || asset.planId !== input.planId)) throw new ApiError("镜头或资产不属于当前方案。", 403);
		confirmedStoryboardUpstream({
			...project,
			specification: parse(project.specification),
			caseIds: parse(project.caseIds || "[]"),
			_meta: {
				schemaVersion: "1.0",
				artifactType: "creation-studio-requirement-intake",
				syncStatus: "synced",
				tenantId: tenant,
				projectId: input.projectId,
				spaceId: input.spaceId,
				revision: Number(project.formRevision),
				baseRevision: Number(project.formRevision)
			}
		}, project, plan, allShots);
		const codeById = new Map(assets.map((asset) => [asset._id, asset.code]));
		const board = {
			consistency: plan.consistency || "",
			assets: assets.map((asset, index) => ({
				code: asset.code,
				sortOrder: index,
				name: asset.name,
				prompt: asset.prompt,
				authorization: asset.authorization,
				imageRefId: asset.imageRefId || ""
			})),
			shots: allShots.map((shot, index) => ({
				code: `SHOT-${String(index + 1).padStart(2, "0")}`,
				prompt: shot.prompt || "",
				supplement: shot.supplement || "",
				assetIds: (parse(shot.assetObjectIds || "[]") || []).map((id) => codeById.get(id) || ""),
				imageRefId: shot.storyboardImageRefId || ""
			}))
		};
		if (stamps.storyboard.storyboardHash !== frontendHash(board)) throw new ApiError("分镜确认已过期，请重新确认当前分镜。");
		const shotLabel = relationId => {
			const index = allShots.findIndex(shot => shot.storyboardImageRefId === relationId);
			return index >= 0 ? `镜头${index + 1}图` : undefined;
		};
		const imageReferenceLabels = generation.references.map((reference, index) => {
			const shot = shotLabel(reference.relationId);
			const label = `参考图${index + 1}`;
			return shot ? `${shot}（${label}）` : label;
		});
		const batchLabels = new Map(generation.references.map((reference, index) => [reference.relationId, imageReferenceLabels[index]]));
		const requiredAssets = new Set(allShots.flatMap((shot) => parse(shot.assetObjectIds || "[]") || []));
		// 分镜与资产图片可留空；已选图片仍须通过项目归属、来源和人工确认核验。
		const requiredPictures = [...allShots.map((shot) => shot.storyboardImageRefId), ...assets.filter((asset) => requiredAssets.has(asset._id)).map((asset) => asset.imageRefId)]
			.filter((value) => value !== undefined && value !== null && value !== "");
		if (requiredPictures.some((value) => !id(value))) throw new ApiError("已选分镜或资产图片引用无效，请重新选择图片。");
		for (const relationId of new Set(requiredPictures)) await referenceData(token, input, {
			relationId,
			label: batchLabels.get(relationId) ?? shotLabel(relationId) ?? `资产图${assets.findIndex(asset => asset.imageRefId === relationId) + 1}`
		}, false);
		const batchShots = allShots.filter((shot) => shot.videoBatchId === input.batchId);
		const duration = batchShots.reduce((sum, shot) => sum + Number(shot.expectedSeconds), 0);
		const audioReferences = generation.audioReferences ?? [];
		const usedAudio = new Map();
		// Validate voice bindings against confirmed speakers. The saved batch supplies all spoken and displayed text.
		for (const shot of batchShots) {
			const detail = parse(shot.scriptDetail);
			const speech = narrationForShot({ detail }, decodeStoryboardSupplement(shot.supplement || "").speech);
			for (const line of speech) {
				const index = narrationAudioIndex(audioReferences, line);
				if (index < 0 || !generation.generateAudio) throw new ApiError("请在视频生成页为每位旁白选择系统音色或上传样音，并开启生成音频。", 400, "video/voice-selection");
				const speakers = usedAudio.get(index) ?? new Map();
				speakers.set(line.speakerId, line.speakerName);
				usedAudio.set(index, speakers);
			}
		}
		if (audioReferences.some((reference, index) => reference.speakerIds.some((id, speakerIndex) =>
			usedAudio.get(index)?.get(id) !== reference.speakerNames[speakerIndex])))
			throw new ApiError("旁白音色必须对应本批脚本中的真实旁白角色。请重新选择音色。", 400, "video/voice-selection");
		const issues = seedanceIssues(generation, fullPrompt, duration);
		if (issues.length) throw new ApiError(issues[0]);
		const urls = [];
		const originalAccounts = new Set();
		for (const [index, reference] of generation.references.entries()) {
			const picture = await referenceData(token, input, { relationId: reference.relationId, label: imageReferenceLabels[index] });
			const { url } = picture;
			if (picture.providerAccountId) originalAccounts.add(picture.providerAccountId);
			urls.push(url);
		}
		if (originalAccounts.size > 1) throw new ApiError("本批文生图原始产物来自不同方舟账号，不能合并提交。请返回分镜，使用同账号产物或调整批次。");
		const requiredAccountId = [...originalAccounts][0];
		if (requiredAccountId && !env.PROVIDER_ACCOUNTS) throw new ApiError("缺少原始生图账号解析能力，未提交视频；请联系管理员恢复原账号池。");
		const { urls: audioUrls, labels: audioReferenceLabels } = await prepareBatchAudio(token, input, generation, selectedModel);
		const videoUrls = [];
		const videoReferenceLabels = [];
		let videoDuration = 0;
		for (const [index, reference] of videoReferences.entries()) {
			const label = `参考视频${index + 1}`;
			const video = await videoReferenceData(token, input, reference, label, selectedModel);
			videoDuration += video.duration;
			if (videoDuration > selectedModel.maxSeconds)
				throw new ApiError(`参考视频总时长超过 ${selectedModel.maxSeconds} 秒，请缩短或移除视频。`, 400, "video/reference-video-duration");
			videoUrls.push(video.url);
			videoReferenceLabels.push(label);
		}
		const request = buildSeedanceRequest(generation, fullPrompt, duration, urls, audioUrls, videoUrls);
		if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024 * 1024) throw new ApiError("请求体超过64MB，请减少本批参考音频或提示词。", 400, "video/request-too-large");
		return { provider, request, duration, requiredAccountId, imageReferenceLabels,
			...(videoReferenceLabels.length && { videoReferenceLabels }), ...(audioReferenceLabels.length && { audioReferenceLabels }),
			storyboardConfirmedAt: Number(stamps.storyboard.at), voiceSelection: batchVoiceSelection(generation) };
	}
	async function submit(token, input) {
		if (!apiKey && !env.PROVIDER_ACCOUNTS) throw new ApiError("视频服务尚未配置账号池或 ARK_API_KEY。", 503);
		const { plan, project, remake } = await authorize(token, input);
		const batchId = remake ? input.projectId : input.batchId;
		if (!id(batchId) || typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{8,100}$/u.test(input.requestId))
			throw new ApiError("批次或请求编号无效。");
		const selection = remake ? remakeSelection(remake) : undefined;
		const base = selection ? `remake-${selection.key}` : "";
		const suffix = base && input.requestId.startsWith(base) ? input.requestId.slice(base.length) : null;
		if (remake && (suffix === null || (suffix !== "" && !/^-[1-9]\d{0,2}$/u.test(suffix))))
			throw new ApiError("请保存主体图后，使用当前分镜提交复刻。", 409, "video/remake-subject-changed");
		const previous = await readTask(input, input.requestId);
		if (previous) {
			if (previous.batchId !== batchId) throw new ApiError("该请求编号已经用于其他批次，请核对原任务。");
			return view(previous);
		}
		if (remake && suffix) {
			const attempt = Number(suffix.slice(1));
			const prior = await readTask(input, attempt === 1 ? base : `${base}-${attempt - 1}`);
			if (!retryable.has(prior?.status))
				throw new ApiError("原复刻任务尚未明确失败，请继续查询原任务。", 409, "video/remake-original-active");
		}
		const { provider, request, duration, requiredAccountId, imageReferenceLabels, videoReferenceLabels, audioReferenceLabels, storyboardConfirmedAt, voiceSelection } = remake
			? await prepareRemakeRequest(token, input, remake, selection)
			: await prepareStoryboardRequest(token, input, project, plan);
		if (provider === 'malanshan' && requiredAccountId)
			throw new ApiError("本批含需要原方舟账号核验的 Seedream 文生图。请使用已开通该素材权限的方舟模型，或换用有权提交给马栏山的参考图。", 400, "video/malanshan-original-image");
		const task = {
			requestId: input.requestId,
			tenantId: tenant,
			batchId,
			spaceId: input.spaceId,
			projectId: input.projectId,
			planId: input.planId,
			model: request.model,
			provider,
			status: "submitting",
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			duration,
			imageReferenceLabels,
			...(videoReferenceLabels && { videoReferenceLabels }),
			...(audioReferenceLabels && { audioReferenceLabels }),
			billingParameters: { resolution: request.resolution, audioMode: request.generate_audio ? "enabled" : "disabled",
				inputVideoMode: request.content.some(item => item.type === "video_url") ? "present" : "none", serviceTier: "default" },
			...(selection && { remakeChanges: { sourceRefId: remake.sourceRefId, subjects: selection.subjects, prompt: request.content[0].text,
				...(selection.assetId && { sourceVideoAssetId: selection.assetId }) } }),
			...(storyboardConfirmedAt === undefined ? {} : { storyboardConfirmedAt }),
			...(voiceSelection === undefined ? {} : { voiceSelection })
		};
		await mkdir(directory, { recursive: true });
		try {
			await mkdir(`${taskPath(input, input.requestId)}.lock`);
		} catch (error) {
			if (error.code === "EEXIST") return view(await readTask(input, input.requestId) || task);
			throw error;
		}
		await store(input, task);
		// 在付费提交前固定原账号；后续查询不能重新负载分配。
		let account = { apiKey };
		if (env.PROVIDER_ACCOUNTS) {
			try {
				const selected = await env.PROVIDER_ACCOUNTS.acquire(provider, { ...input, scenario: 'video', model: task.model,
					...(requiredAccountId ? { requiredAccountId } : {}) });
				account = selected.account;
				Object.assign(task, selected.receipt);
				task.status = 'submitting';
				await store(input, task);
			} catch (error) {
				task.status = 'failed';
				task.error = requiredAccountId ? `原始图片须使用同一方舟账号生成视频。${error.message}` : error.message;
				task.errorCode = error.code;
				await store(input, task);
				if (task.providerLeaseId) await env.PROVIDER_ACCOUNTS.settle(task, 'failed');
				return view(task);
			}
		}
		const providerName = provider === 'malanshan' ? '马栏山' : '方舟';
		const mediaLabels = [...imageReferenceLabels, ...videoReferenceLabels ?? [], ...audioReferenceLabels ?? []];
		let gatewayStatus;
		let gatewayTrace;
		let gatewayCode;
		let gatewayMessage;
		try {
			const response = provider === 'malanshan' ? await submitMalanshanVideo(request, account.apiKey, transport)
				: await transport("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.apiKey.trim().replace(/^Bearer\s+/iu, '')}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(9e4)
			});
			if (provider === 'malanshan') {
				gatewayStatus = response.status;
				const trace = response.headers.get('x-request-id') || response.headers.get('x-tt-logid');
				if (trace !== account.apiKey && /^[a-z0-9-]{6,128}$/iu.test(trace ?? '')) gatewayTrace = trace;
			}
			const data = await response.json();
			const malanshan = provider === 'malanshan' ? decodeMalanshanVideoResponse(data, account.apiKey) : undefined;
			gatewayCode = malanshan?.gatewayCode;
			gatewayMessage = malanshan?.gatewayMessage;
			const taskId = malanshan ? malanshan.taskId : data.id;
			const providerError = malanshan ? malanshan.error : data?.error;
			const gatewayUncertain = response.status >= 500 || response.status === 408;
			if (malanshan?.rejected && !gatewayUncertain && !taskId) {
				task.status = "failed";
				task.errorCode = providerError.code;
				task.error = formatProviderError(providerError, mediaLabels, "马栏山未接受生成任务。");
			} else if ((remake || malanshan) && (gatewayUncertain || (response.ok && (!taskId || malanshan?.error)))) {
				task.status = "unknown";
				if (malanshan) {
					task.errorCode = response.ok ? 'video/malanshan-task-id-missing' : 'video/malanshan-gateway';
					task.error = formatProviderError(providerError, mediaLabels, response.ok
						? "马栏山响应中没有可用的任务 ID，请先核对原任务。"
						: "马栏山网关异常，任务受理状态待核对。");
				} else {
					task.error = "方舟未返回确定的任务回执，请先在方舟控制台核对。";
				}
			} else if (!response.ok || !taskId) {
				task.status = "failed";
				task.errorCode = providerError?.code;
				task.error = formatProviderError(providerError, mediaLabels, `${providerName}未接受生成任务。`);
			} else {
				task.id = taskId;
				task.status = "queued";
			}
		} catch {
			task.status = "unknown";
			if (provider === 'malanshan') {
				task.errorCode = gatewayStatus === undefined ? 'video/malanshan-submit-interrupted' : 'video/malanshan-response-unreadable';
				task.error = gatewayStatus === undefined
					? "马栏山提交连接中断或超时，请核对原任务。"
					: "马栏山提交回执无法解析，请核对原任务。";
			} else {
				task.error = "提交结果未确认，请在方舟控制台核对后再新建任务，当前请求不会自动重发。";
			}
		}
		if (provider === 'malanshan' && task.error) {
			if (gatewayStatus !== undefined) task.error += `响应状态码 ${gatewayStatus}。`;
			if (gatewayCode !== undefined) task.error += `马栏山业务码 ${gatewayCode}。`;
			if (gatewayMessage) task.error += `马栏山返回「${gatewayMessage}」。`;
			if (gatewayTrace) task.error += `网关追踪号 ${gatewayTrace}。`;
		}
		await store(input, task);
		await env.PROVIDER_ACCOUNTS?.settle(task, task.status, task.id);
		return view(task);
	}
	async function refresh(token, input) {
		await authorize(token, input);
		const task = await readTask(input, input.requestId);
		if (!task) throw new ApiError("没有找到当前项目的生成任务。", 404);
		// 旧成功任务缺usage时允许只读补取原回执；不新建供应商任务。
		const result = () => ({ ...view(task), remakeClip: task.remakeClip, remakeMusic: task.remakeMusic, remakeCaptions: task.remakeCaptions });
		if (!task.id || (terminal.has(task.status) && !(task.status === "succeeded" && task.usage === undefined))) return result();
		const provider = task.provider ?? 'ark';
		const providerName = provider === 'malanshan' ? '马栏山' : '方舟';
		const account = task.providerAccountId && env.PROVIDER_ACCOUNTS
			? await env.PROVIDER_ACCOUNTS.resolve(provider, task) : provider === 'ark' ? { apiKey } : undefined;
		if (!account?.apiKey) throw new ApiError(provider === 'malanshan' ? "原视频任务的马栏山账号未配置。" : "原视频任务的 ARK_API_KEY 未配置。", 503);
		const response = provider === 'malanshan' ? await queryMalanshanVideo(task.id, account.apiKey, transport)
			: await transport(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${encodeURIComponent(task.id)}`, {
			headers: { Authorization: `Bearer ${account.apiKey.trim().replace(/^Bearer\s+/iu, '')}` },
			signal: AbortSignal.timeout(3e4)
		});
		const payload = await response.json();
		const malanshan = provider === 'malanshan' ? decodeMalanshanVideoResponse(payload, account.apiKey) : undefined;
		const data = malanshan ? malanshan.data : payload;
		const providerError = malanshan ? malanshan.error : data?.error;
		const mediaLabels = [...task.imageReferenceLabels ?? [], ...task.videoReferenceLabels ?? [], ...task.audioReferenceLabels ?? []];
		if (!response.ok) throw new ApiError(formatProviderError(providerError, mediaLabels, `查询${providerName}任务失败。`), 502);
		if (malanshan && (malanshan.taskId !== task.id || !terminal.has(data.status) && !['queued', 'running'].includes(data.status)
			|| data.status === 'succeeded' && (typeof data.content?.video_url !== 'string' || !data.content.video_url.trim()))) {
			const details = formatProviderError(providerError, mediaLabels,
				malanshan.gatewayMessage || "马栏山未返回有效的原任务状态，请继续查询原任务。");
			throw new ApiError(malanshan.gatewayCode === undefined ? details : `${details} 马栏山业务码 ${malanshan.gatewayCode}。`, 502, "video/malanshan-task-response");
		}
		task.status = data.status;
		task.errorCode = providerError?.code;
		task.error = formatProviderError(providerError, mediaLabels);
		// 用量在下载之前落盘；total_tokens仅核对，不与completion_tokens重复相加。
		if (data.usage !== undefined) task.usage = data.usage;
		task.billingParameters = { ...task.billingParameters,
			...(data.resolution ? { resolution: data.resolution } : {}),
			...(data.service_tier ? { serviceTier: data.service_tier } : {}),
			...(typeof data.generate_audio === "boolean" ? { audioMode: data.generate_audio ? "enabled" : "disabled" } : {}) };
		if (data.status === "succeeded") {
			task.videoUrl = data.content?.video_url || "";
			if (task.remakeChanges && !task.remakeClip && !task.remakeMusic && !task.remakeCaptions && Number.isFinite(data.duration) && data.duration > 0)
				task.duration = data.duration;
		}
		await store(input, task);
		await env.PROVIDER_ACCOUNTS?.settle(task, task.status, task.id);
		return result();
	}
	async function projectTasks(input) {
		let files;
		try {
			files = await readdir(directory);
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
		const tasks = [];
		for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
			const task = JSON.parse(await readFile(join(directory, file), "utf8"));
			if (task.tenantId === tenant && task.spaceId === input.spaceId && task.projectId === input.projectId && task.planId === input.planId) tasks.push(task);
		}
		return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	async function list(token, input) {
		await authorize(token, input, true);
		return (await projectTasks(input)).map(view);
	}
	return {
		submit,
		refresh,
		list,
		transcript
	};
}
