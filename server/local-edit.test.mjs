import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { composeLocalReference, maskBytes, maskRegion, normalizeLocalImage, normalizeSenseNovaInput, pixelRect, preserveOutsideRegion, referenceBytes, validatePlacement, validateRect } from './local-edit.mjs';
import { authHeaders, login } from './test-auth.mjs';

const rect = { x: 25, y: 20, width: 50, height: 60 };
const plan = { intent: '将目标替换为参考主体', target_rect: { x: 30, y: 25, width: 30, height: 40 }, reference_rect: { x: 20, y: 10, width: 60, height: 70 }, edit_prompt: '自然融合参考主体，修复边缘与光影，保留框外内容。' };
const solid = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const raw = (bytes) => sharp(bytes).ensureAlpha().raw().toBuffer();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertOutside(original, changed, width, height, selection) {
  const box = pixelRect(selection, width, height);
  let insideChanged = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const equal = original.subarray(offset, offset + 4).equals(changed.subarray(offset, offset + 4));
    if (x < box.left || x >= box.left + box.width || y < box.top || y >= box.top + box.height) assert.ok(equal, `outside changed at ${x},${y}`);
    else if (!equal) insideChanged = true;
  }
  assert.ok(insideChanged, 'the selected area must actually change');
}

test('reject invalid uploads and model coordinates before compositing', () => {
  for (const bad of [null, { ...rect, width: NaN }, { ...rect, x: '25' }, { ...rect, x: 99 }, { ...rect, height: 0 }]) assert.throws(() => validateRect(bad));
  assert.throws(() => validatePlacement({ ...plan, target_rect: { x: 0, y: 0, width: 10, height: 10 } }, rect), /超出/);
  assert.throws(() => validatePlacement({ ...plan, reference_rect: { x: -1, y: 0, width: 10, height: 10 } }, rect));
  assert.throws(() => referenceBytes({ data: '!!!!', mimeType: 'image/png' }));
  assert.throws(() => referenceBytes({ data: 'YWJj', mimeType: 'image/svg+xml' }));
  assert.throws(() => referenceBytes({ data: 'A'.repeat(14 * 1024 * 1024), mimeType: 'image/png' }));
});

// ---- 笔刷蒙版 ----------------------------------------------------------

const whitePatch = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
const transparentCanvas = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
async function maskFixture(width, height, patches) {
  return sharp(await transparentCanvas(width, height))
    .composite(await Promise.all(patches.map(async ({ left, top, width: w, height: h }) => ({ input: await whitePatch(w, h), left, top }))))
    .png().toBuffer();
}

test('brush mask validation and painted bounding box derivation', async () => {
  assert.throws(() => maskBytes('data:image/jpeg;base64,AAAA'), /PNG/);
  assert.throws(() => maskBytes('data:image/png;base64,!!!!'), /无效/);
  assert.throws(() => maskBytes(`data:image/png;base64,${'A'.repeat(14 * 1024 * 1024)}`), /10MB/);
  assert.throws(() => maskBytes('plain-not-data-url'), /PNG data URL/);
  const mask = await maskFixture(120, 90, [{ left: 30, top: 25, width: 50, height: 40 }, { left: 85, top: 70, width: 20, height: 15 }]);
  const region = await maskRegion(mask, 120, 90);
  // composite 补丁是左闭右开区间：第二块 [85,105) 的最后像素在 104，总宽 75。
  assert.deepEqual({ left: region.left, top: region.top, width: region.width, height: region.height }, { left: 30, top: 25, width: 75, height: 60 });
  assert.equal(region.rect.x, 25);
  assert.equal(region.rect.width, (75 * 100) / 120);
  await assert.rejects(maskRegion(await transparentCanvas(120, 90), 120, 90), /蒙版为空/);
  // 蒙版尺寸与原图不一致时自动缩放到原图分辨率，包围盒按缩放后计算；
  // 插值内核会让硬边缘向右/下溢出约 1px，断言允许该误差。
  const scaled = await maskRegion(await maskFixture(60, 45, [{ left: 15, top: 12, width: 25, height: 20 }]), 120, 90);
  assert.equal(scaled.left, 30);
  assert.equal(scaled.top, 24);
  assert.ok(Math.abs(scaled.width - 50) <= 1 && Math.abs(scaled.height - 40) <= 1, `scaled bbox ${scaled.width}x${scaled.height}`);
});

