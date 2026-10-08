import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import type { AdminSettings, AdminUser, ModelConfig } from '../types';
import { Icon } from '../components/Icon';

type Props = {
  models: ModelConfig[];
  activeModel: string;
  activeVisionModel: string;
  currentUsername: string;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

type AdminTab = 'models' | 'users' | 'settings';
const TABS: { key: AdminTab; label: string }[] = [
  { key: 'models', label: '模型' },
  { key: 'users', label: '用户' },
  { key: 'settings', label: '设置' },
];

const PROVIDERS: { value: ModelConfig['provider']; label: string }[] = [
  { value: 'sensenova', label: '日日新' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini · Nano Banana' },
  { value: 'grok', label: 'Grok · Imagine' },
  { value: 'agnes', label: 'Agnes' },
];

const API_FORMATS: { value: NonNullable<ModelConfig['apiFormat']>; label: string }[] = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'responses', label: 'Responses' },
];

const SIZES = ['1024x1024', '1536x1024', '1024x1536', '512x512'];
const IMAGE_CAPS: { value: string; label: string }[] = [
  { value: 'text_to_image', label: '文生图' },
  { value: 'image_to_image', label: '图生图' },
  { value: 'edit_prompt', label: '提示词改图' },
  { value: 'edit_text', label: '文字编辑' },
  { value: 'remove_watermark', label: '去水印' },
];

const senseNovaUrl = 'https://token.sensenova.cn/v1';
const senseNovaVisionUrl = 'https://api.sensenova.cn/v1';
const openAiUrl = 'https://api.openai.com/v1';
const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta';
const grokUrl = 'https://api.x.ai/v1';
const agnesUrl = 'https://apihub.agnes-ai.com/v1';

function providerBaseUrl(type: ModelConfig['type'], provider: ModelConfig['provider']) {
  if (provider === 'sensenova') return type === 'vision' ? senseNovaVisionUrl : senseNovaUrl;
  if (provider === 'gemini') return geminiUrl;
  if (provider === 'grok') return grokUrl;
  if (provider === 'agnes') return agnesUrl;
  return openAiUrl;
}

function defaultModelName(type: ModelConfig['type'], provider: ModelConfig['provider']) {
  if (type === 'vision') return provider === 'sensenova' ? 'SenseChat-V6.5' : 'gpt-4.1-mini';
  if (provider === 'sensenova') return 'sensenova-u1.5-lite';
  if (provider === 'gemini') return 'gemini-3.1-flash-image';
  if (provider === 'grok') return 'grok-imagine-image-2.0';
  if (provider === 'agnes') return 'agnes-image-2.0-flash';
  return 'gpt-image-2';
}

function blankFor(type: ModelConfig['type'] = 'image'): ModelConfig {
  return type === 'vision'
    ? { id: '', name: '', type, provider: 'openai', apiFormat: 'chat_completions', baseUrl: openAiUrl, apiKey: '', apiKeys: [], model: 'gpt-4.1-mini', capabilities: ['image_understanding'], defaultParams: {} }
    : { id: '', name: '', type, provider: 'openai', baseUrl: openAiUrl, apiKey: '', apiKeys: [], model: 'gpt-image-2', capabilities: ['text_to_image', 'image_to_image', 'edit_prompt'], defaultParams: { size: '1024x1024', count: 1, quality: 'auto' } };
}

function keyPoolText(model: Pick<ModelConfig, 'apiKey' | 'apiKeys'>) {
  const keys = model.apiKeys?.length ? model.apiKeys : (model.apiKey ? [model.apiKey] : []);
  return keys.join('\n');
}

