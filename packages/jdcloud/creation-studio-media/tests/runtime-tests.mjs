// @vitest-environment node
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
// The migrated JavaScript is loaded from source; URL imports avoid built declarations in source tests.
const { createHarnessMediaRuntime } = await import(new URL('../src/runtime.mjs', import.meta.url).href);
const { requestGptImage } = await import(new URL('../src/images.mjs', import.meta.url).href);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const { frontendHash } = await import(new URL('../src/upstream.mjs', import.meta.url).href);
import { encodeGenerationPrompt } from '../src/seedance-request.mjs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VZkAAAAASUVORK5CYII=';
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
            if (request.path.endsWith('/form/list'))
                return { list: request.body.menuId === '6ad81c871f280486bb45ac4b' ? f.rows : [] };
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
    records.set(f.project.spaceId, { _id: f.project.spaceId, ownerUserId: 'owner', status: 'active' });
    const provider = vi.fn(async (url, init = {}) => {
        expect(String(init.headers?.Authorization || '')).not.toContain('platform');
        if (url.startsWith('https://api.kbsfdxc.net')) {
            imageCalls++;
            return Response.json({ data: [{ b64_json: png }] });
        }
        if (url.includes('contents/generations/tasks')) {
            if (init.method === 'POST') {
                videoCalls++;
                return Response.json({ id: 'task-id' });
            }
            return Response.json({ status: 'succeeded', content: { video_url: 'https://result.tos-cn-beijing.volces.com/result.mp4' } });
        }
        return new Response(Buffer.from('0000ftypisom-video-bytes'), { headers: { 'content-type': 'video/mp4' } });
    });
    const config = { platformURL: 'https://platform.example', tenantId: f.requirement._meta.tenantId, stateDirectory: directory,
        imageModel: 'gpt-image-2.5', imageKeyRef: 'GPT_IMAGE_API_KEY', arkKeyRef: 'ARK_API_KEY' };
    const runtime = () => createHarnessMediaRuntime(config, auth, async (key) => key === 'ARK_API_KEY' ? 'ark-key' : 'gpt-key', async () => ({ width: 1024, height: 1024 }), provider);
    const input = { projectId: f.project._id, planId: f.plan._id, spaceId: f.project.spaceId, requestId: 'request-test-001' };
    return { ...f, config, auth, provider, records, runtime, input, batchId,
        failNextRelation() { failRelation = true; }, denyWrites() { denyWrite = true; },
        counts: () => ({ imageCalls, videoCalls, uploads }) };
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
it('submits official 2.5 reference tasks, uploads completed videos, and restores platform results without another paid request', async () => {
    const f = await setup();
    const request = { ...f.input, batchId: f.batchId };
    const runtime = f.runtime();
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
    const restored = await f.runtime().run('video/list', f.input);
    expect(restored[0].videoRefId).toBe(saved.videoRefId);
    expect(f.counts()).toEqual({ imageCalls: 0, videoCalls: 1, uploads: 1 });
});
it('waits for a started generation to finish saving when the plugin is disposed', async () => {
    const f = await setup();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.provider.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return Response.json({ data: [{ b64_json: png }] });
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
    f.provider.mockImplementationOnce(async () => { owner = 'other'; return Response.json({ data: [{ b64_json: png }] }); });
    const request = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    await expect(f.runtime().run('images/generate', request)).rejects.toThrow('账号已变化');
    expect(f.counts().uploads).toBe(0);
    owner = 'owner';
    expect((await f.runtime().run('images/generate', request)).relationId).toHaveLength(24);
    expect(f.provider).toHaveBeenCalledTimes(1);
});