test('mask-aware preservation keeps unpainted pixels exactly original', async () => {
  const source = await normalizeLocalImage(await solid(120, 90, '#264560'));
  const strokes = await maskFixture(120, 90, [{ left: 40, top: 30, width: 40, height: 30 }]);
  const region = await maskRegion(strokes, 120, 90);
  const output = await preserveOutsideRegion(source, { bytes: await solid(300, 300, '#49b974') }, { x: 25, y: 20, width: 50, height: 60 }, region);
  assert.equal(output.width, 120);
  assert.equal(output.height, 90);
  const original = await raw(source.buffer);
  const changed = await raw(output.bytes);
  const at = (x, y) => changed.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4);
  // 笔画中心完全采用生成结果；包围盒外与远离笔画的包围盒内像素严格等于原图。
  assert.ok(at(60, 45).equals(Buffer.from([0x49, 0xb9, 0x74, 255])));
  assert.ok(at(10, 10).equals(original.subarray((10 * 120 + 10) * 4, (10 * 120 + 10) * 4 + 4)));
  assert.ok(at(100, 80).equals(original.subarray((80 * 120 + 100) * 4, (80 * 120 + 100) * 4 + 4)));
  // 羽化带（σ=1，约 1px）介于原图与生成色之间。
  const edge = at(40, 45);
  assert.ok(!edge.equals(Buffer.from([0x49, 0xb9, 0x74, 255])) && !edge.equals(original.subarray((45 * 120 + 40) * 4, (45 * 120 + 40) * 4 + 4)));
});

