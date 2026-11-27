// @vitest-environment node
import { readFile, rm, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
// The migrated JavaScript is loaded from source; URL imports avoid built declarations in source tests.
const { createHarnessMediaRuntime } = await import(new URL('../src/runtime.mjs', import.meta.url).href);
const { requestGptImage } = await import(new URL('../src/images.mjs', import.meta.url).href);
const { createBillingRecorder } = await import(new URL('../src/billing-recorder.mjs', import.meta.url).href);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const { frontendHash } = await import(new URL('../src/upstream.mjs', import.meta.url).href);
import { decodeGenerationPrompt, encodeGenerationPrompt, SEEDANCE_MODELS } from '../src/seedance-request.mjs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VZkAAAAASUVORK5CYII=';
const originalImageUrl = 'https://result.tos-cn-beijing.volces.com/original.png';
const seedreamResult = () => Response.json({ created: Math.floor(Date.now() / 1000), data: [{ url: originalImageUrl }] });
const originalImageBytes = () => new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
it('sends one Bearer prefix and no inferred Content-Type on URL reference edits', async () => {
    const transport = vi.fn(async (url, init) => {
        const request = new Request(url, init);
        expect(request.headers.get('authorization')).toBe('Bearer image-secret');
        expect(request.headers.get('content-type')).toBeNull();
        expect(await request.json()).toMatchObject({ images: ['https://platform.example/reference.jpg'], model: 'gpt-image-2.5' });
        return Response.json({ data: [{ b64_json: png }] });
    });
    await requestGptImage(' Bearer image-secret ', 'gpt-image-2.5', { prompt: 'reference', size: '1024x1024' },
        [{ url: 'https://platform.example/reference.jpg' }], transport);
});
async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'harness-media-'));
    roots.push(directory);
    // JSON wire fixtures include extensible low-code fields; the runtime validates them.
    const f = JSON.parse(await readFile(new URL('./project.fixture.json', import.meta.url), 'utf8'));
    const ref = f.imageReferences[0];
    const batchId = 'b'.repeat(24);
    f.plan.consistency = 'product unchanged';
    f.rows.forEach((row) => { row.videoBatchId = batchId; row.prompt = 'product'; row.storyboardImageRefId = ref.relationId; row.assetObjectIds = []; });
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.storyboard = { ...stamps.script, at: stamps.script.at + 1, storyboardHash: frontendHash({
            consistency: f.plan.consistency, assets: [], shots: f.rows.map((row, index) => ({
                code: `SHOT-${String(index + 1).padStart(2, '0')}`, prompt: row.prompt, supplement: '', assetIds: [], imageRefId: ref.relationId,
            })),
        }) };
    f.plan.stageConfirmations = JSON.stringify(stamps);
    const batch = { _id: batchId, projectId: f.project._id, planId: f.plan._id, spaceId: f.project.spaceId,
        prompt: encodeGenerationPrompt('参考@图片1生成全新广告', { ratio: '9:16', resolution: '720p', generateAudio: true, watermark: true,
            references: [{ relationId: ref.relationId, name: 'product.png', purpose: 'product identity' }] }) };
    const records = new Map([
        [f.project._id, f.project], [f.plan._id, f.plan], [batchId, batch],
        [ref.relationId, { _id: ref.relationId, materialId: ref.materialId, projectId: f.project._id, spaceId: f.project.spaceId, sourceRevision: 1 }],
        [ref.materialId, { _id: ref.materialId, spaceId: f.project.spaceId, ...ref, library: 'project', sourceKind: 'uploaded', revision: 1 }],
    ]);
    const priceRows = [
        { scenario: 'image', provider: 'ark', modelKey: 'doubao-seedream-5-0-pro-260628', billingUnit: 'image', imagePerUnitYuan: '2' },
        { scenario: 'video', provider: 'ark', modelKey: 'doubao-seedance-2-5-260628', billingUnit: 'million_tokens', videoPerMillionYuan: '100' },
    ].map((row, index) => ({ ...row, _id: String(index).repeat(24), pricingStatus: 'published', currency: 'CNY' }));
    let counter = 0, imageCalls = 0, videoCalls = 0, uploads = 0;
    let failRelation = false, denyWrite = false;
    const auth = {
        status: async () => ({ authenticated: true, corpId: f.requirement._meta.tenantId, baseUrl: 'https://platform.example' }),
        currentScopeKey: async () => 'owner',
        writableMenus: async (signal) => {
            expect(signal).toBeInstanceOf(AbortSignal);
            return { menus: ['6ad81c871f280486bb45ac43', '6ad81c871f280486bb45ac45'].map(menuId => ({ menuId, agentPermissions: denyWrite ? [] : ['addData'] })) };
        },
        downloadFileAuthenticated: vi.fn(async () => new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })),
        requestAuthenticated: vi.fn(async (request) => {
            if (request.path === '/api/oauth/currentUser')
                return { userInfo: { id: 'owner', corpId: f.requirement._meta.tenantId } };
            if (request.path === '/api/file/uploader') {
                uploads++;
                return { name: request.multipartFile.name, url: `/api/file/previewImage/${f.requirement._meta.tenantId}/${'f'.repeat(24)}` };
            }
            if (request.path.endsWith('/form/info'))
                return records.get(request.body._id);
            if (request.path.endsWith('/form/list')) {
                if (request.body.menuId === '6ad81c871f280486bb45ac59') return { list: priceRows };
                if (request.body.menuId === '6ad81c871f280486bb45ac5b') return { list: [...records.values()].filter(row => row.usageEventKey
                    && request.body.filter.every(item => row[item.enCode] === item.value)) };
                return { list: request.body.menuId === '6ad81c871f280486bb45ac4b' ? f.rows : [] };
            }
            if (request.path.endsWith('/form/update')) {
                expect(request.method).toBe('PUT');
                Object.assign(records.get(request.body._id), JSON.parse(request.body.data));
                return request.body._id;
            }
            if (request.path.endsWith('/form/create')) {
                if (failRelation && request.body.menuId === '6ad81c871f280486bb45ac45') {
                    failRelation = false;
                    throw new Error('relation failed');
                }
                const id = String(++counter).padStart(24, 'c');
                records.set(id, { _id: id, ...JSON.parse(request.body.data) });
                return id;
            }
            return { _id: f.project.spaceId, ownerUserId: 'owner', status: 'active' };
        }),
    };
    // Space shares a separate ID and must resolve before the generic detail lookup.
    records.set(f.project.spaceId, { _id: f.project.spaceId, ownerUserId: 'owner', status: 'active', points: '20' });
    const provider = vi.fn(async (url, init = {}) => {
        expect(String(init.headers?.Authorization || '')).not.toContain('platform');
        if (url.endsWith('/images/generations')) {
            imageCalls++;
            const body = JSON.parse(init.body);
            return Response.json(body.response_format === 'url'
                ? { created: Math.floor(Date.now() / 1000), data: [{ url: 'https://result.tos-cn-beijing.volces.com/original.png' }] }
                : { data: [{ b64_json: png }] });
        }
        if (url === 'https://result.tos-cn-beijing.volces.com/original.png')
            return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
        if (url.includes('/api/file/previewImage/')) {
            expect(init.headers).toBeUndefined();
            return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
        }
        if (url.includes('contents/generations/tasks')) {
            if (init.method === 'POST') {
                videoCalls++;
                return Response.json({ id: 'task-id' });
            }
            return Response.json({ status: 'succeeded', usage: { completion_tokens: 144512, total_tokens: 144512 },
                resolution: '480p', generate_audio: true, service_tier: 'default',
                content: { video_url: 'https://result.tos-cn-beijing.volces.com/result.mp4' } });
        }
        return new Response(Buffer.from('0000ftypisom-video-bytes'), { headers: { 'content-type': 'video/mp4' } });
    });
    const config = { platformURL: 'https://platform.example', tenantId: f.requirement._meta.tenantId, stateDirectory: directory,
        imageModel: 'doubao-seedream-5-0-pro-260628', imageKeyRef: 'GPT_IMAGE_API_KEY', arkKeyRef: 'ARK_API_KEY' };
    const runtime = (billing, poolRows) => createHarnessMediaRuntime(config, auth, async (key) =>
        key === 'ARK_API_KEY' ? 'ark-key' : key === 'GPT_IMAGE_API_KEY' ? 'gpt-key'
            : key === 'CREATION_STUDIO_ACCOUNT_POOL_TOKEN' && poolRows ? 'reader-token' : '',
        async () => ({ width: 1024, height: 1024 }), async (url, init = {}) => {
            if (poolRows && url.startsWith('https://platform.example') && !url.includes('/api/file/')) {
                expect(init.headers.Authorization).toBe('reader-token');
                return Response.json({ code: 200, data: init.method === 'GET'
                    ? { userInfo: { corpId: config.tenantId } }
                    : { list: poolRows.filter(row => row.provider === JSON.parse(init.body).filter[0].value) } });
            }
            return provider(url, init);
        }, billing);
    const input = { projectId: f.project._id, planId: f.plan._id, spaceId: f.project.spaceId, requestId: 'request-test-001' };
    return { ...f, config, auth, provider, records, runtime, input, batchId, priceRows,
        failNextRelation() { failRelation = true; }, denyWrites() { denyWrite = true; },
        counts: () => ({ imageCalls, videoCalls, uploads }) };
}

