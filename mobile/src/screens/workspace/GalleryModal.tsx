import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
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

/** Prompt gallery: tap an entry to fill the prompt box; save the canvas image as a new entry. */
export function GalleryModal({ projectId, currentImageId, notify, onUse }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [entries, setEntries] = useState<GalleryEntryItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

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

  return (
    <View style={styles.container}>
      <Pressable style={[styles.saveBtn, (!currentImageId || saving) && { opacity: 0.5 }]} onPress={saveCurrentImage} disabled={!currentImageId || saving}>
        {saving ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="gallery" size={16} color={colors.accent} />}
        <Text style={styles.saveText}>收藏当前画布图片（自动提炼提示词）</Text>
      </Pressable>
      {entries === null ? (
        <View style={styles.loading}><ActivityIndicator size="large" color={colors.accent} /></View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item: GalleryEntryItem) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.accent} />}
          ListEmptyComponent={<Text style={styles.empty}>画廊暂无条目</Text>}
          renderItem={({ item }: { item: GalleryEntryItem }) => (
            <Pressable style={styles.card} onPress={() => onUse(item.prompt, item.stylePrompt)}>
              {item.image ? <Image source={imageSource(item.image, 240)} style={styles.thumb} resizeMode="cover" /> : null}
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
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1 },
    saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, margin: spacing.md, padding: spacing.sm, borderWidth: 1, borderStyle: 'dashed', borderColor: c.accent, borderRadius: radius.md },
    saveText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    list: { padding: spacing.md, paddingTop: 0, paddingBottom: spacing.xxl, gap: spacing.sm },
    empty: { textAlign: 'center', color: c.muted, marginTop: spacing.xl },
    card: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.sm },
    thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: c.bg },
    body: { flex: 1 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { flex: 1, fontSize: fontSize.md, fontWeight: '600', color: c.text },
    category: { fontSize: fontSize.xs, color: c.accent },
    prompt: { fontSize: fontSize.xs, color: c.textSecondary, marginTop: 2 },
    style: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
  });