test('PNG/JPEG/WebP decoding, orientation, crop placement and original outside pixels', async () => {
  const input = await solid(120, 90, { r: 80, g: 110, b: 140, alpha: 0.5 });
  for (const format of ['png', 'jpeg', 'webp']) {
    const image = await normalizeLocalImage(await sharp(input).toFormat(format).toBuffer());
    assert.equal(image.width, 120);
    assert.equal(image.height, 90);
  }
  const oriented = await normalizeLocalImage(await sharp(input).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  assert.equal(oriented.width, 90);
  assert.equal(oriented.height, 120);
  await assert.rejects(normalizeLocalImage(Buffer.from('not an image')));
  const source = await normalizeLocalImage(input);
  const reference = await normalizeLocalImage(await solid(100, 100, 'red'));
  const composed = await composeLocalReference(source, reference, validatePlacement(plan, rect));
  assertOutside(await raw(source.buffer), await raw(composed.buffer), 120, 90, rect);
  // Simulate a model that changes the entire image and returns the wrong size.
  const output = await preserveOutsideRegion(source, { bytes: await solid(300, 300, 'green') }, rect);
  assert.equal(output.mimeType, 'image/png');
  assert.equal(output.width, 120);
  assert.equal(output.height, 90);
  assertOutside(await raw(source.buffer), await raw(output.bytes), 120, 90, rect);
});

test('SenseNova provider copies use a valid 32px-aligned canvas without changing the original', async () => {
  const source = await solid(450, 450, '#f4d35e');
  const preferred = await normalizeSenseNovaInput(source, '1024x1024');
  assert.equal(preferred.mime_type, 'image/png');
  assert.deepEqual(await sharp(preferred.buffer).metadata().then(({ width, height }) => ({ width, height })), { width: 1024, height: 1024 });
  assert.deepEqual(await sharp(source).metadata().then(({ width, height }) => ({ width, height })), { width: 450, height: 450 });

  const automatic = await normalizeSenseNovaInput(await solid(120, 90, '#264560'));
  assert.equal(automatic.width % 32, 0);
  assert.equal(automatic.height % 32, 0);
  assert.ok(automatic.width >= 512 && automatic.height >= 512);
  assert.ok(Math.max(automatic.width / automatic.height, automatic.height / automatic.width) <= 3);
});

test('local edit API: all vision formats, composed provider input, history, failures and cancellation', { timeout: 180000 }, async (t) => {
  // Only generated fixtures and a loopback model stub; never read user data/config.
  const root = path.resolve(import.meta.dirname, '..');
  await mkdir(path.join(root, 'work'), { recursive: true });
  const testRoot = await mkdtemp(path.join(root, 'work', 'local-edit-test-'));
  const dataRoot = path.join(testRoot, 'data');
  const configRoot = path.join(testRoot, 'config');
  await mkdir(configRoot);
  const sourceBytes = await solid(120, 90, '#264560');
  const reference = { data: (await solid(80, 100, 'red')).toString('base64'), mimeType: 'image/png' };
  const generated = await solid(128, 128, '#49b974');
  const calls = [];
  let mode = 'success';
  let releaseVision;
  let releaseGeneration;
  const stub = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      calls.push({ url: req.url, bytes, contentType: req.headers['content-type'] });
      if (req.url.endsWith('/images/edits')) {
        if (mode === 'hold-generation') await new Promise((resolve) => { releaseGeneration = resolve; });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }, { b64_json: generated.toString('base64') }] }));
        return;
      }
      if (mode === 'hold-vision') await new Promise((resolve) => { releaseVision = resolve; });
      const content = JSON.stringify(mode === 'bad-plan' ? { ...plan, target_rect: { x: 0, y: 0, width: 5, height: 5 } } : plan);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.endsWith('/messages') ? { content: [{ type: 'text', text: content }] } : req.url.endsWith('/responses') ? { output_text: content } : { choices: [{ message: { content } }] }));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const visionFormats = ['chat_completions', 'anthropic_messages', 'responses'];
  await writeFile(path.join(configRoot, 'models.json'), JSON.stringify({ active_model: 'image', active_vision_model: visionFormats[0], models: [
    { id: 'image', name: 'Local image stub', provider: 'openai', type: 'image', model: 'fixture', baseUrl: stubUrl, apiKey: 'local-test-placeholder', capabilities: ['edit_prompt'], defaultParams: { size: '1024x1024' } },
    ...visionFormats.map((apiFormat) => ({ id: apiFormat, name: apiFormat, provider: 'openai', type: 'vision', apiFormat, model: 'fixture', baseUrl: stubUrl, apiKey: 'local-test-placeholder' })),
  ] }));
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, PIXELFLOW_API_PORT: '0', LAYERIVE_DATA_ROOT: dataRoot, LAYERIVE_CONFIG_ROOT: configRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    releaseVision?.(); releaseGeneration?.();
    if (child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  });
  await waitUntil(() => /127\.0\.0\.1:\d+/.test(logs), 30000);
  const base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const token = await login(base);
  const auth = authHeaders(token);
  async function request(url, body, expected = 200) {
    const response = await fetch(`${base}/api${url}`, body === undefined ? { headers: auth } : { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.status, expected, JSON.stringify(payload));
    return payload;
  }
  async function fixtureProject() {
    const { project } = await request('/projects', { name: 'Local edit fixture' }, 201);
    const uploaded = await request(`/projects/${project.id}/images`, { data: sourceBytes.toString('base64'), mimeType: 'image/png', name: 'source.png' }, 201);
    return { projectId: project.id, imageId: uploaded.project.currentImageId };
  }
  const submit = ({ projectId, imageId }, extra = {}) => request(`/projects/${projectId}/local-edit`, { imageId, modelId: 'image', visionModelId: visionFormats[0], instruction: '', reference, rect, params: { size: '1024x1024', count: 2 }, ...extra }, 202);
  async function finished(projectId, taskId) {
    let task;
    await waitUntil(async () => { task = await request(`/projects/${projectId}/tasks/${taskId}`); return task.status !== 'generating'; }, 60000);
    return task;
  }
  for (const format of visionFormats) {
    const fixture = await fixtureProject();
    const first = calls.length;
    const started = await submit(fixture, { visionModelId: format });
    const task = await finished(fixture.projectId, started.taskId);
    assert.equal(task.status, 'success', task.error);
    const vision = JSON.parse(calls[first].bytes);
    const content = format === 'responses' ? vision.input[0].content : vision.messages.at(-1).content;
    assert.equal(content.filter((item) => ['image', 'image_url', 'input_image'].includes(item.type)).length, 2);
    const modelCall = calls.slice(first).find((item) => item.url.endsWith('/images/edits'));
    const form = await new Response(modelCall.bytes, { headers: { 'Content-Type': modelCall.contentType } }).formData();
    const providerInput = Buffer.from(await form.get('image').arrayBuffer());
    assertOutside(await raw(sourceBytes), await raw(providerInput), 120, 90, rect);
    assert.match(form.get('prompt'), /初步拼贴/);
    const bundle = await request(`/projects/${fixture.projectId}`);
    const version = bundle.versions.find((item) => item.operation === 'local_edit');
    assert.equal(version.outputs.length, 2);
    assert.equal(version.parentVersionId, bundle.versions.find((item) => item.operation === 'upload').id);
    assert.deepEqual(version.inputs.map((item) => item.sourceType).sort(), ['local_composite', 'local_reference', 'upload']);
    for (const image of version.outputs) {
      assert.equal(image.width, 120); assert.equal(image.height, 90); assert.equal(image.mimeType, 'image/png');
      const bytes = Buffer.from(await (await fetch(base + image.url)).arrayBuffer());
      assertOutside(await raw(sourceBytes), await raw(bytes), 120, 90, rect);
    }
  }
  const textFixture = await fixtureProject();
  const textStart = calls.length;
  const textTask = await submit(textFixture, { reference: undefined, instruction: '将选区变绿' });
  assert.equal((await finished(textFixture.projectId, textTask.taskId)).status, 'success');
  assert.equal(JSON.parse(calls[textStart].bytes).messages.at(-1).content.filter((item) => item.type === 'image_url').length, 1);
  const badFixture = await fixtureProject();
  mode = 'bad-plan';
  const beforeBad = calls.length;
  const bad = await submit(badFixture);
  assert.equal((await finished(badFixture.projectId, bad.taskId)).status, 'failed');
  assert.ok(!calls.slice(beforeBad).some((item) => item.url.endsWith('/images/edits')));
  assert.equal((await request(`/projects/${badFixture.projectId}`)).project.currentImageId, badFixture.imageId);
  for (const hold of ['hold-vision', 'hold-generation']) {
    mode = hold;
    const fixture = await fixtureProject();
    const started = await submit(fixture);
    await waitUntil(() => hold === 'hold-vision' ? Boolean(releaseVision) : Boolean(releaseGeneration));
    const active = await request(`/projects/${fixture.projectId}/tasks/${started.taskId}`);
    assert.equal(active.stage, hold === 'hold-vision' ? 'planning' : 'generating');
    await request(`/projects/${fixture.projectId}/tasks/${started.taskId}/cancel`, {});
    assert.equal((await finished(fixture.projectId, started.taskId)).status, 'canceled');
    const bundle = await request(`/projects/${fixture.projectId}`);
    assert.equal(bundle.project.currentImageId, fixture.imageId);
    assert.ok(!bundle.versions.some((item) => item.operation === 'local_edit'));
    releaseVision?.(); releaseGeneration?.();
    releaseVision = null; releaseGeneration = null;
  }

  // 批量局部修改：多条指令共用同一选区与参考图，逐张写入同一个版本并保留框外像素。
  mode = 'success';
  {
    const fixture = await fixtureProject();
    const started = await request(`/projects/${fixture.projectId}/local-edit-batch`, {
      imageId: fixture.imageId,
      modelId: 'image',
      visionModelId: visionFormats[0],
      rect,
      reference,
      instructions: ['把主体换成红色款', '把主体换成蓝色款'],
      params: { size: '1024x1024' },
    }, 202);
    let progress;
    await waitUntil(async () => {
      progress = await request(`/projects/${fixture.projectId}/batch-edits/${started.taskId}`);
      return progress.status !== 'generating';
    }, 60000);
    assert.equal(progress.status, 'success', progress.error);
    assert.equal(progress.localEdit, true);
    assert.equal(progress.total, 2);
    assert.deepEqual(progress.items.map((item) => item.values), [
      { 指令: '把主体换成红色款' },
      { 指令: '把主体换成蓝色款' },
    ]);
    const bundle = await request(`/projects/${fixture.projectId}`);
    const version = bundle.versions.filter((item) => item.operation === 'local_edit').at(-1);
    assert.equal(version.status, 'success');
    assert.equal(version.outputs.length, 2);
    // 每个子项独立规划并保存各自的参考图 / 合成图素材，全部关联到版本。
    assert.deepEqual(version.inputs.map((item) => item.sourceType).sort(), ['local_composite', 'local_composite', 'local_reference', 'local_reference', 'upload']);
    for (const image of version.outputs) {
      assert.equal(image.width, 120); assert.equal(image.height, 90); assert.equal(image.mimeType, 'image/png');
      const bytes = Buffer.from(await (await fetch(base + image.url)).arrayBuffer());
      assertOutside(await raw(sourceBytes), await raw(bytes), 120, 90, rect);
    }
    const single = await request(`/projects/${fixture.projectId}/local-edit-batch`, {
      imageId: fixture.imageId,
      modelId: 'image',
      rect,
      instructions: ['只有一条指令'],
    }, 400);
    assert.match(single.error, /2–50/);
  }

  // 笔刷蒙版：只涂蒙版、不填指令时按消除默认文案规划，输出按蒙版羽化回填，
  // 蒙版外像素严格等于原图，蒙版素材挂到版本 inputs。
  {
    const fixture = await fixtureProject();
    const strokes = await maskFixture(120, 90, [{ left: 40, top: 30, width: 40, height: 30 }]);
    const start = calls.length;
    const started = await request(`/projects/${fixture.projectId}/local-edit`, {
      imageId: fixture.imageId,
      modelId: 'image',
      visionModelId: visionFormats[0],
      mask: `data:image/png;base64,${strokes.toString('base64')}`,
      instruction: '',
      params: { size: '1024x1024', count: 1 },
    }, 202);
    const task = await finished(fixture.projectId, started.taskId);
    assert.equal(task.status, 'success', task.error);
    assert.match(JSON.stringify(JSON.parse(calls[start].bytes)), /移除涂选区域内的物体/);
    const bundle = await request(`/projects/${fixture.projectId}`);
    const version = bundle.versions.filter((item) => item.operation === 'local_edit').at(-1);
    assert.ok(version.inputs.some((item) => item.sourceType === 'local_mask'));
    const bytes = Buffer.from(await (await fetch(base + version.outputs[0].url)).arrayBuffer());
    const changed = await raw(bytes);
    const source = await raw(sourceBytes);
    const at = (x, y) => changed.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4);
    const originalAt = (x, y) => source.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4);
    assert.ok(at(60, 45).equals(Buffer.from([0x49, 0xb9, 0x74, 255])));
    assert.ok(at(10, 10).equals(originalAt(10, 10)));
    assert.ok(at(88, 40).equals(originalAt(88, 40)));
  }
});

async function waitUntil(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(30);
  }
  throw new Error('Timed out waiting for local fixture');
}