it.each(['direct', 'wrapped'])('routes Seedance 2.5 to Malanshan and refreshes a %s receipt with the reserved Key', async (format) => {
    const f = await setup();
    const rows = [
        { _id: '8'.repeat(24), accountCode: 'MLS-A', provider: 'malanshan', models: [SEEDANCE_MODELS[0].value],
            scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'Bearer mls-fixture' },
        { _id: '9'.repeat(24), accountCode: 'ARK-VIDEO', provider: 'ark', models: SEEDANCE_MODELS.slice(0, 2).map(model => model.value),
            scenarios: ['video'], enabled: 1, maxConcurrent: 2, apiKey: 'ark-fixture' },
    ];
    const endpoint = 'https://maas.mlsvcloud.com:8559/maas/ai/aiFactoryServer/v1/apis/1/seedance-2-5FromBot:1.1/ark/api/v3/contents/generations';
    const malanshanTaskId = 'cgt-20261119105331-0lg3k';
    const respond = data => Response.json(format === 'wrapped' ? { code: 200, msg: '请求成功', data } : data);
    let lookupUnavailable = true;
    f.provider.mockImplementation(async (url, init) => {
        if (url.includes('/api/file/previewImage/'))
            return originalImageBytes();
        if (url === `${endpoint}/tasks`) {
            expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer mls-fixture' } });
            const body = JSON.parse(init.body);
            expect(body).toMatchObject({ model: 'doubao-seedance-2-5-bot-THD', generate_audio: true, output_format: 'mp4', resolution: '720p', duration: 15 });
            expect(body).not.toHaveProperty('omni_reference_task_type');
            expect(body.content[1]).toMatchObject({ type: 'image_url', role: 'reference_image' });
            return respond({ id: malanshanTaskId });
        }
        if (url === `${endpoint}/tasksGet/${malanshanTaskId}`) {
            expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer mls-fixture' } });
            if (lookupUnavailable) {
                lookupUnavailable = false;
                return Response.json({ code: 500, msg: '请求失败', data: { error: { code: 'NotFound.TaskId', message: 'The specified Task is not found.' } } });
            }
            return respond({ id: malanshanTaskId, status: 'succeeded', model: 'doubao-seedance-2-5', usage: { completion_tokens: 108900 },
                content: { video_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4' } });
        }
        if (url === 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4') {
            expect(init.headers).toBeUndefined();
            return new Response(Buffer.from('0000ftypisom-video-bytes'), { headers: { 'content-type': 'video/mp4' } });
        }
        if (url === 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks') {
            expect(init.headers.Authorization).toBe('Bearer ark-fixture');
            expect(SEEDANCE_MODELS.slice(0, 2).map(model => model.value)).toContain(JSON.parse(init.body).model);
            return Response.json({ id: 'ark-task' });
        }
        throw new Error('Unexpected provider call');
    });
    const batch = { ...f.input, batchId: f.batchId };
    const runtime = f.runtime(undefined, rows);
    try {
        rows[0].scenarios = ['image', 'video'];
        expect((await runtime.run('config')).video).toMatchObject({ configured: true, providers: {}, availability: {
            [SEEDANCE_MODELS[0].value]: { configured: false, message: expect.stringContaining('视频生成') },
            [SEEDANCE_MODELS[1].value]: { configured: true },
            [SEEDANCE_MODELS[2].value]: { configured: false },
        } });
        await expect(runtime.run('video/tasks', batch)).rejects.toMatchObject({ code: 'accounts/malanshan-scenarios' });
        rows[0].scenarios = ['video'];
        expect((await runtime.run('config')).video.providers).toEqual({ [SEEDANCE_MODELS[0].value]: 'malanshan' });
        await expect(runtime.run('video/tasks', { ...batch, expectedProvider: 'ark' })).rejects.toMatchObject({
            code: 'video/provider-changed', submissionState: 'not-submitted',
        });
        expect(await runtime.run('video/tasks', { ...batch, expectedProvider: 'malanshan' })).toMatchObject({ provider: 'malanshan', id: malanshanTaskId, status: 'queued' });
        expect(await runtime.run('video/tasks', batch)).toMatchObject({ id: malanshanTaskId });
        expect(await runtime.run('video/tasks', { ...batch, requestId: 'full-malanshan' })).toMatchObject({ provider: 'malanshan', errorCode: 'accounts/busy' });
        const batchRow = f.records.get(f.batchId);
        const saved = decodeGenerationPrompt(batchRow.prompt);
        batchRow.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model: SEEDANCE_MODELS[1].value });
        expect(await runtime.run('video/tasks', { ...batch, requestId: 'ark-20-new-task' })).toMatchObject({ provider: 'ark', id: 'ark-task' });
        rows[0].enabled = 0;
        expect((await runtime.run('config')).video.providers).toEqual({ [SEEDANCE_MODELS[0].value]: 'ark' });
        batchRow.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model: SEEDANCE_MODELS[0].value });
        expect(await runtime.run('video/tasks', { ...batch, requestId: 'ark-25-new-task' })).toMatchObject({ provider: 'ark', id: 'ark-task' });
    } finally { await runtime.close(); }
    const restarted = f.runtime(undefined, rows);
    try {
        await expect(restarted.run('video/refresh', batch)).rejects.toMatchObject({
            code: 'video/malanshan-task-response', message: expect.stringContaining('NotFound.TaskId'),
        });
        expect(await restarted.run('video/refresh', batch)).toMatchObject({ status: 'succeeded', provider: 'malanshan',
            model: SEEDANCE_MODELS[0].value, providerAccountRef: 'MLS-A', usage: { completion_tokens: 108900 }, videoFileId: expect.any(String) });
        expect(f.provider.mock.calls.filter(([url]) => url === `${endpoint}/tasks`)).toHaveLength(1);
    } finally { await restarted.close(); }
});

it.each([
    { status: 200, body: '{}', errorCode: 'video/malanshan-task-id-missing', outcome: 'unknown', detail: '没有可用的任务 ID' },
    { status: 200, body: '{"code":500,"msg":"请求失败","data":{"id":"cgt-not-confirmed"}}', errorCode: 'video/malanshan-task-id-missing', outcome: 'unknown', detail: '马栏山业务码 500' },
    { status: 200, body: '{"code":500,"msg":"上游未返回结果","data":null}', errorCode: 'video/malanshan-task-id-missing', outcome: 'unknown', detail: '上游未返回结果' },
    { status: 200, body: '{"code":500,"msg":"请求失败","data":{"error":{"code":"InternalError","message":"Service unavailable"}}}', errorCode: 'video/malanshan-task-id-missing', outcome: 'unknown', detail: 'InternalError' },
    { status: 200, body: '{"code":16067,"msg":"Signature information does not match"}', errorCode: 'video/malanshan-signature-mismatch', outcome: 'failed', detail: '签名校验未通过' },
    { status: 200, body: '{"code":500,"msg":"请求失败","data":{"error":{"code":"InvalidParameter","message":"Invalid media https://example.invalid/private?token=private with Bearer mls-fixture"}}}', errorCode: 'InvalidParameter', outcome: 'failed', detail: 'Invalid media [链接] with Bearer [已隐藏]' },
    { status: 503, body: '{"error":{"code":"unavailable"}}', errorCode: 'video/malanshan-gateway', outcome: 'unknown', detail: '马栏山网关异常' },
    { status: 502, body: 'unexpected reply', errorCode: 'video/malanshan-response-unreadable', outcome: 'unknown', detail: '无法解析' },
])('reports Malanshan $status $detail as $outcome', async ({ status, body, errorCode, outcome, detail }) => {
    const f = await setup();
    const config = { _id: '8'.repeat(24), accountCode: 'MLS-A', provider: 'malanshan', models: [SEEDANCE_MODELS[0].value],
        scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'mls-fixture' };
    f.provider.mockImplementation(async (url) => url.includes('/api/file/previewImage/') ? originalImageBytes()
        : new Response(body, { status, headers: { 'X-Request-Id': 'fixture-trace' } }));
    const runtime = f.runtime(undefined, [config]);
    const input = { ...f.input, batchId: f.batchId };
    try {
        const result = await runtime.run('video/tasks', input);
        expect(result).toMatchObject({ provider: 'malanshan', status: outcome, errorCode });
        expect(result.id).toBeUndefined();
        expect(result.error).toContain(detail);
        expect(result.error).toContain(`响应状态码 ${status}`);
        expect(result.error).toContain('网关追踪号 fixture-trace');
        expect(result.error).not.toMatch(/mls-fixture|private\?token/u);
        expect(await runtime.run('video/tasks', input)).toMatchObject({ status: outcome, errorCode });
        expect(await runtime.run('video/refresh', input)).toMatchObject({ status: outcome, errorCode });
        expect(f.provider.mock.calls.filter(([url]) => url.startsWith('https://maas.mlsvcloud.com:8559/'))).toHaveLength(1);
    } finally { await runtime.close(); }
});

it.each([200, 400])('maps a Malanshan portrait rejection over HTTP %i to the submitted reference', async (status) => {
    const f = await setup();
    const account = { _id: '8'.repeat(24), accountCode: 'MLS-A', provider: 'malanshan', models: [SEEDANCE_MODELS[0].value],
        scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'mls-fixture' };
    const errorCode = 'InputImageSensitiveContentDetected.PrivacyInformation';
    const requestNumber = '0217955784819' + 'a'.repeat(39);
    const providerReply = {
        msg: '请求参数有误',
        code: 400,
        data: { error: {
            code: errorCode,
            message: `The request failed because the input image 'content[1]' may contain real person. Request id: ${requestNumber}`,
            param: 'content[1]',
            type: 'BadRequest',
        } },
    };
    f.provider.mockImplementation(async url => url.includes('/api/file/previewImage/') ? originalImageBytes()
        : Response.json(providerReply, { status }));
    const runtime = f.runtime(undefined, [account]);
    const input = { ...f.input, batchId: f.batchId };
    try {
        const result = await runtime.run('video/tasks', input);
        expect(result).toMatchObject({ provider: 'malanshan', status: 'failed', errorCode });
        expect(result.id).toBeUndefined();
        expect(result.error).toContain('镜头1图（参考图1）');
        expect(result.error).toContain(requestNumber);
        expect(result.error).toContain('马栏山业务码 400');
        expect(result.error).not.toContain('product.png');
        expect(await runtime.run('video/refresh', input)).toMatchObject({ status: 'failed', errorCode, error: result.error });
        expect(await runtime.run('video/tasks', input)).toMatchObject({ status: 'failed', errorCode });
        expect(f.provider.mock.calls.filter(([url]) => url.startsWith('https://maas.mlsvcloud.com:8559/'))).toHaveLength(1);
    } finally { await runtime.close(); }
});

/** Adopt an actually generated and uploaded picture, preserving the real confirmation checks. */
async function originalPictureFixture(poolRows, referenceIds = []) {
    const f = await setup();
    const runtime = f.runtime(undefined, poolRows);
    const request = { ...f.input, prompt: '一位虚构的成年店员，正面人像', size: '1024x1024', referenceIds };
    await runtime.run('images/tasks', request);
    let task;
    await vi.waitFor(async () => {
        task = await runtime.run('images/refresh', f.input);
        expect(task.status).toBe('succeeded');
    });
    const image = task.result;
    const material = f.records.get(image.materialId);
    const description = JSON.parse(material.sourceDescription);
    description.generatedImage.confirmedAt = new Date().toISOString();
    material.sourceDescription = JSON.stringify(description);
    f.rows.forEach(row => { row.storyboardImageRefId = image.relationId; });
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.storyboard.storyboardHash = frontendHash({
        consistency: f.plan.consistency, assets: [], shots: f.rows.map((row, index) => ({
            code: `SHOT-${String(index + 1).padStart(2, '0')}`, prompt: row.prompt, supplement: '', assetIds: [], imageRefId: image.relationId,
        })),
    });
    f.plan.stageConfirmations = JSON.stringify(stamps);
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation,
        references: [{ relationId: image.relationId, name: '虚拟店员.png', purpose: '人物外观' }] });
    return { ...f, runtime, image, material, request };
}

it.each([false, true])('keeps the original Ark account check on Malanshan with link expired: %s', async (expired) => {
    const rows = [
        { _id: '8'.repeat(24), accountCode: 'MLS-A', provider: 'malanshan', models: [SEEDANCE_MODELS[0].value],
            scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'mls-fixture' },
        { _id: '9'.repeat(24), accountCode: 'ARK-IMAGE', provider: 'ark', models: ['doubao-seedream-5-0-pro-260628'],
            scenarios: ['image'], enabled: 1, maxConcurrent: 1, apiKey: 'ark-fixture' },
    ];
    const f = await originalPictureFixture(rows);
    try {
        if (expired) await setOriginalImageDates(f, 2, -24);
        await expect(f.runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toMatchObject({
            code: 'video/malanshan-original-image', submissionState: 'not-submitted',
        });
        expect(f.counts().videoCalls).toBe(0);
    } finally { await f.runtime.close(); }
});

it('sends uploaded reference URLs without putting large image bytes in the video request', async () => {
    const f = await setup();
    const ref = f.imageReferences[0];
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    const references = [ref, ...[1, 2].map(index => {
        const image = { ...ref, relationId: `9${index}`.repeat(12), materialId: `b${index}`.repeat(12), fileId: `c${index}`.repeat(12) };
        f.records.set(image.relationId, { ...f.records.get(ref.relationId), _id: image.relationId, materialId: image.materialId });
        f.records.set(image.materialId, { ...f.records.get(ref.materialId), _id: image.materialId, fileId: image.fileId });
        return image;
    })].map((image, index) => ({ relationId: image.relationId, name: `产品图${index + 1}`, purpose: '产品外观' }));
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, references });
    // Three 18 MiB inputs exceed 64 MiB when Base64 encoded, while their public URLs fit easily.
    const bytes = Buffer.alloc(18 * 1024 * 1024, 1);
    f.auth.downloadFileAuthenticated.mockImplementation(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
    const previous = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (url, init) => url.includes('/api/file/previewImage/')
        ? new Response(bytes, { headers: { 'content-type': 'image/png' } }) : previous(url, init));
    const runtime = f.runtime();
    try {
        expect((await runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).status).toBe('queued');
        const call = f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST');
        const body = JSON.parse(call[1].body);
        expect(body.content.filter(item => item.type === 'image_url').map(item => item.image_url.url)).toEqual(references.map(reference => {
            const image = f.records.get(f.records.get(reference.relationId).materialId);
            return `https://platform.example/api/file/previewImage/${f.config.tenantId}/${image.fileId}`;
        }));
        expect(Buffer.byteLength(call[1].body)).toBeLessThan(10000);
        expect(f.auth.downloadFileAuthenticated).not.toHaveBeenCalled();
        for (const [url, init] of f.provider.mock.calls.filter(([url]) => url.includes('/api/file/previewImage/'))) {
            expect(init.headers).toBeUndefined();
            expect(url).not.toMatch(/token|Authorization/u);
        }
        await expect(`${JSON.stringify(body.content.filter(item => item.type === 'image_url'), null, 2)}\n`)
            .toMatchFileSnapshot('./expected/uploaded-image-video-input.json');
    } finally { await runtime.close(); }
});