export function ModelsScreen({ models, activeModel, activeVisionModel, currentUsername, onBack, onRefresh, notify }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  const [refreshing, setRefreshing] = useState(false);
  const [editModel, setEditModel] = useState<ModelConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<AdminTab>('models');
  // 用户管理
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userForm, setUserForm] = useState<{ mode: 'create' | 'reset'; target?: AdminUser } | null>(null);
  // 站点设置
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const imageModels = useMemo(() => models.filter((m) => m.type !== 'vision'), [models]);
  const visionModels = useMemo(() => models.filter((m) => m.type === 'vision'), [models]);

  async function loadUsers() {
    setUsersLoading(true);
    try {
      const data = await api.adminUsers();
      setUsers(data.users);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setUsersLoading(false); }
  }

  async function loadSettings() {
    setSettingsLoading(true);
    try {
      setSettings(await api.adminSettings());
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setSettingsLoading(false); }
  }

  // 切到用户/设置分区时懒加载
  useEffect(() => {
    if (tab === 'users') loadUsers();
    if (tab === 'settings') loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function createUser(input: { username: string; password: string; role: 'admin' | 'user' }) {
    await api.createAdminUser(input);
    setUserForm(null);
    await loadUsers();
    notify('用户已创建');
  }

  function confirmResetPassword(user: AdminUser, password: string) {
    Alert.alert('重置密码', `确定将「${user.username}」的密码重置吗？对方已登录的会话将失效。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '确定',
        onPress: async () => {
          setBusy(true);
          try {
            await api.updateAdminUser(user.username, { password });
            setUserForm(null);
            notify('密码已重置');
          } catch (e) { notify((e as Error).message, 'error'); }
          finally { setBusy(false); }
        },
      },
    ]);
  }

  function toggleRole(user: AdminUser) {
    const next = user.role === 'admin' ? 'user' : 'admin';
    Alert.alert('切换角色', `确定将「${user.username}」从${user.role === 'admin' ? '管理员' : '普通用户'}切换为${next === 'admin' ? '管理员' : '普通用户'}吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '确定',
        onPress: async () => {
          setBusy(true);
          try {
            await api.updateAdminUser(user.username, { role: next });
            await loadUsers();
            notify('角色已更新');
          } catch (e) { notify((e as Error).message, 'error'); }
          finally { setBusy(false); }
        },
      },
    ]);
  }

  function confirmDeleteUser(user: AdminUser) {
    Alert.alert('删除用户', `确定删除「${user.username}」吗？其所有会话将立即失效。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api.deleteAdminUser(user.username);
            await loadUsers();
            notify('已删除');
          } catch (e) { notify((e as Error).message, 'error'); }
          finally { setBusy(false); }
        },
      },
    ]);
  }

  async function saveSettings(concurrency: number) {
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 16) {
      notify('并发数需在 1-16 之间', 'error');
      return;
    }
    setSavingSettings(true);
    try {
      const saved = await api.updateAdminSettings({ queueConcurrency: Math.round(concurrency) });
      setSettings(saved);
      notify('队列设置已保存');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setSavingSettings(false); }
  }

  async function doRefresh() {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  }

  function openEdit(model: ModelConfig) {
    setEditModel(model);
    setCreating(false);
  }

  function openCreate(type: ModelConfig['type']) {
    setEditModel(blankFor(type));
    setCreating(true);
  }

  async function activate(model: ModelConfig) {
    setBusy(true);
    try {
      if (model.type === 'vision') await api.activateVisionModel(model.id);
      else await api.activateModel(model.id);
      await onRefresh();
      notify('已设为默认');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setBusy(false); }
  }

  async function testConnection(model: ModelConfig) {
    setBusy(true);
    try {
      const result = await api.testModel(model.id);
      notify(`${result.message}（${result.latency}ms）`, result.ok ? 'success' : 'error');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setBusy(false); }
  }

  function confirmDelete(model: ModelConfig) {
    Alert.alert('删除模型', `确定删除「${model.name}」吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api.deleteModel(model.id);
            await onRefresh();
            notify('已删除');
          } catch (e) { notify((e as Error).message, 'error'); }
          finally { setBusy(false); }
        },
      },
    ]);
  }

  async function saveModel(form: ModelConfig, keyPool: string) {
    const apiKeys = keyPool.split('\n').map((l) => l.trim()).filter(Boolean);
    const payload: Partial<ModelConfig> = { ...form, apiKey: apiKeys[0] || '', apiKeys };
    if (!form.name.trim() || !form.model.trim()) { notify('请填写显示名称和模型名称', 'error'); return; }
    setBusy(true);
    try {
      if (creating) {
        await api.createModel(payload);
        notify('模型已创建');
      } else {
        await api.updateModel(form.id, payload);
        notify('已保存');
      }
      setEditModel(null);
      setCreating(false);
      await onRefresh();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setBusy(false); }
  }

  const renderItem = (model: ModelConfig) => {
    const isActive = model.type === 'vision' ? activeVisionModel === model.id : activeModel === model.id;
    return (
      <View key={model.id} style={styles.card}>
        <Pressable style={styles.cardMain} onPress={() => openEdit(model)}>
          <View style={[styles.typeBadge, model.type === 'vision' ? styles.visionBadge : styles.imageBadge]}>
            <Text style={styles.typeBadgeText}>{model.type === 'vision' ? '识' : '图'}</Text>
          </View>
          <View style={styles.cardBody}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle} numberOfLines={1}>{model.name}</Text>
              {isActive ? <View style={styles.activeTag}><Text style={styles.activeTagText}>默认</Text></View> : null}
            </View>
            <Text style={styles.cardSub} numberOfLines={1}>{model.provider} · {model.model}</Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.muted} />
        </Pressable>
        <View style={styles.cardActions}>
          {!isActive && (
            <Pressable style={styles.cardActionBtn} onPress={() => activate(model)} disabled={busy}>
              <Icon name="check" size={14} color={colors.accent} />
              <Text style={styles.cardActionText}>设为默认</Text>
            </Pressable>
          )}
          <Pressable style={styles.cardActionBtn} onPress={() => testConnection(model)} disabled={busy}>
            <Icon name="data" size={14} color={colors.muted} />
            <Text style={styles.cardActionText}>测试</Text>
          </Pressable>
          <Pressable style={styles.cardActionBtn} onPress={() => confirmDelete(model)} disabled={busy}>
            <Icon name="trash" size={14} color={colors.danger} />
            <Text style={[styles.cardActionText, { color: colors.danger }]}>删除</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const renderUser = (user: AdminUser) => {
    const isSelf = user.username === currentUsername;
    return (
      <View key={user.username} style={styles.card}>
        <View style={styles.cardMain}>
          <View style={[styles.typeBadge, user.role === 'admin' ? styles.imageBadge : styles.visionBadge]}>
            <Text style={styles.typeBadgeText}>{user.role === 'admin' ? '管' : '员'}</Text>
          </View>
          <View style={styles.cardBody}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle} numberOfLines={1}>{user.username}</Text>
              {isSelf ? <View style={styles.activeTag}><Text style={styles.activeTagText}>我</Text></View> : null}
            </View>
            <Text style={styles.cardSub}>{user.role === 'admin' ? '管理员' : '普通用户'}</Text>
          </View>
        </View>
        <View style={styles.cardActions}>
          <Pressable style={styles.cardActionBtn} onPress={() => setUserForm({ mode: 'reset', target: user })} disabled={busy}>
            <Icon name="data" size={14} color={colors.muted} />
            <Text style={styles.cardActionText}>改密</Text>
          </Pressable>
          {!isSelf && (
            <>
              <Pressable style={styles.cardActionBtn} onPress={() => toggleRole(user)} disabled={busy}>
                <Icon name="check" size={14} color={colors.accent} />
                <Text style={styles.cardActionText}>{user.role === 'admin' ? '设为用户' : '设为管理员'}</Text>
              </Pressable>
              <Pressable style={styles.cardActionBtn} onPress={() => confirmDeleteUser(user)} disabled={busy}>
                <Icon name="trash" size={14} color={colors.danger} />
                <Text style={[styles.cardActionText, { color: colors.danger }]}>删除</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.card }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
          <Icon name="back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>管理后台</Text>
        {tab === 'models' && (
          <View style={styles.headerActions}>
            <Pressable style={styles.addBtn} onPress={() => openCreate('image')} hitSlop={8}>
              <Icon name="plus" size={18} color={colors.accent} />
              <Text style={styles.addBtnText}>图</Text>
            </Pressable>
            <Pressable style={styles.addBtn} onPress={() => openCreate('vision')} hitSlop={8}>
              <Icon name="plus" size={18} color={colors.accent} />
              <Text style={styles.addBtnText}>识</Text>
            </Pressable>
          </View>
        )}
        {tab === 'users' && (
          <Pressable style={styles.addBtn} onPress={() => setUserForm({ mode: 'create' })} hitSlop={8}>
            <Icon name="plus" size={18} color={colors.accent} />
            <Text style={styles.addBtnText}>用户</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.tabRow}>
        {TABS.map((t) => (
          <Pressable key={t.key} style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabBtnText, tab === t.key && styles.tabBtnTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'models' && (
        <SectionList
          sections={[
            { key: 'image', title: '图片生成模型', data: imageModels },
            { key: 'vision', title: '视觉识别模型', data: visionModels },
          ].filter((section) => section.data.length > 0)}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: (insets.bottom || 0) + spacing.xxl }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={colors.accent} />}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.groupTitle, styles.sectionHeaderSpacing]}>{section.title}</Text>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name="models" size={48} color={colors.border} />
              <Text style={styles.emptyText}>暂无模型配置</Text>
            </View>
          }
          renderItem={({ item }) => renderItem(item)}
        />
      )}

      {tab === 'users' && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.list, { paddingBottom: (insets.bottom || 0) + spacing.xxl }]}
          refreshControl={<RefreshControl refreshing={usersLoading} onRefresh={loadUsers} tintColor={colors.accent} />}
        >
          {users.map((u) => renderUser(u))}
          {!usersLoading && users.length === 0 && (
            <View style={styles.empty}>
              <Icon name="person-outline" size={48} color={colors.border} />
              <Text style={styles.emptyText}>暂无用户</Text>
            </View>
          )}
        </ScrollView>
      )}

      {tab === 'settings' && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.list, { paddingBottom: (insets.bottom || 0) + spacing.xxl }]}
          refreshControl={<RefreshControl refreshing={settingsLoading} onRefresh={loadSettings} tintColor={colors.accent} />}
        >
          {settings ? (
            <View style={styles.card}>
              <Text style={styles.fieldLabel}>生成队列并发数</Text>
              <View style={styles.cardMain}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={String(settings.queueConcurrency)}
                  onChangeText={(v) => setSettings({ queueConcurrency: Number(v.replace(/[^0-9]/g, '')) || 0 })}
                  keyboardType="number-pad"
                />
                <Pressable style={[styles.saveBtn, { flex: 0, paddingHorizontal: spacing.lg }, savingSettings && { opacity: 0.5 }]} onPress={() => saveSettings(settings.queueConcurrency)} disabled={savingSettings}>
                  {savingSettings ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>保存</Text>}
                </Pressable>
              </View>
              <Text style={styles.cardSub}>同时处理的生成任务上限（1-16）。调大可加快批量速度，但会增加模型服务压力。</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <ActivityIndicator size="small" color={colors.accent} />
            </View>
          )}
        </ScrollView>
      )}

      {busy && (
        <View style={styles.busyOverlay} pointerEvents="none">
          <View style={styles.busyCard}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        </View>
      )}

      {editModel && (
        <ModelFormModal
          model={editModel}
          creating={creating}
          busy={busy}
          colors={colors}
          onSave={saveModel}
          onCancel={() => { setEditModel(null); setCreating(false); }}
        />
      )}

      {userForm && (
        <UserFormModal
          mode={userForm.mode}
          target={userForm.target}
          busy={busy}
          colors={colors}
          onCreate={createUser}
          onReset={(user, password) => confirmResetPassword(user, password)}
          onCancel={() => setUserForm(null)}
        />
      )}
    </View>
  );
}

