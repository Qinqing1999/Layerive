import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { API_BASE, type BatchEditProgress, type BatchEditResult, type GenerateResult, type GenerationTask, type GalleryEntryItem, type ModelConfig, type ModelsPayload, type Project, type ProjectBundle, type TextSegment, type AdminSettings, type AdminUser } from './types';

const AUTH_TOKEN_KEY = 'pixelforge-auth-token';
const SERVER_BASE_KEY = 'pixelforge-server-base';

let authToken: string | null = null;
let currentBase = API_BASE;

/** 会话过期（曾持有 token 却收到 401）时通知 App 回到登录页 */
let sessionExpiredHandler: (() => void) | null = null;
export function setSessionExpiredHandler(handler: (() => void) | null) {
  sessionExpiredHandler = handler;
}

/** 网络连接状态通知（断网时 App 显示持久横幅） */
let onlineState = true;
let connectionChangeHandler: ((online: boolean) => void) | null = null;
export function setConnectionChangeHandler(handler: ((online: boolean) => void) | null) {
  connectionChangeHandler = handler;
}
export function isOnline() { return onlineState; }

/** 网络断开期间失败的幂等 GET 请求队列，网络恢复后自动重试 */
type PendingRetry = { fn: () => Promise<void>; };
const pendingRetryQueue: PendingRetry[] = [];

function markOffline() {
  if (onlineState) { onlineState = false; connectionChangeHandler?.(false); }
}
function markOnline() {
  if (!onlineState) {
    onlineState = true;
    connectionChangeHandler?.(true);
    // 网络恢复后逐个重放幂等请求队列（不阻塞 UI）
    const queue = pendingRetryQueue.splice(0);
    for (const item of queue) {
      item.fn().catch(() => { /* 重放失败不再入队，避免无限循环 */ });
    }
  }
}

export async function setAuthToken(token: string) {
  authToken = token;
  await AsyncStorage.setItem(AUTH_TOKEN_KEY, token);
}

export async function clearAuthToken() {
  authToken = null;
  await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function getAuthToken(): Promise<string | null> {
  if (authToken) return authToken;
  authToken = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
  return authToken;
}

/** Read persisted server address; fall back to the default for this platform. */
export async function initServerBase(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(SERVER_BASE_KEY);
    if (saved) currentBase = saved.replace(/\/+$/, '');
  } catch { /* keep default */ }
  return currentBase;
}

export function getServerBase(): string {
  return currentBase;
}

export async function setServerBase(url: string | null) {
  const next = url ? url.trim().replace(/\/+$/, '') : '';
  currentBase = next || API_BASE;
  if (next) await AsyncStorage.setItem(SERVER_BASE_KEY, currentBase);
  else await AsyncStorage.removeItem(SERVER_BASE_KEY);
}

/** Authorization header value for Image sources and downloads. */
export function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

/** 防止 401 并发时多次触发 sessionExpiredHandler */
let sessionExpiredFiring = false;

/** 全局并发请求限流：避免连点/批量操作时短时间内并发过多请求压垮本地服务端 */
const MAX_CONCURRENCY = 6;
let inflightCount = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inflightCount < MAX_CONCURRENCY) {
    inflightCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => { inflightCount++; resolve(); });
  });
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    inflightCount = Math.max(0, inflightCount - 1);
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const method = init?.method || 'GET';
  // GET 等幂等请求失败可自动重试，POST/PATCH/DELETE 不自动重试（避免重复写入）
  const isIdempotent = method === 'GET';
  const maxRetries = isIdempotent ? 2 : 0;
  let lastError: Error = new Error('请求失败');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireSlot();
    try {
      const result = await fetchOnce<T>(path, init);
      return result;
    } catch (e) {
      lastError = e as Error;
      const isNetworkError = !(e as any)?.status; // 网络错误无 status，HTTP 错误带 status
      const is429 = (e as any)?.status === 429;
      if (attempt < maxRetries && (isNetworkError || is429)) {
        // 指数退避：500ms, 1500ms
        await new Promise((r) => setTimeout(r, 500 * Math.pow(3, attempt)));
        continue;
      }
      // 断网期间幂等 GET 失败：登记到重试队列，网络恢复后自动重放（不阻塞当前调用）
      if (isIdempotent && isNetworkError && !onlineState) {
        pendingRetryQueue.push({
          fn: async () => {
            try {
              const data = await fetchOnce<T>(path, init);
              connectionRetryHandler?.(path, data);
            } catch { /* 重放失败不再入队，避免无限循环 */ }
          },
        });
        // 队列上限 20，避免无限堆积
        if (pendingRetryQueue.length > 20) pendingRetryQueue.splice(0, pendingRetryQueue.length - 20);
      }
      throw e;
    } finally {
      releaseSlot();
    }
  }
  throw lastError;
}

