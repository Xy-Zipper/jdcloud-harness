/** Seedance task execution migrated from the standalone media service. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { buildSeedanceRequest, decodeGenerationPrompt, SEEDANCE_MODEL } from './seedance-request.mjs'
import { confirmedStoryboardUpstream, frontendHash } from './upstream.mjs'
import { generatedImagePending } from './image-generation.mjs'
import { decodeStoryboardSupplement, narrationForShot } from './narration.mjs'
import { parseBuffer } from 'music-metadata'

/** Seedance 2.5 服务端代理。平台权限逐次核对；方舟密钥只取服务端环境，不返回浏览器。 */
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
var ApiError = class extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
};
/** 生成核心由 Harness Host 调用；项目身份、确认链和原请求回执均在执行前核对。 */
export function createSeedanceService(env, transport = fetch) {
	const apiKey = env.ARK_API_KEY?.trim();
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
	async function authorize(token, input) {
		if (!platform || !tenant) throw new ApiError("视频服务缺少平台地址或租户配置。", 503);
		if (!token || !id(input.projectId) || !id(input.spaceId) || !id(input.planId)) throw new ApiError("请登录并打开已保存的项目。", 401);
		const user = (await platformCall(token, "/api/oauth/currentUser")).userInfo;
		if (!user?.id || user.corpId !== tenant) throw new ApiError("账号不属于当前租户。", 403);
		const [project, space] = await Promise.all([detail(token, MENU.project, input.projectId), detail(token, MENU.space, input.spaceId)]);
		if (project?._id !== input.projectId || project.spaceId !== input.spaceId || project.deletedAt || space?._id !== input.spaceId || space.status === "inactive") throw new ApiError("项目或空间不可用。", 403);
		if (space.ownerUserId !== user.id) {
			if (!(await rows(token, MENU.member, [filter("spaceId", input.spaceId), filter("userId", user.id)])).some((member) => member.spaceId === input.spaceId && member.userId === user.id && member.status === "active" && ["admin", "editor"].includes(member.role))) throw new ApiError("当前角色不能生成视频。", 403);
		}
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
		status: task.status,
		videoUrl: task.videoUrl,
		error: task.error,
		createdAt: task.createdAt,
		duration: task.duration,
		...(task.storyboardConfirmedAt === undefined ? {} : { storyboardConfirmedAt: task.storyboardConfirmedAt })
	});
	/** 每张图从当前平台引用读取，认证头仅发送给固定平台，不将私有URL交给方舟拉取。 */
	async function referenceData(token, scope, reference, download = true) {
		const relation = await detail(token, MENU.relation, reference.relationId);
		if (relation?._id !== reference.relationId || relation.spaceId !== scope.spaceId || relation.projectId !== scope.projectId || !id(relation.materialId)) throw new ApiError(`参考图“${reference.name}”不属于当前项目。`);
		const material = await detail(token, MENU.material, relation.materialId);
		if (material?._id !== relation.materialId || material.spaceId !== scope.spaceId || !["自有", "可商用"].includes(material.authorization)) throw new ApiError(`参考图“${reference.name}”尚未确认使用范围。`);
		if (generatedImagePending(material.sourceKind, material.sourceDescription)) throw new ApiError(`参考图“${reference.name}”是尚待人工确认的 AI 图片。`);
		const source = Number(material.revision) === Number(relation.sourceRevision) ? material : parse(relation.usageSnapshot);
		if (!object(source) || Number(source.revision) !== Number(relation.sourceRevision) || !id(source.fileId) || !["自有", "可商用"].includes(source.authorization) || ![
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
		].includes(source.mime)) throw new ApiError(`参考图“${reference.name}”文件、版本或格式无效。`);
		if (Number(source.width) > 0 && Number(source.height) > 0 && (source.width < 300 || source.width > 6e3 || source.height < 300 || source.height > 6e3 || source.width / source.height < .4 || source.width / source.height > 2.5)) throw new ApiError(`参考图“${reference.name}”宽高须为300–6000像素，宽高比须为0.4–2.5。`);
		if (!download) return source;
		const response = await transport(`${platform}/api/file/dowloadFile/${tenant}/${source.fileId}`, {
			headers: { Authorization: token },
			redirect: "error",
			signal: AbortSignal.timeout(6e4)
		});
		if (!response.ok || Number(response.headers.get("content-length")) >= 30 * 1024 * 1024) throw new ApiError(`参考图“${reference.name}”下载失败或超过30MB。`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (!bytes.length || bytes.length >= 30 * 1024 * 1024 || response.headers.get("content-type")?.includes("text/html")) throw new ApiError(`参考图“${reference.name}”返回内容无效。`);
		return `data:${source.mime};base64,${bytes.toString("base64")}`;
	}
	/** 音色只取当前可读的共享/本空间目录；实际解码核对时长，不信任调用方 URL 或时长。 */
	async function audioData(token, scope, reference) {
		const voice = await detail(token, MENU.voice, reference.voiceId);
		if (voice?._id !== reference.voiceId || (voice.spaceId && voice.spaceId !== scope.spaceId)
			|| !id(voice.fileId) || !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(voice.mime))
			throw new ApiError(`旁白音色“${reference.name}”不可用或不属于当前空间。`, 403);
		const response = await transport(`${platform}/api/file/dowloadFile/${tenant}/${voice.fileId}`, {
			headers: { Authorization: token }, redirect: "error", signal: AbortSignal.timeout(60000)
		});
		if (!response.ok || !response.body) throw new ApiError(`旁白音色“${reference.name}”下载失败。`);
		const chunks = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > 15 * 1024 * 1024) throw new ApiError("旁白参考音频不能超过15MB。");
			chunks.push(chunk);
		}
		const bytes = Buffer.concat(chunks);
		const metadata = await parseBuffer(bytes, { mimeType: voice.mime }, { duration: true });
		const duration = metadata.format.duration;
		if (!Number.isFinite(duration) || duration < 2 || duration > 30)
			throw new ApiError(`旁白音色“${reference.name}”的样音须为2–30秒。`);
		const mime = voice.mime.includes("wav") ? "audio/wav" : "audio/mp3";
		return { duration, url: `data:${mime};base64,${bytes.toString("base64")}` };
	}
	async function submit(token, input) {
		if (!apiKey) throw new ApiError("视频服务尚未配置 ARK_API_KEY，请由服务端配置后再生成。", 503);
		const { plan, project } = await authorize(token, input);
		if (!id(input.batchId) || !/^[a-zA-Z0-9-]{8,100}$/u.test(input.requestId || "")) throw new ApiError("批次或请求编号无效。");
		const previous = await readTask(input, input.requestId);
		if (previous) {
			if (previous.batchId !== input.batchId) throw new ApiError("该请求编号已经用于其他批次，请核对原任务。");
			return view(previous);
		}
		const stamps = parse(plan.stageConfirmations);
		if (!stamps?.storyboard?.at || stamps.storyboard.formRevision !== Number(project.formRevision) || Number(project.formRevision) !== Number(project.confirmedFormRevision)) throw new ApiError("请先确认当前需求、脚本和分镜。");
		const batch = await detail(token, MENU.batch, input.batchId);
		if (batch?.spaceId !== input.spaceId || batch.projectId !== input.projectId || batch.planId !== input.planId) throw new ApiError("生成批次不属于当前方案。", 403);
		const { prompt, generation } = decodeGenerationPrompt(batch.prompt || "");
		if (!generation) throw new ApiError("请先保存本批次参考图片、用途与生成设置。");
		const fullPrompt = `${plan.globalPrompt?.trim() ? `全片约束：\n${plan.globalPrompt.trim()}\n\n` : ""}${prompt}`;
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
		const requiredAssets = new Set(allShots.flatMap((shot) => parse(shot.assetObjectIds || "[]") || []));
		const requiredPictures = [...allShots.map((shot) => shot.storyboardImageRefId), ...assets.filter((asset) => requiredAssets.has(asset._id)).map((asset) => asset.imageRefId)];
		if (requiredPictures.some((value) => !id(value))) throw new ApiError("分镜或所需资产图片尚未补齐。");
		for (const relationId of new Set(requiredPictures)) await referenceData(token, input, {
			relationId,
			name: "分镜或资产图片"
		}, false);
		const batchShots = allShots.filter((shot) => shot.videoBatchId === input.batchId);
		const duration = batchShots.reduce((sum, shot) => sum + Number(shot.expectedSeconds), 0);
		const audioReferences = generation.audioReferences ?? [];
		const sound = [];
		const usedAudio = new Set();
		let start = 0;
		for (const shot of batchShots) {
			const end = start + Number(shot.expectedSeconds);
			const detail = parse(shot.scriptDetail);
			const speech = narrationForShot({ detail }, decodeStoryboardSupplement(shot.supplement || "").speech);
			for (const line of speech) {
				const index = audioReferences.findIndex(reference => reference.voiceId === line.voiceId && reference.speakerIds.includes(line.speakerId));
				if (index < 0 || !generation.generateAudio) throw new ApiError("请先在分镜资产为每位旁白选择音色并开启生成音频。");
				usedAudio.add(index);
				sound.push(`${start}–${end}秒 ${line.speakerName}参考@音频${index + 1}，只朗读一次：“${line.text}”`);
			}
			for (const [key, label] of [["music", "音乐"], ["soundEffects", "音效"], ["subtitle", "字幕"]]) {
				if (detail?.[key]) sound.push(`${start}–${end}秒 ${label}：${detail[key]}`);
			}
			start = end;
		}
		if (audioReferences.some((_reference, index) => !usedAudio.has(index)))
			throw new ApiError("参考音频必须对应本批脚本中的真实旁白角色。");
		const finalPrompt = sound.length ? `${fullPrompt}\n\n已确认脚本声音与字幕（优先按此时间段执行，不朗读样音示例）：\n${sound.join("\n")}` : fullPrompt;
		buildSeedanceRequest(generation, finalPrompt, duration, generation.references.map(() => "pending"), audioReferences.map(() => "pending"));
		const urls = [];
		let encodedSize = 0;
		for (const reference of generation.references) {
			const url = await referenceData(token, input, reference);
			encodedSize += url.length;
			if (encodedSize > 63 * 1024 * 1024) throw new ApiError("参考图编码后超过方舟64MB请求体上限，请减小图片文件。");
			urls.push(url);
		}
		const audioUrls = [];
		let audioDuration = 0;
		for (const reference of audioReferences) {
			const audio = await audioData(token, input, reference);
			audioDuration += audio.duration;
			if (audioDuration > 30) throw new ApiError("参考音频总时长超过30秒，请选择更短的音色样音或分批生成。");
			audioUrls.push(audio.url);
		}
		const request = buildSeedanceRequest(generation, finalPrompt, duration, urls, audioUrls);
		if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024 * 1024) throw new ApiError("图片和音频合计超过64MB，请减少本批参考素材。");
		const task = {
			requestId: input.requestId,
			tenantId: tenant,
			batchId: input.batchId,
			spaceId: input.spaceId,
			projectId: input.projectId,
			planId: input.planId,
			model: SEEDANCE_MODEL,
			status: "submitting",
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			duration,
			storyboardConfirmedAt: Number(stamps.storyboard.at)
		};
		await mkdir(directory, { recursive: true });
		try {
			await mkdir(`${taskPath(input, input.requestId)}.lock`);
		} catch (error) {
			if (error.code === "EEXIST") return view(await readTask(input, input.requestId) || task);
			throw error;
		}
		await store(input, task);
		try {
			const response = await transport("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(9e4)
			});
			const data = await response.json();
			if (!response.ok || !data.id) {
				task.status = "failed";
				task.error = data.error?.message || "方舟未接受生成任务。";
			} else {
				task.id = data.id;
				task.status = "queued";
			}
		} catch {
			task.status = "unknown";
			task.error = "提交结果未确认，请在方舟控制台核对后再新建任务，当前请求不会自动重发。";
		}
		await store(input, task);
		return view(task);
	}
	async function refresh(token, input) {
		await authorize(token, input);
		const task = await readTask(input, input.requestId);
		if (!task) throw new ApiError("没有找到当前项目的生成任务。", 404);
		if (!task.id || terminal.has(task.status)) return view(task);
		if (!apiKey) throw new ApiError("视频服务尚未配置 ARK_API_KEY。", 503);
		const response = await transport(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${encodeURIComponent(task.id)}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(3e4)
		});
		const data = await response.json();
		if (!response.ok) throw new ApiError(data.error?.message || "查询方舟任务失败。", 502);
		task.status = data.status;
		task.error = data.error?.message || "";
		if (data.status === "succeeded") task.videoUrl = data.content?.video_url || "";
		await store(input, task);
		return view(task);
	}
	async function list(token, input) {
		await authorize(token, input);
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
			if (task.tenantId === tenant && task.spaceId === input.spaceId && task.projectId === input.projectId && task.planId === input.planId) tasks.push(view(task));
		}
		return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	return {
		submit,
		refresh,
		list
	};
}
