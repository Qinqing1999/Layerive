import { Platform } from 'react-native';

// 服务端地址 - 开发时用本机 IP，生产时由 AsyncStorage 持久化的用户设置覆盖
export const API_BASE = __DEV__
  ? Platform.OS === 'android'
    ? 'http://10.0.2.2:8788'  // Android 模拟器
    : 'http://127.0.0.1:8788'  // iOS 模拟器 / 物理设备
  : 'http://127.0.0.1:8788'; // 生产环境默认本机，用户可在设置页修改

// Shared types (from web version)
export type ModelConfig = {
  id: string;
  name: string;
  type: 'image' | 'vision';
  provider: 'sensenova' | 'openai' | 'gemini' | 'grok' | 'agnes';
  apiFormat?: 'anthropic_messages' | 'chat_completions' | 'responses';
  baseUrl: string;
  apiKey: string;
  apiKeys?: string[];
  model: string;
  capabilities: string[];
  defaultParams: { size?: string; count?: number; quality?: string };
};

export type Project = {
  id: string;
  name: string;
  description: string;
  coverImageId: string | null;
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
  defaultModelId: string | null;
  currentVersionId: string | null;
  currentImageId: string | null;
  draft: Record<string, unknown>;
  isFavorite: boolean;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectImage = {
  id: string;
  projectId: string;
  versionId: string | null;
  taskId: string | null;
  sourceType: 'upload' | 'generated' | 'edited' | 'mask' | 'extract' | 'local_reference' | 'local_composite';
  url: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileSize: number;
  createdAt: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  type: string;
  content: {
    text?: string;
    prompt?: string;
    prompts?: string[];
    operation?: string;
    inputImageId?: string | null;
    outputImageIds?: string[];
    modelName?: string;
    versionId?: string;
    versionNumber?: number;
    message?: string;
    params?: Record<string, unknown>;
    batch?: { variableNames?: string[]; values?: string[]; variables?: Array<{ name: string; values: string[] }>; prompts?: string[]; local?: boolean; completed?: number; failed?: number; canceled?: boolean };
  };
  createdAt: string;
};

export type Version = {
  id: string;
  number: number;
  operation: string;
  parentVersionId: string | null;
  selectedImageId: string | null;
  status: string;
  outputs: ProjectImage[];
  inputs: ProjectImage[];
  createdAt: string;
};

export type ProjectBundle = {
  project: Project;
  messages: Message[];
  versions: Version[];
  images: ProjectImage[];
};

export type ModelsPayload = { activeModel: string; activeVisionModel: string; models: ModelConfig[] };

export type GenerationTask = {
  id: string;
  status: 'queued' | 'generating' | 'success' | 'partial' | 'failed' | 'canceled';
  operationType?: string;
  stage?: 'planning' | 'compositing' | 'generating' | 'preserving' | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** 排队中的全局位次（从 1 开始），非排队状态为 null */
  queuePosition?: number | null;
};

export type GenerateResult = { taskId: string; status: string; userMessageId: string };

export type TextSegment = {
  id: string;
  text: string;
  originalText: string;
  context: string;
  manual?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
};

export type BatchEditProgress = {
  id: string;
  status: 'queued' | 'generating' | 'success' | 'partial' | 'failed' | 'canceled';
  versionId: string | null;
  versionNumber: number | null;
  localEdit?: boolean;
  textBatch?: boolean;
  total: number;
  completed: number;
  failed: number;
  remaining: number;
  currentIndex: number | null;
  estimatedRemainingSeconds: number | null;
  items: Array<{ index: number; status: string; image: ProjectImage | null; error: string | null }>;
  error: string | null;
  createdAt: string;
};

export type BatchEditResult = GenerateResult & { versionId: string };

export type GalleryEntryItem = {
  id: string;
  title: string;
  category: string;
  prompt: string;
  stylePrompt: string;
  image: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type LocalEditReference = { data: string; mimeType: string; name?: string };

export type AdminUser = { username: string; role: 'admin' | 'user' };
export type AdminSettings = { queueConcurrency: number };