it.each(['unreadable', 'too-large'])('rejects a %s public image before creating a video task', async (failure) => {
    const f = await setup();
    const previous = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (url, init) => url.includes('/api/file/previewImage/')
        ? failure === 'unreadable' ? new Response('login required', { status: 403 })
            : new Response('oversized', { headers: { 'content-type': 'image/png', 'content-length': String(30 * 1024 * 1024) } })
        : previous(url, init));
    const runtime = f.runtime();
    try {
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toMatchObject({
            submissionState: 'not-submitted', code: failure === 'unreadable' ? 'video/reference-unreadable' : 'video/reference-too-large',
        });
        expect(f.counts().videoCalls).toBe(0);
        expect(await runtime.run('video/list', f.input)).toEqual([]);
    } finally { await runtime.close(); }
});

it('uses the provider original URL for a new image edit without treating it as trusted portrait text-to-image', async () => {
    const f = await originalPictureFixture(undefined, ['6'.repeat(24)]);
    const runtime = f.runtime;
    try {
        expect(f.image.generation.originalUrl).toBe(originalImageUrl);
        const task = await runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
        expect(task.status).toBe('queued');
        const call = f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST');
        expect(JSON.parse(call[1].body).content.find(item => item.type === 'image_url').image_url.url).toBe(originalImageUrl);
    } finally { await runtime.close(); }
});

it('sends the original text-to-image URL and original account after low-code upload and a Host restart', async () => {
    const f = await originalPictureFixture();
    expect(f.image.generation).toMatchObject({
        originalUrl: 'https://result.tos-cn-beijing.volces.com/original.png',
        providerAccountRef: 'ENV-ARK', referenceIds: [],
    });
    expect(f.image.generation.originalUrlExpiresAt).toBeTruthy();
    await f.runtime.close();
    const restored = createHarnessMediaRuntime(f.config, f.auth, async key => key === 'ARK_API_KEY' ? 'ark-key' : '',
        async () => ({ width: 1024, height: 1024 }), f.provider);
    const task = await restored.run('video/tasks', { ...f.input, batchId: f.batchId });
    expect(task.status).toBe('queued');
    const call = f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST');
    const request = JSON.parse(call[1].body);
    expect(request.content.filter(item => item.type === 'image_url')).toEqual([
        { type: 'image_url', image_url: { url: f.image.generation.originalUrl }, role: 'reference_image' },
    ]);
    await expect(`${JSON.stringify(request.content.filter(item => item.type === 'image_url'), null, 2)}\n`)
        .toMatchFileSnapshot('./expected/original-image-video-input.json');
    expect(f.auth.downloadFileAuthenticated).not.toHaveBeenCalled();
    expect(task.providerAccountRef).toBe('ENV-ARK');
    await restored.close();
});

it.each(['same material', 'same material after link expiry', 'another material', 'another space'])('resolves a copied project reference with %s', async (reuse) => {
    const f = await originalPictureFixture();
    const projectId = '31'.repeat(12);
    const planId = '32'.repeat(12);
    const referenceId = '33'.repeat(12);
    const spaceId = reuse === 'another space' ? '34'.repeat(12) : f.input.spaceId;
    const materialId = reuse === 'another material' ? '35'.repeat(12) : f.image.materialId;
    f.records.set(spaceId, { _id: spaceId, ownerUserId: 'owner', status: 'active', points: '20' });
    f.records.set(projectId, { ...f.project, _id: projectId, spaceId, adoptedPlanId: planId });
    f.records.set(materialId, { ...f.material, _id: materialId, spaceId });
    f.records.set(referenceId, { ...f.records.get(f.image.relationId), _id: referenceId, projectId, spaceId, materialId });
    for (const row of f.rows)
        Object.assign(row, { projectId, planId, spaceId, storyboardImageRefId: referenceId });
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.storyboard.storyboardHash = frontendHash({
        consistency: f.plan.consistency, assets: [], shots: f.rows.map(row => ({
            code: row.code, prompt: row.prompt, supplement: '', assetIds: [], imageRefId: referenceId,
        })),
    });
    f.records.set(planId, { ...f.plan, _id: planId, projectId, spaceId, stageConfirmations: JSON.stringify(stamps) });
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    Object.assign(batch, { projectId, planId, spaceId, prompt: encodeGenerationPrompt(saved.prompt, { ...saved.generation,
        references: [{ ...saved.generation.references[0], relationId: referenceId }] }) });

    try {
        const expired = reuse === 'same material after link expiry';
        if (expired) await setOriginalImageDates(f, 2, -24);
        const submission = f.runtime.run('video/tasks', { projectId, planId, spaceId, batchId: f.batchId, requestId: 'copied-video-001' });
        if (reuse.startsWith('same material')) {
            expect(await submission).toMatchObject({ status: 'queued', providerAccountRef: 'ENV-ARK' });
            const [, init] = f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST');
            const url = expired ? `${f.config.platformURL}/api/file/previewImage/${f.config.tenantId}/${f.image.fileId}` : originalImageUrl;
            expect(JSON.parse(init.body).content.filter(item => item.type === 'image_url')).toEqual([
                { type: 'image_url', image_url: { url }, role: 'reference_image' },
            ]);
            expect(f.counts().videoCalls).toBe(1);
        } else {
            await expect(submission).rejects.toMatchObject({ code: 'image/original-missing', submissionState: 'not-submitted' });
            expect(f.counts().videoCalls).toBe(0);
        }
        expect(f.counts().imageCalls).toBe(1);
    } finally { await f.runtime.close(); }
});

async function setOriginalImageDates(fixture, ageDays, hoursUntilLinkExpiry) {
    const files = await readdir(join(fixture.config.stateDirectory, 'images'));
    const path = join(fixture.config.stateDirectory, 'images', files.find(name => name.endsWith('.json')));
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    receipt.result.source.generatedAt = new Date(now - ageDays * 24 * hour).toISOString();
    receipt.result.source.originalUrlExpiresAt = new Date(now + hoursUntilLinkExpiry * hour).toISOString();
    await writeFile(path, JSON.stringify(receipt));
}

it.each([
    { mode: 'text-to-image', refs: [], ageDays: 2, model: 'doubao-seedance-2-0-fast-260128' },
    { mode: 'image editing', refs: ['6'.repeat(24)], ageDays: 32, model: 'doubao-seedance-2-5-260628' },
])('uses the bound low-code file for an expired $mode URL', async ({ refs, ageDays, model }) => {
    const f = await originalPictureFixture(undefined, refs);
    try {
        await setOriginalImageDates(f, ageDays, -24);
        const batch = f.records.get(f.batchId);
        const saved = decodeGenerationPrompt(batch.prompt);
        batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model });
        const url = `${f.config.platformURL}/api/file/previewImage/${f.config.tenantId}/${f.image.fileId}`;
        f.provider.mockClear();
        const task = await f.runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
        expect(task).toMatchObject({ status: 'queued', providerAccountRef: 'ENV-ARK', model });
        const urls = f.provider.mock.calls;
        expect(urls.find(([value]) => value === url)?.[1]).toMatchObject({ redirect: 'error' });
        expect(urls.find(([value]) => value === url)?.[1].headers).toBeUndefined();
        expect(urls.some(([value]) => value === originalImageUrl)).toBe(false);
        const call = urls.find(([value, init]) => value.includes('contents/generations/tasks') && init.method === 'POST');
        expect(JSON.parse(call[1].body).content.filter(item => item.type === 'image_url')).toEqual([
            { type: 'image_url', image_url: { url }, role: 'reference_image' },
        ]);
        expect(f.counts()).toMatchObject({ imageCalls: 1, videoCalls: 1 });
        expect(f.auth.downloadFileAuthenticated).not.toHaveBeenCalled();
    } finally { await f.runtime.close(); }
});

