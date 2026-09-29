import { useState } from 'react';
import { api, setAuthToken } from './api';

export function LoginView({ onSuccess, notify }: { onSuccess: (role: 'admin' | 'user') => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const result = await api.login(username, password);
      setAuthToken(result.token);
      onSuccess(result.role === 'admin' ? 'admin' : 'user');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="login-logo">L</div>
          <h1>Layerive</h1>
          <p>本地 AI 图片创作工作台</p>
        </div>
        <label className="login-field">
          <span>用户名</span>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" disabled={loading} />
        </label>
        <label className="login-field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={loading} placeholder="请输入密码" autoFocus />
        </label>
        <button type="submit" className="login-button" disabled={loading || !password}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}
