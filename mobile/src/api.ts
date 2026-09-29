import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { API_BASE, type BatchEditProgress, type BatchEditResult, type GenerateResult, type GenerationTask, type GalleryEntryItem, type ModelsPayload, type Project, type ProjectBundle, type TextSegment } from './types';

const AUTH_TOKEN_KEY = 'pixelforge-auth-token';
const SERVER_BASE_KEY = 'pixelforge-server-base';

let authToken: string | null = null;
let currentBase = API_BASE;

/** 会话过期（曾持有 token 却收到 401）时通知 App 回到登录页 */
let sessionExpiredHandler: (() => void) | null = null;
export function setSessionExpiredHandler(handler: (() => void) | null) {
  sessionExpiredHandler = handler;
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

async function request<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...init?.headers };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = path.startsWith('http') ? path : `${currentBase}${path}`;
  const response = await fetch(url, {
    method: init?.method || 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const hadSession = Boolean(authToken);
    await clearAuthToken();
    if (hadSession) sessionExpiredHandler?.();
    throw new Error('登录已过期，请重新登录');
  }
  if (!response.ok) throw new Error((payload as { error?: string }).error || `请求失败（${response.status}）`);
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

  recognizeText: (id: string, imageId: string) =>
    request<{ segments: TextSegment[]; modelName: string; cached: boolean }>(`/api/projects/${id}/recognize-text`, { method: 'POST', body: { imageId } }),

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

  galleryAdd: (input: { title: string; prompt: string; stylePrompt?: string; category?: string }) =>
    request<{ entry: GalleryEntryItem }>('/api/gallery', { method: 'POST', body: { category: 'mine', ...input } }),

  galleryFromImage: (projectId: string, imageId: string) =>
    request<{ entry: GalleryEntryItem }>('/api/gallery/from-image', { method: 'POST', body: { projectId, imageId } }),

  models: () => request<ModelsPayload>('/api/models'),
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
  if (result.status !== 200) throw new Error(`下载失败（${result.status}）`);
  return result.uri;
}

export const exportProjectPath = (id: string) => `/api/projects/${id}/export`;
export const backupPath = () => '/api/backup';
export const versionDownloadPath = (id: string, versionId: string) => `/api/projects/${id}/versions/${versionId}/download`;
