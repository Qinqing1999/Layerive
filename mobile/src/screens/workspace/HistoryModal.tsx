import React, { useMemo } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { imageSource, thumbUrl } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { ProjectBundle, Version } from '../../types';
import { Icon } from '../../components/Icon';

const OP_LABELS: Record<string, string> = {
  upload: '上传',
  text_to_image: '文生图',
  edit_prompt: '改图',
  edit_text: '改字',
  local_edit: '局部编辑',
  outpaint: '扩图',
  enhance: '变清晰',
  remove_watermark: '去水印',
  extract_asset: '提取素材',
  batch_edit: '批量改图',
  batch_generate: '批量文生图',
};

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  generating: '生成中',
  success: '完成',
  partial: '部分完成',
  failed: '失败',
  canceled: '已取消',
};

type Props = {
  bundle: ProjectBundle;
  onUseVersion: (version: Version) => void;
  onDeleteVersion: (version: Version) => void;
  onDownloadVersion: (version: Version) => void;
};

export function HistoryModal({ bundle, onUseVersion, onDeleteVersion, onDownloadVersion }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const versions = useMemo(
    () => [...bundle.versions].sort((a, b) => b.number - a.number),
    [bundle.versions],
  );

  const childCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of bundle.versions) {
      if (v.parentVersionId) map.set(v.parentVersionId, (map.get(v.parentVersionId) || 0) + 1);
    }
    return map;
  }, [bundle.versions]);

  const selectedImageOf = (version: Version) =>
    version.outputs.find((img) => img.id === version.selectedImageId) || version.outputs[0] || null;

  return (
    <FlatList
      data={versions}
      keyExtractor={(item: Version) => item.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={styles.empty}>暂无历史版本</Text>}
      renderItem={({ item }: { item: Version }) => {
        const img = selectedImageOf(item);
        const children = childCount.get(item.id) || 0;
        const outputs = item.outputs.filter((o) => o.fileSize > 0);
        return (
          <View style={styles.card}>
            <View style={styles.thumbWrap}>
              {img ? (
                <Image source={imageSource(thumbUrl(img.url, 240))} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbEmpty]}><Icon name="image" size={22} color={colors.border} /></View>
              )}
            </View>
            <View style={styles.info}>
              <Text style={styles.title}>V{item.number} · {OP_LABELS[item.operation] || item.operation}</Text>
              <Text style={[styles.status, item.status === 'failed' && { color: colors.danger }, (item.status === 'generating' || item.status === 'queued') && { color: colors.warning }]}>
                {STATUS_LABELS[item.status] || item.status}{outputs.length > 1 ? ` · ${outputs.length} 张` : ''}
              </Text>
            </View>
            <View style={styles.actions}>
              <Pressable style={[styles.actionBtn, { backgroundColor: colors.accent }]} onPress={() => onUseVersion(item)}>
                <Text style={styles.actionText}>使用</Text>
              </Pressable>
              {outputs.length > 1 && (
                <Pressable style={styles.actionBtnGhost} onPress={() => onDownloadVersion(item)}>
                  <Icon name="zip" size={16} color={colors.textSecondary} />
                </Pressable>
              )}
              <Pressable style={styles.actionBtnGhost} onPress={() => onDeleteVersion(item)}>
                <Icon name="trash" size={16} color={colors.danger} />
              </Pressable>
            </View>
            {children > 0 ? <Text style={styles.children}>此版本有 {children} 个子版本，删除时将一并确认</Text> : null}
          </View>
        );
      }}
    />
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    list: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
    empty: { textAlign: 'center', color: c.muted, marginTop: spacing.xxl },
    card: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, padding: spacing.sm, flexWrap: 'wrap', gap: spacing.sm },
    thumbWrap: { width: 52, height: 52 },
    thumb: { width: 52, height: 52, borderRadius: radius.sm },
    thumbEmpty: { backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' },
    info: { flex: 1, minWidth: 120 },
    title: { fontSize: fontSize.md, fontWeight: '600', color: c.text },
    status: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    actionBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm },
    actionText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
    actionBtnGhost: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    children: { width: '100%', fontSize: fontSize.xs, color: c.muted },
  });
