import type { AdminSettings, AdminUser, BatchEditProgress, BatchEditResult, GenerateResult, GenerationTask, GalleryEntryItem, LocalEditReference, ModelConfig, ModelsPayload, Project, ProjectBundle, ProjectImage, TextSegment } from './types';

let authToken: string | null = localStorage.getItem('layerive-auth-token');

export function setAuthToken(token: string) {
  authToken = token;
  localStorage.setItem('layerive-auth-token', token);
}

export function clearAuthToken() {
  authToken = null;
  localStorage.removeItem('layerive-auth-token');
}

export function getAuthToken() {
  return authToken || localStorage.getItem('layerive-auth-token') || null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['Content-Type'] = 'application/json';
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (init?.headers) {
    const extra = init.headers as Record<string, string>;
    Object.assign(headers, extra);
  }
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearAuthToken();
    window.location.reload();
    throw new Error('登录已过期，请重新登录');
  }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload as T;
}

async function readFileAsBase64(file: File) {
  const dataUrl = await readFileAsDataUrl(file);
  return dataUrl.replace(/^data:[^;]+;base64,/, '');
}

async function downloadFile(url: string) {
  const headers: Record<string, string> = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export const api = {
  login: (username: string, password: string) => request<{ token: string; username: string; role: 'admin' | 'user' }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  checkAuth: () => request<{ authenticated: boolean; username: string; role: string }>('/api/auth/check'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (input: { name: string; description?: string; defaultModelId?: string }) =>
    request<ProjectBundle>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => request<ProjectBundle>(`/api/projects/${id}`),
  updateProject: (id: string, input: Record<string, unknown>) =>
    request<ProjectBundle>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  duplicateProject: (id: string) => request<ProjectBundle>(`/api/projects/${id}/duplicate`, { method: 'POST' }),
  exportProject: (id: string) => downloadFile(`/api/projects/${id}/export`),
  importProject: async (file: File) => {
    const data = await readFileAsBase64(file);
    return request<ProjectBundle>('/api/projects/import', { method: 'POST', body: JSON.stringify({ data }) });
  },
  downloadBackup: () => downloadFile('/api/backup'),
  restoreBackup: async (file: File) => {
    const data = await readFileAsBase64(file);
    return request<{ ok: boolean; restartRequired: boolean; safetyBackup: string }>('/api/backup/restore', { method: 'POST', body: JSON.stringify({ data }) });
  },
  deleteVersion: (projectId: string, versionId: string, force = false) =>
    request<ProjectBundle>(`/api/projects/${projectId}/versions/${versionId}${force ? '?force=1' : ''}`, { method: 'DELETE' }),
  downloadVersionImages: (projectId: string, versionId: string) =>
    downloadFile(`/api/projects/${projectId}/versions/${versionId}/download`),
  generate: (id: string, input: Record<string, unknown>) =>
    request<GenerateResult>(`/api/projects/${id}/generate`, { method: 'POST', body: JSON.stringify(input) }),
  startBatchEdit: (id: string, input: { imageId: string; modelId: string; parentVersionId?: string | null; template?: string; quantity?: number; variables?: Array<{ name: string; values: string[] }>; prompts?: string[]; params?: Record<string, unknown> }) =>
    request<BatchEditResult>(`/api/projects/${id}/batch-edit`, { method: 'POST', body: JSON.stringify(input) }),
  startBatchGenerate: (id: string, input: { modelId: string; parentVersionId?: string | null; template?: string; quantity?: number; variables?: Array<{ name: string; values: string[] }>; prompts?: string[]; stylePrompt?: string; params?: Record<string, unknown> }) =>
    request<BatchEditResult>(`/api/projects/${id}/batch-generate`, { method: 'POST', body: JSON.stringify(input) }),
  getBatchEdit: (id: string, taskId: string) => request<BatchEditProgress>(`/api/projects/${id}/batch-edits/${taskId}`),
  listGeneratingTasks: (id: string) => request<{ tasks: GenerationTask[] }>(`/api/projects/${id}/tasks`),
  getTask: (id: string, taskId: string) => request<GenerationTask>(`/api/projects/${id}/tasks/${taskId}`),
  cancelTask: (id: string, taskId: string) => request<{ ok: boolean; status: string }>(`/api/projects/${id}/tasks/${taskId}/cancel`, { method: 'POST' }),
  recognizeText: (id: string, imageId: string, visionModelId?: string) =>
    request<{ segments: TextSegment[]; modelName: string; cached: boolean }>(`/api/projects/${id}/recognize-text`, { method: 'POST', body: JSON.stringify({ imageId, visionModelId }) }),
  editText: (id: string, input: { imageId: string; modelId: string; visionModelId?: string; parentVersionId?: string | null; segments: TextSegment[]; params?: Record<string, unknown> }) =>
    request<GenerateResult>(`/api/projects/${id}/edit-text`, { method: 'POST', body: JSON.stringify(input) }),
  localEdit: (id: string, input: { imageId: string; modelId: string; visionModelId?: string; parentVersionId?: string | null; instruction: string; reference?: LocalEditReference; rect?: { x: number; y: number; width: number; height: number }; mask?: string; params?: Record<string, unknown> }) =>
    request<GenerateResult>(`/api/projects/${id}/local-edit`, { method: 'POST', body: JSON.stringify(input) }),
  localEditBatch: (id: string, input: { imageId: string; modelId: string; visionModelId?: string; parentVersionId?: string | null; rect?: { x: number; y: number; width: number; height: number }; mask?: string; instructions: string[]; reference?: LocalEditReference; params?: Record<string, unknown> }) =>
    request<BatchEditResult>(`/api/projects/${id}/local-edit-batch`, { method: 'POST', body: JSON.stringify(input) }),
  outpaint: (id: string, input: { imageId: string; modelId: string; parentVersionId?: string | null; size: string; params?: Record<string, unknown> }) =>
    request<GenerateResult>(`/api/projects/${id}/outpaint`, { method: 'POST', body: JSON.stringify(input) }),
  enhance: (id: string, input: { imageId: string; modelId: string; parentVersionId?: string | null; params?: Record<string, unknown> }) =>
    request<GenerateResult>(`/api/projects/${id}/enhance`, { method: 'POST', body: JSON.stringify(input) }),
  removeWatermark: (id: string, input: { imageId: string; modelId: string; visionModelId?: string; parentVersionId?: string | null; params?: Record<string, unknown> }) =>
    request<GenerateResult>(`/api/projects/${id}/remove-watermark`, { method: 'POST', body: JSON.stringify(input) }),
  extractAsset: (id: string, input: { imageId: string; modelId: string; visionModelId?: string; parentVersionId?: string | null; rect: { x: number; y: number; width: number; height: number }; crop: { data: string; mimeType: string; padded?: boolean }; hint?: string; params?: Record<string, unknown> }) =>
    request<GenerateResult>(`/api/projects/${id}/extract-asset`, { method: 'POST', body: JSON.stringify(input) }),
  uploadImage: (id: string, input: { data: string; mimeType: string; name: string }) =>
    request<ProjectBundle>(`/api/projects/${id}/images`, { method: 'POST', body: JSON.stringify(input) }),
  gallery: () => request<{ entries: GalleryEntryItem[] }>('/api/gallery'),
  saveGalleryEntry: (input: { id?: string; title: string; category: string; prompt: string; stylePrompt: string; image?: { data: string; mimeType: string } | null }) =>
    request<{ entry: GalleryEntryItem }>(`/api/gallery`, { method: 'POST', body: JSON.stringify(input) }),
  updateGalleryEntry: (id: string, input: { title?: string; category?: string; prompt?: string; stylePrompt?: string; image?: { data: string; mimeType: string } | null }) =>
    request<{ entry: GalleryEntryItem }>(`/api/gallery/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteGalleryEntry: (id: string) => request<{ ok: boolean }>(`/api/gallery/${id}`, { method: 'DELETE' }),
  analyzeGalleryImage: (input: { data: string; mimeType: string; visionModelId?: string }) =>
    request<{ title: string; prompt: string; stylePrompt: string }>('/api/gallery/analyze', { method: 'POST', body: JSON.stringify(input) }),
  addGalleryFromProject: (input: { projectId: string; imageId: string; visionModelId?: string }) =>
    request<{ entry: GalleryEntryItem }>('/api/gallery/from-image', { method: 'POST', body: JSON.stringify(input) }),
  models: () => request<ModelsPayload>('/api/models'),
  createModel: (input: Partial<ModelConfig>) => request<{ model: ModelConfig }>('/api/models', { method: 'POST', body: JSON.stringify(input) }),
  updateModel: (id: string, input: Partial<ModelConfig>) => request<{ model: ModelConfig }>(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  revealModelApiKey: (id: string) => request<{ apiKey: string }>(`/api/models/${id}/api-key`, { method: 'POST' }),
  deleteModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}`, { method: 'DELETE' }),
  activateModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}/activate`, { method: 'POST' }),
  activateVisionModel: (id: string) => request<{ ok: boolean }>(`/api/models/${id}/activate-vision`, { method: 'POST' }),
  testModel: (id: string) => request<{ ok: boolean; latency: number; message: string }>(`/api/models/${id}/test`, { method: 'POST' }),
  testModelConfig: (input: Partial<ModelConfig>) => request<{ ok: boolean; latency: number; message: string }>('/api/models/test-config', { method: 'POST', body: JSON.stringify(input) }),
  // ---- 管理后台（仅管理员，服务端 requireAdmin 校验） ----
  adminUsers: () => request<{ users: AdminUser[] }>('/api/admin/users'),
  createAdminUser: (input: { username: string; password: string; role: 'admin' | 'user' }) =>
    request<{ user: AdminUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  updateAdminUser: (username: string, input: { password?: string; role?: 'admin' | 'user' }) =>
    request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteAdminUser: (username: string) => request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  adminSettings: () => request<AdminSettings>('/api/admin/settings'),
  updateAdminSettings: (input: Partial<AdminSettings>) => request<AdminSettings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(input) }),
};

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

// List/thumbnail contexts load a downscaled copy; the canvas keeps the full
// image. The server falls back to the original file for non-PNG sources.
export function thumbUrl(image: Pick<ProjectImage, 'url'>, width = 480) {
  return `${image.url}?w=${width}`;
}
