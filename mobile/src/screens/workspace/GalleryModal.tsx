import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { RemoteImage } from '../../components/RemoteImage';
import { api, imageSource } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { GalleryEntryItem } from '../../types';
import { Icon } from '../../components/Icon';

type Props = {
  projectId: string;
  currentImageId: string | null;
  notify: (message: string, kind?: 'success' | 'error') => void;
  onUse: (prompt: string, stylePrompt: string) => void;
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

/** Prompt gallery: tap an entry to fill the prompt box; save the canvas image as a new entry. */
export function GalleryModal({ projectId, currentImageId, notify, onUse }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [entries, setEntries] = useState<GalleryEntryItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [editTarget, setEditTarget] = useState<GalleryEntryItem | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editStyle, setEditStyle] = useState('');
  const [editCategory, setEditCategory] = useState('mine');
  const [editBusy, setEditBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.gallery();
      setEntries(data.entries || []);
    } catch (e) {
      notify((e as Error).message, 'error');
      setEntries([]);
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const filteredEntries = useMemo(() => {
    if (!entries) return null;
    if (filter === 'all') return entries;
    return entries.filter((e) => (e.category || 'mine') === filter);
  }, [entries, filter]);

  const FILTERS = [{ key: 'all', label: '全部' }, ...CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] }))];

  async function saveCurrentImage() {
    if (!currentImageId || saving) return;
    setSaving(true);
    try {
      await api.galleryFromImage(projectId, currentImageId);
      await load();
      notify('已收藏画布图片到画廊');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setSaving(false);
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
      <Pressable style={[styles.saveBtn, (!currentImageId || saving) && { opacity: 0.5 }]} onPress={saveCurrentImage} disabled={!currentImageId || saving}>
        {saving ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="gallery" size={16} color={colors.accent} />}
        <Text style={styles.saveText}>收藏当前画布图片（自动提炼提示词）</Text>
      </Pressable>
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.accent} />}
          ListEmptyComponent={<Text style={styles.empty}>{filter === 'all' ? '画廊暂无条目' : '该分类下暂无条目'}</Text>}
          renderItem={({ item }: { item: GalleryEntryItem }) => (
            <View style={styles.card}>
              <Pressable style={styles.cardMain} onPress={() => onUse(item.prompt, item.stylePrompt)}>
                {item.image ? <RemoteImage source={imageSource(item.image, 240)} style={styles.thumb} resizeMode="cover" fallbackLabel="图片加载失败" /> : null}
                <View style={styles.body}>
                  <View style={styles.cardHead}>
                    <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.category}>{CATEGORY_LABELS[item.category] || item.category}</Text>
                  </View>
                  {item.prompt ? <Text style={styles.prompt} numberOfLines={3}>{item.prompt}</Text> : null}
                  {item.stylePrompt ? <Text style={styles.style} numberOfLines={1}>风格：{item.stylePrompt}</Text> : null}
                </View>
                <Icon name="send" size={14} color={colors.muted} />
              </Pressable>
              <View style={styles.cardActions}>
                <Pressable style={styles.cardActionBtn} onPress={() => openEdit(item)}>
                  <Icon name="edit" size={14} color={colors.muted} />
                  <Text style={styles.cardActionText}>编辑</Text>
                </Pressable>
                <Pressable style={styles.cardActionBtn} onPress={() => deleteEntry(item)}>
                  <Icon name="trash" size={14} color={colors.muted} />
                  <Text style={styles.cardActionText}>删除</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}

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
    saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, margin: spacing.md, padding: spacing.sm, borderWidth: 1, borderStyle: 'dashed', borderColor: c.accent, borderRadius: radius.md },
    saveText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
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
    cardActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: c.border },
    cardActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    cardActionText: { fontSize: fontSize.xs, color: c.muted },
    thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: c.bg },
    body: { flex: 1 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { flex: 1, fontSize: fontSize.md, fontWeight: '600', color: c.text },
    category: { fontSize: fontSize.xs, color: c.accent },
    prompt: { fontSize: fontSize.xs, color: c.textSecondary, marginTop: 2 },
    style: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
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
