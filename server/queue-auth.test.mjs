import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { test } from 'node:test';
import { authHeaders, login } from './test-auth.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(30);
  }
  throw new Error('Timed out waiting for queue/auth fixture');
}

async function spawnServer(t, dataRoot, configRoot) {
  const root = path.resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, PIXELFLOW_API_PORT: '0', LAYERIVE_DATA_ROOT: dataRoot, LAYERIVE_CONFIG_ROOT: configRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  await waitUntil(() => /127\.0\.0\.1:\d+/.test(logs));
  const base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  t.after(async () => {
    // A signal-killed child keeps exitCode null (signalCode is set instead);
    // awaiting 'exit' on an already-exited child would hang forever.
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  return { child, base };
}

test('admin guard, user management, queue settings clamp and key-pool rotation', { timeout: 90000 }, async (t) => {
  const root = path.resolve(import.meta.dirname, '..');
  await mkdir(path.join(root, 'work'), { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'work', 'queue-auth-test-'));
  const configRoot = path.join(fixture, 'config');
  await mkdir(configRoot);
  const generated = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#49b974' } }).png().toBuffer();
  const poolKeys = ['key-alpha', 'key-beta'];
  const imageAuth = [];
  let failNext429 = 0;
  const stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!req.url.endsWith('/images/generations')) { res.writeHead(404); res.end('{}'); return; }
    imageAuth.push(String(req.headers.authorization || ''));
    if (failNext429 > 0) {
      failNext429 -= 1;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  t.after(async () => {
    stub.closeAllConnections?.();
    await new Promise((resolve) => stub.close(resolve));
  });
  await writeFile(path.join(configRoot, 'models.json'), JSON.stringify({ active_model: 'image', active_vision_model: '', models: [
    { id: 'image', name: 'Pool stub', provider: 'openai', type: 'image', model: 'fixture', baseUrl: stubUrl, apiKey: 'key-alpha', apiKeys: poolKeys, capabilities: ['text_to_image'], defaultParams: { size: '1024x1024' } },
  ] }));

  const { base } = await spawnServer(t, path.join(fixture, 'data'), configRoot);
  const call = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? authHeaders(token) : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const adminLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.body.username, 'admin');
  assert.equal(adminLogin.body.role, 'admin');
  const admin = adminLogin.body.token;

  // Queue settings: default value, clamping and validation.
  let settings = await call('/api/admin/settings', { token: admin });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.queueConcurrency, 2);
  assert.equal((await call('/api/admin/settings', { method: 'PUT', token: admin, body: { queueConcurrency: 99 } })).body.queueConcurrency, 8);
  assert.equal((await call('/api/admin/settings', { method: 'PUT', token: admin, body: { queueConcurrency: -5 } })).body.queueConcurrency, 1);
  assert.equal((await call('/api/admin/settings', { method: 'PUT', token: admin, body: { queueConcurrency: 0 } })).body.queueConcurrency, 2);
  assert.equal((await call('/api/admin/settings', { method: 'PUT', token: admin, body: { queueConcurrency: 'x' } })).status, 400);
  await call('/api/admin/settings', { method: 'PUT', token: admin, body: { queueConcurrency: 2 } });

  // The last admin cannot be demoted or deleted.
  assert.equal((await call('/api/admin/users/admin', { method: 'PATCH', token: admin, body: { role: 'user' } })).status, 400);
  assert.equal((await call('/api/admin/users/admin', { method: 'DELETE', token: admin })).status, 400);

  // Create a restricted user and verify the guards.
  const created = await call('/api/admin/users', { method: 'POST', token: admin, body: { username: 'alice', password: 'secret123', role: 'user' } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.user, { username: 'alice', role: 'user' });
  assert.equal((await call('/api/admin/users', { method: 'POST', token: admin, body: { username: 'alice', password: 'secret123' } })).status, 400);
  const aliceLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  assert.equal(aliceLogin.body.role, 'user');
  const alice = aliceLogin.body.token;
  assert.equal((await call('/api/admin/users', { token: alice })).status, 403);
  assert.equal((await call('/api/admin/settings', { token: alice })).status, 403);
  assert.equal((await call('/api/models', { method: 'POST', token: alice, body: {} })).status, 403);
  assert.equal((await call('/api/backup', { token: alice })).status, 403);
  assert.equal((await call('/api/models', { token: alice })).status, 200);
  assert.equal((await call('/api/projects', { token: alice })).status, 200);

  // Role changes and password changes revoke the user's sessions.
  assert.equal((await call('/api/admin/users/alice', { method: 'PATCH', token: admin, body: { role: 'admin' } })).status, 200);
  assert.equal((await call('/api/projects', { token: alice })).status, 401);
  const aliceAgain = await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  assert.equal(aliceAgain.body.role, 'admin');
  assert.equal((await call('/api/admin/users/alice', { method: 'PATCH', token: admin, body: { password: 'newpass9' } })).status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret123' } })).status, 401);
  assert.equal((await call('/api/admin/users/alice', { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'newpass9' } })).status, 401);
  assert.equal((await call('/api/admin/users/nope', { method: 'DELETE', token: admin })).status, 404);

  // Key pool: consecutive single-image tasks rotate across the pool.
  const project = await call('/api/projects', { method: 'POST', token: admin, body: { name: 'Pool fixture' } });
  assert.equal(project.status, 201);
  const projectId = project.body.project.id;
  const generate = async () => call(`/api/projects/${projectId}/generate`, { method: 'POST', token: admin, body: { prompt: '轮询', params: { count: 1 } } });
  const keyOf = (authorization) => authorization.replace(/^Bearer\s+/, '');
  const finished = async (taskId) => {
    let task;
    await waitUntil(async () => { task = await call(`/api/projects/${projectId}/tasks/${taskId}`, { token: admin }); return !['queued', 'generating'].includes(task.body.status); });
    return task.body;
  };

  const first = await generate();
  assert.equal(first.status, 202);
  const second = await generate();
  assert.equal(second.status, 202);
  assert.equal((await finished(first.body.taskId)).status, 'success');
  assert.equal((await finished(second.body.taskId)).status, 'success');
  const rotated = imageAuth.map(keyOf);
  assert.equal(rotated.length, 2);
  assert.equal(new Set(rotated).size, 2);

  // A 429 retry must switch to a different key within the same task.
  failNext429 = 1;
  const third = await generate();
  assert.equal(third.status, 202);
  assert.equal((await finished(third.body.taskId)).status, 'success');
  const retried = imageAuth.slice(2).map(keyOf);
  assert.equal(retried.length, 2);
  assert.notEqual(retried[0], retried[1]);

  // Masked keys survive a save: the pool still authenticates with real keys.
  const listing = await call('/api/models', { token: admin });
  const masked = listing.body.models.find((model) => model.id === 'image');
  assert.equal(masked.apiKey, '••••••••');
  assert.deepEqual(masked.apiKeys, ['••••••••', '••••••••']);
  const saved = await call('/api/models/image', { method: 'PATCH', token: admin, body: { ...masked, apiKey: '••••••••', apiKeys: ['••••••••', '••••••••'] } });
  assert.equal(saved.status, 200);
  const fourth = await generate();
  const fifth = await generate();
  assert.equal((await finished(fourth.body.taskId)).status, 'success');
  assert.equal((await finished(fifth.body.taskId)).status, 'success');
  const preserved = imageAuth.slice(4).map(keyOf);
  assert.equal(preserved.length, 2);
  assert.equal(new Set(preserved).size, 2);
  assert.ok(preserved.every((key) => poolKeys.includes(key)), 'masked keys must not reach the provider');
});

test('global queue serializes work, queued cancel skips the provider, restart fails pending tasks', { timeout: 90000 }, async (t) => {
  const root = path.resolve(import.meta.dirname, '..');
  await mkdir(path.join(root, 'work'), { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'work', 'queue-serial-test-'));
  const configRoot = path.join(fixture, 'config');
  await mkdir(configRoot);
  const generated = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#49b974' } }).png().toBuffer();
  const waiters = [];
  const imageCalls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!req.url.endsWith('/images/generations')) { res.writeHead(404); res.end('{}'); return; }
    imageCalls.push(String(req.headers.authorization || ''));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Hold each generation until the test releases it.
    await new Promise((resolve) => waiters.push(resolve));
    inFlight -= 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  t.after(async () => {
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  });
  await writeFile(path.join(configRoot, 'models.json'), JSON.stringify({ active_model: 'image', active_vision_model: '', models: [
    { id: 'image', name: 'Serial stub', provider: 'openai', type: 'image', model: 'fixture', baseUrl: stubUrl, apiKey: 'local-test-placeholder', capabilities: ['text_to_image'], defaultParams: { size: '1024x1024' } },
  ] }));

  const dataRoot = path.join(fixture, 'data');
  let server = await spawnServer(t, dataRoot, configRoot);
  let base = server.base;
  const admin = await login(base);
  const call = async (path, { method = 'GET', token, body } = {}, useBase = base) => {
    const response = await fetch(`${useBase}${path}`, {
      method,
      headers: { ...(token ? authHeaders(token) : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  await call('/api/admin/settings', { method: 'PUT', token: admin, body: { queueConcurrency: 1 } });
  const project = await call('/api/projects', { method: 'POST', token: admin, body: { name: 'Queue fixture' } });
  const projectId = project.body.project.id;
  const generate = async () => call(`/api/projects/${projectId}/generate`, { method: 'POST', token: admin, body: { prompt: '排队', params: { count: 1 } } });
  const taskOf = (taskId) => call(`/api/projects/${projectId}/tasks/${taskId}`, { token: admin });

  // Concurrency 1: A runs, B and C stay queued.
  const a = await generate();
  const b = await generate();
  const c = await generate();
  assert.equal(a.body.status, 'queued');
  await waitUntil(async () => (await taskOf(a.body.taskId)).body.status === 'generating');
  await waitUntil(() => waiters.length === 1);
  assert.equal((await taskOf(b.body.taskId)).body.status, 'queued');
  assert.equal((await taskOf(c.body.taskId)).body.status, 'queued');
  assert.equal(imageCalls.length, 1);

  // Canceling a queued task never reaches the provider and hides its version.
  const canceled = await call(`/api/projects/${projectId}/tasks/${b.body.taskId}/cancel`, { method: 'POST', token: admin });
  assert.equal(canceled.body.status, 'canceled');
  assert.equal((await taskOf(b.body.taskId)).body.status, 'canceled');
  assert.equal(imageCalls.length, 1);

  // Releasing A lets C start; B's slot is gone.
  waiters.shift()();
  await waitUntil(async () => (await taskOf(a.body.taskId)).body.status === 'success');
  await waitUntil(async () => (await taskOf(c.body.taskId)).body.status === 'generating');
  waiters.shift()();
  await waitUntil(async () => (await taskOf(c.body.taskId)).body.status === 'success');
  assert.equal(maxInFlight, 1);
  assert.equal(imageCalls.length, 2);
  const bundle = await call(`/api/projects/${projectId}`, { token: admin });
  assert.equal(bundle.body.versions.filter((version) => version.operation === 'text_to_image').length, 2);
  assert.ok(bundle.body.versions.every((version) => version.status === 'success'));

  // A hard kill leaves queued/generating tasks behind; the next boot fails them.
  const d = await generate();
  await waitUntil(async () => (await taskOf(d.body.taskId)).body.status === 'generating');
  await waitUntil(() => waiters.length === 1);
  const exited = once(server.child, 'exit');
  server.child.kill('SIGKILL');
  await exited;
  server = await spawnServer(t, dataRoot, configRoot);
  base = server.base;
  const restartedAdmin = await login(base);
  assert.equal((await call(`/api/projects/${projectId}/tasks/${d.body.taskId}`, { token: restartedAdmin })).body.status, 'failed');
  assert.equal((await call(`/api/projects/${projectId}/tasks/${a.body.taskId}`, { token: restartedAdmin })).body.status, 'success');
});
