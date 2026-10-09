import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './db.mjs';

// Local accounts live in DATA_ROOT/users.json (gitignored, like models.json).
// There is no registration: the admin creates colleague accounts from the
// management page. Roles are 'admin' (sees the management page) or 'user'
// (works inside projects only).
const usersPath = path.join(DATA_ROOT, 'users.json');
mkdirSync(path.dirname(usersPath), { recursive: true });

/** 原子写入：先写临时文件再 rename，避免写入中途崩溃导致用户数据损坏 */
function atomicWriteUsers(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

const hash = (value) => createHash('sha256').update(`layerive:${value}`).digest('hex');
const normalizeRole = (value) => (value === 'admin' ? 'admin' : 'user');

/** 今日日期，格式 YYYY-MM-DD（本地时区） */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 默认水印配额 */
function defaultWatermarkQuota() {
  return { dailyFree: 3, bonusCredits: 0, adCredits: 0, dailyUsed: 0, vipUsedToday: 0, lastResetDate: todayStr() };
}

/** 默认水印设置（老版本 settings 没有这些字段时使用） */
const DEFAULT_WATERMARK = { enabled: true, text: 'Layerive', fontSize: 24, opacity: 0.15, rotation: -30, spacing: 200, color: '#888888' };

/** 默认配额设置 */
const DEFAULT_QUOTA = { defaultDailyFree: 3, defaultAdCredits: 1, vipDailyLimit: 0, adEnabled: false };

/** 从 settings 参数提取水印配置，缺省时用默认值 */
function resolveWatermark(settings) {
  const wm = settings?.watermark;
  if (!wm || typeof wm !== 'object') return { ...DEFAULT_WATERMARK };
  return {
    enabled: wm.enabled ?? DEFAULT_WATERMARK.enabled,
    text: wm.text ?? DEFAULT_WATERMARK.text,
    fontSize: wm.fontSize ?? DEFAULT_WATERMARK.fontSize,
    opacity: wm.opacity ?? DEFAULT_WATERMARK.opacity,
    rotation: wm.rotation ?? DEFAULT_WATERMARK.rotation,
    spacing: wm.spacing ?? DEFAULT_WATERMARK.spacing,
    color: wm.color ?? DEFAULT_WATERMARK.color,
  };
}

/** 从 settings 参数提取配额配置，缺省时用默认值 */
function resolveQuota(settings) {
  const q = settings?.quota;
  if (!q || typeof q !== 'object') return { ...DEFAULT_QUOTA };
  return {
    defaultDailyFree: q.defaultDailyFree ?? DEFAULT_QUOTA.defaultDailyFree,
    defaultAdCredits: q.defaultAdCredits ?? DEFAULT_QUOTA.defaultAdCredits,
    vipDailyLimit: q.vipDailyLimit ?? DEFAULT_QUOTA.vipDailyLimit,
    adEnabled: q.adEnabled ?? DEFAULT_QUOTA.adEnabled,
  };
}

function sanitizeUser(user) {
  const base = { username: String(user.username || ''), passwordHash: String(user.passwordHash || ''), role: normalizeRole(user.role) };
  // VIP 与水印配额字段（向后兼容：老用户没有时给默认值）
  base.vipType = user.vipType ?? null; // null | 'permanent' | 'subscription'
  base.vipExpiresAt = user.vipExpiresAt ?? null; // ISO 字符串或 null
  const wq = user.watermarkQuota;
  base.watermarkQuota = {
    dailyFree: wq?.dailyFree ?? 3,
    bonusCredits: wq?.bonusCredits ?? 0,
    adCredits: wq?.adCredits ?? 0,
    dailyUsed: wq?.dailyUsed ?? 0,
    vipUsedToday: wq?.vipUsedToday ?? 0,
    lastResetDate: wq?.lastResetDate ?? todayStr(),
  };
  return base;
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
  const seeded = [{ username: 'admin', passwordHash: hash('admin'), role: 'admin', vipType: null, vipExpiresAt: null, watermarkQuota: defaultWatermarkQuota() }];
  writeUsers(seeded);
  return seeded;
}

export function writeUsers(users) {
  atomicWriteUsers(usersPath, `${JSON.stringify(users, null, 2)}\n`);
}

export function verifyLogin(username, password) {
  const wanted = String(username || '').trim();
  if (!wanted || !password) return null;
  const user = readUsers().find((item) => item.username === wanted);
  if (!user || user.passwordHash !== hash(String(password))) return null;
  return { username: user.username, role: user.role };
}

export function listUsersPublic() {
  return readUsers().map(({ username, role, vipType, vipExpiresAt, watermarkQuota }) => ({ username, role, vipType, vipExpiresAt, watermarkQuota }));
}

/** 公网部署前自检：默认 admin/admin 账号是否仍然存在 */
export function hasDefaultAdminCredentials() {
  return readUsers().some((user) => user.username === 'admin' && user.passwordHash === hash('admin'));
}

/**
 * 判断用户是否为 VIP。
 * admin 自动视为 VIP；permanent 为永久 VIP；subscription 需检查过期时间。
 */
export function isVip(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!user.vipType) return false;
  if (user.vipType === 'permanent') return true;
  if (user.vipType === 'subscription' && user.vipExpiresAt) {
    return new Date(user.vipExpiresAt).getTime() > Date.now();
  }
  return false;
}

