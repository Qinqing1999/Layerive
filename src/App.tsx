import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getAuthToken, clearAuthToken } from './api';
import { LoginView } from './LoginView';
import { HomeView } from './HomeView';
import { ModelConfigView } from './ModelConfigView';
import { WorkspaceView } from './WorkspaceView';
import type { ModelConfig, Project } from './types';

type View = { name: 'home' } | { name: 'models'; backTo?: string } | { name: 'workspace'; projectId: string };

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [view, setView] = useState<View>({ name: 'home' });
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [activeModel, setActiveModel] = useState('');
  const [activeVisionModel, setActiveVisionModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' } | null>(null);

  const notify = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const refreshProjects = useCallback(async () => {
    const data = await api.listProjects();
    setProjects(data.projects);
  }, []);

  const refreshModels = useCallback(async () => {
    const data = await api.models();
    setModels(data.models);
    setActiveModel(data.activeModel);
    setActiveVisionModel(data.activeVisionModel);
  }, []);
  const handleProjectChanged = useCallback(() => { void refreshProjects(); }, [refreshProjects]);

  const authCheckRef = useRef(false);
  useEffect(() => {
    if (authCheckRef.current) return;
    authCheckRef.current = true;
    const token = getAuthToken();
    if (!token) { setAuthed(false); return; }
    api.checkAuth().then((r) => {
      if (r.authenticated) {
        setAuthed(true);
        setRole(r.role === 'admin' ? 'admin' : 'user');
        return Promise.all([refreshProjects(), refreshModels()])
          .catch(() => notify('无法连接本地服务，请确认应用服务已经启动。', 'error'))
          .finally(() => setLoading(false));
      }
      clearAuthToken();
      setAuthed(false);
    }).catch(() => { setAuthed(false); });
  }, [refreshProjects, refreshModels, notify]);

  async function createProject(input: { name: string; description: string }) {
    try {
      const bundle = await api.createProject({ ...input, defaultModelId: activeModel });
      await refreshProjects();
      setView({ name: 'workspace', projectId: bundle.project.id });
      notify('项目已创建，内容会自动保存在本机。');
    } catch (error) { notify((error as Error).message, 'error'); }
  }

  async function deleteProject(id: string) {
    try { await api.deleteProject(id); await refreshProjects(); notify('项目已移入回收状态'); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function duplicateProject(id: string) {
    try { await api.duplicateProject(id); await refreshProjects(); notify('项目已复制'); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function importProject(file: File) {
    try { const bundle = await api.importProject(file); await refreshProjects(); notify('项目导入成功，已生成新的项目。'); setView({ name: 'workspace', projectId: bundle.project.id }); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function saveModel(model: Partial<ModelConfig>, id?: string) {
    try {
      const result = id ? await api.updateModel(id, model) : await api.createModel(model);
      await refreshModels(); notify('模型配置已保存');
      return result.model;
    } catch (error) { notify((error as Error).message, 'error'); }
  }

  async function deleteModel(id: string) {
    try { await api.deleteModel(id); await refreshModels(); notify('模型配置已删除'); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function activateModel(id: string) {
    try { await api.activateModel(id); await refreshModels(); notify('默认模型已更新'); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function activateVisionModel(id: string) {
    try { await api.activateVisionModel(id); await refreshModels(); notify('默认视觉识别模型已更新'); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function testModelConfig(model: Partial<ModelConfig>) {
    try { const result = await api.testModelConfig(model); return `✓ ${result.message} · ${result.latency}ms`; }
    catch (error) { return `连接失败：${(error as Error).message}`; }
  }

  async function revealModelApiKey(id: string) {
    try { return (await api.revealModelApiKey(id)).apiKey; }
    catch (error) { notify((error as Error).message, 'error'); return ''; }
  }

  async function logout() {
    try { await api.logout(); } catch { /* ignore */ }
    clearAuthToken();
    setAuthed(false);
    setView({ name: 'home' });
  }

  if (authed === null) return null;
  if (!authed) return <LoginView onSuccess={(userRole) => { setRole(userRole); setAuthed(true); setLoading(true); Promise.all([refreshProjects(), refreshModels()]).catch(() => notify('无法连接本地服务，请确认应用服务已经启动。', 'error')).finally(() => setLoading(false)); }} notify={notify} />;
  const isAdmin = role === 'admin';

  return (
    <>
      {view.name === 'home' && <HomeView projects={projects} loading={loading} isAdmin={isAdmin} onOpen={(projectId) => setView({ name: 'workspace', projectId })} onCreate={createProject} onDelete={deleteProject} onDuplicate={duplicateProject} onImport={importProject} onRefreshProjects={refreshProjects} onModels={() => setView({ name: 'models' })} onLogout={logout} notify={notify} />}
      {view.name === 'models' && <ModelConfigView models={models} activeModel={activeModel} activeVisionModel={activeVisionModel} onBack={() => view.backTo ? setView({ name: 'workspace', projectId: view.backTo }) : setView({ name: 'home' })} onSave={saveModel} onDelete={deleteModel} onActivate={activateModel} onActivateVision={activateVisionModel} onTestConfig={testModelConfig} onRevealApiKey={revealModelApiKey} notify={notify} />}
      {view.name === 'workspace' && <WorkspaceView projectId={view.projectId} models={models} activeModel={activeModel} activeVisionModel={activeVisionModel} isAdmin={isAdmin} onBack={() => { setView({ name: 'home' }); void refreshProjects(); }} onModels={() => setView({ name: 'models', backTo: view.projectId })} onProjectChanged={handleProjectChanged} notify={notify} />}
      {toast && <div className={`toast ${toast.kind}`} role="status"><span>{toast.kind === 'success' ? '✓' : '!'}</span>{toast.message}</div>}
    </>
  );
}
