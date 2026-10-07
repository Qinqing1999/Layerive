import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_ROOT, uid } from './db.mjs';

const configPath = path.join(CONFIG_ROOT, 'models.json');
mkdirSync(path.dirname(configPath), { recursive: true });

/** 原子写入：先写临时文件再 rename，避免写入中途崩溃导致配置文件损坏 */
function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/(?:images\/generations|images\/edits)\/?$/i, '').replace(/\/+$/, '');
}

const VISION_API_FORMATS = new Set(['anthropic_messages', 'chat_completions', 'responses']);

function hostnameOf(value) {
  try { return new URL(value).hostname; }
  catch { return ''; }
}

// The legacy multimodal API is hosted at api.sensenova.cn and uses the
// /llm/chat-completions route. Token Plan's newer multimodal models (such as
// sensenova-6.8-flash-lite) are OpenAI Chat Completions-compatible and use
// token.sensenova.cn/v1/chat/completions instead.
export function isSenseNovaLegacyVisionEndpoint(value) {
  return /^api\.sensenova\.cn$/i.test(hostnameOf(value));
}

export function isSenseNovaTokenChatEndpoint(value) {
  return /^token\.sensenova\.(?:cn|ai)$/i.test(hostnameOf(value));
}

export function visionApiFormat(model) {
  if (VISION_API_FORMATS.has(model?.apiFormat)) return model.apiFormat;
  // Before apiFormat existed, Dots/askdiandian was the sole Messages-style
  // adapter. Preserve that route while defaulting every other legacy vision
  // configuration to its previous Chat Completions behavior.
  return /(?:^|\.)askdiandian\.com$/i.test(hostnameOf(normalizeBaseUrl(model?.baseUrl)))
    ? 'anthropic_messages'
    : 'chat_completions';
}

export function visionEndpoint(model) {
  const baseUrl = normalizeBaseUrl(model?.baseUrl);
  const format = visionApiFormat(model);
  const pathSuffix = format === 'anthropic_messages' ? '/messages' : format === 'responses' ? '/responses' : '/chat/completions';
  if (baseUrl.toLowerCase().endsWith(pathSuffix)) return baseUrl;
  if (format === 'anthropic_messages' && /(?:^|\.)askdiandian\.com$/i.test(hostnameOf(baseUrl))) return `${baseUrl}/messages`;
  if (format === 'anthropic_messages' && /\/v1$/i.test(baseUrl)) return `${baseUrl}/messages`;
  if (format === 'anthropic_messages') return `${baseUrl}/v1/messages`;
  if (format === 'chat_completions' && isSenseNovaLegacyVisionEndpoint(baseUrl)) return `${baseUrl}/llm/chat-completions`;
  return `${baseUrl}${pathSuffix}`;
}

function normalizeApiKeys(value) {
  return Array.isArray(value) ? value.map((key) => String(key || '').trim()).filter(Boolean) : [];
}

export function readModels() {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.models = Array.isArray(config.models) ? config.models.map((model) => {
      const baseUrl = normalizeBaseUrl(model.baseUrl);
       const isSenseNova = model.provider === 'sensenova' || /(?:^|[/.])sensenova\.cn(?:[/:]|$)/i.test(baseUrl);
       const host = hostnameOf(baseUrl);
       const isGemini = model.provider === 'gemini' || /(?:^|\.)generativelanguage\.googleapis\.com$/i.test(host);
       const isGrok = model.provider === 'grok' || /(?:^|\.)x\.ai$/i.test(host);
       const isAgnes = model.provider === 'agnes' || /(?:^|\.)agnes-ai\.com$/i.test(host);
      // apiKey stays the first pool entry for backwards compatibility with
      // readers that only look at model.apiKey.
      const apiKeys = normalizeApiKeys(model.apiKeys);
      return {
        ...model,
        type: model.type === 'vision' ? 'vision' : 'image',
         provider: isSenseNova ? 'sensenova' : isGemini ? 'gemini' : isGrok ? 'grok' : isAgnes ? 'agnes' : 'openai',
        baseUrl,
        apiKey: model.apiKey || apiKeys[0] || '',
        apiKeys,
        ...(model.type === 'vision' ? { apiFormat: visionApiFormat({ ...model, baseUrl }) } : {}),
      };
    }) : [];
    if (!config.active_vision_model || !config.models.some((model) => model.id === config.active_vision_model && model.type === 'vision')) {
      config.active_vision_model = config.models.find((model) => model.type === 'vision')?.id || '';
    }
    return config;
  }
  catch { return { active_model: '', models: [] }; }
}

