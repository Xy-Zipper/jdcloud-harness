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
            return Response.json({ data: [{ b64_json: png }] });
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
            if (poolRows && url.startsWith('https://platform.example')) {
                expect(init.headers.Authorization).toBe('reader-token');
                return Response.json({ code: 200, data: init.method === 'GET'
                    ? { userInfo: { corpId: config.tenantId } } : { list: poolRows } });
            }
            return provider(url, init);
        }, billing);
    const input = { projectId: f.project._id, planId: f.plan._id, spaceId: f.project.spaceId, requestId: 'request-test-001' };
    return { ...f, config, auth, provider, records, runtime, input, batchId, priceRows,
        failNextRelation() { failRelation = true; }, denyWrites() { denyWrite = true; },
        counts: () => ({ imageCalls, videoCalls, uploads }) };
}
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
    await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('1–9');
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
        f.auth.downloadFileAuthenticated.mockRejectedValueOnce(new Error('reference-preflight-complete'));
        await expect(runtime.run('video/tasks', { ...f.input, batchId: f.batchId })).rejects.toThrow('reference-preflight-complete');
        expect(JSON.stringify(material)).toBe(before);
        expect(f.provider).not.toHaveBeenCalled();
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

// Inspect the actual provider request: confirmed copy must precede editable visual prose.
it('places confirmed Chinese subtitles and narration before visual prompts without rewriting the copy', async () => {
    const f = await setup();
    const voiceId = 'a'.repeat(24), audioFileId = 'b'.repeat(24);
    const copy = ['下单，报价，开标。', '麓山云，做软件开发。'];
    f.rows.forEach((row, index) => {
        const detail = JSON.parse(row.scriptDetail);
        detail.subtitle = copy[index] || '';
        detail.narration = copy[index] || '';
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
    batch.prompt = encodeGenerationPrompt(saved.prompt, { ...saved.generation,
        audioReferences: [{ voiceId, name: '男声', speakerIds: ['narrator'], speakerNames: ['旁白'] }] });
    f.records.set(voiceId, { _id: voiceId, spaceId: '', fileId: audioFileId, mime: 'audio/wav' });
    const wav = Buffer.alloc(44 + 8000 * 2 * 3);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    f.auth.downloadFileAuthenticated.mockImplementation(async fileId => fileId === audioFileId
        ? new Response(wav, { headers: { 'content-type': 'audio/wav' } })
        : new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }));
    const runtime = f.runtime();
    try {
        await runtime.run('video/tasks', { ...f.input, batchId: f.batchId });
        const call = f.provider.mock.calls.find(([url, init]) => url.includes('contents/generations/tasks') && init?.method === 'POST');
        const body = JSON.parse(call[1].body);
        const text = body.content[0].text;
        for (const [index, line] of copy.entries()) {
            const time = `${index * 3}–${(index + 1) * 3}秒`;
            expect(text).toContain(`${time} 字幕：〖${line}〗`);
            expect(text).toContain(`${time} 旁白参考@音频1，只朗读一次：{${line}}`);
            expect(text.indexOf(`〖${line}〗`)).toBeLessThan(text.indexOf(f.plan.globalPrompt));
        }
        expect(body.content.filter(item => item.type === 'audio_url')).toHaveLength(1);
        expect(text).not.toContain('开锦');
        await expect(`${text}\n`).toMatchFileSnapshot('./expected/confirmed-video-copy-prompt.txt');
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

it('submits multiple Seedream requests before completion and restores each uploaded result', async () => {
    const f = await setup();
    const release = Promise.withResolvers();
    let created = 0;
    f.provider.mockImplementation(async (url, init) => {
        expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({ model: 'doubao-seedream-5-0-pro-260628', response_format: 'b64_json' });
        expect(body.image).toEqual([`https://platform.example/api/file/previewImage/${f.config.tenantId}/${f.imageReferences[0].fileId}`]);
        expect(init.headers.Authorization).toBe('Bearer ark-key');
        created++;
        await release.promise;
        return Response.json({ data: [{ b64_json: png }] });
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
    f.provider.mockImplementation(async (_url, init) => {
        expect(init.headers.Authorization).toBe('Bearer pooled-image-key');
        const release = Promise.withResolvers();
        releases.push(release);
        active++;
        peak = Math.max(peak, active);
        if (!releaseAll) await release.promise;
        active--;
        return Response.json({ data: [{ b64_json: png }] });
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
        return Response.json({ data: [{ b64_json: png }] });
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
        expect(f.provider).toHaveBeenCalledTimes(2);
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
        return Response.json({ data: [{ b64_json: png }] });
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
    f.provider.mockImplementation(async () => {
        if (++created === 2) await release.promise;
        return Response.json({ data: [{ b64_json: png }] });
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
        return Response.json({ data: [{ b64_json: png }] });
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
            return Response.json({ data: [{ b64_json: png }] });
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
