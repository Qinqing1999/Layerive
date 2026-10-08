import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { GenerationTask } from '../../types';
import { Icon } from '../../components/Icon';
import { OPERATION_LABELS, STATUS_LABELS, formatRelativeTime } from '../../labels';

type Props = {
  projectId: string;
  visible: boolean;
  onClose: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

const STATUS_COLORS: Record<string, string> = {
  success: '#16a34a',
  partial: '#d97706',
  failed: '#dc2626',
  canceled: '#6b7280',
  generating: '#2563eb',
  queued: '#7c3aed',
};

export function TaskHistorySheet({ projectId, visible, onClose, notify }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const [tasks, setTasks] = useState<GenerationTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { tasks: list } = await api.listAllTasks(projectId);
      setTasks(list);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  async function cancelTask(task: GenerationTask) {
    if (busyId) return;
    setBusyId(task.id);
    try {
      await api.cancelTask(projectId, task.id);
      notify('已取消任务');
      await load();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom || spacing.md }]}>
        <View style={styles.header}>
          <Pressable hitSlop={12} style={styles.backBtn} onPress={onClose}>
            <Icon name="chevronRight" size={18} color={colors.text} />
            <Text style={styles.backText}>返回</Text>
          </Pressable>
          <Text style={styles.title}>任务记录</Text>
          <View style={styles.headerRight} />
        </View>

        {tasks === null && !loadError ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : loadError ? (
          <View style={styles.center}>
            <Text style={styles.empty}>加载失败：{loadError}</Text>
            <Pressable style={styles.retryBtn} onPress={() => void load()}>
              <Text style={styles.retryText}>重试</Text>
            </Pressable>
          </View>
        ) : (tasks?.length ?? 0) === 0 ? (
          <View style={styles.center}>
            <Icon name="history" size={32} color={colors.muted} />
            <Text style={styles.empty}>暂无任务记录</Text>
          </View>
        ) : (
          <FlatList
            data={tasks}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
            renderItem={({ item }) => {
              const statusColor = STATUS_COLORS[item.status] || colors.muted;
              const isActive = item.status === 'generating' || item.status === 'queued';
              return (
                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.opLabel} numberOfLines={1}>{OPERATION_LABELS[item.operationType || ''] || item.operationType || '任务'}</Text>
                    <Text style={[styles.statusChip, { color: statusColor, borderColor: statusColor }]}>
                      {STATUS_LABELS[item.status] || item.status}
                    </Text>
                  </View>
                  <Text style={styles.time}>{formatRelativeTime(item.createdAt)}</Text>
                  {item.error ? (
                    <Text style={styles.errorText} numberOfLines={3}>{item.error}</Text>
                  ) : null}
                  {isActive ? (
                    <Pressable
                      style={[styles.cancelBtn, busyId === item.id && { opacity: 0.5 }]}
                      disabled={busyId === item.id}
                      onPress={() => cancelTask(item)}
                    >
                      {busyId === item.id
                        ? <ActivityIndicator size="small" color={colors.danger} />
                        : <Text style={styles.cancelText}>取消</Text>}
                    </Pressable>
                  ) : null}
                </View>
              );
            }}
          />
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, justifyContent: 'flex-end' },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      backgroundColor: c.card,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      maxHeight: '85%',
      paddingTop: spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingRight: spacing.sm },
    backText: { fontSize: fontSize.sm, color: c.text, fontWeight: '600' },
    title: { fontSize: fontSize.lg, fontWeight: '700', color: c.text },
    headerRight: { width: 48 },
    center: { paddingVertical: spacing.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    empty: { fontSize: fontSize.sm, color: c.muted, marginTop: spacing.xs },
    retryBtn: { marginTop: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: c.accent },
    retryText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
    list: { padding: spacing.md, gap: spacing.sm },
    card: { backgroundColor: c.input, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: c.border },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
    opLabel: { fontSize: fontSize.md, fontWeight: '600', color: c.text, flex: 1, marginRight: spacing.xs },
    statusChip: { fontSize: 10, fontWeight: '600', paddingHorizontal: spacing.xs, paddingVertical: 2, borderRadius: 999, borderWidth: 1, overflow: 'hidden' },
    time: { fontSize: fontSize.xs, color: c.muted },
    errorText: { fontSize: fontSize.xs, color: c.danger, marginTop: spacing.xs },
    cancelBtn: { alignSelf: 'flex-start', marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: c.danger },
    cancelText: { color: c.danger, fontSize: fontSize.sm, fontWeight: '600' },
  });
