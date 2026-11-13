import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 裁剪是纯本地 Sharp 操作：这里用一张会记录请求的假图片服务证明它从不被调用。
test('crop plugin cuts the selection locally without calling any model', { timeout: 40000 }, async (t) => {
  const root = path.resolve(import.meta.dirname, '..');
  await mkdir(path.join(root, 'work'), { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'work', 'crop-test-'));
  const configRoot = path.join(fixture, 'config');
  await mkdir(configRoot);
  const providerCalls = [];
  const provider = http.createServer((req, res) => {
    providerCalls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('unused').toString('base64') }] }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${provider.address().port}`;
  // 只用 text_to_image 的模型：裁剪不要求任何编辑能力，仍必须成功。
  await writeFile(path.join(configRoot, 'models.json'), JSON.stringify({
    active_model: 'plain', models: [
      { id: 'plain', type: 'image', provider: 'custom', name: 'Plain image', model: 'fixture', baseUrl, apiKey: 'crop-test-secret', capabilities: ['text_to_image'], outputFormats: ['png'], defaultParams: { size: '1024x1024' } },
    ],
  }));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PIXELFLOW_API_PORT: '0', LAYERIVE_DATA_ROOT: path.join(fixture, 'data'), LAYERIVE_CONFIG_ROOT: configRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await new Promise((resolve) => provider.close(resolve));
  });
  for (let i = 0; i < 200 && !/127\.0\.0\.1:\d+/.test(logs); i += 1) await pause(25);
  const base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base, logs);
  const request = async (url, body, status = 200) => {
    const response = await fetch(base + '/api' + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  };
  const waitForTask = async (projectId, taskId) => {
    for (let i = 0; i < 200; i += 1) {
      const task = await request(`/projects/${projectId}/tasks/${taskId}`);
      if (['success', 'failed', 'canceled'].includes(task.status)) return task;
      await pause(25);
    }
    throw new Error('crop task did not finish');
  };

  const { project } = await request('/projects', { name: 'Crop fixture' }, 201);
  const prefix = '/projects/' + project.id;
  const source = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const uploaded = await request(prefix + '/images', { data: source.toString('base64'), mimeType: 'image/png' }, 201);
  const imageId = uploaded.project.currentImageId;

  const started = await request(prefix + '/plugins/layerive.crop/run', { imageId, modelId: 'plain', rect: { x: 25, y: 25, width: 50, height: 50 } }, 202);
  const task = await waitForTask(project.id, started.taskId);
  assert.equal(task.status, 'success', task.error || '');
  assert.equal(task.stage, 'cutting');
  const bundle = await request(prefix);
  const version = bundle.versions.find((item) => item.operation === 'crop_image');
  assert.ok(version, 'crop version is recorded');
  assert.equal(version.outputs.length, 1);
  // 400x300 的中间 50% 应得到 200x150 的真实像素尺寸，而不是模型画布。
  assert.equal(version.outputs[0].width, 200);
  assert.equal(version.outputs[0].height, 150);
  // 上传图首次编辑会补建起始版本，裁剪版本挂在它下面。
  const uploadVersion = bundle.versions.find((item) => item.id === version.parentVersionId);
  assert.ok(uploadVersion, 'crop version is parented to the uploaded source version');
  assert.equal(providerCalls.length, 0, 'no model request may be issued');

  // 旧路由与统一插件入口等价。
  const legacy = await request(prefix + '/crop', { imageId, modelId: 'plain', rect: { x: 0, y: 0, width: 25, height: 50 } }, 202);
  const legacyTask = await waitForTask(project.id, legacy.taskId);
  assert.equal(legacyTask.status, 'success', legacyTask.error || '');
  const legacyVersion = (await request(prefix)).versions
    .filter((item) => item.operation === 'crop_image')
    .sort((a, b) => b.number - a.number)[0];
  assert.equal(legacyVersion.outputs[0].width, 100);
  assert.equal(legacyVersion.outputs[0].height, 150);

  // 无效与过小的矩形都在创建任务前被拒绝。
  await request(prefix + '/plugins/layerive.crop/run', { imageId, modelId: 'plain', rect: { x: 0, y: 0, width: 0, height: 40 } }, 400);
  await request(prefix + '/plugins/layerive.crop/run', { imageId, modelId: 'plain', rect: { x: 10, y: 10, width: 0.2, height: 0.2 } }, 400);
  await request(prefix + '/plugins/layerive.crop/run', { imageId, modelId: 'plain', rect: { x: 120, y: 0, width: 10, height: 10 } }, 400);
  await request(prefix + '/plugins/layerive.crop/run', { modelId: 'plain', rect: { x: 10, y: 10, width: 30, height: 30 } }, 400);
  assert.equal(providerCalls.length, 0);
});

test('crop resolves percentage coordinates against the EXIF-oriented frame', { timeout: 40000 }, async (t) => {
  const root = path.resolve(import.meta.dirname, '..');
  await mkdir(path.join(root, 'work'), { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'work', 'crop-exif-test-'));
  const configRoot = path.join(fixture, 'config');
  await mkdir(configRoot);
  await writeFile(path.join(configRoot, 'models.json'), JSON.stringify({
    active_model: 'plain', models: [
      { id: 'plain', type: 'image', provider: 'custom', name: 'Plain image', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'crop-test-secret', capabilities: ['text_to_image'], outputFormats: ['png'], defaultParams: { size: '1024x1024' } },
    ],
  }));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PIXELFLOW_API_PORT: '0', LAYERIVE_DATA_ROOT: path.join(fixture, 'data'), LAYERIVE_CONFIG_ROOT: configRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => { if (child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  for (let i = 0; i < 200 && !/127\.0\.0\.1:\d+/.test(logs); i += 1) await pause(25);
  const base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base, logs);
  const request = async (url, body, status = 200) => {
    const response = await fetch(base + '/api' + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  };
  // 编码帧 400x200，EXIF orientation 6（顺时针 90°）→ 用户看到的是 200x400。
  const encoded = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#aa3311' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const { project } = await request('/projects', { name: 'Crop EXIF fixture' }, 201);
  const prefix = '/projects/' + project.id;
  const uploaded = await request(prefix + '/images', { data: encoded.toString('base64'), mimeType: 'image/jpeg' }, 201);
  const imageId = uploaded.project.currentImageId;
  const started = await request(prefix + '/plugins/layerive.crop/run', { imageId, modelId: 'plain', rect: { x: 0, y: 0, width: 50, height: 50 } }, 202);
  let task;
  for (let i = 0; i < 200; i += 1) {
    task = await request(`/projects/${project.id}/tasks/${started.taskId}`);
    if (['success', 'failed', 'canceled'].includes(task.status)) break;
    await pause(25);
  }
  assert.equal(task.status, 'success', task.error || '');
  const version = (await request(prefix)).versions.find((item) => item.operation === 'crop_image');
  // 可见画幅的左上四分之一：200x400 的一半 → 100x200（未按 EXIF 处理会得到 200x100）。
  assert.equal(version.outputs[0].width, 100);
  assert.equal(version.outputs[0].height, 200);
});