it.each(['forbidden response', 'network failure'])('stops before generation for a low-code %s', async (failure) => {
    const f = await originalPictureFixture();
    try {
        await setOriginalImageDates(f, 2, -24);
        const previous = f.provider.getMockImplementation();
        f.provider.mockImplementation(async (url, init) => {
            if (!url.includes('/api/file/previewImage/')) return previous(url, init);
            if (failure === 'network failure') throw new Error('Asset server unreachable');
            return new Response('login required', { status: 403 });
        });
        await expect(f.runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toMatchObject({
            code: 'video/reference-unreadable', submissionState: 'not-submitted', message: expect.stringContaining('低代码图片地址'),
        });
        expect(f.counts().videoCalls).toBe(0);
    } finally { await f.runtime.close(); }
});

it('reports when the text-to-image trust window itself has expired', async () => {
    const f = await originalPictureFixture();
    try {
        await setOriginalImageDates(f, 31, -24);
        await expect(f.runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toMatchObject({
            code: 'image/original-expired', submissionState: 'not-submitted',
            message: expect.stringContaining('镜头1图（参考图1）的火山原图受信期已过期'),
        });
        expect(f.counts()).toMatchObject({ imageCalls: 1, videoCalls: 0 });
        expect(f.auth.downloadFileAuthenticated).not.toHaveBeenCalled();
    } finally { await f.runtime.close(); }
});

it('refuses a changed platform file without the matching Host upload binding', async () => {
    const f = await originalPictureFixture();
    f.material.fileId = '0'.repeat(24);
    await expect(f.runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toMatchObject({
        code: 'image/original-invalid', message: expect.stringMatching(/^镜头1图（参考图1）原始产物/u),
    });
    expect(f.counts().videoCalls).toBe(0);
    await f.runtime.close();
});

it('rejects mixed original generating accounts before a video provider call', async () => {
    const poolRows = [1, 2].map(index => ({
        _id: String(index).repeat(24), accountCode: `ARK-${index}`, provider: 'ark',
        models: ['doubao-seedream-5-0-pro-260628', 'doubao-seedance-2-5-260628'],
        scenarios: ['image', 'video'], enabled: 1, maxConcurrent: 1, apiKey: `key-${index}`,
    }));
    const f = await originalPictureFixture(poolRows);
    poolRows.find(row => row.accountCode === f.image.generation.providerAccountRef).enabled = 0;
    const request = { ...f.request, requestId: 'another-original-image' };
    await f.runtime.run('images/tasks', request);
    let second;
    await vi.waitFor(async () => {
        const task = await f.runtime.run('images/refresh', request);
        expect(task.status).toBe('succeeded');
        second = task.result;
    });
    const material = f.records.get(second.materialId);
    const description = JSON.parse(material.sourceDescription);
    description.generatedImage.confirmedAt = new Date().toISOString();
    material.sourceDescription = JSON.stringify(description);
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation,
        references: [...saved.generation.references, { relationId: second.relationId, name: '另一张人像', purpose: '人物外观' }] });
    await expect(f.runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('不同方舟账号');
    expect(f.counts().videoCalls).toBe(0);
    await f.runtime.close();
});

it('keeps the paid original receipt when downloading fails and recovers it without another generation', async () => {
    const f = await setup();
    const provider = f.provider.getMockImplementation();
    let denyDownload = true;
    f.provider.mockImplementation((url, init) => url === originalImageUrl && denyDownload
        ? Promise.resolve(new Response('unavailable', { status: 503 })) : provider(url, init));
    const runtime = f.runtime();
    const request = { ...f.input, prompt: '虚拟人物', size: '1024x1024', referenceIds: [] };
    await runtime.run('images/tasks', request);
    let task;
    await vi.waitFor(async () => {
        task = await runtime.run('images/refresh', f.input);
        expect(task.status).toBe('upload_failed');
    });
    denyDownload = false;
    const recovered = await runtime.run('images/refresh', f.input);
    expect(recovered).toMatchObject({ status: 'succeeded', result: { generation: { originalUrl: originalImageUrl } } });
    expect(f.counts().imageCalls).toBe(1);
    await runtime.close();
});

it.each([
    { when: 'submit', extra: false, label: '镜头1图（参考图1）' },
    { when: 'submit', extra: true, label: '参考图2' },
    { when: 'refresh', extra: false, label: '镜头1图（参考图1）' },
])('locates the rejected picture as $label during $when', async ({ when, extra, label }) => {
    const f = await setup();
    if (extra) {
        const { relationId, materialId } = f.imageReferences[0];
        const extraId = 'af'.repeat(12);
        f.records.set(extraId, { ...f.records.get(relationId), _id: extraId, materialId });
        const batch = f.records.get(f.batchId);
        const saved = decodeGenerationPrompt(batch.prompt);
        batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation,
            references: [...saved.generation.references, { relationId: extraId, name: 'extra.png', purpose: '补充参考' }] });
    }
    const error = { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: 'input may contain real person', param: `content[${extra ? 2 : 1}]` };
    const previous = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (url, init) => {
        if (!url.includes('contents/generations/tasks')) return previous(url, init);
        if (when === 'submit') return Response.json({ error }, { status: 400 });
        return init.method === 'POST' ? previous(url, init) : Response.json({ status: 'failed', error });
    });
    const runtime = f.runtime();
    try {
        let task = await runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
        if (when === 'refresh') {
            expect(task.status).toBe('queued');
            f.rows[0].storyboardImageRefId = '';
            task = await runtime.run('video/refresh', f.input);
        }
        expect(task).toMatchObject({ status: 'failed', errorCode: error.code, error: `${error.code}：${label}：${error.message}` });
        expect((await runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).error).toBe(task.error);
        expect(f.provider.mock.calls.filter(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST')).toHaveLength(1);
    } finally { await runtime.close(); }
});
it.each(SEEDANCE_MODELS)('submits the saved $label model and preserves it when the same request is recovered', async ({ value }) => {
    const f = await setup();
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model: value });
    const runtime = f.runtime();
    const input = { ...f.input, batchId: f.batchId };
    const task = await runtime.run('video/tasks', input);
    expect(task.model).toBe(value);
    const calls = f.provider.mock.calls.filter(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST');
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0][1].body);
    expect(sent.model).toBe(value);
    expect(sent.omni_reference_task_type).toBe(value.includes('2-5') ? 'reference' : undefined);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model: 'doubao-seedance-2-0-fast-260128' });
    expect((await runtime.run('video/tasks', input)).model).toBe(value);
    expect(f.counts().videoCalls).toBe(1);
    await runtime.close();
});
function addReferenceVideo(f, index, durationSeconds = 6) {
    const relationId = (120 + index * 3).toString(16).padStart(24, '0');
    const materialId = (121 + index * 3).toString(16).padStart(24, '0');
    const fileId = (122 + index * 3).toString(16).padStart(24, '0');
    const relation = { _id: relationId, projectId: f.input.projectId, spaceId: f.input.spaceId, materialId, sourceRevision: 1 };
    const material = { _id: materialId, fileId, spaceId: f.input.spaceId, revision: 1, library: 'project',
        sourceKind: 'uploaded', mime: 'video/mp4', authorization: '自有' };
    f.records.set(relationId, relation);
    f.records.set(materialId, material);
    return { relation, material, reference: { relationId, durationSeconds, name: 'reference-video.mp4', purpose: '跟随运镜' },
        url: `${f.config.platformURL}/api/file/dowloadFile/${f.config.tenantId}/${fileId}` };
}
it('passes selected videos to Ark in batch order and settles the input-video price', async () => {
    const f = await setup();
    const model = SEEDANCE_MODELS[0].value;
    const pool = [
        { _id: '8'.repeat(24), accountCode: 'MLS-A', provider: 'malanshan', models: [model],
            scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'mls-fixture' },
        { _id: '9'.repeat(24), accountCode: 'ARK-A', provider: 'ark', models: [model],
            scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'ark-fixture' },
    ];
    const media = [addReferenceVideo(f, 1), addReferenceVideo(f, 2)];
    const video = await readFile(new URL('./fixtures/reference-video.mp4', import.meta.url));
    const originalProvider = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (url, init) => {
        if (media.some(clip => clip.url === url)) {
            expect(init.headers).toBeUndefined();
            return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) } });
        }
        return originalProvider(url, init);
    });
    const batch = f.records.get(f.batchId);
    const { generation } = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt('跟随@视频2的机位及@图片1的产品外观。', { ...generation, videoReferences: media.map(clip => clip.reference) });
    f.priceRows[1].inputVideoMode = 'none';
    f.priceRows.push({ ...f.priceRows[1], _id: 'd'.repeat(24), inputVideoMode: 'present', videoPerMillionYuan: '80' });
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const runtime = f.runtime(billing, pool);
    try {
        const settings = await runtime.run('config', f.input);
        expect(settings.video.providers[model]).toBe('malanshan');
        expect(settings.video.referenceVideoAvailability[model]).toEqual({ configured: true });
        const input = { ...f.input, batchId: f.batchId };
        await expect(runtime.run('video/tasks', { ...input, expectedProvider: 'malanshan' })).rejects.toMatchObject({ code: 'video/provider-changed' });
        const task = await runtime.run('video/tasks', { ...input, expectedProvider: 'ark' });
        expect(task).toMatchObject({ provider: 'ark', status: 'queued', billingParameters: { inputVideoMode: 'present' } });
        const calls = f.provider.mock.calls.filter(([url, init]) => url.includes('contents/generations/tasks') && init.method === 'POST');
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
        const sent = JSON.parse(calls[0][1].body);
        expect(sent).toMatchObject({ omni_reference_task_type: 'reference', duration: 15, ratio: '9:16' });
        expect(sent.content.slice(1)).toEqual([
            expect.objectContaining({ type: 'image_url', role: 'reference_image' }),
            ...media.map(clip => ({ type: 'video_url', role: 'reference_video', video_url: { url: clip.url } })),
        ]);
        expect(sent.content[0].text).toContain('@视频2：跟随运镜');
        expect((await runtime.run('video/refresh', f.input)).consumption).toMatchObject({ credits: '11.56' });
    } finally { await runtime.close(); await billing.close(); }
});
it.each(['other-project', 'measured-duration'])('rejects a reference video with invalid %s before generation', async (violation) => {
    const f = await setup();
    const media = [1, 2, 3].map(index => addReferenceVideo(f, index, 4));
    if (violation === 'other-project') media[0].relation.projectId = 'd'.repeat(24);
    const video = await readFile(new URL('./fixtures/reference-video.mp4', import.meta.url));
    const originalProvider = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (url, init) =>
        media.some(clip => clip.url === url) ? new Response(video, { headers: { 'Content-Type': 'video/mp4' } }) : originalProvider(url, init));
    const batch = f.records.get(f.batchId);
    const { generation } = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt('参考@视频1的运镜。', { ...generation, model: SEEDANCE_MODELS[1].value,
        references: [], videoReferences: media.map(clip => clip.reference) });
    const runtime = f.runtime();
    try {
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow(
            violation === 'other-project' ? '不属于当前项目' : '参考视频总时长超过 15 秒',
        );
        expect(f.counts().videoCalls).toBe(0);
    } finally { await runtime.close(); }
});
it('records the selected mini model against its own price instead of the 2.5 price', async () => {
    const f = await setup();
    const model = 'doubao-seedance-2-0-mini-260615';
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model });
    f.priceRows.push({ ...f.priceRows[1], _id: 'e'.repeat(24), modelKey: model, videoPerMillionYuan: '23' });
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const runtime = f.runtime(billing);
    await runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
    const task = await runtime.run('video/refresh', f.input);
    expect(task.model).toBe(model);
    expect(task.consumption.credits).toBe('3.32');
    const usage = [...f.records.values()].find(row => row.scenario === 'video' && row.usageEventKey);
    expect(usage).toMatchObject({ modelKey: model, customerCharge: '3.32', videoOutputTokens: 144512 });
    await runtime.close();
    await billing.close();
});
it.each(['1080p', '4k'])('rejects the unsupported mini resolution %s before a paid provider request', async (resolution) => {
    const f = await setup();
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model: 'doubao-seedance-2-0-mini-260615', resolution });
    const runtime = f.runtime();
    await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('分辨率');
    expect(f.counts().videoCalls).toBe(0);
    await runtime.close();
});
it('does not drop extra reference images to fit a selected 2.0 model', async () => {
    const f = await setup();
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation, model: 'doubao-seedance-2-0-260128',
        references: Array.from({ length: 10 }, (_, index) => ({ ...saved.generation.references[0], relationId: String(index).padStart(24, 'a') })) });
    const runtime = f.runtime();
    await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('最多支持 9 张');
    expect(f.counts().videoCalls).toBe(0);
    await runtime.close();
});
it('rechecks persisted Skill bindings after restart and does not invent usage for a denied call', async () => {
    const f = await setup();
    f.auth.owns = async () => true;
    const session = { id: 'session', header: { createdAt: 1 }, snapshotEvents: () => [] };
    const recorder = createBillingRecorder(f.config, f.auth, async () => '');
    const message = { source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({
        context: { tenantId: f.config.tenantId, spaceId: f.input.spaceId, projectId: f.input.projectId },
    }) }] };
    await recorder.bind(session, [message]);
    await expect(recorder.checkPoints(session)).resolves.toBeUndefined();
    f.records.get(f.project.spaceId).points = '0';
    await expect(recorder.checkPoints(session)).rejects.toMatchObject({ code: 'creation-studio/insufficient-points' });
    const restored = createBillingRecorder(f.config, f.auth, async () => '');
    await expect(restored.checkPoints(session)).rejects.toMatchObject({ code: 'creation-studio/insufficient-points' });
    await restored.capture(session, { type: 'assistant/attempt', seq: 2, time: 100, data: { turn: 1, step: 1,
        stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error',
            failure: { code: 'creation-studio/insufficient-points', message: '请充值' } } } }] } });
    expect([...f.records.values()].filter(row => row.usageEventKey)).toHaveLength(0);
    f.records.get(f.project.spaceId).points = '0.001';
    await expect(restored.checkPoints(session)).resolves.toBeUndefined();
    await expect(restored.checkPoints({ ...session, id: 'ordinary-chat' })).resolves.toBeUndefined();
    await recorder.close();
    await restored.close();
});
it('blocks new paid image and video calls at zero points but lets a recharge take effect on the next attempt', async () => {
    const f = await setup();
    f.records.get(f.project.spaceId).points = '0';
    const runtime = f.runtime();
    const image = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] };
    expect(await runtime.run('images/tasks', image)).toMatchObject({ status: 'failed', error: expect.stringContaining('充值') });
    expect(await runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).toMatchObject({ status: 'failed', error: expect.stringContaining('充值') });
    expect(f.counts()).toMatchObject({ imageCalls: 0, videoCalls: 0 });
    f.records.get(f.project.spaceId).points = '0.01';
    expect((await runtime.run('video/tasks', { ...f.input, batchId: f.batchId, requestId: 'after-recharge' })).status).toBe('queued');
    expect(f.counts().videoCalls).toBe(1);
    await runtime.close();
});
it('keeps paid video polling and result upload available when points are depleted after submission', async () => {
    const f = await setup();
    const runtime = f.runtime();
    await runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
    f.records.get(f.project.spaceId).points = '-1';
    const task = await runtime.run('video/refresh', f.input);
    expect(task.status).toBe('succeeded');
    expect(task.videoRefId).toBeTruthy();
    expect(f.counts().videoCalls).toBe(1);
    await runtime.close();
});
// Receipts written by the released GPT executor remain readable after the provider switch.
async function seedLegacy(f, input) {
    const source = { requestId: input.requestId, model: 'gpt-image-2.5', prompt: input.prompt,
        size: input.size, referenceIds: input.referenceIds, createdAt: new Date().toISOString(), confirmedAt: '' };
    const data = await (await f.provider('https://api.kbsfdxc.net/v1/images/generations', {
        method: 'POST', headers: { Authorization: 'Bearer gpt-key' }, body: JSON.stringify({ model: source.model, async: true, n: 1 }),
    })).json();
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    await mkdir(join(f.config.stateDirectory, 'images'), { recursive: true });
    await writeFile(join(f.config.stateDirectory, 'images', `${hash([f.config.tenantId, input.spaceId, input.projectId, input.planId, input.requestId])}.json`),
        JSON.stringify({ ...input, tenantId: f.config.tenantId, taskId: data.id, status: 'pending', source,
            fingerprint: hash([input.prompt, input.size, input.referenceIds]) }));
}
it('returns only uploaded image references, keeps pending review, and resumes partial uploads across Host restarts', async () => {
    const f = await setup();
    const request = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [f.imageReferences[0].relationId] };
    f.failNextRelation();
    await expect(f.runtime().run('images/generate', request)).rejects.toThrow('relation failed');
    const result = await f.runtime().run('images/generate', request);
    expect(result).toMatchObject({ origin: 'generated', authorization: '自有', needsConfirmation: true, generation: { confirmedAt: '' } });
    expect(result).not.toHaveProperty('b64');
    expect(f.counts()).toEqual({ imageCalls: 1, videoCalls: 0, uploads: 1 });
    expect(f.auth.downloadFileAuthenticated).not.toHaveBeenCalled();
    const material = f.records.get(result.materialId);
    expect(material).toMatchObject({ sourceKind: 'generated', width: 1024, height: 1024, spaceId: f.project.spaceId });
    await f.runtime().run('images/generate', request);
    expect(f.counts().imageCalls).toBe(1);
    const description = JSON.parse(material.sourceDescription);
    description.generatedImage.confirmedAt = '2026-10-29T00:00:00Z';
    material.sourceDescription = JSON.stringify(description);
    expect((await f.runtime().run('images/generate', request)).needsConfirmation).toBe(false);
});
it('enforces table writes and current project scope before a paid request', async () => {
    const f = await setup();
    const request = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] };
    f.denyWrites();
    await expect(f.runtime().run('images/generate', request)).rejects.toThrow('权限');
    expect(f.counts().imageCalls).toBe(0);
});
it('quotes Seedream using the actual request without reserving an account or invoking the provider', async () => {
    const f = await setup();
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const quote = await f.runtime(billing).run('images/quote', { ...f.input, prompt: 'scene', size: '1536x864', referenceIds: [] });
    expect(quote).toMatchObject({ estimated: true, estimatedCredits: '2.00', size: '1536x864', referenceCount: 0 });
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.counts().uploads).toBe(0);
});
// Reject the download after validation so this regression never reaches a video provider request.
it.each([undefined, '', '待确认', ' 自有 '].flatMap(authorization =>
    [false, true].map(snapshot => ({ authorization, snapshot }))))('defaults reference usage for image quotes and video preflight ($authorization, snapshot=$snapshot)', async ({ authorization, snapshot }) => {
    const f = await setup();
    const ref = f.imageReferences[0];
    const material = f.records.get(ref.materialId);
    const relation = f.records.get(ref.relationId);
    material.authorization = authorization;
    if (snapshot) {
        relation.usageSnapshot = JSON.stringify({ ...material, authorization });
        material.revision += 1;
    }
    const before = JSON.stringify(material);
    const runtime = f.runtime();
    try {
        const quote = await runtime.run('images/quote', { ...f.input, prompt: 'reference', size: '1024x1024', referenceIds: [ref.relationId] });
        expect(quote.referenceCount).toBe(1);
        f.provider.mockRejectedValueOnce(new Error('reference-preflight-complete'));
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('reference-preflight-complete');
        expect(JSON.stringify(material)).toBe(before);
        expect(f.provider.mock.calls.filter(([url]) => url.includes('contents/generations/tasks'))).toHaveLength(0);
    }
    finally {
        await runtime.close();
    }
});
it.each(['仅内部参考', '仅供内部参考'].flatMap(authorization =>
    [false, true].map(snapshot => ({ authorization, snapshot }))))('retains explicit reference usage restrictions ($authorization, snapshot=$snapshot)', async ({ authorization, snapshot }) => {
    const f = await setup();
    const ref = f.imageReferences[0];
    const material = f.records.get(ref.materialId);
    if (snapshot) {
        f.records.get(ref.relationId).usageSnapshot = JSON.stringify({ ...material, authorization });
        material.revision += 1;
    }
    else material.authorization = authorization;
    const runtime = f.runtime();
    try {
        await expect(runtime.run('images/quote', { ...f.input, prompt: 'reference', size: '1024x1024', referenceIds: [ref.relationId] })).rejects.toThrow('使用范围');
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow(/使用范围|文件、版本或格式/u);
        expect(f.provider).not.toHaveBeenCalled();
    }
    finally {
        await runtime.close();
    }
});
// Image editing can reuse a pending picture; video submission still requires its review.
it('quotes and generates with pending image references without approving their pictures', async () => {
    const f = await setup();
    const original = f.records.get(f.imageReferences[0].materialId);
    original.sourceKind = 'generated';
    original.sourceDescription = JSON.stringify({ generatedImage: { requestId: 'pending-original', confirmedAt: '' } });
    const before = original.sourceDescription;
    const runtime = f.runtime();
    const request = { ...f.input, prompt: 'adjust reference lighting', size: '1024x1024', referenceIds: [f.imageReferences[0].relationId] };
    const quote = await runtime.run('images/quote', request);
    expect(quote).toMatchObject({ referenceCount: 1 });
    expect(f.provider).not.toHaveBeenCalled();
    const result = await runtime.run('images/generate', request);
    expect(result).toMatchObject({ needsConfirmation: true, generation: { confirmedAt: '' } });
    expect(original.sourceDescription).toBe(before);
    await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId, requestId: 'pending-video' })).rejects.toThrow('人工确认');
    expect(f.counts()).toMatchObject({ imageCalls: 1, videoCalls: 0 });
    await expect(`${JSON.stringify({
        referenceCount: quote.referenceCount,
        originalConfirmedAt: JSON.parse(original.sourceDescription).generatedImage.confirmedAt,
        resultNeedsConfirmation: result.needsConfirmation,
        resultConfirmedAt: result.generation.confirmedAt,
        videoSubmissions: f.counts().videoCalls,
    }, null, 2)}\n`).toMatchFileSnapshot('./expected/pending-image-reference.json');
    await runtime.close();
});
it('keeps a quote with missing prices lossless without inventing an amount or price version', async () => {
    const f = await setup();
    const quote = await f.runtime().run('images/quote', { ...f.input, prompt: 'scene', size: '1536x864', referenceIds: [] });
    expect(quote).toStrictEqual(JSON.parse(JSON.stringify(quote)));
    expect(quote).not.toHaveProperty('estimatedCredits');
    expect(quote).not.toHaveProperty('priceVersionId');
    expect(quote.reason).toContain('售价');
    expect(f.provider).not.toHaveBeenCalled();
});
it('submits official 2.5 reference tasks, uploads completed videos, and restores platform results without another paid request', async () => {
    const f = await setup();
    const request = { ...f.input, batchId: f.batchId };
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const runtime = f.runtime(billing);
    const task = await runtime.run('video/tasks', request);
    expect(task.status).toBe('queued');
    const body = JSON.parse(f.provider.mock.calls.find(([, init]) => init?.method === 'POST')[1].body);
    expect(body).toMatchObject({ model: 'doubao-seedance-2-5-260628', omni_reference_task_type: 'reference', output_format: 'mp4', duration: 15 });
    f.failNextRelation();
    const pending = await runtime.run('video/refresh', request);
    expect(pending.status).toBe('upload_failed');
    expect(pending.videoUrl).toBe('');
    const saved = await f.runtime().run('video/refresh', request);
    expect(saved.status).toBe('succeeded');
    expect(saved.videoRefId).toHaveLength(24);
    expect(saved.videoUrl).toContain('platform.example/api/file/');
    expect(saved.usage).toEqual({ completion_tokens: 144512, total_tokens: 144512 });
    expect(saved.billingParameters).toMatchObject({ resolution: '480p', inputVideoMode: 'none', audioMode: 'enabled' });
    const restored = await f.runtime().run('video/list', f.input);
    expect(restored[0].videoRefId).toBe(saved.videoRefId);
    expect(restored[0].usage.completion_tokens).toBe(144512);
    expect(f.counts()).toEqual({ imageCalls: 0, videoCalls: 1, uploads: 1 });
    await runtime.run('video/refresh', request);
    const usage = [...f.records.values()].filter(row => row.usageEventKey);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ videoOutputTokens: 144512, customerCharge: '14.45', deliveryStatus: 'delivered' });
});

