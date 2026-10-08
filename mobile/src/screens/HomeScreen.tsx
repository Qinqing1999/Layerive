import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { RemoteImage } from '../components/RemoteImage';
import { ProjectFormModal } from './workspace/ProjectFormModal';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, backupPath, downloadToCache, exportProjectPath, imageSource, thumbUrl } from '../api';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import type { Project } from '../types';
import { Icon } from '../components/Icon';

type Props = {
  projects: Project[];
  loading: boolean;
  isAdmin: boolean;
  onOpen: (id: string) => void;
  onCreate: (input: { name: string; description: string }) => Promise<void>;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
  onOpenModels: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

const formatUpdated = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export function HomeScreen({ projects, loading, isAdmin, onOpen, onCreate, onRefresh, onLogout, onOpenModels, notify }: Props) {
  const { colors, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // 搜索防抖：250ms 内连续按键合并为一次过滤计算
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 250);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search]);
  const [refreshing, setRefreshing] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [projectMenu, setProjectMenu] = useState<Project | null>(null);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<'all' | 'updated' | 'favorite'>('all');

  const filtered = useMemo(() => {
    let list = projects.filter((p) => !debouncedSearch || p.name.toLowerCase().includes(debouncedSearch.toLowerCase()));
    if (filter === 'favorite') list = list.filter((p) => p.isFavorite);
    if (filter === 'updated') {
      // 「最近」：近 7 天更新过的项目，按更新时间倒序
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      list = list.filter((p) => new Date(p.updatedAt).getTime() >= sevenDaysAgo);
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list;
  }, [projects, debouncedSearch, filter]);

  async function handleCreate(name: string, desc: string) {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await onCreate({ name: name.trim(), description: desc.trim() });
      setCreateOpen(false);
    } finally {
      setCreating(false);
    }
  }

  async function handleSubmitRename(name: string, desc: string) {
    if (!renameTarget || !name.trim()) return;
    try {
      await api.updateProject(renameTarget.id, { name: name.trim(), description: desc.trim() });
      setRenameTarget(null);
      await onRefresh();
      notify('已更新');
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  const onRefreshData = useCallback(async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  }, [onRefresh]);

  async function toggleFavorite(project: Project) {
    try {
      await api.updateProject(project.id, { isFavorite: !project.isFavorite });
      await onRefresh();
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  async function duplicate(project: Project) {
    try { await api.duplicateProject(project.id); await onRefresh(); notify('项目已复制'); }
    catch (e) { notify((e as Error).message, 'error'); }
  }

  function rename(project: Project) {
    setRenameTarget(project);
  }



  async function exportProject(project: Project) {
    try {
      setBusy('正在导出项目 ZIP…');
      const uri = await downloadToCache(exportProjectPath(project.id), `pixel-forge-${project.id.slice(0, 8)}.zip`);
      setBusy('');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: '导出项目' });
      } else {
        notify(`已下载到本地：${uri}`);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setBusy(''); }
  }

  async function importProject() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      if (asset.size && asset.size > 500 * 1024 * 1024) { notify('项目 ZIP 过大（超过 500MB），请在电脑端导入', 'error'); return; }
      setBusy('正在导入项目…');
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      await api.importProject(base64);
      await onRefresh();
      notify('项目已导入');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setBusy(''); }
  }

  async function downloadBackup() {
    try {
      setBusy('正在下载完整备份…');
      const uri = await downloadToCache(backupPath(), 'pixel-forge-backup.zip');
      setBusy('');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: '完整备份' });
      } else {
        notify(`备份已下载到本地：${uri}`);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally { setBusy(''); }
  }

  async function restoreBackup() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset) return;
      if (asset.size && asset.size > 500 * 1024 * 1024) { notify('备份文件过大（超过 500MB）', 'error'); return; }
      Alert.alert(
        '从备份恢复',
        '恢复将覆盖当前所有数据，且需要重启服务端。确定继续？',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '恢复',
            style: 'destructive',
            onPress: async () => {
              setBusy('正在从备份恢复…');
              try {
                const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
                await api.restoreBackup(base64);
                notify('备份已恢复，服务端正在重启');
                await onRefresh();
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally { setBusy(''); }
            },
          },
        ],
      );
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }

  function openProjectMenu(project: Project) {
    setProjectMenu(project);
  }

  function confirmDeleteProject(project: Project) {
    Alert.alert('删除项目', `确定删除「${project.name}」吗？此操作为软删除，不影响图片文件。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try { await api.deleteProject(project.id); await onRefresh(); notify('项目已删除'); }
          catch (e) { notify((e as Error).message, 'error'); }
        },
      },
    ]);
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.card }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.brand}>
          <View style={styles.logo}><Text style={styles.logoText}>P</Text></View>
          <Text style={styles.title}>像素变换</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={toggle} style={styles.headerBtn} hitSlop={8}>
            <Icon name={mode === 'dark' ? 'sun' : 'moon'} size={20} color={colors.text} />
          </Pressable>
          <Pressable onPress={() => setMenuVisible(true)} style={styles.headerBtn} hitSlop={8}>
            <Icon name="menu" size={22} color={colors.text} />
          </Pressable>
        </View>
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Pressable style={styles.createBtn} onPress={() => setCreateOpen(true)}>
          <Icon name="plus" size={16} color="#fff" />
          <Text style={styles.createBtnText}>新建项目</Text>
        </Pressable>
        <Pressable onPress={() => void importProject()} style={styles.iconBtn}>
          <Icon name="import" size={18} color={colors.muted} />
        </Pressable>
        <Pressable onPress={() => setMenuVisible(true)} style={styles.iconBtn}>
          <Icon name="data" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {/* Search + Sort */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Icon name="search" size={16} color={colors.muted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="搜索项目…"
            placeholderTextColor={colors.muted}
          />
        </View>
      </View>

      {/* Filter Tabs */}
      <View style={styles.filterRow}>
        {(['all', 'updated', 'favorite'] as const).map((f) => (
          <Pressable key={f} style={[styles.filterTab, filter === f && styles.filterTabActive]} onPress={() => setFilter(f)}>
            <Text style={[styles.filterTabText, filter === f && styles.filterTabTextActive]}>
              {f === 'all' ? '全部' : f === 'updated' ? '最近' : '收藏'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* List */}
      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.emptyText}>加载中…</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item: Project) => item.id}
          numColumns={2}
          columnWrapperStyle={{ gap: spacing.md }}
          removeClippedSubviews={true}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={4}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefreshData} tintColor={colors.accent} />}
          contentContainerStyle={[styles.listContent, { paddingBottom: (insets.bottom || 0) + spacing.xxl }]}
          renderItem={({ item }: { item: Project }) => (
            <ProjectCard
              item={item}
              colors={colors}
              onPress={() => onOpen(item.id)}
              onMenu={() => openProjectMenu(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name="image" size={48} color={colors.border} />
              <Text style={styles.emptyText}>暂无项目，开始你的第一次创作</Text>
              <Pressable
                style={({ pressed }) => [styles.createBtn, pressed && { opacity: 0.85 }]}
                onPress={() => setCreateOpen(true)}
              >
                <Icon name="plus" size={16} color="#fff" />
                <Text style={styles.createBtnText}>新建项目</Text>
              </Pressable>
            </View>
          }
        />
      )}

      {/* Create Modal */}
      <ProjectFormModal
        visible={createOpen}
        title="新建项目"
        submitLabel="创建"
        busy={creating}
        onSubmit={handleCreate}
        onCancel={() => setCreateOpen(false)}
      />

      {/* Rename Modal */}
      <ProjectFormModal
        visible={Boolean(renameTarget)}
        title="编辑项目"
        initialName={renameTarget?.name || ''}
        initialDesc={renameTarget?.description || ''}
        submitLabel="保存"
        onSubmit={handleSubmitRename}
        onCancel={() => setRenameTarget(null)}
      />

      {/* Menu modal */}
      <Modal visible={menuVisible} animationType="fade" transparent>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>更多</Text>
            {isAdmin && (
              <MenuItem icon="models" label="模型管理" colors={colors} onPress={() => { setMenuVisible(false); onOpenModels(); }} />
            )}
            <MenuItem icon="import" label="导入项目 ZIP" colors={colors} onPress={() => { setMenuVisible(false); void importProject(); }} />
            <MenuItem icon="zip" label="下载完整备份" colors={colors} onPress={() => { setMenuVisible(false); void downloadBackup(); }} />
            <MenuItem icon="data" label="从备份恢复" colors={colors} onPress={() => { setMenuVisible(false); void restoreBackup(); }} />
            <MenuItem icon={mode === 'dark' ? 'sun' : 'moon'} label={mode === 'dark' ? '切换为亮色模式' : '切换为暗色模式'} colors={colors} onPress={() => { toggle(); setMenuVisible(false); }} />
            <MenuItem icon="logout" label="退出登录" colors={colors} destructive onPress={() => { setMenuVisible(false); onLogout(); }} />
          </View>
        </Pressable>
      </Modal>

      {/* Project action sheet */}
      <Modal visible={Boolean(projectMenu)} animationType="slide" transparent>
        <Pressable style={styles.sheetOverlay} onPress={() => setProjectMenu(null)}>
          <View style={styles.sheetCard}>
            {projectMenu ? <Text style={styles.sheetTitle} numberOfLines={1}>{projectMenu.name}</Text> : null}
            <MenuItem
              icon={projectMenu?.isFavorite ? 'starFilled' : 'star'}
              label={projectMenu?.isFavorite ? '取消收藏' : '收藏'}
              colors={colors}
              onPress={() => { if (projectMenu) { void toggleFavorite(projectMenu); setProjectMenu(null); } }}
            />
            <MenuItem icon="edit" label="重命名" colors={colors} onPress={() => { if (projectMenu) { rename(projectMenu); setProjectMenu(null); } }} />
            <MenuItem icon="copy" label="复制" colors={colors} onPress={() => { if (projectMenu) { void duplicate(projectMenu); setProjectMenu(null); } }} />
            <MenuItem icon="zip" label="导出 ZIP" colors={colors} onPress={() => { if (projectMenu) { void exportProject(projectMenu); setProjectMenu(null); } }} />
            <MenuItem icon="trash" label="删除项目" colors={colors} destructive onPress={() => { if (projectMenu) { setProjectMenu(null); confirmDeleteProject(projectMenu); } }} />
          </View>
        </Pressable>
      </Modal>

      {/* Busy overlay */}
      {busy ? (
        <View style={styles.busyOverlay} pointerEvents="none">
          <View style={styles.busyCard}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.busyText}>{busy}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ProjectCard({ item, colors, onPress, onMenu }: { item: Project; colors: ReturnType<typeof useTheme>['colors']; onPress: () => void; onMenu: () => void }) {
  const styles = makeStyles(colors);
  const menuPressedRef = useRef(false);
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
      onPressIn={() => { menuPressedRef.current = false; }}
      onPress={() => { if (!menuPressedRef.current) onPress(); }}
    >
      {item.coverUrl ? (
        <RemoteImage source={imageSource(thumbUrl(item.coverUrl))} style={styles.cardCover} resizeMode="cover" fallbackLabel="封面加载失败" />
      ) : (
        <View style={[styles.cardCover, styles.cardPlaceholder]}>
          <Icon name="image" size={40} color={colors.muted} />
        </View>
      )}
      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
          <Pressable
            onPressIn={() => { menuPressedRef.current = true; }}
            onPress={onMenu}
            hitSlop={12}
            style={({ pressed }) => [{ padding: spacing.sm }, pressed && { opacity: 0.6 }]}
          >
            <Icon name="more" size={18} color={colors.muted} />
          </Pressable>
        </View>
        {item.isFavorite ? <Icon name="starFilled" size={13} color={colors.warning} /> : null}
        {item.description ? <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text> : null}
        <View style={styles.cardFooter}>
          <Text style={styles.cardTime}>{formatUpdated(item.updatedAt)}</Text>
          <Text style={styles.cardVersions}>{item.versionCount} 个版本</Text>
        </View>
      </View>
    </Pressable>
  );
}

function MenuItem({ icon, label, colors, onPress, destructive }: { icon: string; label: string; colors: ReturnType<typeof useTheme>['colors']; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable style={menuStyles.item} onPress={onPress}>
      <Icon name={icon} size={18} color={destructive ? colors.danger : colors.accent} />
      <Text style={[menuStyles.label, { color: destructive ? colors.danger : colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const menuStyles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, paddingHorizontal: spacing.lg },
  label: { fontSize: fontSize.md },
});

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.card },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
    brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    logo: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    logoText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
    title: { fontSize: fontSize.lg, fontWeight: '800', color: c.text },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    headerBtn: { padding: spacing.xs },
    toolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    createBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, height: 42, borderRadius: radius.md, backgroundColor: c.accent },
    createBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
    iconBtn: { padding: spacing.sm },
    moreDots: { fontSize: 16, color: c.muted, fontWeight: '700' },
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1, paddingHorizontal: spacing.md, height: 40, borderRadius: radius.md, backgroundColor: c.card, borderWidth: 1, borderColor: c.border },
    searchInput: { flex: 1, fontSize: fontSize.md, color: c.text },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.md },
    sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, height: 40, borderRadius: radius.md, backgroundColor: c.card, borderWidth: 1, borderColor: c.border },
    sortText: { fontSize: fontSize.sm, color: c.muted, fontWeight: '600' },
    filterRow: { flexDirection: 'row', gap: spacing.xs, marginHorizontal: spacing.lg, marginBottom: spacing.sm },
    filterTab: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    filterTabActive: { backgroundColor: c.accent, borderColor: c.accent },
    filterTabText: { fontSize: fontSize.sm, color: c.muted, fontWeight: '500' },
    filterTabTextActive: { color: '#fff', fontWeight: '700' },
    listContent: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
    emptyText: { color: c.muted, fontSize: fontSize.md, textAlign: 'center' },
    card: { flex: 1, backgroundColor: c.card, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
    cardCover: { width: '100%', height: 110, backgroundColor: c.canvasBg },
    cardPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    cardBody: { padding: spacing.md, gap: 2 },
    cardHeader: { flexDirection: 'row', alignItems: 'center' },
    cardTitle: { flex: 1, fontSize: fontSize.md, fontWeight: '700', color: c.text },
    cardDesc: { fontSize: fontSize.xs, color: c.muted },
    cardFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
    cardTime: { fontSize: 10, color: c.muted },
    cardVersions: { fontSize: 10, color: c.muted },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    modalCard: { width: '100%', maxWidth: 360, backgroundColor: c.card, borderRadius: radius.lg, padding: spacing.xl },
    modalTitle: { fontSize: fontSize.lg, fontWeight: '700', color: c.text, marginBottom: spacing.md },
    modalInput: { borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text, backgroundColor: c.input, marginBottom: spacing.md },
    modalDesc: { height: 80, textAlignVertical: 'top' },
    modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
    modalCancel: { flex: 1, height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    modalCancelText: { color: c.textSecondary, fontSize: fontSize.md },
    modalSubmit: { flex: 1, height: 44, borderRadius: radius.sm, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    modalSubmitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
    menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'flex-end', justifyContent: 'flex-start', padding: spacing.lg, paddingTop: 70 },
    menuCard: { width: 250, backgroundColor: c.card, borderRadius: radius.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: c.border },
    menuTitle: { fontSize: fontSize.xs, color: c.muted, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
    sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', padding: spacing.md },
    sheetCard: { backgroundColor: c.card, borderRadius: radius.lg, paddingVertical: spacing.sm, borderWidth: 1, borderColor: c.border },
    sheetTitle: { fontSize: fontSize.sm, color: c.muted, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border, marginBottom: spacing.xs },
    busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
    busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    busyText: { color: c.text, fontSize: fontSize.sm },
  });
