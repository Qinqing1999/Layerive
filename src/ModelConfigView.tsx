import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Icon } from './Icon';
import { useTheme } from './theme';
import type { AdminSettings, AdminUser, ModelConfig } from './types';

type Props = {
  models: ModelConfig[];
  activeModel: string;
  activeVisionModel: string;
  onBack: () => void;
  onSave: (model: Partial<ModelConfig>, id?: string) => Promise<ModelConfig | undefined>;
  onDelete: (id: string) => Promise<void>;
  onActivate: (id: string) => Promise<void>;
  onActivateVision: (id: string) => Promise<void>;
  onTestConfig: (model: Partial<ModelConfig>) => Promise<string>;
  onRevealApiKey: (id: string) => Promise<string>;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

const senseNovaUrl = 'https://token.sensenova.cn/v1';
const senseNovaVisionUrl = 'https://api.sensenova.cn/v1';
const openAiUrl = 'https://api.openai.com/v1';
const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta';
const grokUrl = 'https://api.x.ai/v1';
const agnesUrl = 'https://apihub.agnes-ai.com/v1';
const defaultVisionApiFormat: NonNullable<ModelConfig['apiFormat']> = 'chat_completions';

function providerBaseUrl(type: ModelConfig['type'], provider: ModelConfig['provider']) {
  if (provider === 'sensenova') return type === 'vision' ? senseNovaVisionUrl : senseNovaUrl;
  if (provider === 'gemini') return geminiUrl;
  if (provider === 'grok') return grokUrl;
  if (provider === 'agnes') return agnesUrl;
  return openAiUrl;
}

function blankFor(type: ModelConfig['type'] = 'image'): ModelConfig {
  return type === 'vision'
    ? { id: '', name: '', type, provider: 'openai', apiFormat: defaultVisionApiFormat, baseUrl: openAiUrl, apiKey: '', apiKeys: [], model: 'gpt-4.1-mini', capabilities: ['image_understanding'], defaultParams: {} }
    : { id: '', name: '', type, provider: 'openai', baseUrl: openAiUrl, apiKey: '', apiKeys: [], model: 'gpt-image-2', capabilities: ['text_to_image', 'image_to_image', 'edit_prompt'], defaultParams: { size: '1024x1024', count: 1, quality: 'auto' } };
}

// The key pool is edited as one key per line; the first line is the primary
// key used by connection tests.
function keyPoolText(model: Pick<ModelConfig, 'apiKey' | 'apiKeys'>) {
  const keys = model.apiKeys?.length ? model.apiKeys : (model.apiKey ? [model.apiKey] : []);
  return keys.join('\n');
}

function defaultModel(type: ModelConfig['type'], provider: ModelConfig['provider']) {
  if (type === 'vision') return provider === 'sensenova' ? 'SenseChat-V6.5' : 'gpt-4.1-mini';
  if (provider === 'sensenova') return 'sensenova-u1.5-lite';
  if (provider === 'gemini') return 'gemini-3.1-flash-image';
  if (provider === 'grok') return 'grok-imagine-image-2.0';
  if (provider === 'agnes') return 'agnes-image-2.0-flash';
  return 'gpt-image-2';
}

export function ModelConfigView({ models, activeModel, activeVisionModel, onBack, onSave, onDelete, onActivate, onActivateVision, onTestConfig, onRevealApiKey, notify }: Props) {
  const { theme, toggleTheme } = useTheme();
  const [section, setSection] = useState<'models' | 'operations'>('models');
  const [selectedId, setSelectedId] = useState(models[0]?.id || '');
  const [form, setForm] = useState<ModelConfig>(models[0] || blankFor());
  const [keyPool, setKeyPool] = useState(keyPoolText(models[0] || { apiKey: '', apiKeys: [] }));
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const imageModels = useMemo(() => models.filter((model) => model.type !== 'vision'), [models]);
  const visionModels = useMemo(() => models.filter((model) => model.type === 'vision'), [models]);
  const isSenseNova = form.provider === 'sensenova';
  const isGemini = form.provider === 'gemini';
  const isGrok = form.provider === 'grok';
  const isAgnes = form.provider === 'agnes';

  useEffect(() => {
    if (creating) return;
    const selected = models.find((item) => item.id === selectedId);
    if (selected) setForm(selected);
    else if (models[0]) { setSelectedId(models[0].id); setForm(models[0]); }
  }, [models, selectedId, creating]);

  // Keep the pool textarea in sync with the selected (or reloaded) model.
  useEffect(() => {
    if (creating) return;
    setKeyPool(keyPoolText(form));
  }, [form, creating]);

  function choose(id: string) {
    const selected = models.find((item) => item.id === id);
    if (selected) { setCreating(false); setSelectedId(id); setForm(selected); setKeyPool(keyPoolText(selected)); setTestResult(''); }
  }
  function startCreate(type: ModelConfig['type']) { setCreating(true); setSelectedId(''); setForm(blankFor(type)); setKeyPool(''); setTestResult(''); }
  function update<K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) { setForm((current) => ({ ...current, [key]: value })); }
  function changeType(type: ModelConfig['type']) {
    setForm((current) => ({ ...current, type, provider: 'openai', apiFormat: type === 'vision' ? defaultVisionApiFormat : undefined, baseUrl: openAiUrl, model: defaultModel(type, 'openai'), capabilities: type === 'vision' ? ['image_understanding'] : ['text_to_image', 'image_to_image', 'edit_prompt'], defaultParams: type === 'vision' ? {} : { size: '1024x1024', count: 1, quality: 'auto' } }));
  }
  function changeProvider(provider: ModelConfig['provider']) {
    setForm((current) => ({ ...current, provider, baseUrl: providerBaseUrl(current.type, provider), model: defaultModel(current.type, provider) }));
  }
  function toggleCapability(capability: string) {
    update('capabilities', form.capabilities.includes(capability) ? form.capabilities.filter((item) => item !== capability) : [...form.capabilities, capability]);
  }
  async function revealFirstKey() {
    const firstLine = keyPool.split('\n')[0] || '';
    if (!selectedId || !firstLine.includes('••')) return;
    setRevealingApiKey(true);
    try {
      const apiKey = await onRevealApiKey(selectedId);
      if (!apiKey) return;
      setKeyPool((current) => {
        const lines = current.split('\n');
        lines[0] = apiKey;
        return lines.join('\n');
      });
    } finally { setRevealingApiKey(false); }
  }
  function parsedKeyPool() {
    return keyPool.split('\n').map((line) => line.trim()).filter(Boolean);
  }
  async function save() {
    setSaving(true);
    try {
      const apiKeys = parsedKeyPool();
      const saved = await onSave({ ...form, apiKey: apiKeys[0] || '', apiKeys }, selectedId || undefined);
      if (saved) { setKeyPool(keyPoolText(saved)); }
      if (!selectedId && saved?.id) { setCreating(false); setSelectedId(saved.id); setForm(saved); }
    } finally { setSaving(false); }
  }
  async function testConnection() {
    const apiKeys = parsedKeyPool();
    let candidate: Partial<ModelConfig> = { ...form, apiKey: apiKeys[0] || '', apiKeys };
    if (candidate.apiKey === '••••••••' && selectedId) {
      const revealed = await onRevealApiKey(selectedId);
      if (revealed) candidate = { ...candidate, apiKey: revealed };
    }
    setTestResult(await onTestConfig(candidate));
  }
  function renderItem(model: ModelConfig) {
    const typeLabel = model.type === 'vision' ? '视觉识别' : '图片生成';
    const visionFormatLabel = model.apiFormat === 'anthropic_messages' ? 'A' : model.apiFormat === 'responses' ? 'R' : 'C';
    return <button key={model.id} className={`model-list-item ${selectedId === model.id ? 'active' : ''}`} onClick={() => choose(model.id)}>
      <span className={`model-provider ${model.type === 'vision' ? 'vision-api' : model.provider}`}>{model.type === 'vision' ? visionFormatLabel : model.provider === 'sensenova' ? '日' : model.provider === 'gemini' ? 'Gm' : model.provider === 'grok' ? 'Gr' : model.provider === 'agnes' ? 'Ag' : 'O'}</span>
      <span className="model-label"><strong>{model.name}</strong><small>{typeLabel} · {model.model}</small></span>
      {model.type !== 'vision' && activeModel === model.id && <span className="default-tag">默认</span>}
      {model.type === 'vision' && activeVisionModel === model.id && <span className="default-tag">识别默认</span>}
    </button>;
  }

  return (
    <main className="settings-page">
      <header className="settings-topbar">
        <button className="back-button" onClick={onBack}><Icon name="left" size={15} /> 返回</button>
        <div><p className="eyebrow">ADMIN CONSOLE</p><h1>管理后台</h1></div>
        <div className="save-state"><button className="icon-button theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'} aria-label="切换配色模式"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} /></button><span className="status-dot" />仅管理员可见</div>
      </header>

      <nav className="admin-tabs" role="tablist" aria-label="管理后台分区">
        <button role="tab" aria-selected={section === 'models'} className={section === 'models' ? 'active' : ''} onClick={() => setSection('models')}>模型与密钥</button>
        <button role="tab" aria-selected={section === 'operations'} className={section === 'operations' ? 'active' : ''} onClick={() => setSection('operations')}>用户与队列</button>
      </nav>

      {section === 'operations' ? <OperationsPanel notify={notify} /> : <>
      <section className="models-layout">
        <aside className="model-list-panel">
          <div className="panel-heading"><div><h2>模型列表</h2><p>{models.length} 个可用配置</p></div><div className="model-add-actions"><button title="添加图片生成模型" onClick={() => startCreate('image')}><Icon name="plus" size={13} /> 图</button><button title="添加视觉识别模型" onClick={() => startCreate('vision')}><Icon name="plus" size={13} /> 识</button></div></div>
          <div className="model-list">
            <p className="model-group-title">图片生成模型</p>{imageModels.map(renderItem)}
            <p className="model-group-title vision">视觉识别模型</p>{visionModels.map(renderItem)}
            {!visionModels.length && <button className="empty-model-group" onClick={() => startCreate('vision')}><Icon name="plus" size={14} /> 添加视觉识别模型</button>}
          </div>
          <div className="model-help"><strong>关于密钥</strong><p>密钥仅保存在本机配置文件中，不会写入项目对话和任务历史。多 Key 轮询的轮转状态仅存在于内存。</p></div>
        </aside>

        <section className="model-form-panel">
          <div className="form-title-row"><div><p className="eyebrow">{selectedId ? 'EDIT MODEL' : 'NEW MODEL'}</p><h2>{selectedId ? '编辑模型配置' : '添加模型配置'}</h2></div>{form.type === 'image' && activeModel !== selectedId && selectedId && <button className="button secondary" onClick={() => void onActivate(selectedId)}>设为默认</button>}{form.type === 'vision' && activeVisionModel !== selectedId && selectedId && <button className="button secondary" onClick={() => void onActivateVision(selectedId)}>设为识别默认</button>}</div>
          <div className="form-grid two-columns">
            <label className="field"><span>配置类型</span><select value={form.type} onChange={(event) => changeType(event.target.value as ModelConfig['type'])}><option value="image">图片生成模型</option><option value="vision">视觉识别模型</option></select></label>
            <label className="field"><span>显示名称 *</span><input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder={form.type === 'vision' ? '例如：图片理解模型' : '例如：日日新 U1.5'} /></label>
          </div>
          {form.type === 'vision'
            ? <label className="field"><span>API 格式</span><select value={form.apiFormat || defaultVisionApiFormat} onChange={(event) => update('apiFormat', event.target.value as NonNullable<ModelConfig['apiFormat']>)}><option value="anthropic_messages">Anthropic Messages (/v1/messages)</option><option value="chat_completions">Chat Completions (/chat/completions)</option><option value="responses">Responses (/responses)</option></select></label>
            : <label className="field"><span>提供商</span><select value={form.provider} onChange={(event) => changeProvider(event.target.value as ModelConfig['provider'])}><option value="sensenova">日日新</option><option value="openai">OpenAI</option><option value="gemini">Gemini · Nano Banana</option><option value="grok">Grok · Imagine</option><option value="agnes">Agnes</option></select></label>}

          {form.type === 'vision' ? <div className="provider-guide"><strong>视觉接口配置</strong><p>请选择服务支持的请求格式；Base URL 填写服务根地址，系统会自动拼接所选接口路径。旧配置会沿用原请求格式。</p></div> : isSenseNova ? <div className="provider-guide sensenova-guide"><strong>日日新配置</strong><p>使用日日新官方图片接口。图片生成会固定启用无水印参数，并按接口限制每次生成 1 张。</p></div> : isGemini ? <div className="provider-guide gemini-guide"><strong>Gemini Nano Banana 配置</strong><p>使用 Gemini 原生图片接口和 Google API Key，支持文生图、参考图改图与文字编辑。默认模型为 gemini-3.1-flash-image；也可填写 gemini-2.5-flash-image 或其他 Nano Banana 模型。</p></div> : isGrok ? <div className="provider-guide grok-guide"><strong>Grok Imagine 配置</strong><p>使用 xAI 图片生成与编辑接口，支持文生图、图生图和提示词改图。建议模型填写 grok-imagine-image-2.0。</p></div> : isAgnes ? <div className="provider-guide agnes-guide"><strong>Agnes 配置</strong><p>使用 Agnes AI 图片接口，支持文生图和图生图（走 /images/generations + image 参数）。每次仅生成 1 张，不支持质量、输出格式和透明背景参数。建议模型填写 agnes-image-2.0-flash。</p></div> : <div className="provider-guide"><strong>OpenAI 配置</strong><p>适用于 OpenAI 官方接口和 OpenAI 兼容中转站；请填写服务根地址，不要包含具体接口路径。</p></div>}

          <label className="field"><span>{form.type === 'vision' ? 'API Base URL' : isSenseNova ? '日日新服务地址' : isGemini ? 'Gemini API Base URL' : isGrok ? 'xAI API Base URL' : isAgnes ? 'Agnes API Base URL' : 'API Base URL'}</span><input disabled={form.type === 'image' && isSenseNova} value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder={providerBaseUrl(form.type, form.provider)} /><small className="field-help">{form.type === 'vision' ? '填写服务根地址；也兼容直接填写完整接口地址。' : isSenseNova ? `固定使用 ${providerBaseUrl(form.type, form.provider)}。` : isGemini ? '官方地址为 https://generativelanguage.googleapis.com/v1beta。' : isGrok ? '官方地址为 https://api.x.ai/v1。' : isAgnes ? '官方地址为 https://apihub.agnes-ai.com/v1。' : '例如 https://api.openai.com/v1 或中转站提供的 /v1 根地址。'}</small></label>
          <div className="form-grid two-columns">
            <label className="field key-pool-field"><span>{form.type === 'vision' ? 'API Key 池' : isSenseNova ? '日日新 API Key 池' : isGemini ? 'Gemini API Key 池' : isGrok ? 'xAI API Key 池' : isAgnes ? 'Agnes API Key 池' : 'OpenAI API Key 池'}</span><div className="secret-input key-pool"><textarea rows={Math.min(6, Math.max(2, keyPool.split('\n').length + (keyPool.endsWith('\n') ? 1 : 0)))} value={keyPool} onChange={(event) => setKeyPool(event.target.value)} placeholder={'sk-第一个 Key\nsk-第二个 Key（可选，自动轮询）'} spellCheck={false} autoComplete="off" /><button type="button" disabled={revealingApiKey} onClick={() => void revealFirstKey()} title="回显保存的第一个 API Key" aria-label="回显保存的第一个 API Key">{revealingApiKey ? <span className="secret-loading" /> : <Icon name="eye" size={17} />}</button></div><small className="field-help">每行一个 Key；第一个 Key 用于连接测试。请求会按池内 Key 轮询使用，遇到 429 限流自动换下一个 Key 重试。被掩码（••••••••）的行保存时保留原 Key。</small></label>
            <label className="field"><span>{form.type === 'vision' ? '视觉识别模型名称 *' : '图片生成模型名称 *'}</span><input value={form.model} onChange={(event) => update('model', event.target.value)} placeholder={defaultModel(form.type, form.provider)} /></label>
          </div>

          {form.type === 'image' ? <>
            <fieldset className="capability-field"><legend>支持能力</legend><div className="capability-options">
              {[['text_to_image', '文生图'], ['image_to_image', '图生图'], ['edit_prompt', '提示词改图'], ['edit_text', '文字编辑'], ['remove_watermark', '去水印']].map(([value, label]) => (
                <label key={value} className={form.capabilities.includes(value) ? 'checked' : ''}><input type="checkbox" checked={form.capabilities.includes(value)} onChange={() => toggleCapability(value)} /><span>{label}</span></label>
              ))}
            </div></fieldset>
            <div className="form-grid three-columns">
              <label className="field"><span>默认尺寸</span><select value={form.defaultParams.size || '1024x1024'} onChange={(event) => update('defaultParams', { ...form.defaultParams, size: event.target.value })}><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option><option>512x512</option></select></label>
              <label className="field"><span>默认数量</span><select disabled={isSenseNova || isGemini || isAgnes} value={isSenseNova || isGemini || isAgnes ? 1 : form.defaultParams.count || 1} onChange={(event) => update('defaultParams', { ...form.defaultParams, count: Number(event.target.value) })}><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option></select></label>
              <label className="field"><span>默认质量</span><select disabled={isGemini || isAgnes} value={form.defaultParams.quality || 'auto'} onChange={(event) => update('defaultParams', { ...form.defaultParams, quality: event.target.value })}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            </div>
          </> : <div className="vision-guide"><strong>视觉识别模型用途</strong><p>用于识别和理解上传图片内容。当前会保存和测试该配置；工作台后续的智能图片分析将使用这里配置的模型。</p></div>}
          {testResult && <div className="test-result">{testResult}</div>}
          <div className="form-footer">
            <div>{selectedId && <button className="text-danger" onClick={() => { if (window.confirm('删除该模型配置？历史项目中的参数快照仍会保留。')) void onDelete(selectedId); }}>删除模型</button>}</div>
            <div className="footer-actions"><button className="button secondary" disabled={!form.name.trim() || !form.model.trim()} onClick={() => void testConnection()}>测试连接</button><button className="button primary" disabled={!form.name.trim() || !form.model.trim() || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</button></div>
          </div>
        </section>
      </section>
      </>}
    </main>
  );
}

// The operations tab is only reachable for admins: user accounts plus the
// global queue concurrency setting live here.
function OperationsPanel({ notify }: { notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' as 'admin' | 'user' });
  const [creatingUser, setCreatingUser] = useState(false);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [savingUser, setSavingUser] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [userPayload, settingsPayload] = await Promise.all([api.adminUsers(), api.adminSettings()]);
        if (cancelled) return;
        setUsers(userPayload.users);
        setSettings(settingsPayload);
      } catch (error) {
        notify((error as Error).message, 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [notify]);

  async function refreshUsers() {
    try {
      const payload = await api.adminUsers();
      setUsers(payload.users);
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  }

  async function createUser() {
    const username = newUser.username.trim();
    if (!username || !newUser.password || creatingUser) return;
    setCreatingUser(true);
    try {
      await api.createAdminUser({ username, password: newUser.password, role: newUser.role });
      setNewUser({ username: '', password: '', role: 'user' });
      notify(`已创建用户 ${username}`);
      await refreshUsers();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setCreatingUser(false);
    }
  }

  async function patchUser(user: AdminUser, input: { password?: string; role?: 'admin' | 'user' }) {
    if (savingUser) return;
    setSavingUser(user.username);
    try {
      await api.updateAdminUser(user.username, input);
      notify(`已更新用户 ${user.username}`);
      setPasswordDrafts((current) => ({ ...current, [user.username]: '' }));
      await refreshUsers();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setSavingUser('');
    }
  }

  async function removeUser(user: AdminUser) {
    if (!window.confirm(`删除用户 ${user.username}？该账号的登录会话会立即失效。`)) return;
    try {
      await api.deleteAdminUser(user.username);
      notify(`已删除用户 ${user.username}`);
      await refreshUsers();
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  }

  async function saveSettings() {
    if (!settings || savingSettings) return;
    setSavingSettings(true);
    try {
      const saved = await api.updateAdminSettings({ queueConcurrency: settings.queueConcurrency });
      setSettings(saved);
      notify('队列设置已保存');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <section className="operations-layout">
      <section className="operations-card">
        <div className="panel-heading"><div><h2>用户管理</h2><p>{loading ? '正在读取…' : `${users.length} 个账号`}</p></div></div>
        {!loading && <div className="user-rows">
          {users.map((user) => (
            <div className="user-row" key={user.username}>
              <span className="user-name">{user.username}</span>
              <select value={user.role} disabled={savingUser === user.username} onChange={(event) => void patchUser(user, { role: event.target.value as 'admin' | 'user' })} aria-label={`${user.username} 的角色`}>
                <option value="admin">管理员</option>
                <option value="user">普通用户</option>
              </select>
              <input type="password" placeholder="设置新密码（可留空）" value={passwordDrafts[user.username] || ''} onChange={(event) => setPasswordDrafts((current) => ({ ...current, [user.username]: event.target.value }))} autoComplete="new-password" />
              <button className="button secondary" disabled={savingUser === user.username || !(passwordDrafts[user.username] || '').trim()} onClick={() => void patchUser(user, { password: (passwordDrafts[user.username] || '').trim() })}>{savingUser === user.username ? '保存中…' : '改密'}</button>
              <button className="text-danger" onClick={() => void removeUser(user)}>删除</button>
            </div>
          ))}
        </div>}
        <div className="user-create-row">
          <input placeholder="用户名" value={newUser.username} onChange={(event) => setNewUser((current) => ({ ...current, username: event.target.value }))} autoComplete="off" />
          <input type="password" placeholder="初始密码" value={newUser.password} onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))} autoComplete="new-password" />
          <select value={newUser.role} onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value as 'admin' | 'user' }))} aria-label="新用户角色">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <button className="button primary" disabled={!newUser.username.trim() || !newUser.password || creatingUser} onClick={() => void createUser()}>{creatingUser ? '创建中…' : '创建用户'}</button>
        </div>
        <div className="provider-guide"><strong>账号说明</strong><p>管理员可以进入管理后台并调整模型、密钥和队列；普通用户只能使用工作台创作。修改角色或删除用户会让该账号的现有登录会话立即失效。</p></div>
      </section>

      <section className="operations-card">
        <div className="panel-heading"><div><h2>任务队列</h2><p>全局任务队列同时执行的任务数</p></div></div>
        {settings && <div className="queue-setting-row">
          <label className="field"><span>并发上限</span>
            <select value={settings.queueConcurrency} onChange={(event) => setSettings({ ...settings, queueConcurrency: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{count} 个任务</option>)}
            </select>
          </label>
          <button className="button primary" disabled={savingSettings} onClick={() => void saveSettings()}>{savingSettings ? '保存中…' : '保存设置'}</button>
        </div>}
        <div className="provider-guide"><strong>队列说明</strong><p>用户提交的生成任务先进入排队状态，按提交顺序等待空位执行，排队中的任务可以取消且不消耗模型请求。修改并发上限立即生效，重启服务后仍会保留。</p></div>
      </section>
    </section>
  );
}