/**
 * 自然日重置：如果 lastResetDate 不是今天，则重置 dailyUsed、adCredits、vipUsedToday。
 * 返回传入 user 的引用（可能被原地修改）。
 */
export function checkAndResetDailyQuota(user) {
  if (!user?.watermarkQuota) return user;
  const today = todayStr();
  if (user.watermarkQuota.lastResetDate !== today) {
    user.watermarkQuota.dailyUsed = 0;
    user.watermarkQuota.adCredits = 0;
    user.watermarkQuota.vipUsedToday = 0;
    user.watermarkQuota.lastResetDate = today;
  }
  return user;
}

/**
 * 获取用户剩余配额。
 * VIP 用户：若 vipDailyLimit > 0 则返回 max(0, limit - vipUsedToday)，否则返回 Infinity。
 * 非 VIP 用户：返回 max(0, dailyFree - dailyUsed) + bonusCredits + adCredits。
 */
export function getRemainingQuota(user, settings) {
  if (!user) return 0;
  const { vipDailyLimit } = resolveQuota(settings);
  checkAndResetDailyQuota(user);
  if (isVip(user)) {
    if (vipDailyLimit > 0) return Math.max(0, vipDailyLimit - user.watermarkQuota.vipUsedToday);
    return Infinity;
  }
  const wq = user.watermarkQuota;
  return Math.max(0, wq.dailyFree - wq.dailyUsed) + wq.bonusCredits + wq.adCredits;
}

/**
 * 扣除一次配额（消耗 1 次）。
 * VIP 用户：若 vipDailyLimit > 0 则扣 vipUsedToday，否则不扣（无限制）。
 * 非 VIP 用户：按 dailyFree → adCredits → bonusCredits 顺序扣除。
 * 返回 true 表示成功，false 表示配额不足。
 */
export function consumeQuota(user, settings) {
  if (!user) return false;
  const { vipDailyLimit } = resolveQuota(settings);
  checkAndResetDailyQuota(user);
  if (isVip(user)) {
    if (vipDailyLimit > 0) {
      if (user.watermarkQuota.vipUsedToday >= vipDailyLimit) return false;
      user.watermarkQuota.vipUsedToday += 1;
    }
    // 无限制 VIP 不扣次数
    return true;
  }
  const wq = user.watermarkQuota;
  // 先扣免费配额
  if (wq.dailyUsed < wq.dailyFree) {
    wq.dailyUsed += 1;
    return true;
  }
  // 再扣广告配额
  if (wq.adCredits > 0) {
    wq.adCredits -= 1;
    return true;
  }
  // 最后扣奖励配额
  if (wq.bonusCredits > 0) {
    wq.bonusCredits -= 1;
    return true;
  }
  return false;
}