it('submits multiple asynchronous reference edits before completion and restores each uploaded result', async () => {
    const f = await setup();
    let created = 0;
    let completed = false;
    f.provider.mockImplementation(async (url, init = {}) => {
        if (init.method === 'POST') {
            expect(url).toBe('https://api.kbsfdxc.net/v1/images/edits');
            const body = JSON.parse(Buffer.from(init.body).toString());
            expect(body).toMatchObject({ model: 'gpt-image-2.5', async: true, n: 1, response_format: 'url' });
            expect(body.images).toEqual([`https://platform.example/api/file/previewImage/${f.config.tenantId}/${f.imageReferences[0].fileId}`]);
            expect(body).not.toHaveProperty('mask');
            expect(init.headers['Content-Type']).toBeUndefined();
            expect(init.headers.Authorization).toBe('Bearer gpt-key');
            return Response.json({ id: `img_${++created}`, status: 'pending' });
        }
        if (url.endsWith('/content'))
            return new Response(null, { status: 302, headers: { location: 'https://image.example/result.png' } });
        if (url.startsWith('https://image.example/')) {
            expect(init.headers?.Authorization).toBeUndefined();
            return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
        }
        return Response.json({ id: url.split('/').at(-1), status: completed ? 'completed' : 'pending' });
    });
    const requests = [1, 2].map(index => ({
        ...f.input, requestId: `async-image-${index}`, prompt: `product view ${index}`,
        referenceIds: [f.imageReferences[0].relationId], size: '1024x1024',
    }));
    const runtime = f.runtime();
    const tasks = await Promise.all(requests.map(input => runtime.run('images/tasks', input)));
    expect(created).toBe(2);
    expect(tasks.map(task => task.status)).toEqual(['pending', 'pending']);
    expect(tasks).toEqual(JSON.parse(JSON.stringify(tasks)));
    expect(JSON.stringify(tasks)).not.toContain('b64');
    expect((await runtime.run('images/refresh', requests[0])).status).toBe('pending');
    completed = true;
    const result = await f.runtime().run('images/refresh', requests[0]);
    expect(result).toMatchObject({ status: 'succeeded', result: { needsConfirmation: true, generation: { confirmedAt: '' } } });
    expect(result.result.relationId).toHaveLength(24);
    const restored = await f.runtime().run('images/list', f.input);
    expect(restored.find(task => task.requestId === requests[0].requestId).result.relationId).toBe(result.result.relationId);
    const second = await f.runtime().run('images/refresh', requests[1]);
    expect(second.result.relationId).not.toBe(result.result.relationId);
    expect(JSON.stringify(restored)).not.toContain('b64');
    expect(created).toBe(2);
});

it('refreshes scoped task ID arrays and uploads each completed image without waiting for other provider queries', async () => {
    const f = await setup();
    let created = 0;
    const release = Promise.withResolvers();
    f.provider.mockImplementation(async (url, init = {}) => {
        if (init.method === 'POST')
            return Response.json({ id: `img_batch_${++created}`, status: 'pending' });
        if (url.endsWith('/content'))
            return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
        if (url.endsWith('img_batch_2'))
            await release.promise;
        return Response.json({ id: url.split('/').at(-1), status: url.endsWith('img_batch_2') ? 'pending' : 'completed' });
    });
    const runtime = f.runtime();
    const requests = [1, 2].map(index => ({ ...f.input, requestId: `batch-request-${index}`, prompt: 'product', size: '1024x1024', referenceIds: [] }));
    await Promise.all(requests.map(input => runtime.run('images/tasks', input)));
    const batch = runtime.run('images/refresh', { ...f.input, taskIds: ['img_batch_1', 'img_batch_2'] });
    await vi.waitFor(() => expect(f.counts().uploads).toBe(1));
    release.resolve();
    const result = await batch;
    expect(result.map(task => task.status)).toEqual(['succeeded', 'pending']);
    expect(result[0].result.relationId).toHaveLength(24);
    const before = f.provider.mock.calls.length;
    await expect(runtime.run('images/refresh', { ...f.input, taskIds: ['img_batch_2', 'img_other_project'] })).rejects.toThrow('任务');
    expect(f.provider.mock.calls.length).toBe(before);
    expect(created).toBe(2);
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
    await Promise.all([1, 2].map(index => runtime.run('images/tasks', { ...f.input, requestId: `partial-${index}`, prompt: 'product', size: '1024x1024', referenceIds: [] })));
    const result = await runtime.run('images/refresh', { ...f.input, taskIds: ['img_partial_1', 'img_partial_2'] });
    expect(result[0].status).toBe('succeeded');
    expect(result[1]).toMatchObject({ requestId: 'partial-2', taskId: 'img_partial_2', status: 'refresh_failed', error: 'provider unavailable' });
    expect((await runtime.run('images/list', f.input)).find(task => task.requestId === 'partial-2').status).toBe('pending');
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
    await f.runtime().run('images/tasks', input);
    const retried = await f.runtime().run('images/refresh', input);
    expect(retried).toMatchObject({ status: 'pending', taskId: 'img_retry_2', retryCount: 1 });
    fail = false;
    const saved = await f.runtime().run('images/refresh', input);
    expect(saved).toMatchObject({ status: 'succeeded', retryCount: 1 });
    expect(saved.result.generation.taskId).toBe('img_retry_2');
    expect(created).toBe(2);
    expect(f.counts().uploads).toBe(1);
});

it('stops automatic retry after two replacements, including after restarts and concurrent refreshes', async () => {
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
    await f.runtime().run('images/tasks', input);
    await Promise.all([f.runtime().run('images/refresh', input), f.runtime().run('images/refresh', input)]);
    expect(created).toBe(2);
    await f.runtime().run('images/refresh', input);
    expect(created).toBe(3);
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'failed', retryCount: 2, error: 'image generation failed; please retry' });
    await f.runtime().run('images/refresh', input);
    expect(created).toBe(3);
    expect(f.counts().uploads).toBe(0);
});