export function writeModels(config) {
  atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function publicModel(model) {
  return { ...model, apiKey: model.apiKey ? '••••••••' : '', apiKeys: normalizeApiKeys(model.apiKeys).map(() => '••••••••') };
}

// Round-robin over a model's key pool. Rotation state is in-memory only: every
// dispatch moves to the next key, so concurrent generations spread across the
// pool and a 429 retry automatically lands on a different key.
const apiKeyCounters = new Map();
export function pickApiKey(model) {
  const pool = (normalizeApiKeys(model?.apiKeys).length ? normalizeApiKeys(model.apiKeys) : (model?.apiKey ? [model.apiKey] : [])).filter(Boolean);
  if (pool.length <= 1) return pool[0] || model?.apiKey || '';
  const id = model?.id || model?.model || 'default';
  const index = (apiKeyCounters.get(id) || 0) % pool.length;
  apiKeyCounters.set(id, (apiKeyCounters.get(id) || 0) + 1);
  return pool[index];
}

export function upsertModel(input, modelId) {
  const config = readModels();
  const index = modelId ? config.models.findIndex((item) => item.id === modelId) : -1;
  const existing = index >= 0 ? config.models[index] : null;
  const requestedId = String(input.id || '').trim();
  const type = input.type === 'vision' ? 'vision' : 'image';
  const requestedProvider = ['sensenova', 'openai', 'gemini', 'grok', 'agnes'].includes(input.provider) ? input.provider : 'openai';
  if (type === 'vision' && ['gemini', 'grok', 'agnes'].includes(requestedProvider)) throw Object.assign(new Error('Gemini、Grok 和 Agnes 当前仅支持配置为图片生成模型'), { status: 400 });
  const provider = requestedProvider;
  const defaultBaseUrl = provider === 'sensenova' ? (type === 'vision' ? 'https://api.sensenova.cn/v1' : 'https://token.sensenova.cn/v1') : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : provider === 'grok' ? 'https://api.x.ai/v1' : provider === 'agnes' ? 'https://apihub.agnes-ai.com/v1' : 'https://api.openai.com/v1';
  const defaultModel = type === 'vision' ? (provider === 'sensenova' ? 'SenseChat-V6.5' : 'gpt-4.1-mini') : provider === 'sensenova' ? 'sensenova-u1.5-lite' : provider === 'gemini' ? 'gemini-3.1-flash-image' : provider === 'grok' ? 'grok-imagine-image-2.0' : provider === 'agnes' ? 'agnes-image-2.0-flash' : 'gpt-image-2';
  if (existing && config.active_model === existing.id && type === 'vision') {
    throw Object.assign(new Error('当前默认图片生成模型不能改为视觉识别模型，请先设定另一个图片生成默认模型'), { status: 400 });
  }
  // Resolve the key pool. Masked entries keep their saved counterpart
  // positionally so the admin UI can submit the full list back unchanged.
  const submittedKeys = Array.isArray(input.apiKeys) ? input.apiKeys.map((key) => String(key ?? '').trim()) : null;
  const savedKeys = normalizeApiKeys(existing?.apiKeys);
  let apiKeys;
  if (submittedKeys) {
    apiKeys = submittedKeys
      .map((key, position) => (key === '••••••••' ? savedKeys[position] || '' : key))
      .filter(Boolean);
  } else if (input.apiKey === '••••••••') {
    apiKeys = savedKeys.length ? savedKeys : (existing?.apiKey ? [existing.apiKey] : []);
  } else {
    const singleKey = String(input.apiKey || '').trim();
    apiKeys = singleKey ? [singleKey] : savedKeys;
  }
  const model = {
    // Empty IDs make the workbench fall back to the active model. Always assign
    // a stable ID for newly created models, even when the form submits id: ''.
    id: existing?.id || requestedId || uid(),
    name: String(input.name || '未命名模型'),
    type,
    provider,
    ...(type === 'vision' ? { apiFormat: VISION_API_FORMATS.has(input.apiFormat) ? input.apiFormat : visionApiFormat(existing || input) } : {}),
    baseUrl: normalizeBaseUrl(input.baseUrl || defaultBaseUrl),
    apiKey: apiKeys[0] || '',
    apiKeys,
    model: String(input.model || defaultModel),
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : (type === 'vision' ? ['image_understanding'] : ['text_to_image']),
    defaultParams: input.defaultParams && typeof input.defaultParams === 'object' ? input.defaultParams : (type === 'vision' ? {} : { size: '2048x2048', count: 1, quality: 'auto' }),
  };
  if (index >= 0) config.models[index] = model; else config.models.push(model);
  if (model.type === 'vision') {
    if (!config.active_vision_model) config.active_vision_model = model.id;
  } else if (!config.active_model) config.active_model = model.id;
  writeModels(config);
  return publicModel(model);
}

export function removeModel(modelId) {
  const config = readModels();
  config.models = config.models.filter((item) => item.id !== modelId);
  if (config.active_model === modelId) config.active_model = config.models.find((item) => item.type === 'image')?.id ?? '';
  if (config.active_vision_model === modelId) config.active_vision_model = config.models.find((item) => item.type === 'vision')?.id ?? '';
  writeModels(config);
}
