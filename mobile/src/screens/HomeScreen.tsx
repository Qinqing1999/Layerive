import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api, backupPath, downloadToCache, exportProjectPath, imageSource, thumbUrl } from '../api';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import type { Project } from '../types';
import { Icon } from '../components/Icon';

type Props = {
  projects: Project[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreate: (input: { name: string; description: string }) => Promise<void>;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

const formatUpdated = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export function HomeScreen({ projects, loading, onOpen, onCreate, onRefresh, onLogout, notify }: Props) {
  const { colors, mode, toggle } = useTheme();
  const styles = makeStyles(colors);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState('');

  const filtered = projects.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  async function handleCreate() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      await onCreate({ name: newName.trim(), description: newDesc.trim() });
      setCreateOpen(false);
      setNewName('');
      setNewDesc('');
    } finally {
      setCreating(false);
    }
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

  function confirmDelete(project: Project) {
    Alert.alert('删除项目', `确定删除「${project.name}」吗？可在本地数据库中软删除，不影响图片文件。`, [
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

  async function duplicate(project: Project) {
    try { await api.duplicateProject(project.id); await onRefresh(); notify('项目已复制'); }
    catch (e) { notify((e as Error).message, 'error'); }
  }

  function rename(project: Project) {
    setRenameTarget(project);
    setRenameValue(project.name);
  }

  async function submitRename() {
    if (!renameTarget || !renameValue.trim()) return;
    try {
      await api.updateProject(renameTarget.id, { name: renameValue.trim() });
      setRenameTarget(null);
      await onRefresh();
      notify('已重命名');
    } catch (e) { notify((e as Error).message, 'error'); }
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

  function openProjectMenu(project: Project) {
    Alert.alert(project.name, undefined, [
      { text: project.isFavorite ? '取消收藏' : '收藏', onPress: () => void toggleFavorite(project) },
      { text: '重命名', onPress: () => rename(project) },
      { text: '复制', onPress: () => void duplicate(project) },
      { text: '导出 ZIP', onPress: () => void exportProject(project) },
      { text: '删除', style: 'destructive', onPress: () => confirmDelete(project) },
      { text: '取消', style: 'cancel' },
    ]);
  }

  return (
    <View style={styles.container}>
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

      {/* Search */}
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefreshData} tintColor={colors.accent} />}
          contentContainerStyle={styles.listContent}
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
              <Text style={styles.emptyText}>暂无项目，点击「新建项目」开始创作</Text>
            </View>
          }
        />
      )}

      {/* Create Modal */}
      <Modal visible={createOpen} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>新建项目</Text>
            <TextInput
              style={styles.modalInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="项目名称"
              placeholderTextColor={colors.muted}
              autoFocus
            />
            <TextInput
              style={[styles.modalInput, styles.modalDesc]}
              value={newDesc}
              onChangeText={setNewDesc}
              placeholder="项目描述（可选）"
              placeholderTextColor={colors.muted}
              multiline
              numberOfLines={3}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => { setCreateOpen(false); setNewName(''); setNewDesc(''); }}>
                <Text style={styles.modalCancelText}>取消</Text>
              </Pressable>
              <Pressable style={[styles.modalSubmit, (!newName.trim() || creating) && { opacity: 0.5 }]} onPress={handleCreate} disabled={!newName.trim() || creating}>
                {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSubmitText}>创建</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rename Modal */}
      <Modal visible={Boolean(renameTarget)} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>重命名项目</Text>
            <TextInput
              style={styles.modalInput}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="项目名称"
              placeholderTextColor={colors.muted}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setRenameTarget(null)}>
                <Text style={styles.modalCancelText}>取消</Text>
              </Pressable>
              <Pressable style={[styles.modalSubmit, !renameValue.trim() && { opacity: 0.5 }]} onPress={submitRename} disabled={!renameValue.trim()}>
                <Text style={styles.modalSubmitText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Menu Modal */}
      <Modal visible={menuVisible} animationType="fade" transparent>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>更多</Text>
            <MenuItem icon="import" label="导入项目 ZIP" colors={colors} onPress={() => { setMenuVisible(false); void importProject(); }} />
            <MenuItem icon="zip" label="下载完整备份" colors={colors} onPress={() => { setMenuVisible(false); void downloadBackup(); }} />
            <MenuItem icon={mode === 'dark' ? 'sun' : 'moon'} label={mode === 'dark' ? '切换为亮色模式' : '切换为暗色模式'} colors={colors} onPress={() => { toggle(); setMenuVisible(false); }} />
            <MenuItem icon="logout" label="退出登录" colors={colors} destructive onPress={() => { setMenuVisible(false); onLogout(); }} />
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
  return (
    <Pressable style={styles.card} onPress={onPress}>
      {item.coverUrl ? (
        <Image source={imageSource(thumbUrl(item.coverUrl))} style={styles.cardCover} resizeMode="cover" />
      ) : (
        <View style={[styles.cardCover, styles.cardPlaceholder]}>
          <Icon name="image" size={40} color={colors.muted} />
        </View>
      )}
      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
          <Pressable onPress={onMenu} hitSlop={8} style={styles.iconBtn}>
            <Text style={styles.moreDots}>⋯</Text>
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
    container: { flex: 1, backgroundColor: c.bg },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
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
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.md, paddingHorizontal: spacing.md, height: 40, borderRadius: radius.md, backgroundColor: c.card, borderWidth: 1, borderColor: c.border },
    searchInput: { flex: 1, fontSize: fontSize.md, color: c.text },
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
    busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
    busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    busyText: { color: c.text, fontSize: fontSize.sm },
  });