function UserFormModal({
  mode,
  target,
  busy,
  colors,
  onCreate,
  onReset,
  onCancel,
}: {
  mode: 'create' | 'reset';
  target?: AdminUser;
  busy: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  onCreate: (input: { username: string; password: string; role: 'admin' | 'user' }) => Promise<void>;
  onReset: (user: AdminUser, password: string) => void;
  onCancel: () => void;
}) {
  const styles = makeStyles(colors);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [err, setErr] = useState('');
  const isCreate = mode === 'create';

  async function submit() {
    setErr('');
    if (isCreate) {
      if (!username.trim()) { setErr('请输入用户名'); return; }
      if (password.length < 4) { setErr('密码至少 4 位'); return; }
      await onCreate({ username: username.trim(), password, role });
    } else if (target) {
      if (password.length < 4) { setErr('新密码至少 4 位'); return; }
      onReset(target, password);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{isCreate ? '新建用户' : `重置「${target?.username}」密码`}</Text>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Icon name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.formScroll} showsVerticalScrollIndicator={false}>
            {isCreate && (
              <>
                <Text style={styles.fieldLabel}>用户名 *</Text>
                <TextInput
                  style={styles.input}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="登录账号"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.fieldLabel}>角色</Text>
                <View style={styles.segRow}>
                  {(['user', 'admin'] as const).map((r) => (
                    <Pressable key={r} style={[styles.segBtn, role === r && styles.segBtnActive]} onPress={() => setRole(r)}>
                      <Text style={[styles.segBtnText, role === r && styles.segBtnTextActive]}>{r === 'admin' ? '管理员' : '普通用户'}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <Text style={styles.fieldLabel}>{isCreate ? '初始密码 *' : '新密码 *'}</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="至少 4 位"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoCapitalize="none"
            />
            {err ? <Text style={[styles.cardSub, { color: colors.danger, marginTop: spacing.sm }]}>{err}</Text> : null}
          </ScrollView>

          <View style={styles.modalActions}>
            <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={busy}>
              <Text style={styles.cancelBtnText}>取消</Text>
            </Pressable>
            <Pressable style={[styles.saveBtn, busy && { opacity: 0.5 }]} onPress={submit} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>{isCreate ? '创建' : '重置'}</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ModelFormModal({
  model,
  creating,
  busy,
  colors,
  onSave,
  onCancel,
}: {
  model: ModelConfig;
  creating: boolean;
  busy: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  onSave: (form: ModelConfig, keyPool: string) => void;
  onCancel: () => void;
}) {
  const styles = makeStyles(colors);
  const [form, setForm] = useState<ModelConfig>(model);
  const [keyPool, setKeyPool] = useState(keyPoolText(model));

  useEffect(() => {
    setForm(model);
    setKeyPool(keyPoolText(model));
  }, [model]);

  function update<K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) {
    setForm((c) => ({ ...c, [key]: value }));
  }

  function changeType(type: ModelConfig['type']) {
    setForm((c) => ({
      ...c, type, provider: 'openai',
      apiFormat: type === 'vision' ? 'chat_completions' : undefined,
      baseUrl: openAiUrl,
      model: defaultModelName(type, 'openai'),
      capabilities: type === 'vision' ? ['image_understanding'] : ['text_to_image', 'image_to_image', 'edit_prompt'],
      defaultParams: type === 'vision' ? {} : { size: '1024x1024', count: 1, quality: 'auto' },
    }));
  }

  function changeProvider(provider: ModelConfig['provider']) {
    setForm((c) => ({ ...c, provider, baseUrl: providerBaseUrl(c.type, provider), model: defaultModelName(c.type, provider) }));
  }

  function toggleCapability(cap: string) {
    update('capabilities', form.capabilities.includes(cap) ? form.capabilities.filter((x) => x !== cap) : [...form.capabilities, cap]);
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{creating ? '添加模型' : '编辑模型'}</Text>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Icon name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.formScroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.fieldLabel}>配置类型</Text>
            <View style={styles.segRow}>
              {(['image', 'vision'] as const).map((t) => (
                <Pressable key={t} style={[styles.segBtn, form.type === t && styles.segBtnActive]} onPress={() => changeType(t)}>
                  <Text style={[styles.segBtnText, form.type === t && styles.segBtnTextActive]}>
                    {t === 'image' ? '图片生成' : '视觉识别'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.fieldLabel}>显示名称 *</Text>
            <TextInput
              style={styles.input}
              value={form.name}
              onChangeText={(v) => update('name', v)}
              placeholder="例如：日日新 U1.5"
              placeholderTextColor={colors.muted}
            />

            {form.type === 'image' ? (
              <>
                <Text style={styles.fieldLabel}>提供商</Text>
                <View style={styles.chipRow}>
                  {PROVIDERS.map((p) => (
                    <Pressable key={p.value} style={[styles.chip, form.provider === p.value && styles.chipActive]} onPress={() => changeProvider(p.value)}>
                      <Text style={[styles.chipText, form.provider === p.value && styles.chipTextActive]}>{p.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : (
              <>
                <Text style={styles.fieldLabel}>API 格式</Text>
                <View style={styles.chipRow}>
                  {API_FORMATS.map((f) => (
                    <Pressable key={f.value} style={[styles.chip, (form.apiFormat || 'chat_completions') === f.value && styles.chipActive]} onPress={() => update('apiFormat', f.value)}>
                      <Text style={[styles.chipText, (form.apiFormat || 'chat_completions') === f.value && styles.chipTextActive]}>{f.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.fieldLabel}>Base URL</Text>
            <TextInput
              style={[styles.input, form.type === 'image' && form.provider === 'sensenova' && { opacity: 0.6 }]}
              value={form.baseUrl}
              onChangeText={(v) => update('baseUrl', v)}
              placeholder={providerBaseUrl(form.type, form.provider)}
              placeholderTextColor={colors.muted}
              editable={!(form.type === 'image' && form.provider === 'sensenova')}
            />

            <Text style={styles.fieldLabel}>API Key 池（每行一个）</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={keyPool}
              onChangeText={setKeyPool}
              placeholder="sk-第一个 Key&#10;sk-第二个 Key（可选）"
              placeholderTextColor={colors.muted}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.fieldLabel}>模型名称 *</Text>
            <TextInput
              style={styles.input}
              value={form.model}
              onChangeText={(v) => update('model', v)}
              placeholder={defaultModelName(form.type, form.provider)}
              placeholderTextColor={colors.muted}
            />

            {form.type === 'image' && (
              <>
                <Text style={styles.fieldLabel}>支持能力</Text>
                <View style={styles.chipRow}>
                  {IMAGE_CAPS.map((c) => (
                    <Pressable key={c.value} style={[styles.chip, form.capabilities.includes(c.value) && styles.chipActive]} onPress={() => toggleCapability(c.value)}>
                      <Text style={[styles.chipText, form.capabilities.includes(c.value) && styles.chipTextActive]}>{c.label}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>默认尺寸</Text>
                <View style={styles.chipRow}>
                  {SIZES.map((s) => (
                    <Pressable key={s} style={[styles.chip, (form.defaultParams.size || '1024x1024') === s && styles.chipActive]} onPress={() => update('defaultParams', { ...form.defaultParams, size: s })}>
                      <Text style={[styles.chipText, (form.defaultParams.size || '1024x1024') === s && styles.chipTextActive]}>{s}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
          </ScrollView>

          <View style={styles.modalActions}>
            <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={busy}>
              <Text style={styles.cancelBtnText}>取消</Text>
            </Pressable>
            <Pressable style={[styles.saveBtn, busy && { opacity: 0.5 }]} onPress={() => onSave(form, keyPool)} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>{creating ? '创建' : '保存'}</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.card },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
    backBtn: { padding: spacing.xs },
    title: { flex: 1, fontSize: fontSize.lg, fontWeight: '800', color: c.text },
    headerActions: { flexDirection: 'row', gap: spacing.sm },
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: spacing.xs },
    addBtnText: { fontSize: fontSize.sm, color: c.accent, fontWeight: '600' },
    list: { padding: spacing.lg, gap: spacing.sm },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
    emptyText: { color: c.muted, fontSize: fontSize.md },
    groupTitle: { fontSize: fontSize.sm, fontWeight: '700', color: c.textSecondary, marginTop: spacing.sm, marginBottom: spacing.xs },
    sectionHeaderSpacing: { marginTop: spacing.md, paddingTop: spacing.xs },
    card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.sm },
    cardMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    typeBadge: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
    imageBadge: { backgroundColor: c.accent },
    visionBadge: { backgroundColor: c.warning },
    typeBadgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },
    cardBody: { flex: 1 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    cardTitle: { flex: 1, fontSize: fontSize.md, fontWeight: '700', color: c.text },
    cardSub: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
    activeTag: { backgroundColor: c.success, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
    activeTagText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    cardActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: c.border },
    cardActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    cardActionText: { fontSize: fontSize.xs, color: c.muted },
    busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.2)' },
    busyCard: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: c.card },
    tabRow: { flexDirection: 'row', gap: spacing.xs, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border },
    tabBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, alignItems: 'center', backgroundColor: c.input },
    tabBtnActive: { backgroundColor: c.accent },
    tabBtnText: { fontSize: fontSize.sm, color: c.muted, fontWeight: '600' },
    tabBtnTextActive: { color: '#fff', fontWeight: '700' },

    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: spacing.lg },
    modalCard: { backgroundColor: c.card, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, maxHeight: '85%' },
    modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
    modalTitle: { fontSize: fontSize.lg, fontWeight: '700', color: c.text },
    formScroll: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    fieldLabel: { fontSize: fontSize.xs, fontWeight: '600', color: c.muted, marginBottom: 4, marginTop: spacing.sm },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text, backgroundColor: c.input },
    textarea: { minHeight: 72, textAlignVertical: 'top' },
    segRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.xs },
    segBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
    segBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
    segBtnText: { fontSize: fontSize.sm, color: c.muted, fontWeight: '600' },
    segBtnTextActive: { color: '#fff', fontWeight: '700' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.xs },
    chip: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
    chipActive: { backgroundColor: c.accent, borderColor: c.accent },
    chipText: { fontSize: fontSize.xs, color: c.muted },
    chipTextActive: { color: '#fff', fontWeight: '700' },
    modalActions: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, borderTopWidth: 1, borderTopColor: c.border },
    cancelBtn: { flex: 1, height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    cancelBtnText: { color: c.muted, fontSize: fontSize.md, fontWeight: '600' },
    saveBtn: { flex: 1, height: 44, borderRadius: radius.sm, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    saveBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  });