it('submits product-only reference video without per-shot images and rejects unconfirmed selected products', async () => {
    const f = await setup();
    for (const row of f.rows) row.storyboardImageRefId = '';
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.storyboard.storyboardHash = frontendHash({
        consistency: f.plan.consistency, assets: [], shots: f.rows.map((row, index) => ({
            code: `SHOT-${String(index + 1).padStart(2, '0')}`, prompt: row.prompt, supplement: '', assetIds: [], imageRefId: '',
        })),
    });
    f.plan.stageConfirmations = JSON.stringify(stamps);
    const request = { ...f.input, batchId: f.batchId };
    const task = await f.runtime().run('video/tasks', request);
    expect(task.status).toBe('queued');
    const body = JSON.parse(f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init?.method === 'POST')[1].body);
    expect(body.content.filter(item => item.type === 'image_url')).toHaveLength(1);
    await expect(`${body.content[0].text}\n`).toMatchFileSnapshot('./expected/product-only-video-prompt.txt');
    const material = f.records.get(f.imageReferences[0].materialId);
    material.sourceKind = 'generated';
    material.sourceDescription = JSON.stringify({ generatedImage: { requestId: 'unconfirmed', confirmedAt: '' } });
    await expect(f.runtime().run('video/tasks', { ...request, requestId: 'unconfirmed-product' })).rejects.toThrow('人工确认');
    expect(f.counts().videoCalls).toBe(1);
});