/**
 * 获取用户完整信息（含 VIP 状态、剩余配额、水印配置），用于前端展示。
 */
export function getUserProfile(username, settings) {
  const users = readUsers();
  const user = users.find((item) => item.username === username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  checkAndResetDailyQuota(user);
  writeUsers(users);
  return {
    username: user.username,
    role: user.role,
    isVip: isVip(user),
    vipType: user.vipType,
    vipExpiresAt: user.vipExpiresAt,
    remainingQuota: getRemainingQuota(user, settings),
    watermark: resolveWatermark(settings),
  };
}

/**
 * 设置或取消用户 VIP。
 * vipType: null（取消）、'permanent'（永久）、'subscription'（订阅，需指定 vipExpiresAt）。
 */
export function setUserVip(username, vipType, vipExpiresAt) {
  const users = readUsers();
  const user = users.find((item) => item.username === username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (vipType === null || vipType === undefined) {
    user.vipType = null;
    user.vipExpiresAt = null;
  } else if (vipType === 'permanent') {
    user.vipType = 'permanent';
    user.vipExpiresAt = null;
  } else if (vipType === 'subscription') {
    user.vipType = 'subscription';
    user.vipExpiresAt = vipExpiresAt ?? null;
  } else {
    throw Object.assign(new Error('无效的 VIP 类型'), { status: 400 });
  }
  writeUsers(users);
  return { username: user.username, vipType: user.vipType, vipExpiresAt: user.vipExpiresAt };
}

/**
 * 管理员调配用户配额：可调整 dailyFree 和 bonusCredits。
 * 传入 undefined / null 表示不修改该字段。
 */
export function adjustUserQuota(username, dailyFree, bonusCredits) {
  const users = readUsers();
  const user = users.find((item) => item.username === username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (dailyFree !== undefined && dailyFree !== null) {
    const val = Number(dailyFree);
    if (!Number.isFinite(val) || val < 0) throw Object.assign(new Error('每日免费次数必须为非负数'), { status: 400 });
    user.watermarkQuota.dailyFree = val;
  }
  if (bonusCredits !== undefined && bonusCredits !== null) {
    const val = Number(bonusCredits);
    if (!Number.isFinite(val) || val < 0) throw Object.assign(new Error('奖励次数必须为非负数'), { status: 400 });
    user.watermarkQuota.bonusCredits = val;
  }
  writeUsers(users);
  return { username: user.username, watermarkQuota: user.watermarkQuota };
}

/**
 * 用户观看广告获取额外配额。
 * settings.quota.adEnabled 为 false 时抛 403。
 * 否则 adCredits += defaultAdCredits。
 */
export function watchAd(username, settings) {
  const { adEnabled, defaultAdCredits } = resolveQuota(settings);
  if (!adEnabled) throw Object.assign(new Error('广告功能未启用'), { status: 403 });
  const users = readUsers();
  const user = users.find((item) => item.username === username);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  checkAndResetDailyQuota(user);
  user.watermarkQuota.adCredits += defaultAdCredits;
  writeUsers(users);
  return { username: user.username, adCredits: user.watermarkQuota.adCredits };
}

export function createUser(input) {
  const username = String(input?.username || '').trim();
  const password = String(input?.password || '');
  const role = normalizeRole(input?.role);
  if (!username || /[\s/\\]/.test(username)) throw Object.assign(new Error('用户名不能为空，且不能包含空格或路径分隔符'), { status: 400 });
  if (password.length < 4) throw Object.assign(new Error('密码至少 4 位'), { status: 400 });
  const users = readUsers();
  if (users.some((item) => item.username === username)) throw Object.assign(new Error('用户名已存在'), { status: 400 });
  users.push({ username, passwordHash: hash(password), role, vipType: null, vipExpiresAt: null, watermarkQuota: defaultWatermarkQuota() });
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