/** 网络恢复后重试成功的回调，由 App.tsx 注册以刷新当前视图 */
let connectionRetryHandler: ((path: string, data: unknown) => void) | null = null;
export function setConnectionRetryHandler(handler: ((path: string, data: unknown) => void) | null) {
  connectionRetryHandler = handler;
}

async function fetchOnce<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...init?.headers };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = path.startsWith('http') ? path : `${currentBase}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method || 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      markOffline();
      throw new Error('请求超时，请检查网络连接');
    }
    markOffline();
    throw new Error(`网络请求失败：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const hadSession = Boolean(authToken);
    await clearAuthToken();
    if (hadSession && !sessionExpiredFiring) {
      sessionExpiredFiring = true;
      try { sessionExpiredHandler?.(); } finally { sessionExpiredFiring = false; }
    }
    throw new Error('登录已过期，请重新登录');
  }
  if (!response.ok) {
    // 429 标记 status 让上层重试
    const err = new Error((payload as { error?: string }).error || `请求失败（${response.status}）`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  markOnline();
  return payload as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; username: string; role: 'admin' | 'user' }>('/api/auth/login', { method: 'POST', body: { username, password } }),

  checkAuth: () => request<{ authenticated: boolean; username: string; role: string }>('/api/auth/check'),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  listProjects: () => request<{ projects: Project[] }>('/api/projects'),

  createProject: (input: { name: string; description?: string; defaultModelId?: string }) =>
    request<ProjectBundle>('/api/projects', { method: 'POST', body: input }),

  getProject: (id: string) => request<ProjectBundle>(`/api/projects/${id}`),

  updateProject: (id: string, input: Record<string, unknown>) =>
    request<ProjectBundle>(`/api/projects/${id}`, { method: 'PATCH', body: input }),

  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  duplicateProject: (id: string) => request<ProjectBundle>(`/api/projects/${id}/duplicate`, { method: 'POST' }),

  importProject: (base64Data: string) =>
    request<ProjectBundle>('/api/projects/import', { method: 'POST', body: { data: base64Data } }),

  uploadImage: (id: string, input: { data: string; mimeType: string; name: string }) =>
    request<ProjectBundle>(`/api/projects/${id}/images`, { method: 'POST', body: input }),

  generate: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/generate`, { method: 'POST', body: input }),

  listGeneratingTasks: (id: string) => request<{ tasks: GenerationTask[] }>(`/api/projects/${id}/tasks`),

  getTask: (id: string, taskId: string) => request<GenerationTask>(`/api/projects/${id}/tasks/${taskId}`),

  cancelTask: (id: string, taskId: string) => request<{ ok: boolean; status: string }>(`/api/projects/${id}/tasks/${taskId}/cancel`, { method: 'POST' }),

  recognizeText: (id: string, imageId: string, visionModelId?: string) =>
    request<{ segments: TextSegment[]; modelName: string; cached: boolean }>(`/api/projects/${id}/recognize-text`, { method: 'POST', body: { imageId, visionModelId } }),

  editText: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/edit-text`, { method: 'POST', body: input }),

  localEdit: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/local-edit`, { method: 'POST', body: input }),

  outpaint: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/outpaint`, { method: 'POST', body: input }),

  enhance: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/enhance`, { method: 'POST', body: input }),

  removeWatermark: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/remove-watermark`, { method: 'POST', body: input }),

  extractAsset: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/extract-asset`, { method: 'POST', body: input }),

  startBatchEdit: (id: string, input: Record<string, unknown>) =>
    request<BatchEditResult>(`/api/projects/${id}/batch-edit`, { method: 'POST', body: input }),

  startBatchGenerate: (id: string, input: Record<string, unknown>) =>
    request<BatchEditResult>(`/api/projects/${id}/batch-generate`, { method: 'POST', body: input }),

  getBatchEdit: (id: string, taskId: string) => request<BatchEditProgress>(`/api/projects/${id}/batch-edits/${taskId}`),

  deleteVersion: (id: string, versionId: string, force?: boolean) =>
    request<{ ok: boolean }>(`/api/projects/${id}/versions/${versionId}${force ? '?force=1' : ''}`, { method: 'DELETE' }),

  gallery: () => request<{ entries: GalleryEntryItem[] }>('/api/gallery'),

  galleryAdd: (input: { title: string; prompt: string; stylePrompt?: string; category?: string; image?: { data: string; mimeType: string } | null }) =>
    request<{ entry: GalleryEntryItem }>('/api/gallery', { method: 'POST', body: { category: 'mine', ...input } }),

  galleryFromImage: (projectId: string, imageId: string) =>
    request<{ entry: GalleryEntryItem }>('/api/gallery/from-image', { method: 'POST', body: { projectId, imageId } }),

  analyzeGalleryImage: (input: { data: string; mimeType: string; visionModelId?: string }) =>
    request<{ title: string; prompt: string; stylePrompt: string }>('/api/gallery/analyze', { method: 'POST', body: input }),

  galleryUpdate: (id: string, input: Partial<{ title: string; prompt: string; stylePrompt: string; category: string }>) =>
    request<{ entry: GalleryEntryItem }>(`/api/gallery/${id}`, { method: 'PATCH', body: input }),

  galleryDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/gallery/${id}`, { method: 'DELETE' }),

  localEditBatch: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/local-edit-batch`, { method: 'POST', body: input }),

  models: () => request<ModelsPayload>('/api/models'),

  createModel: (input: Partial<ModelConfig>) =>
    request<{ model: ModelConfig }>('/api/models', { method: 'POST', body: input }),

  updateModel: (id: string, input: Partial<ModelConfig>) =>
    request<{ model: ModelConfig }>(`/api/models/${id}`, { method: 'PATCH', body: input }),

  revealModelApiKey: (id: string) =>
    request<{ apiKey: string }>(`/api/models/${id}/api-key`, { method: 'POST' }),

  deleteModel: (id: string) =>
    request<{ ok: boolean }>(`/api/models/${id}`, { method: 'DELETE' }),

  activateModel: (id: string) =>
    request<{ ok: boolean }>(`/api/models/${id}/activate`, { method: 'POST' }),

  activateVisionModel: (id: string) =>
    request<{ ok: boolean }>(`/api/models/${id}/activate-vision`, { method: 'POST' }),

  testModel: (id: string) =>
    request<{ ok: boolean; latency: number; message: string }>(`/api/models/${id}/test`, { method: 'POST' }),

  testModelConfig: (input: Partial<ModelConfig>) =>
    request<{ ok: boolean; latency: number; message: string }>('/api/models/test-config', { method: 'POST', body: input }),

  restoreBackup: (base64Data: string) =>
    request<{ ok: boolean; restartRequired: boolean; safetyBackup: string }>('/api/backup/restore', { method: 'POST', body: { data: base64Data } }),

  // ---- 管理后台（仅管理员，服务端 requireAdmin 校验） ----
  adminUsers: () => request<{ users: AdminUser[] }>('/api/admin/users'),
  createAdminUser: (input: { username: string; password: string; role: 'admin' | 'user' }) =>
    request<{ user: AdminUser }>('/api/admin/users', { method: 'POST', body: input }),
  updateAdminUser: (username: string, input: { password?: string; role?: 'admin' | 'user' }) =>
    request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: input }),
  deleteAdminUser: (username: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  adminSettings: () => request<AdminSettings>('/api/admin/settings'),
  updateAdminSettings: (input: Partial<AdminSettings>) =>
    request<AdminSettings>('/api/admin/settings', { method: 'PUT', body: input }),
};

// Resolve relative image URLs to absolute
export function resolveUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${currentBase}${url}`;
}

