import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './db.mjs';

// Local accounts live in DATA_ROOT/users.json (gitignored, like models.json).
// There is no registration: the admin creates colleague accounts from the
// management page. Roles are 'admin' (sees the management page) or 'user'
// (works inside projects only).
const usersPath = path.join(DATA_ROOT, 'users.json');
mkdirSync(path.dirname(usersPath), { recursive: true });

const hash = (value) => createHash('sha256').update(`layerive:${value}`).digest('hex');
const normalizeRole = (value) => (value === 'admin' ? 'admin' : 'user');

function sanitizeUser(user) {
  return { username: String(user.username || ''), passwordHash: String(user.passwordHash || ''), role: normalizeRole(user.role) };
}

export function readUsers() {
  try {
    const raw = JSON.parse(readFileSync(usersPath, 'utf8'));
    if (Array.isArray(raw)) {
      const users = raw.map(sanitizeUser).filter((user) => user.username);
      if (users.length) return users;
    }
  } catch { /* missing or malformed file falls through to seeding */ }
  // First run: seed the historical single built-in account so existing
  // admin/admin logins keep working after the upgrade.
  const seeded = [{ username: 'admin', passwordHash: hash('admin'), role: 'admin' }];
  writeUsers(seeded);
  return seeded;
}

export function writeUsers(users) {
  writeFileSync(usersPath, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
}

export function verifyLogin(username, password) {
  const wanted = String(username || '').trim();
  if (!wanted || !password) return null;
  const user = readUsers().find((item) => item.username === wanted);
  if (!user || user.passwordHash !== hash(String(password))) return null;
  return { username: user.username, role: user.role };
}

export function listUsersPublic() {
  return readUsers().map(({ username, role }) => ({ username, role }));
}

/** 公网部署前自检：默认 admin/admin 账号是否仍然存在 */
export function hasDefaultAdminCredentials() {
  return readUsers().some((user) => user.username === 'admin' && user.passwordHash === hash('admin'));
}

export function createUser(input) {
  const username = String(input?.username || '').trim();
  const password = String(input?.password || '');
  const role = normalizeRole(input?.role);
  if (!username || /[\s/\\]/.test(username)) throw Object.assign(new Error('用户名不能为空，且不能包含空格或路径分隔符'), { status: 400 });
  if (password.length < 4) throw Object.assign(new Error('密码至少 4 位'), { status: 400 });
  const users = readUsers();
  if (users.some((item) => item.username === username)) throw Object.assign(new Error('用户名已存在'), { status: 400 });
  users.push({ username, passwordHash: hash(password), role });
  writeUsers(users);
  return { username, role };
}

export function updateUser(username, input) {
  const users = readUsers();
  const user = users.find((item) => item.username === username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  const password = input?.password === undefined ? null : String(input.password || '');
  if (password !== null && password.length < 4) throw Object.assign(new Error('密码至少 4 位'), { status: 400 });
  const role = input?.role === undefined ? user.role : normalizeRole(input.role);
  // Keep at least one admin able to reach the management page.
  if (user.role === 'admin' && role !== 'admin' && users.filter((item) => item.role === 'admin').length <= 1) {
    throw Object.assign(new Error('至少需要保留一个管理员账号'), { status: 400 });
  }
  user.role = role;
  if (password) user.passwordHash = hash(password);
  writeUsers(users);
  return { username: user.username, role: user.role };
}

export function deleteUser(username) {
  const users = readUsers();
  const user = users.find((item) => item.username === username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (user.role === 'admin' && users.filter((item) => item.role === 'admin').length <= 1) {
    throw Object.assign(new Error('至少需要保留一个管理员账号'), { status: 400 });
  }
  writeUsers(users.filter((item) => item.username !== username));
  return { username, role: user.role };
}
