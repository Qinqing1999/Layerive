import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { RemoteImage } from '../../components/RemoteImage';
import { api, downloadToCache, getServerBase, imageSource, resolveUrl } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { GalleryEntryItem, LocalEditReference } from '../../types';
import { GALLERY_CATEGORIES, GALLERY_ENTRIES } from '../../gallery';
import { Icon } from '../../components/Icon';

type Props = {
  projectId: string;
  currentImageId: string | null;
  notify: (message: string, kind?: 'success' | 'error') => void;
  onUse: (prompt: string, stylePrompt: string) => void;
  /** 把画廊图片导入为项目图片并设为画布（由父级完成上传） */
  onSetCanvas: (asset: LocalEditReference) => void;
  /** 把画廊图片设为局部修改参考图 */
  onUseReference: (asset: LocalEditReference) => void;
};

const CATEGORY_LABELS: Record<string, string> = {
  mine: '我的收藏',
  portrait: '人像',
  scene: '场景',
  product: '产品',
  style: '风格',
  other: '其他',
};

const CATEGORIES = ['mine', 'portrait', 'scene', 'product', 'style', 'other'];

/** 内置画廊条目（与 H5 的 GALLERY_ENTRIES 同源，图片由服务器 /gallery 静态服务提供） */
const BUILTIN_ENTRIES: GalleryEntryItem[] = GALLERY_ENTRIES.map((entry) => ({
  id: `b-${entry.id}`,
  title: entry.title,
  category: entry.category,
  prompt: entry.prompt,
  stylePrompt: entry.stylePrompt,
  image: entry.image,
  source: 'builtin',
  createdAt: '',
  updatedAt: '',
}));

function categoryLabel(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return GALLERY_CATEGORIES.find((c) => c.id === category)?.zh || category;
}