export function thumbUrl(url: string | null, width = 480): string | null {
  if (!url) return null;
  const abs = resolveUrl(url);
  if (!abs) return null;
  return `${abs}?w=${width}`;
}

/** Image source that carries the session token (Image components cannot use fetch interceptors). */
export function imageSource(url: string | null, width?: number): { uri: string; headers: Record<string, string> } | undefined {
  const target = width ? thumbUrl(url, width) : resolveUrl(url);
  if (!target) return undefined;
  return { uri: target, headers: authHeaders() };
}

/** Download a server file (ZIP backup / export / version archive) into the app cache. */
export async function downloadToCache(path: string, filename: string): Promise<string> {
  const token = await getAuthToken();
  const target = path.startsWith('http') ? path : `${currentBase}${path}`;
  const fileUri = `${FileSystem.cacheDirectory}${filename}`;
  const result = await FileSystem.downloadAsync(target, fileUri, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (result.status === 401) {
    const hadSession = Boolean(authToken);
    await clearAuthToken();
    if (hadSession && !sessionExpiredFiring) {
      sessionExpiredFiring = true;
      try { sessionExpiredHandler?.(); } finally { sessionExpiredFiring = false; }
    }
    throw new Error('登录已过期，请重新登录');
  }
  if (result.status !== 200) throw new Error(`下载失败（${result.status}）`);
  return result.uri;
}

export const exportProjectPath = (id: string) => `/api/projects/${id}/export`;
export const backupPath = () => '/api/backup';
export const versionDownloadPath = (id: string, versionId: string) => `/api/projects/${id}/versions/${versionId}/download`;
