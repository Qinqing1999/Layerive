import React, { useCallback, useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { getAuthToken, api, clearAuthToken, initServerBase } from './api';
import { ThemeProvider, useTheme } from './theme';
import { fontSize, radius, spacing } from './theme';
import type { ModelConfig, Project } from './types';
import { LoginScreen } from './screens/LoginScreen';
import { HomeScreen } from './screens/HomeScreen';
import { WorkspaceScreen } from './screens/WorkspaceScreen';

type AuthState = 'checking' | 'guest' | 'authed';
type ScreenView = { name: 'home' } | { name: 'workspace'; projectId: string };

type Toast = { message: string; kind: 'success' | 'error' };

function AppShell() {
  const { colors, mode } = useTheme();
  const styles = makeStyles(colors);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [view, setView] = useState<ScreenView>({ name: 'home' });
  const [toast, setToast] = useState<Toast | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [activeModel, setActiveModel] = useState('');
  const [activeVisionModel, setActiveVisionModel] = useState('');
  const [loading, setLoading] = useState(true);

  const notify = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 3200);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [projData, modelData] = await Promise.all([api.listProjects(), api.models()]);
      setProjects(projData.projects);
      setModels(modelData.models);
      setActiveModel(modelData.activeModel);
      setActiveVisionModel(modelData.activeVisionModel);
    } catch {
      notify('无法连接本地服务，请确认应用服务已启动。', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    (async () => {
      await initServerBase();
      const token = await getAuthToken();
      if (!token) { setAuthState('guest'); return; }
      try {
        const r = await api.checkAuth();
        if (r.authenticated) { setAuthState('authed'); await loadAll(); }
        else setAuthState('guest');
      } catch {
        setAuthState('guest');
      }
    })();
  }, [loadAll]);

  const onLoginSuccess = useCallback(async () => {
    setAuthState('authed');
    setLoading(true);
    await loadAll();
  }, [loadAll]);

  const onLogout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    await clearAuthToken();
    setAuthState('guest');
    setProjects([]);
    setModels([]);
  }, []);

  const refreshProjects = useCallback(async () => { await loadAll(); }, [loadAll]);

  async function createProject(input: { name: string; description: string }) {
    try {
      const bundle = await api.createProject(input);
      await refreshProjects();
      setView({ name: 'workspace', projectId: bundle.project.id });
      notify('项目已创建');
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  if (authState === 'checking') return <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />;

  if (authState === 'guest') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        <LoginScreen onSuccess={onLoginSuccess} notify={notify} />
        {toast && <ToastView toast={toast} colors={colors} />}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      {view.name === 'home' && (
        <HomeScreen
          projects={projects}
          loading={loading}
          onOpen={(id: string) => setView({ name: 'workspace', projectId: id })}
          onCreate={createProject}
          onRefresh={refreshProjects}
          onLogout={onLogout}
          notify={notify}
        />
      )}
      {view.name === 'workspace' && (
        <WorkspaceScreen
          projectId={view.projectId}
          models={models}
          activeModel={activeModel}
          activeVisionModel={activeVisionModel}
          onBack={() => { setView({ name: 'home' }); void refreshProjects(); }}
          notify={notify}
        />
      )}
      {toast && <ToastView toast={toast} colors={colors} />}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

function ToastView({ toast, colors }: { toast: Toast; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <View style={[toastStyles.toast, toast.kind === 'error' && { borderColor: colors.danger }, { backgroundColor: colors.card }]}>
      <Text style={[toastStyles.toastText, { color: toast.kind === 'error' ? colors.danger : colors.success }]}>
        {toast.kind === 'success' ? '✓' : '!'}
      </Text>
      <Text style={[toastStyles.toastMsg, { color: colors.text }]}>{toast.message}</Text>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: c.bg },
  });

const toastStyles = StyleSheet.create({
  toast: {
    position: 'absolute', bottom: 80, left: spacing.lg, right: spacing.lg,
    padding: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: 'transparent', flexDirection: 'row',
    alignItems: 'center', gap: spacing.sm, elevation: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1, shadowRadius: 10, zIndex: 9999,
  },
  toastText: { fontSize: fontSize.md, fontWeight: '700' },
  toastMsg: { fontSize: fontSize.sm, flex: 1 },
});
