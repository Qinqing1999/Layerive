import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { RemoteImage } from '../../components/RemoteImage';
import { imageSource, thumbUrl } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { ProjectBundle, Version } from '../../types';
import { Icon } from '../../components/Icon';
import { OPERATION_LABELS, STATUS_LABELS } from '../../labels';

type Props = {
  bundle: ProjectBundle;
  onUseVersion: (version: Version) => void;
  onDeleteVersion: (version: Version) => void;
  onDownloadVersion: (version: Version) => void;
  onRefresh?: () => Promise<void>;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

export function HistoryModal({ bundle, onUseVersion, onDeleteVersion, onDownloadVersion, onRefresh, notify }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

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

  /** 找到父版本号用于显示血缘关系 */
  const parentNumberOf = useMemo(() => {
    const map = new Map<string, number>();
    const idToNumber = new Map<string, number>();
    for (const v of bundle.versions) idToNumber.set(v.id, v.number);
    for (const v of bundle.versions) {
      if (v.parentVersionId) {
        const num = idToNumber.get(v.parentVersionId);
        if (num !== undefined) map.set(v.id, num);
      }
    }
    return map;
  }, [bundle.versions]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function toggleSelectAll() {
    if (selected.size === versions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(versions.map((v) => v.id)));
    }
  }

  async function batchDownload() {
    if (selected.size === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      const list = versions.filter((v) => selected.has(v.id));
      for (const v of list) {
        onDownloadVersion(v);
      }
      notify(`已开始下载 ${list.length} 个版本`, 'success');
    } finally {
      setBatchBusy(false);
      exitSelectMode();
    }
  }

  function batchDelete() {
    if (selected.size === 0 || batchBusy) return;
    Alert.alert('批量删除版本', `确认删除选中的 ${selected.size} 个版本？有子版本时会强制删除后代，删除后不可恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        setBatchBusy(true);
        try {
          const list = versions.filter((v) => selected.has(v.id));
          for (const v of list) {
            await onDeleteVersion(v);
          }
          notify(`已删除 ${list.length} 个版本`, 'success');
        } catch (e) {
          notify((e as Error).message, 'error');
        } finally {
          setBatchBusy(false);
          exitSelectMode();
        }
      } },
    ]);
  }

  const selectedImageOf = (version: Version) =>
    version.outputs.find((img) => img.id === version.selectedImageId) || version.outputs[0] || null;

  const isRunning = (v: Version) => v.status === 'generating' || v.status === 'queued';

  return (
    <View style={styles.wrap}>
      <View style={styles.toolbar}>
        {selectMode ? (
          <>
            <Pressable style={styles.toolbarBtn} onPress={toggleSelectAll}>
              <Text style={styles.toolbarBtnText}>{selected.size === versions.length ? '取消全选' : '全选'}</Text>
            </Pressable>
            <Text style={styles.selectCount}>已选 {selected.size}</Text>
            <View style={styles.toolbarRight}>
              {batchBusy ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <>
                  <Pressable
                    style={[styles.toolbarAction, selected.size === 0 && { opacity: 0.4 }]}
                    disabled={selected.size === 0}
                    onPress={batchDownload}
                  >
                    <Icon name="zip" size={16} color={colors.accent} />
                    <Text style={[styles.toolbarActionText, { color: colors.accent }]}>下载</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.toolbarAction, selected.size === 0 && { opacity: 0.4 }]}
                    disabled={selected.size === 0}
                    onPress={batchDelete}
                  >
                    <Icon name="trash" size={16} color={colors.danger} />
                    <Text style={[styles.toolbarActionText, { color: colors.danger }]}>删除</Text>
                  </Pressable>
                </>
              )}
              <Pressable style={styles.toolbarBtn} onPress={exitSelectMode}>
                <Text style={styles.toolbarBtnText}>退出</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.toolbarTitle}>共 {versions.length} 个版本</Text>
            <Pressable style={styles.toolbarBtn} onPress={() => setSelectMode(true)}>
              <Icon name="menu" size={14} color={colors.accent} />
              <Text style={[styles.toolbarBtnText, { color: colors.accent }]}>多选</Text>
            </Pressable>
          </>
        )}
      </View>
      <FlatList
        data={versions}
        keyExtractor={(item: Version) => item.id}
        contentContainerStyle={styles.list}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        refreshControl={onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              try { await onRefresh(); } finally { setRefreshing(false); }
            }}
            colors={[colors.accent]}
            tintColor={colors.accent}
          />
        ) : undefined}
        ListEmptyComponent={<Text style={styles.empty}>暂无历史版本</Text>}
        renderItem={({ item }: { item: Version }) => {
          const img = selectedImageOf(item);
          const children = childCount.get(item.id) || 0;
          const outputs = item.outputs.filter((o) => o.fileSize > 0);
          const parentNum = parentNumberOf.get(item.id);
          const isExpanded = expanded.has(item.id);
          const hasChildren = children > 0;
          const isSel = selected.has(item.id);
          const disableSelect = selectMode && isRunning(item);
          return (
            <View style={styles.card}>
              <View style={styles.cardMain}>
                {/* 左侧血缘指示线 */}
                <View style={styles.indent}>
                  {parentNum ? (
                    <View style={styles.branchLine}>
                      <View style={styles.branchConnector} />
                      <Text style={styles.branchLabel}>← V{parentNum}</Text>
                    </View>
                  ) : null}
                </View>
                {selectMode ? (
                  <Pressable style={styles.checkboxWrap} onPress={() => !disableSelect && toggleSelect(item.id)} disabled={disableSelect}>
                    <View style={[styles.checkbox, isSel && styles.checkboxChecked, disableSelect && { opacity: 0.3 }]}>
                      {isSel ? <Icon name="check" size={14} color="#fff" /> : null}
                    </View>
                  </Pressable>
                ) : null}
                <View style={styles.thumbWrap}>
                  {img ? (
                    <RemoteImage source={imageSource(thumbUrl(img.url, 240))} style={styles.thumb} resizeMode="cover" fallbackLabel="图片加载失败" />
                  ) : (
                    <View style={[styles.thumb, styles.thumbEmpty]}><Icon name="image" size={22} color={colors.border} /></View>
                  )}
                </View>
                <View style={styles.info}>
                  <Text style={styles.title}>V{item.number} · {OPERATION_LABELS[item.operation] || item.operation}</Text>
                  <Text style={[styles.status, item.status === 'failed' && { color: colors.danger }, (item.status === 'generating' || item.status === 'queued') && { color: colors.warning }]}>
                    {STATUS_LABELS[item.status] || item.status}{outputs.length > 1 ? ` · ${outputs.length} 张` : ''}
                  </Text>
                </View>
                <View style={styles.actions}>
                  {selectMode ? null : (
                    <>
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
                    </>
                  )}
                </View>
              </View>
              {/* 子版本展开/折叠 */}
              {hasChildren ? (
                <Pressable style={styles.expandRow} onPress={() => toggleExpand(item.id)}>
                  <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} color={colors.muted} />
                  <Text style={styles.expandText}>{isExpanded ? '收起子版本' : `${children} 个子版本`}</Text>
                </Pressable>
              ) : null}
              {isExpanded && hasChildren ? (
                <View style={styles.childList}>
                  {versions
                    .filter((v) => v.parentVersionId === item.id)
                    .map((child) => {
                      const childImg = selectedImageOf(child);
                      const childOutputs = child.outputs.filter((o) => o.fileSize > 0);
                      const childIsSel = selected.has(child.id);
                      const childDisable = selectMode && isRunning(child);
                      return (
                        <View key={child.id} style={styles.childCard}>
                          <View style={styles.childIndent} />
                          {selectMode ? (
                            <Pressable style={styles.checkboxWrap} onPress={() => !childDisable && toggleSelect(child.id)} disabled={childDisable}>
                              <View style={[styles.checkbox, childIsSel && styles.checkboxChecked, childDisable && { opacity: 0.3 }]}>
                                {childIsSel ? <Icon name="check" size={14} color="#fff" /> : null}
                              </View>
                            </Pressable>
                          ) : null}
                          {childImg ? (
                            <RemoteImage source={imageSource(thumbUrl(childImg.url, 240))} style={styles.childThumb} resizeMode="cover" fallbackLabel="图片加载失败" />
                          ) : (
                            <View style={[styles.childThumb, styles.thumbEmpty]}><Icon name="image" size={16} color={colors.border} /></View>
                          )}
                          <Text style={styles.childTitle} numberOfLines={1}>V{child.number} · {OPERATION_LABELS[child.operation] || child.operation}</Text>
                          <Text style={styles.childStatus}>{STATUS_LABELS[child.status] || child.status}{childOutputs.length > 1 ? ` · ${childOutputs.length}张` : ''}</Text>
                          {selectMode ? null : (
                            <Pressable style={[styles.actionBtn, { backgroundColor: colors.accent }]} onPress={() => onUseVersion(child)}>
                              <Text style={styles.actionText}>使用</Text>
                            </Pressable>
                          )}
                        </View>
                      );
                    })}
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    wrap: { flex: 1 },
    toolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.card },
    toolbarTitle: { flex: 1, fontSize: fontSize.sm, color: c.textSecondary, fontWeight: '600' },
    toolbarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    toolbarBtnText: { fontSize: fontSize.xs, color: c.muted, fontWeight: '600' },
    toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    toolbarAction: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    toolbarActionText: { fontSize: fontSize.xs, fontWeight: '700' },
    selectCount: { fontSize: fontSize.xs, color: c.muted },
    list: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
    empty: { textAlign: 'center', color: c.muted, marginTop: spacing.xxl },
    card: { backgroundColor: c.card, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, padding: spacing.sm, gap: spacing.sm },
    cardMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    indent: { width: 60, justifyContent: 'center' },
    branchLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    branchConnector: { width: 12, height: 1, backgroundColor: c.border },
    branchLabel: { fontSize: fontSize.xs, color: c.muted },
    checkboxWrap: { padding: 2 },
    checkbox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    checkboxChecked: { backgroundColor: c.accent, borderColor: c.accent },
    thumbWrap: { width: 52, height: 52 },
    thumb: { width: 52, height: 52, borderRadius: radius.sm },
    thumbEmpty: { backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' },
    info: { flex: 1, minWidth: 80 },
    title: { fontSize: fontSize.md, fontWeight: '600', color: c.text },
    status: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    actionBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm },
    actionText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
    actionBtnGhost: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    expandRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    expandText: { fontSize: fontSize.xs, color: c.muted },
    childList: { gap: spacing.xs, paddingLeft: 60 },
    childCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs, borderTopWidth: 1, borderTopColor: c.border },
    childIndent: { width: 16, height: 1, backgroundColor: c.border },
    childThumb: { width: 36, height: 36, borderRadius: radius.sm },
    childTitle: { flex: 1, fontSize: fontSize.sm, color: c.text, fontWeight: '500' },
    childStatus: { fontSize: fontSize.xs, color: c.muted },
  });