/** Prompt gallery: search / fullscreen preview / use as canvas or reference; tap an entry to fill the prompt box. */
export function GalleryModal({ projectId, currentImageId, notify, onUse, onSetCanvas, onUseReference }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [entries, setEntries] = useState<GalleryEntryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [base, setBase] = useState(getServerBase());
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [viewing, setViewing] = useState<GalleryEntryItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<GalleryEntryItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editStyle, setEditStyle] = useState('');
  const [editCategory, setEditCategory] = useState('mine');
  const [editBusy, setEditBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setBase(getServerBase());
    try {
      const data = await api.gallery();
      setEntries(data.entries || []);
    } catch (e) {
      notify((e as Error).message, 'error');
      setLoadError((e as Error).message);
      setEntries([]);
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const filteredEntries = useMemo(() => {
    if (entries === null) return null;
    // 服务端用户条目在前，内置画廊条目在后（与 H5 提示词画廊一致）
    const list0 = [...entries, ...BUILTIN_ENTRIES];
    let list = list0;
    if (filter !== 'all') list = list.filter((e) => (e.category || 'mine') === filter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((e) => [e.title, e.prompt, e.stylePrompt].some((text) => (text || '').toLowerCase().includes(q)));
    return list;
  }, [entries, filter, query]);

  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'mine', label: '我的收藏' },
    ...GALLERY_CATEGORIES.map((c) => ({ key: c.id, label: c.zh })),
  ];

  /** 下载画廊图片并转为 base64 资产（供上传画布 / 参考图共用） */
  async function fetchGalleryAsset(entry: GalleryEntryItem): Promise<LocalEditReference> {
    const full = resolveUrl(entry.image);
    if (!full) throw new Error('该条目没有图片');
    const ext = /\.png($|\?)/i.test(full) ? 'png' : /\.webp($|\?)/i.test(full) ? 'webp' : 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const uri = await downloadToCache(full, `gallery-${entry.id}.${ext}`);
    const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return { data, mimeType, name: `gallery-${entry.id}.${ext}` };
  }

  async function runWithEntry(entry: GalleryEntryItem, action: (asset: LocalEditReference) => void) {
    if (busyId) return;
    setBusyId(entry.id);
    try {
      action(await fetchGalleryAsset(entry));
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function saveCurrentImage() {
    if (!currentImageId || saving) return;
    setSaving(true);
    try {
      const { entry } = await api.galleryFromImage(projectId, currentImageId);
      await load();
      // 收藏成功后直接打开编辑弹窗：自动提炼的标题/分类可由用户调整
      openEdit(entry);
      notify('已收藏，可完善标题与分类');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function shareViewing() {
    if (!viewing?.image) return;
    try {
      const full = resolveUrl(viewing.image);
      if (!full) { notify('图片地址无效', 'error'); return; }
      const ext = /\.png($|\?)/i.test(full) ? 'png' : /\.webp($|\?)/i.test(full) ? 'webp' : 'jpg';
      const uri = await downloadToCache(full, `gallery-view-${viewing.id}.${ext}`);
      if (await Sharing.isAvailableAsync()) {
        const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        await Sharing.shareAsync(uri, { mimeType, dialogTitle: '保存 / 分享图片' });
      } else {
        notify(`已下载到本地：${uri}`);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }

  function openEdit(entry: GalleryEntryItem) {
    setEditTarget(entry);
    setEditTitle(entry.title);
    setEditPrompt(entry.prompt || '');
    setEditStyle(entry.stylePrompt || '');
    setEditCategory(entry.category || 'mine');
  }

  async function submitEdit() {
    if (!editTarget || editBusy) return;
    setEditBusy(true);
    try {
      await api.galleryUpdate(editTarget.id, {
        title: editTitle.trim(),
        prompt: editPrompt.trim(),
        stylePrompt: editStyle.trim(),
        category: editCategory,
      });
      setEditTarget(null);
      await load();
      notify('已更新画廊条目');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteEntry(entry: GalleryEntryItem) {
    Alert.alert('确认删除', `删除「${entry.title}」？删除后不可恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        try {
          await api.galleryDelete(entry.id);
          await load();
          notify('已删除');
        } catch (e) {
          notify((e as Error).message, 'error');
        }
      } },
    ]);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.baseLine} numberOfLines={1}>服务器：{base || '（未设置）'}</Text>
      <Pressable style={[styles.saveBtn, (!currentImageId || saving) && { opacity: 0.5 }]} onPress={saveCurrentImage} disabled={!currentImageId || saving}>
        {saving ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="gallery" size={16} color={colors.accent} />}
        <Text style={styles.saveText}>收藏当前画布图片（自动提炼提示词）</Text>
      </Pressable>
      <View style={styles.searchRow}>
        <Icon name="search" size={15} color={colors.muted} />
        <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="搜索标题 / 提示词" placeholderTextColor={colors.muted} />
        {query ? (
          <Pressable hitSlop={6} onPress={() => setQuery('')}>
            <Icon name="close" size={14} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.filterChipText, filter === f.key && styles.filterChipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>
      {filteredEntries === null ? (
        <View style={styles.loading}><ActivityIndicator size="large" color={colors.accent} /></View>
      ) : (
        <FlatList
          data={filteredEntries}
          keyExtractor={(item: GalleryEntryItem) => item.id}
          contentContainerStyle={styles.list}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.accent} />}
          ListEmptyComponent={
            loadError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>加载失败：{loadError}</Text>
                <Pressable style={styles.retryBtn} onPress={() => void load()}>
                  <Text style={styles.retryText}>重试</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.empty}>{query.trim() ? '没有匹配的条目' : filter === 'all' ? '画廊暂无条目' : '该分类下暂无条目'}</Text>
            )
          }
          renderItem={({ item }: { item: GalleryEntryItem }) => (
            <View style={styles.card}>
              <Pressable style={styles.cardMain} onPress={() => onUse(item.prompt, item.stylePrompt)}>
                <Pressable onPress={() => setViewing(item)}>
                  {item.image ? <RemoteImage source={imageSource(item.image, 240)} style={styles.thumb} resizeMode="cover" fallbackLabel="图片加载失败" /> : null}
                </Pressable>
                <View style={styles.body}>
                  <View style={styles.cardHead}>
                    <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.category}>{categoryLabel(item.category)}{item.source === 'builtin' ? ' · 内置' : ''}</Text>
                  </View>
                  {item.prompt ? <Text style={styles.prompt} numberOfLines={3}>{item.prompt}</Text> : null}
                  {item.stylePrompt ? <Text style={styles.style} numberOfLines={1}>风格：{item.stylePrompt}</Text> : null}
                </View>
                <Icon name="send" size={14} color={colors.muted} />
              </Pressable>
              <View style={styles.cardActions}>
                <Pressable style={styles.cardActionBtn} disabled={busyId === item.id} onPress={() => void runWithEntry(item, onSetCanvas)}>
                  {busyId === item.id ? <ActivityIndicator size={12} color={colors.accent} /> : <Icon name="image" size={14} color={colors.muted} />}
                  <Text style={styles.cardActionText}>设为画布</Text>
                </Pressable>
                <Pressable style={styles.cardActionBtn} disabled={busyId === item.id} onPress={() => void runWithEntry(item, onUseReference)}>
                  <Icon name="batch" size={14} color={colors.muted} />
                  <Text style={styles.cardActionText}>作参考图</Text>
                </Pressable>
                {item.source !== 'builtin' ? (
                  <>
                    <Pressable style={styles.cardActionBtn} onPress={() => openEdit(item)}>
                      <Icon name="edit" size={14} color={colors.muted} />
                      <Text style={styles.cardActionText}>编辑</Text>
                    </Pressable>
                    <Pressable style={styles.cardActionBtn} onPress={() => deleteEntry(item)}>
                      <Icon name="trash" size={14} color={colors.muted} />
                      <Text style={styles.cardActionText}>删除</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          )}
        />
      )}

      {/* 全屏大图预览：保存/分享 + 设为画布 */}
      <Modal visible={Boolean(viewing)} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <View style={styles.viewingOverlay}>
          <View style={styles.viewingHeader}>
            <Text style={styles.viewingTitle} numberOfLines={1}>{viewing?.title}</Text>
            <Pressable hitSlop={8} onPress={() => setViewing(null)}>
              <Icon name="close" size={22} color="#fff" />
            </Pressable>
          </View>
          {viewing?.image ? (
            <Image source={imageSource(viewing.image, 1280)} style={styles.viewingImage} resizeMode="contain" />
          ) : null}
          <View style={styles.viewingActions}>
            <Pressable style={styles.viewingShareBtn} onPress={() => void shareViewing()}>
              <Icon name="share" size={15} color={colors.accent} />
              <Text style={styles.viewingShareText}>保存 / 分享</Text>
            </Pressable>
            <Pressable
              style={styles.viewingUseBtn}
              onPress={() => { const target = viewing; setViewing(null); if (target) void runWithEntry(target, onSetCanvas); }}
            >
              <Icon name="image" size={15} color="#fff" />
              <Text style={styles.viewingUseText}>设为画布</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Edit Modal */}
      <Modal visible={Boolean(editTarget)} animationType="fade" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>编辑画廊条目</Text>
            <Text style={styles.fieldLabel}>标题</Text>
            <TextInput style={styles.modalInput} value={editTitle} onChangeText={setEditTitle} placeholder="标题" placeholderTextColor={colors.muted} />
            <Text style={styles.fieldLabel}>提示词</Text>
            <TextInput style={[styles.modalInput, styles.modalTextarea]} value={editPrompt} onChangeText={setEditPrompt} placeholder="提示词" placeholderTextColor={colors.muted} multiline numberOfLines={3} />
            <Text style={styles.fieldLabel}>风格提示词</Text>
            <TextInput style={styles.modalInput} value={editStyle} onChangeText={setEditStyle} placeholder="风格提示词（可选）" placeholderTextColor={colors.muted} />
            <Text style={styles.fieldLabel}>分类</Text>
            <View style={styles.categoryRow}>
              {CATEGORIES.map((cat) => (
                <Pressable key={cat} style={[styles.categoryChip, editCategory === cat && styles.categoryChipActive]} onPress={() => setEditCategory(cat)}>
                  <Text style={[styles.categoryChipText, editCategory === cat && styles.categoryChipTextActive]}>{CATEGORY_LABELS[cat]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setEditTarget(null)}>
                <Text style={styles.modalCancelText}>取消</Text>
              </Pressable>
              <Pressable style={[styles.modalSubmit, editBusy && { opacity: 0.5 }]} onPress={submitEdit} disabled={editBusy}>
                {editBusy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.modalSubmitText}>保存</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1 },
    baseLine: { fontSize: fontSize.xs, color: c.muted, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
    errorBox: { alignItems: 'center', marginTop: spacing.xl, gap: spacing.sm, paddingHorizontal: spacing.lg },
    errorText: { color: c.danger, fontSize: fontSize.sm, textAlign: 'center' },
    retryBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: c.accent },
    retryText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
    saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, margin: spacing.md, padding: spacing.sm, borderWidth: 1, borderStyle: 'dashed', borderColor: c.accent, borderRadius: radius.md },
    saveText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginHorizontal: spacing.md, marginBottom: spacing.sm, paddingHorizontal: spacing.sm, height: 36, borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, backgroundColor: c.bg },
    searchInput: { flex: 1, fontSize: fontSize.sm, color: c.text, paddingVertical: 0 },
    filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
    filterChip: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
    filterChipActive: { backgroundColor: c.accent, borderColor: c.accent },
    filterChipText: { fontSize: fontSize.xs, color: c.muted },
    filterChipTextActive: { color: '#fff', fontWeight: '600' },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: spacing.md, paddingTop: 0, paddingBottom: spacing.xxl, gap: spacing.sm },
    empty: { textAlign: 'center', color: c.muted, marginTop: spacing.xl },
    card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.sm },
    cardMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: c.border },
    cardActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    cardActionText: { fontSize: fontSize.xs, color: c.muted },
    thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: c.bg },
    body: { flex: 1 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { flex: 1, fontSize: fontSize.md, fontWeight: '600', color: c.text },
    category: { fontSize: fontSize.xs, color: c.accent },
    prompt: { fontSize: fontSize.xs, color: c.textSecondary, marginTop: 2 },
    style: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
    viewingOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', paddingTop: 50, paddingBottom: 40 },
    viewingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
    viewingTitle: { flex: 1, marginRight: spacing.md, fontSize: fontSize.md, fontWeight: '600', color: '#fff' },
    viewingImage: { flex: 1 },
    viewingActions: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
    viewingShareBtn: { flex: 1, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: `${c.accent}88` },
    viewingShareText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
    viewingUseBtn: { flex: 1, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, borderRadius: radius.sm, backgroundColor: c.accent },
    viewingUseText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.card, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: c.border },
    modalTitle: { fontSize: fontSize.lg, fontWeight: '700', color: c.text, marginBottom: spacing.md },
    fieldLabel: { fontSize: fontSize.xs, color: c.muted, fontWeight: '600', marginBottom: 4, marginTop: spacing.sm },
    modalInput: { borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text },
    modalTextarea: { minHeight: 72, textAlignVertical: 'top' },
    categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    categoryChip: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    categoryChipActive: { backgroundColor: c.accent, borderColor: c.accent },
    categoryChipText: { fontSize: fontSize.xs, color: c.muted },
    categoryChipTextActive: { color: '#fff', fontWeight: '600' },
    modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
    modalCancel: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    modalCancelText: { color: c.muted, fontSize: fontSize.md, fontWeight: '600' },
    modalSubmit: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: c.accent },
    modalSubmitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  });