// Even a deliberately revised or short batch must not send an older script alongside its text.
function wavFixture(seconds) {
    const wav = Buffer.alloc(44 + 8000 * 2 * seconds);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    return wav;
}

function projectAudioFixture(f, { seconds = 4, declaredSeconds = 4 } = {}) {
    const relationId = '6a'.repeat(12), materialId = '6b'.repeat(12), fileId = '6c'.repeat(12);
    const relation = { _id: relationId, projectId: f.input.projectId, spaceId: f.input.spaceId, materialId, sourceRevision: 1 };
    const material = { _id: materialId, fileId, spaceId: f.input.spaceId, revision: 1, library: 'project',
        sourceKind: 'uploaded', mime: 'audio/wav', authorization: '自有' };
    f.records.set(relationId, relation);
    f.records.set(materialId, material);
    const url = `${f.config.platformURL}/api/file/dowloadFile/${f.config.tenantId}/${fileId}`;
    const previous = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (requestUrl, init) => {
        if (requestUrl !== url) return previous(requestUrl, init);
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return new Response(wavFixture(seconds), { headers: { 'content-type': 'audio/wav' } });
    });
    return { url, relation, material, clip: { relationId, name: 'music.wav', purpose: '参考配乐节奏', durationSeconds: declaredSeconds } };
}

it.each(['another project', 'decoded duration', 'unreadable file'])('stops video submission for reference audio with %s', async (failure) => {
    const f = await setup();
    const { clip, relation, url } = projectAudioFixture(f, { seconds: failure === 'decoded duration' ? 31 : 4 });
    if (failure === 'another project') relation.projectId = 'd'.repeat(24);
    if (failure === 'unreadable file') {
        const previous = f.provider.getMockImplementation();
        f.provider.mockImplementation((requestUrl, init) => requestUrl === url
            ? Promise.resolve(new Response('invalid bytes', { headers: { 'content-type': 'audio/wav' } }))
            : previous(requestUrl, init));
    }
    const batch = f.records.get(f.batchId);
    const { generation } = decodeGenerationPrompt(batch.prompt);
    batch.prompt = encodeGenerationPrompt('按 @音频1 的节奏生成。', { ...generation, references: [], audioClips: [clip] });
    const runtime = f.runtime();
    try {
        const error = failure === 'another project' ? 'video/invalid-request'
            : failure === 'decoded duration' ? 'video/reference-audio-duration' : 'video/reference-audio-unreadable';
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toMatchObject({ code: error, submissionState: 'not-submitted' });
        expect(f.counts().videoCalls).toBe(0);
    } finally { await runtime.close(); }
});

it.each([
    ['ark', 'legacy'],
    ['ark', 'complete'],
    ['ark', 'edited'],
    ['malanshan', 'edited'],
    ['ark', 'project audio'],
    ['malanshan', 'project audio'],
])('uses only the saved audio and subtitle text in the %s request for a %s batch prompt', async (provider, mode) => {
    const f = await setup();
    const voiceId = 'a'.repeat(24), audioFileId = 'b'.repeat(24);
    const copy = ['下单，报价，开标。', '麓山云，做软件开发。'];
    f.rows.forEach((row, index) => {
        const detail = JSON.parse(row.scriptDetail);
        detail.subtitle = copy[index] || '';
        detail.narration = copy[index] || '';
        if (index === 0) detail.soundEffects = '旧按压声';
        row.scriptDetail = JSON.stringify(detail);
        row.voiceover = copy[index] ? `字幕：${copy[index]}\n旁白：${copy[index]}` : '';
        row.supplement = copy[index] ? JSON.stringify({ schemaVersion: 'storyboard-speech-1', supplement: '',
            speech: [{ speakerId: 'narrator', speakerName: '旁白', text: copy[index], voiceId }] }) : '';
    });
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.script.scriptHash = frontendHash(f.rows.map(row => ({
        code: row.code, shotSize: row.shotSize, camera: row.cameraMove, visual: row.visual,
        voiceover: row.voiceover, seconds: row.expectedSeconds, scene: row.scene, emotion: row.emotion,
        scriptDetail: JSON.parse(row.scriptDetail),
    })));
    stamps.storyboard = { ...stamps.storyboard, scriptHash: stamps.script.scriptHash, storyboardHash: frontendHash({
        consistency: f.plan.consistency, assets: [], shots: f.rows.map((row, index) => ({
            code: `SHOT-${String(index + 1).padStart(2, '0')}`, prompt: row.prompt, supplement: row.supplement || '',
            assetIds: [], imageRefId: row.storyboardImageRefId,
        })),
    }) };
    f.plan.stageConfirmations = JSON.stringify(stamps);
    f.plan.globalPrompt = '冷蓝背景，公司名保持参考图样式。';
    const batch = f.records.get(f.batchId);
    const saved = decodeGenerationPrompt(batch.prompt);
    const submittedCopy = mode === 'edited' ? ['一起准备下一步。', copy[1]] : copy;
    const batchText = mode === 'legacy' ? saved.prompt : f.rows.map((row, index) => {
        const detail = JSON.parse(row.scriptDetail);
        const line = submittedCopy[index];
        const effect = mode === 'edited' && index === 0 ? '瓶盖轻响' : detail.soundEffects;
        return [`镜号${index + 1}`, `时间码：${index * 3}–${(index + 1) * 3} 秒`,
            ...(mode === 'edited' && index === 0 ? ['场景：广场（素材 cfc814f3，只作实景底图）；她由项目内 Seedream 5.0 人物资产合成，广场另有人流（@图片1）'] : []),
            '主画面描述：商品保持不变。',
            ...(line ? [`旁白 · 旁白（音色参考@音频1）台词：{${line}}`, `字幕：〖${line}〗`] : []),
            ...(detail.music ? [`音乐：${detail.music}`] : []),
            ...(effect ? [`音效：${effect}`] : []),
        ].join('\n');
    }).join('\n\n');
    const projectAudio = mode === 'project audio' ? projectAudioFixture(f) : undefined;
    const authoredPrompt = projectAudio ? `${batchText}\n音乐：参考 @音频2 的节奏。` : batchText;
    batch.prompt = encodeGenerationPrompt(authoredPrompt, { ...saved.generation,
        ...(projectAudio && { audioClips: [projectAudio.clip] }),
        audioReferences: [{ voiceId, name: '男声', speakerIds: ['narrator'], speakerNames: ['旁白'] }] });
    f.records.set(voiceId, { _id: voiceId, spaceId: '', fileId: audioFileId, mime: 'audio/wav' });
    const wav = wavFixture(3);
    f.auth.downloadFileAuthenticated.mockImplementation(async fileId => fileId === audioFileId
        ? new Response(wav, { headers: { 'content-type': 'audio/wav' } })
        : new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }));
    const pool = provider === 'malanshan' ? [{
        _id: '8'.repeat(24), accountCode: 'MLS-A', provider, models: [SEEDANCE_MODELS[0].value],
        scenarios: ['video'], enabled: 1, maxConcurrent: 1, apiKey: 'mls-fixture',
    }] : undefined;
    const runtime = f.runtime(undefined, pool);
    try {
        const task = await runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
        expect(task).toMatchObject({ provider, status: 'queued' });
        const call = f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init?.method === 'POST');
        const body = JSON.parse(call[1].body);
        const text = body.content[0].text;
        const cleaned = authoredPrompt.replace('（素材 cfc814f3，只作实景底图）；她由项目内 Seedream 5.0 人物资产合成，广场另有人流', '');
        const [rules, ...parts] = text.split('\n\n');
        expect(rules).toBe('已确认脚本声音与字幕（原文优先于下方画面描述及参考素材）：\n{}内只作朗读台词，〖〗内只作屏幕字幕，分隔符不显示也不朗读。逐字保留原文、字形、标点及顺序，不增删、改写、同音替字或转换简繁体；旁白与对应字幕同步，不把画面文字、说明或样音示例当台词。未指定字幕或旁白的时段不自行补充。');
        expect(parts.join('\n\n').split('\n\n参考图片用途')[0]).toBe(`全局风格限定词和约束提示词：\n${f.plan.globalPrompt}\n\n${cleaned}`);
        expect(text).toContain('@图片1：product identity');
        expect(text).not.toContain('product.png');
        if (mode === 'edited') {
            expect(text).not.toContain(copy[0]);
            expect(text).not.toContain('旧按压声');
            expect(text.split('瓶盖轻响')).toHaveLength(2);
        }
        expect(body.generate_audio).toBe(true);
        expect(body.content.filter(item => item.type === 'audio_url')).toEqual([
            { type: 'audio_url', role: 'reference_audio', audio_url: { url: `data:audio/wav;base64,${wav.toString('base64')}` } },
            ...(projectAudio ? [{ type: 'audio_url', role: 'reference_audio', audio_url: { url: projectAudio.url } }] : []),
        ]);
        if (projectAudio) {
            expect(text).toContain('@音频1：参考男声的音色');
            expect(text).toContain('@音频2：参考配乐节奏');
            expect(text).not.toContain('music.wav');
        }
        if (provider === 'malanshan') {
            expect(new URL(call[0]).host).toBe('maas.mlsvcloud.com:8559');
            expect(body.model).toBe('doubao-seedance-2-5-bot-THD');
            expect(text).toContain('@音频1');
        }
        if (mode === 'legacy') await expect(`${text}\n`).toMatchFileSnapshot('./expected/confirmed-video-copy-prompt.txt');
        if (mode === 'complete') await expect(`${text}\n`).toMatchFileSnapshot('./expected/complete-video-copy-prompt.txt');
    } finally {
        await runtime.close();
    }
});

it('requires saved batch text before adding the fixed narration and subtitle rules', async () => {
    const f = await setup();
    const batch = f.records.get(f.batchId);
    batch.prompt = encodeGenerationPrompt('  ', decodeGenerationPrompt(batch.prompt).generation);
    const runtime = f.runtime();
    try {
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('请填写本批次提示词。');
        expect(f.counts().videoCalls).toBe(0);
    } finally {
        await runtime.close();
    }
});

