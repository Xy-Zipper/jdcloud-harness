/** 造物片场媒体 Host 插件：Skill 工具与前端按钮共用已认证生成和入库实现。 */
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { createHarnessMediaRuntime } from './runtime.mjs';
export const name = 'creation-studio-media';
export const inject = ['attachments', 'credentials', 'jdcloudAuthController', 'tools', 'webServer'];
export const Config = z.object({
    platformURL: z.string().required(),
    tenantId: z.string().required(),
    stateDirectory: z.string().required(),
    imageModel: z.string().default('gpt-image-2.5'),
    imageRetryLimit: z.natural().default(2),
    imageKeyRef: z.string().default('GPT_IMAGE_API_KEY'),
    arkKeyRef: z.string().default('ARK_API_KEY'),
});
const prefix = '/api/external/v1/creation-studio/media/';
const operations = ['config', 'images/generate', 'images/tasks', 'images/refresh', 'images/list', 'video/tasks', 'video/refresh', 'video/list'];
/** 工具只能操作本轮真实用户消息绑定的项目，工具结果不能重绑定项目上下文。 */
function assertProjectTurn(exec, args, tenantId) {
    const event = exec.agent?.session.snapshotEvents().findLast((event) => event.type === 'user/message' && event.data.source?.kind === 'user');
    const content = event?.data.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '';
    const message = content.trim().startsWith('/') ? content.slice(content.indexOf('\n') + 1) : content;
    let context;
    try {
        context = JSON.parse(message).context;
    }
    catch {
        throw new Error('媒体工具需要造物片场当前项目的请求上下文，请在项目阶段中调用。');
    }
    if (context?.projectId !== args.projectId || context.spaceId !== args.spaceId || context.tenantId !== tenantId
        || (context.planId && context.planId !== args.planId)) {
        throw new Error('媒体工具参数不属于本轮项目、方案或空间。');
    }
}
/**
 * Register authenticated media routes and tools; dispose waits for pending receipts.
 * @param ctx - Host services including JDCloud authentication and credentials.
 * @param config - Fixed platform, task storage, and credential references.
 */
export function apply(ctx, config) {
    const origin = new URL(config.platformURL);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
        || !/^[a-f0-9]{24}$/iu.test(config.tenantId)) {
        throw new Error('媒体插件平台地址或租户配置无效。');
    }
    const runtime = createHarnessMediaRuntime({ ...config, stateDirectory: resolve(config.stateDirectory) }, ctx.jdcloudAuthController, async (ref) => (await ctx.credentials.resolve(credentialRef(ref)))?.value || '', async (bytes, mediaType) => {
        // 复用 Harness 的真实图片解码与尺寸核验，入库仍上传原始生成字节。
        const image = await ctx.attachments.saveImage({ data: bytes, mediaType });
        const dimensions = image.originalDimensions ?? image;
        return { width: dimensions.width, height: dimensions.height };
    });
    ctx.effect(() => () => runtime.close(), 'creation-studio-media:pending-operations');
    for (const operation of operations) {
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: `${prefix}${operation}`,
            async handler(req, res) {
                const send = (status, data) => {
                    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify(data));
                };
                try {
                    if (req.method !== 'POST')
                        return send(405, { code: 405, message: '请使用 POST。' });
                    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/iu, '');
                    const tenant = req.headers['x-tenant-id'];
                    const base = req.headers['x-jdcloud-base-url'];
                    if (!token || tenant !== config.tenantId || base?.replace(/\/$/u, '') !== config.platformURL.replace(/\/$/u, ''))
                        return send(401, { code: 401, message: '媒体请求的登录、服务地址或租户不匹配。' });
                    const chunks = [];
                    let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 128 * 1024)
                            return send(413, { code: 413, message: '媒体请求过大。' });
                        chunks.push(chunk);
                    }
                    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    const data = await ctx.jdcloudAuthController.runExternalRequest(token, tenant, config.platformURL, AbortSignal.timeout(420_000), () => runtime.run(operation, input));
                    send(200, { code: 200, data });
                }
                catch (error) {
                    const failure = error;
                    send(failure.status || 400, { code: failure.status || 400, ...(failure.code ? { errorCode: failure.code } : {}), message: failure.message || '媒体任务执行失败。' });
                }
            },
        }), `creation-studio-media:${operation}`);
    }
    const scope = {
        projectId: { type: 'string', required: true, description: '当前项目的完整记录 ID。' },
        planId: { type: 'string', required: true, description: '当前采纳方案的完整记录 ID。' },
        spaceId: { type: 'string', required: true, description: '当前项目团队空间的完整记录 ID。' },
    };
    const register = (toolName, description, parameters, execute) => ctx.effect(() => ctx.tools.register(defineTool({
        name: toolName,
        description,
        parameters,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute,
        presentCall: () => ({ card: 'generic', title: description, kind: 'other' }),
    })), toolName);
    register('creation_studio_image_generate', '为当前分镜或资产生成图片并上传项目素材；默认自有，仍须用户确认画面。', { ...scope, requestId: { type: 'string', required: true, description: '稳定请求编号；重试必须沿用，不重新付费。' }, prompt: { type: 'string', required: true, description: '图片描述，说明各参考图片的职责。' }, size: { type: 'string', required: true, enum: ['1024x1024', '1024x1536', '1536x1024'] }, referenceIds: { type: 'array', required: true, items: { type: 'string' }, description: '当前项目真实图片引用 ID，按图1、图2顺序。' } }, (args, exec) => {
        assertProjectTurn(exec, args, config.tenantId);
        return runtime.run('images/generate', args);
    });
    register('creation_studio_image_task', '提交、查询或列出 GPT Image 2.5 异步图片任务；多图先逐个提交，完成后上传项目素材，仍须人工确认。',
        { ...scope, action: { type: 'string', required: true, enum: ['submit', 'refresh', 'list'] },
            requestId: { type: 'string', description: '提交和查询必填，先写入分镜图片项的稳定 requestId；重试必须沿用。' },
            prompt: { type: 'string', description: '提交必填，说明参考图片的职责和需要保持的产品外观。' },
            size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'] },
            referenceIds: { type: 'array', items: { type: 'string' }, description: '提交必填，当前项目真实图片引用 ID，按顺序对应参考图；没有参考时传空数组。' } },
        async ({ action, ...args }, exec) => {
            assertProjectTurn(exec, args, config.tenantId);
            const result = await runtime.run(action === 'submit' ? 'images/tasks' : action === 'refresh' ? 'images/refresh' : 'images/list', args);
            return action === 'list' ? { tasks: result } : result;
        });
    register('creation_studio_video_task', '提交、查询或列出已保存批次的 Seedance 2.5 参考生视频任务；完成后上传项目素材。', { ...scope, action: { type: 'string', required: true, enum: ['submit', 'refresh', 'list'] }, requestId: { type: 'string', description: '提交及查询使用的稳定请求编号。' }, batchId: { type: 'string', description: '提交时必填，当前方案已保存的视频批次 ID。' } }, async ({ action, ...args }, exec) => {
        assertProjectTurn(exec, args, config.tenantId);
        const result = await runtime.run(action === 'submit' ? 'video/tasks' : action === 'refresh' ? 'video/refresh' : 'video/list', args);
        return action === 'list' ? { tasks: result } : result;
    });
}