it('preserves explicit provider rejection as failed and does not retry auth errors or ambiguous replacements', async () => {
    const f = await setup();
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockResolvedValue(Response.json({ error: { message: 'your token is not authorized for any channel serving this model' } }, { status: 403 }));
    expect(await f.runtime().run('images/tasks', input)).toMatchObject({ status: 'failed', errorCode: 'image/provider-rejected' });
    await f.runtime().run('images/refresh', input);
    expect(f.provider).toHaveBeenCalledTimes(1);
    const second = { ...input, requestId: 'retry-unknown-001' };
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_unknown', status: 'pending' }))
        .mockResolvedValueOnce(Response.json({ id: 'img_unknown', status: 'failed', error: 'image generation failed; please retry' }))
        .mockRejectedValueOnce(new Error('connection lost'));
    await f.runtime().run('images/tasks', second);
    expect((await f.runtime().run('images/refresh', second)).status).toBe('unknown');
    await f.runtime().run('images/refresh', second);
    expect(f.provider).toHaveBeenCalledTimes(4);
});

it('respects a disabled retry budget and revoked write access before any paid replacement', async () => {
    const f = await setup();
    f.config.imageRetryLimit = 0;
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockImplementation(async (url, init = {}) => init.method === 'POST'
        ? Response.json({ id: 'img_no_retry', status: 'pending' })
        : Response.json({ id: 'img_no_retry', status: 'failed', error: 'image generation failed; please retry' }));
    await f.runtime().run('images/tasks', input);
    expect((await f.runtime().run('images/refresh', input)).status).toBe('failed');
    expect(f.provider).toHaveBeenCalledTimes(2);
    f.config.imageRetryLimit = 2;
    f.denyWrites();
    await expect(f.runtime().run('images/refresh', input)).rejects.toThrow('权限');
    expect(f.provider).toHaveBeenCalledTimes(2);
});

it('resumes an asynchronous image after upload failure without resubmitting and rejects changed request parameters', async () => {
    const f = await setup();
    let created = 0;
    f.provider.mockImplementation(async (url, init = {}) => {
        if (init.method === 'POST') {
            expect(JSON.parse(init.body)).toMatchObject({ async: true, n: 1, model: 'gpt-image-2.5' });
            created++;
            return Response.json({ id: 'img_resume', status: 'pending' });
        }
        return url.endsWith('/content')
            ? new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
            : Response.json({ id: 'img_resume', status: 'completed' });
    });
    const request = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    await f.runtime().run('images/tasks', request);
    await f.runtime().run('images/tasks', request);
    f.failNextRelation();
    expect((await f.runtime().run('images/refresh', request)).status).toBe('upload_failed');
    expect((await f.runtime().run('images/refresh', request)).status).toBe('succeeded');
    await expect(f.runtime().run('images/tasks', { ...request, prompt: 'different' })).rejects.toThrow('其他参数');
    expect(created).toBe(1);
    expect(f.counts().uploads).toBe(1);
});

it('never resubmits an unknown image submission and does not download an uncompleted or failed task', async () => {
    const f = await setup();
    const request = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockRejectedValue(new Error('submission timeout'));
    expect((await f.runtime().run('images/tasks', request)).status).toBe('unknown');
    expect((await f.runtime().run('images/tasks', request)).status).toBe('unknown');
    expect((await f.runtime().run('images/refresh', request)).status).toBe('unknown');
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.counts().uploads).toBe(0);
});

it('keeps an accepted image receipt after failed or invalid provider status and refuses a foreign project', async () => {
    const f = await setup();
    const input = { ...f.input, prompt: 'product', referenceIds: [], size: '1024x1024' };
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_failure', status: 'pending' }));
    await f.runtime().run('images/tasks', input);
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_other', status: 'completed' }));
    await expect(f.runtime().run('images/refresh', input)).rejects.toThrow('未知状态');
    f.provider.mockResolvedValueOnce(Response.json({ id: 'img_failure', status: 'failed', error: { message: 'provider failed' } }));
    expect(await f.runtime().run('images/refresh', input)).toMatchObject({ status: 'failed', error: 'provider failed' });
    await f.runtime().run('images/tasks', input);
    expect(f.provider).toHaveBeenCalledTimes(3);
    await expect(f.runtime().run('images/refresh', { ...input, projectId: 'd'.repeat(24) })).rejects.toThrow('项目');
    expect(f.counts().uploads).toBe(0);
});