it('automatically stores synchronous image usage after upload and updates the same low-code row on recovery', async () => {
    const f = await setup();
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const runtime = f.runtime(billing);
    const request = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] };
    await runtime.run('images/generate', request);
    await runtime.run('images/generate', request);
    const usage = [...f.records.values()].filter(row => row.usageEventKey);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ scenario: 'image', imageCount: 1, customerCharge: '2.00',
        usageStatus: 'reported', chargeStatus: 'settled', deliveryStatus: 'delivered' });
    expect(f.counts().imageCalls).toBe(1);
});
it('recovers a legacy synchronous image without another generation or changing its recorded provider', async () => {
    const f = await setup();
    const input = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] };
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const source = { ...input, model: 'gpt-image-2.5', createdAt: new Date().toISOString(), confirmedAt: '' };
    await mkdir(join(f.config.stateDirectory, 'images'), { recursive: true });
    await writeFile(join(f.config.stateDirectory, 'images', `${hash([f.config.tenantId, input.spaceId, input.projectId, input.planId, input.requestId])}.json`),
        JSON.stringify({ fingerprint: hash([input.prompt, input.size, input.referenceIds]), status: 'succeeded',
            result: { b64: png, mime: 'image/png', source } }));
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    await f.runtime(billing).run('images/generate', input);
    expect(f.provider).not.toHaveBeenCalled();
    expect([...f.records.values()].find(row => row.usageEventKey)).toMatchObject({ provider: 'gpt-image', modelKey: 'gpt-image-2.5' });
});
it('waits for a started generation to finish saving when the plugin is disposed', async () => {
    const f = await setup();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.provider.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return seedreamResult();
    });
    const runtime = f.runtime();
    const pending = runtime.run('images/generate', { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' });
    await started.promise;
    let stopped = false;
    const shutdown = runtime.close().then(() => { stopped = true; });
    await expect(runtime.run('config')).rejects.toThrow('正在停止');
    expect(stopped).toBe(false);
    release.resolve();
    expect((await pending).relationId).toHaveLength(24);
    await shutdown;
    expect(stopped).toBe(true);
});
it('blocks pending storyboard pictures even when they are absent from the chosen batch references', async () => {
    const f = await setup();
    const relationId = 'd'.repeat(24), materialId = 'e'.repeat(24);
    f.rows[1].storyboardImageRefId = relationId;
    f.records.set(relationId, { _id: relationId, materialId, spaceId: f.project.spaceId, projectId: f.project._id, sourceRevision: 1 });
    f.records.set(materialId, { _id: materialId, spaceId: f.project.spaceId, library: 'project', sourceKind: 'generated',
        revision: 1, fileId: 'f'.repeat(24), authorization: '自有', mime: 'image/png', width: 1024, height: 1024, sourceDescription: '{}' });
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.storyboard.storyboardHash = frontendHash({ consistency: f.plan.consistency, assets: [], shots: f.rows.map((row, index) => ({
            code: `SHOT-${String(index + 1).padStart(2, '0')}`, prompt: row.prompt, supplement: '', assetIds: [], imageRefId: row.storyboardImageRefId,
        })) });
    f.plan.stageConfirmations = JSON.stringify(stamps);
    await expect(f.runtime().run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('人工确认');
    expect(f.counts().videoCalls).toBe(0);
});
it('stops late media uploads after account changes and recovers the paid result under the original account', async () => {
    const f = await setup();
    let owner = 'owner';
    f.auth.currentScopeKey = async () => owner;
    f.provider.mockImplementationOnce(async () => { owner = 'other'; return seedreamResult(); });
    const request = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    await expect(f.runtime().run('images/generate', request)).rejects.toThrow('账号已变化');
    expect(f.counts().uploads).toBe(0);
    owner = 'owner';
    expect((await f.runtime().run('images/generate', request)).relationId).toHaveLength(24);
    expect(f.provider.mock.calls.filter(([url]) => url.endsWith('/images/generations'))).toHaveLength(1);
});

it('submits multiple Seedream requests before completion and restores each uploaded result', async () => {
    const f = await setup();
    const release = Promise.withResolvers();
    let created = 0;
    f.provider.mockImplementation(async (url, init) => {
        if (url === originalImageUrl) return originalImageBytes();
        expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({ model: 'doubao-seedream-5-0-pro-260628', response_format: 'url' });
        expect(body.image).toEqual([`https://platform.example/api/file/previewImage/${f.config.tenantId}/${f.imageReferences[0].fileId}`]);
        expect(init.headers.Authorization).toBe('Bearer ark-key');
        created++;
        await release.promise;
        return seedreamResult();
    });
    const requests = [1, 2].map(index => ({ ...f.input, requestId: `seedream-${index}`, prompt: `view ${index}`,
        referenceIds: [f.imageReferences[0].relationId], size: '1024x1024' }));
    const runtime = f.runtime();
    const tasks = await Promise.all(requests.map(input => runtime.run('images/tasks', input)));
    await vi.waitFor(() => expect(created).toBe(2));
    expect(tasks.map(task => task.status)).toEqual(['pending', 'pending']);
    expect(tasks.every(task => task.providerAccountRef === 'ENV-ARK')).toBe(true);
    expect(JSON.stringify(tasks)).not.toContain('ark-key');
    expect((await runtime.run('images/refresh', requests[0])).status).toBe('pending');
    release.resolve();
    await runtime.close();
    const restored = f.runtime();
    const first = await restored.run('images/refresh', requests[0]);
    const second = await restored.run('images/refresh', requests[1]);
    expect(first).toMatchObject({ status: 'succeeded', result: { needsConfirmation: true, generation: { confirmedAt: '', providerAccountRef: 'ENV-ARK' } } });
    expect(first.result.relationId).not.toBe(second.result.relationId);
    expect((await restored.run('images/list', f.input)).filter(task => task.result)).toHaveLength(2);
    expect(created).toBe(2);
});

it('queues eight accepted images behind five account slots and starts waiting work as each slot is released', async () => {
    const f = await setup();
    const rows = [{ _id: '1'.repeat(24), accountCode: 'ARK-IMAGE', provider: 'ark',
        models: ['doubao-seedream-5-0-pro-260628'], scenarios: ['image'], enabled: 1, maxConcurrent: 5, apiKey: 'pooled-image-key' }];
    const releases = [];
    let active = 0, peak = 0, releaseAll = false;
    f.provider.mockImplementation(async (url, init = {}) => {
        if (url === originalImageUrl) return originalImageBytes();
        expect(init.headers.Authorization).toBe('Bearer pooled-image-key');
        const release = Promise.withResolvers();
        releases.push(release);
        active++;
        peak = Math.max(peak, active);
        if (!releaseAll) await release.promise;
        active--;
        return seedreamResult();
    });
    const runtime = f.runtime(undefined, rows);
    const requests = Array.from({ length: 8 }, (_, index) => ({ ...f.input, requestId: `queued-image-${index}`,
        prompt: `view ${index}`, size: '1024x1024', referenceIds: [] }));
    try {
        const tasks = await Promise.all(requests.map(input => runtime.run('images/tasks', input)));
        expect(tasks.filter(task => task.status === 'pending')).toHaveLength(5);
        expect(tasks.filter(task => task.status === 'queued')).toHaveLength(3);
        await vi.waitFor(() => expect(releases).toHaveLength(5));
        const running = await runtime.run('images/list', f.input);
        expect(running.filter(task => task.status === 'pending')).toHaveLength(5);
        expect(running.filter(task => task.status === 'queued')).toHaveLength(3);
        expect(running.some(task => task.error)).toBe(false);
        const queued = running.find(task => task.status === 'queued');
        expect(await runtime.run('images/refresh', { ...f.input, requestId: queued.requestId })).toMatchObject({ status: 'queued' });
        expect(await runtime.run('images/tasks', requests.find(input => input.requestId === queued.requestId))).toMatchObject({ status: 'queued' });
        expect(releases).toHaveLength(5);
        releases[0].resolve();
        await vi.waitFor(() => expect(releases).toHaveLength(6));
        expect(peak).toBe(5);
        releaseAll = true;
        releases.forEach(release => release.resolve());
        await vi.waitFor(async () => {
            const finished = await runtime.run('images/list', f.input);
            expect(finished.filter(task => task.status === 'upload_pending'),
                JSON.stringify(finished.map(task => ({ requestId: task.requestId, status: task.status, error: task.error })))).toHaveLength(8);
        });
        const uploaded = await runtime.run('images/refresh', { ...f.input, taskIds: tasks.map(task => task.taskId) });
        expect(uploaded.every(task => task.status === 'succeeded')).toBe(true);
        expect(releases).toHaveLength(8);
        expect(peak).toBe(5);
    } finally {
        releaseAll = true;
        releases.forEach(release => release.resolve());
        await runtime.close();
    }
});

it('preserves unsubmitted queued images during shutdown and resumes the same receipt after restart', async () => {
    const f = await setup();
    const rows = [{ _id: '1'.repeat(24), accountCode: 'ARK-IMAGE', provider: 'ark',
        models: ['doubao-seedream-5-0-pro-260628'], scenarios: ['image'], enabled: 1, maxConcurrent: 1, apiKey: 'pooled-image-key' }];
    const release = Promise.withResolvers();
    f.provider.mockImplementationOnce(async () => {
        await release.promise;
        return seedreamResult();
    });
    const runtime = f.runtime(undefined, rows);
    const first = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] };
    const waiting = { ...first, requestId: 'restart-queued-image' };
    await runtime.run('images/tasks', first);
    expect(await runtime.run('images/tasks', waiting)).toMatchObject({ status: 'queued' });
    const shutdown = runtime.close();
    release.resolve();
    await shutdown;
    expect(f.provider).toHaveBeenCalledTimes(1);
    const restored = f.runtime(undefined, rows);
    try {
        const saved = await restored.run('images/list', f.input);
        expect(saved.find(task => task.requestId === waiting.requestId)).toMatchObject({ status: 'queued' });
        expect(f.provider).toHaveBeenCalledTimes(1);
        await restored.run('images/refresh', waiting);
        await vi.waitFor(async () => {
            expect((await restored.run('images/list', f.input)).find(task => task.requestId === waiting.requestId)?.status).toBe('upload_pending');
        });
        expect((await restored.run('images/refresh', waiting)).status).toBe('succeeded');
        await restored.run('images/tasks', waiting);
        expect(f.provider.mock.calls.filter(([url]) => url.endsWith('/images/generations'))).toHaveLength(2);
    } finally {
        await restored.close();
    }
});

it('rechecks queued write permission before paid dispatch and releases the unused account slot', async () => {
    const f = await setup();
    const rows = [{ _id: '1'.repeat(24), accountCode: 'ARK-IMAGE', provider: 'ark',
        models: ['doubao-seedream-5-0-pro-260628'], scenarios: ['image'], enabled: 1, maxConcurrent: 1, apiKey: 'pooled-image-key' }];
    const release = Promise.withResolvers();
    f.provider.mockImplementationOnce(async () => {
        await release.promise;
        return seedreamResult();
    });
    const runtime = f.runtime(undefined, rows);
    try {
        const request = { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] };
        await runtime.run('images/tasks', request);
        expect(await runtime.run('images/tasks', { ...request, requestId: 'revoked-queued-image' })).toMatchObject({ status: 'queued' });
        f.denyWrites();
        release.resolve();
        await vi.waitFor(async () => {
            const task = (await runtime.run('images/list', f.input)).find(task => task.requestId === 'revoked-queued-image');
            expect(task).toMatchObject({ status: 'failed', error: expect.stringContaining('权限') });
        });
        expect(f.provider).toHaveBeenCalledTimes(1);
        const receipts = await Promise.all((await readdir(join(f.config.stateDirectory, 'provider-calls')))
            .map(name => readFile(join(f.config.stateDirectory, 'provider-calls', name), 'utf8')));
        expect(receipts.map(text => JSON.parse(text).status).sort()).toEqual(['failed', 'succeeded']);
    } finally {
        release.resolve();
        await runtime.close();
    }
});

it('uploads a completed Seedream image while another generation remains pending and rejects foreign task IDs', async () => {
    const f = await setup();
    const release = Promise.withResolvers();
    let created = 0;
    f.provider.mockImplementation(async (url) => {
        if (url === originalImageUrl) return originalImageBytes();
        if (++created === 2) await release.promise;
        return seedreamResult();
    });
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const runtime = f.runtime(billing);
    const requests = [1, 2].map(index => ({ ...f.input, requestId: `batch-request-${index}`, prompt: 'product', size: '1024x1024', referenceIds: [] }));
    const tasks = await Promise.all(requests.map(input => runtime.run('images/tasks', input)));
    await vi.waitFor(async () => expect((await runtime.run('images/list', f.input)).some(task => task.status === 'upload_pending')).toBe(true));
    const result = await runtime.run('images/refresh', { ...f.input, taskIds: tasks.map(task => task.taskId) });
    expect(result.map(task => task.status).sort()).toEqual(['pending', 'succeeded']);
    const before = f.provider.mock.calls.length;
    await expect(runtime.run('images/refresh', { ...f.input, taskIds: [tasks[1].taskId, 'foreign-task'] })).rejects.toThrow('任务');
    expect(f.provider.mock.calls.length).toBe(before);
    const usage = [...f.records.values()].filter(row => row.usageEventKey);
    expect(usage).toHaveLength(2);
    expect(usage.every(row => row.providerAccountRef === 'ENV-ARK')).toBe(true);
    expect(usage.find(row => row.imageCount === 1).customerCharge).toBe('2.00');
    release.resolve();
    await runtime.close();
});

it('returns lossless tool results while image consumption is still pending, without resubmitting', async () => {
    const f = await setup();
    const release = Promise.withResolvers();
    f.provider.mockImplementationOnce(async () => {
        await release.promise;
        return seedreamResult();
    });
    const billing = createBillingRecorder(f.config, f.auth, async () => '');
    const runtime = f.runtime(billing);
    const request = { ...f.input, prompt: 'white liquid', size: '1536x864', referenceIds: [] };
    try {
        for (const action of ['tasks', 'list', 'refresh']) {
            const result = await runtime.run(`images/${action}`, request);
            expect(result).toStrictEqual(JSON.parse(JSON.stringify(result)));
            const task = action === 'list' ? result[0] : result;
            expect(task).toMatchObject({ status: 'pending', consumption: { status: 'pending' } });
            expect(task.consumption).not.toHaveProperty('credits');
            const { createdAt: _createdAt, ...visibleTask } = task;
            await expect(`${JSON.stringify(visibleTask, null, 2)}\n`).toMatchFileSnapshot('./expected/pending-image-task.json');
        }
        expect(f.provider).toHaveBeenCalledTimes(1);
    } finally {
        release.resolve();
        await runtime.close();
        await billing.close();
    }
});

it('reports one failed refresh without discarding another uploaded image', async () => {
    const f = await setup();
    let created = 0;
    f.provider.mockImplementation(async (url, init = {}) => {
        if (init.method === 'POST')
            return Response.json({ id: `img_partial_${++created}`, status: 'pending' });
        if (url.endsWith('img_partial_2'))
            throw new Error('provider unavailable');
        if (url.endsWith('/content'))
            return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
        return Response.json({ id: url.split('/').at(-1), status: 'completed' });
    });
    const runtime = f.runtime();
    await Promise.all([1, 2].map(index => seedLegacy(f, { ...f.input, requestId: `partial-${index}`, prompt: 'product', size: '1024x1024', referenceIds: [] })));
    const submitted = await runtime.run('images/list', f.input);
    const result = await runtime.run('images/refresh', { ...f.input, taskIds: ['img_partial_1', 'img_partial_2'] });
    expect(result[0].status).toBe('succeeded');
    const failedRequest = submitted.find(task => task.taskId === 'img_partial_2').requestId;
    expect(result[1]).toMatchObject({ requestId: failedRequest, taskId: 'img_partial_2', status: 'refresh_failed', error: 'provider unavailable' });
    expect((await runtime.run('images/list', f.input)).find(task => task.requestId === failedRequest).status).toBe('pending');
    expect(created).toBe(2);
});

it('rejects stale script confirmation before creating a provider task and identifies the stage to reconfirm', async () => {
    const f = await setup();
    const stamps = JSON.parse(f.plan.stageConfirmations);
    stamps.script.planRevision++;
    f.plan.stageConfirmations = JSON.stringify(stamps);
    await expect(f.runtime().run('images/tasks', { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] }))
        .rejects.toMatchObject({ code: 'creation-studio/stale-confirmation', message: expect.stringContaining('视频脚本重新确认') });
    expect(f.provider).not.toHaveBeenCalled();
});

it('retries only the explicit provider failure within the persisted budget and completes the replacement task', async () => {
    const f = await setup();
    let created = 0;
    let fail = true;
    f.provider.mockImplementation(async (url, init = {}) => {
        expect(init.headers.Authorization).toBe('Bearer gpt-key');
        if (init.method === 'POST') {
            created++;
            return Response.json({ id: `img_retry_${created}`, status: 'pending' });
        }
        if (url.endsWith('/content'))
            return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
        return Response.json({ id: url.split('/').at(-1), status: fail ? 'failed' : 'completed',
            error: fail ? 'image generation failed; please retry' : null });
    });
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    await seedLegacy(f, input);
    const retried = await f.runtime().run('images/refresh', input);
    expect(retried).toMatchObject({ status: 'pending', taskId: 'img_retry_2', retryCount: 1 });
    fail = false;
    const saved = await f.runtime().run('images/refresh', input);
    expect(saved).toMatchObject({ status: 'succeeded', retryCount: 1 });
    expect(saved.result.generation.taskId).toBe('img_retry_2');
    expect(created).toBe(2);
    expect(f.counts().uploads).toBe(1);
});

it('stops automatic retry after four replacements, including after restarts and concurrent refreshes', async () => {
    const f = await setup();
    let created = 0;
    f.provider.mockImplementation(async (url, init = {}) => {
        if (init.method === 'POST') {
            created++;
            return Response.json({ id: `img_limit_${created}`, status: 'pending' });
        }
        return Response.json({ id: url.split('/').at(-1), status: 'failed', error: 'image generation failed; please retry' });
    });
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    await seedLegacy(f, input);
    await Promise.all([f.runtime().run('images/refresh', input), f.runtime().run('images/refresh', input)]);
    expect(created).toBe(2);
    await f.runtime().run('images/refresh', input);
    expect(created).toBe(3);
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'pending', retryCount: 3 });
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'pending', retryCount: 4 });
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'failed', retryCount: 4, error: 'image generation failed; please retry' });
    await f.runtime().run('images/refresh', input);
    expect(created).toBe(5);
    expect(f.counts().uploads).toBe(0);
});

it('preserves rejected and unknown Seedream outcomes without resubmitting', async () => {
    const f = await setup();
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockResolvedValue(Response.json({ error: { message: 'denied' } }, { status: 403 }));
    const runtime = f.runtime();
    await runtime.run('images/tasks', input);
    await runtime.close();
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'failed', errorCode: 'image/provider-rejected' });
    expect(f.provider).toHaveBeenCalledTimes(1);
    const second = { ...input, requestId: 'unknown-seedream-001' };
    f.provider.mockRejectedValueOnce(new Error('connection lost'));
    const another = f.runtime();
    await another.run('images/tasks', second);
    await another.close();
    expect((await f.runtime().run('images/refresh', second)).status).toBe('unknown');
    await f.runtime().run('images/tasks', second);
    expect(f.provider).toHaveBeenCalledTimes(2);
});

it('respects a disabled retry budget and revoked write access before any paid replacement', async () => {
    const f = await setup();
    f.config.imageRetryLimit = 0;
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockImplementation(async (url, init = {}) => init.method === 'POST'
        ? Response.json({ id: 'img_no_retry', status: 'pending' })
        : Response.json({ id: 'img_no_retry', status: 'failed', error: 'image generation failed; please retry' }));
    await seedLegacy(f, input);
    expect((await f.runtime().run('images/refresh', input)).status).toBe('failed');
    expect(f.provider).toHaveBeenCalledTimes(2);
    f.config.imageRetryLimit = 2;
    f.denyWrites();
    await expect(f.runtime().run('images/refresh', input)).rejects.toThrow('权限');
    expect(f.provider).toHaveBeenCalledTimes(2);
});

it('resumes Seedream upload without resubmission and rejects changing the model under the original request', async () => {
    const f = await setup();
    const request = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024', model: 'doubao-seedream-5-0-flash-260915' };
    const runtime = f.runtime();
    await runtime.run('images/tasks', request);
    await runtime.run('images/tasks', request);
    await runtime.close();
    f.failNextRelation();
    expect((await f.runtime().run('images/refresh', request)).status).toBe('upload_failed');
    expect((await f.runtime().run('images/refresh', request)).status).toBe('succeeded');
    await expect(f.runtime().run('images/tasks', { ...request, model: 'doubao-seedream-5-0-pro-260628' })).rejects.toThrow('其他参数');
    expect(f.counts().imageCalls).toBe(1);
    expect(f.counts().uploads).toBe(1);
});

it('never resubmits an unknown Seedream task after Host recovery', async () => {
    const f = await setup();
    const request = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockRejectedValue(new Error('submission timeout'));
    const runtime = f.runtime();
    await runtime.run('images/tasks', request);
    await runtime.close();
    expect((await f.runtime().run('images/tasks', request)).status).toBe('unknown');
    expect((await f.runtime().run('images/refresh', request)).status).toBe('unknown');
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.counts().uploads).toBe(0);
});

it('keeps an accepted image receipt after failed or invalid provider status and refuses a foreign project', async () => {
    const f = await setup();
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_failure', status: 'pending' }));
    await seedLegacy(f, input);
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_other', status: 'completed' }));
    await expect(f.runtime().run('images/refresh', input)).rejects.toThrow('未知状态');
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_failure', status: 'failed', error: { message: 'provider failed' } }));
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'failed', error: 'provider failed' });
    await f.runtime().run('images/tasks', input);
    expect(f.provider).toHaveBeenCalledTimes(3);
    await expect(f.runtime().run('images/refresh', { ...input, projectId: 'd'.repeat(24) })).rejects.toThrow('项目');
    expect(f.counts().uploads).toBe(0);
});

it('shares pool capacity between images and videos and polls a disabled account with its original key', async () => {
    const f = await setup();
    const rows = [1, 2].map(index => ({ _id: String(index).repeat(24), accountCode: `ARK-${index}`,
        provider: 'ark', models: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', 'doubao-seedance-2-5-260628'], scenarios: ['image', 'video'], enabled: 1, maxConcurrent: 1, apiKey: `pooled-key-${index}` }));
    const release = Promise.withResolvers();
    const original = f.provider.getMockImplementation();
    f.provider.mockImplementation(async (url, init) => {
        if (url.endsWith('/images/generations')) {
            await release.promise;
            return seedreamResult();
        }
        return original(url, init);
    });
    const runtime = f.runtime(undefined, rows);
    const image = await runtime.run('images/tasks', { ...f.input, prompt: 'product', size: '1024x1024', referenceIds: [] });
    const video = await runtime.run('video/tasks', { ...f.input, requestId: 'pooled-video', batchId: f.batchId });
    expect(video.status).toBe('queued');
    expect(video.providerAccountRef).not.toBe(image.providerAccountRef);
    const account = rows.find(row => row.accountCode === video.providerAccountRef);
    account.enabled = 0;
    const result = await runtime.run('video/refresh', { ...f.input, requestId: 'pooled-video' });
    expect(result.status).toBe('succeeded');
    const queries = f.provider.mock.calls.filter(([url]) => url.includes('contents/generations/tasks'));
    expect(queries.map(([, init]) => init.headers.Authorization)).toEqual([`Bearer ${account.apiKey}`, `Bearer ${account.apiKey}`]);
    release.resolve();
    await runtime.close();
    const audits = await Promise.all((await readdir(join(f.config.stateDirectory, 'provider-calls'))).map(name => readFile(join(f.config.stateDirectory, 'provider-calls', name), 'utf8')));
    expect(audits).toHaveLength(2);
    expect(audits.join()).not.toContain('pooled-key-');
    expect(audits.map(text => JSON.parse(text).initiatedByUserId)).toEqual(['owner', 'owner']);
});
