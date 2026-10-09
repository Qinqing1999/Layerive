# VIP/水印/免水印次数体系 — 设计文档

## 1. 背景与目标

Layerive 是图片生成/编辑应用。当前所有用户生成的图片均无水印保护。需要引入 VIP 体系和水印机制：

- **非 VIP 用户**：生成的图片展示时叠加平铺文字水印；保存到相册时消耗每日免费免水印次数下载原图
- **VIP 用户**：不显示水印，不限次数保存原图（或管理员可设上限）
- **每日免费次数**：默认 3 次，自然日 0 点重置
- **广告获得次数**：看广告获得额外次数（当前预留接口，禁用）
- **管理员可配置**：全局默认次数、水印样式、用户 VIP 状态、手动调配次数

## 2. 需求决策

| 决策 | 结论 |
|------|------|
| VIP 模式 | 两种都支持（有期限 subscription + 永久 permanent） |
| 水印位置 | 原图无水印存储，客户端展示时叠加水印层（服务端不烧入） |
| 水印样式 | 平铺文字水印，管理员可自定义内容/字号/透明度/间距/颜色/旋转 |
| 重置周期 | 自然日 0 点 |
| 广告 | 仅预留接口，当前禁用 |
| 去水印机制 | 保存时消耗次数下载原图（非 VIP） |
| 激活码 | 先跳过，后续再加 |
| 管理员 | 自动 VIP |

## 3. 数据层

### 3.1 users.json 扩展

```json
{
  "username": "admin",
  "passwordHash": "...",
  "role": "admin",
  "vipType": "permanent",
  "vipExpiresAt": null,
  "watermarkQuota": {
    "dailyFree": 3,
    "bonusCredits": 0,
    "adCredits": 0,
    "dailyUsed": 0,
    "vipUsedToday": 0,
    "lastResetDate": "2026-10-08"
  }
}
```

字段说明：
- `vipType`：`"permanent"` | `"subscription"` | `null`
- `vipExpiresAt`：ISO 时间字符串，仅 subscription 时有值
- `watermarkQuota.dailyFree`：每日免费免水印次数，默认从全局配置取，管理员可覆盖
- `watermarkQuota.bonusCredits`：管理员手动调配的额外次数，不随自然日重置
- `watermarkQuota.adCredits`：广告获得的次数，自然日重置
- `watermarkQuota.dailyUsed`：今日已使用的免费次数（用于判断 dailyFree 是否用完）
- `watermarkQuota.vipUsedToday`：VIP 用户今日已使用次数（仅 vipDailyLimit > 0 时有效）
- `watermarkQuota.lastResetDate`：上次重置日期（YYYY-MM-DD）

### 3.2 settings.json 扩展

```json
{
  "queueConcurrency": 2,
  "watermark": {
    "enabled": true,
    "text": "Layerive",
    "fontSize": 24,
    "opacity": 0.15,
    "rotation": -30,
    "spacing": 200,
    "color": "#888888"
  },
  "quota": {
    "defaultDailyFree": 3,
    "defaultAdCredits": 1,
    "vipDailyLimit": 0,
    "adEnabled": false
  }
}
```

字段说明：
- `watermark.enabled`：全局水印开关
- `watermark.text`：水印文字内容（管理员自定义）
- `watermark.fontSize/opacity/rotation/spacing/color`：水印视觉参数
- `quota.defaultDailyFree`：新用户默认每日免费次数
- `quota.defaultAdCredits`：看一次广告获得的次数
- `quota.vipDailyLimit`：VIP 每日保存上限（0 = 无限）
- `quota.adEnabled`：广告功能开关（当前 false）

## 4. 服务端 API

### 4.1 用户侧 API

| 路径 | 方法 | 权限 | 功能 |
|------|------|------|------|
| `/api/user/profile` | GET | 登录 | 获取 VIP 状态 + 今日剩余次数 + 水印配置 |
| `/api/user/watermark-save` | POST | 登录 | 消耗 1 次免水印机会，返回原图 URL |
| `/api/user/watch-ad` | POST | 登录 | 观看广告获得次数（adEnabled=false 时返回 403） |

**GET /api/user/profile 响应**：
```json
{
  "username": "testuser",
  "role": "user",
  "isVip": false,
  "vipType": null,
  "vipExpiresAt": null,
  "remainingQuota": 3,
  "watermark": {
    "enabled": true,
    "text": "Layerive",
    "fontSize": 24,
    "opacity": 0.15,
    "rotation": -30,
    "spacing": 200,
    "color": "#888888"
  }
}
```

**POST /api/user/watermark-save 请求**：
```json
{ "imageVersionId": 123 }
```

**POST /api/user/watermark-save 响应**：
```json
{
  "downloadUrl": "/api/images/123/download?token=...",
  "remainingQuota": 2
}
```

**POST /api/user/watch-ad 响应**（adEnabled=true 时）：
```json
{
  "credits": 1,
  "remainingQuota": 4
}
```

### 4.2 管理侧 API

| 路径 | 方法 | 权限 | 功能 |
|------|------|------|------|
| `/api/admin/users/:username/vip` | PUT | admin | 设置/取消 VIP |
| `/api/admin/users/:username/quota` | PUT | admin | 手动调配用户次数 |
| `/api/admin/watermark` | GET/PUT | admin | 读取/修改水印配置 |
| `/api/admin/quota-config` | GET/PUT | admin | 读取/修改全局次数配置 |

**PUT /api/admin/users/:username/vip 请求**：
```json
{
  "vipType": "permanent",
  "vipExpiresAt": null
}
```
- `vipType: "permanent"` → 永久 VIP
- `vipType: "subscription"` + `vipExpiresAt: "2026-12-31T23:59:59Z"` → 有期限 VIP
- `vipType: null` → 取消 VIP

**PUT /api/admin/users/:username/quota 请求**：
```json
{
  "dailyFree": 5,
  "bonusCredits": 10
}
```

**PUT /api/admin/watermark 请求**：
```json
{
  "enabled": true,
  "text": "Layerive Pro",
  "fontSize": 24,
  "opacity": 0.15,
  "rotation": -30,
  "spacing": 200,
  "color": "#888888"
}
```

**PUT /api/admin/quota-config 请求**：
```json
{
  "defaultDailyFree": 3,
  "defaultAdCredits": 1,
  "vipDailyLimit": 0,
  "adEnabled": false
}
```

## 5. 核心逻辑

### 5.1 VIP 判定

```js
function isVip(user) {
  if (user.role === 'admin') return true;
  if (user.vipType === 'permanent') return true;
  if (user.vipType === 'subscription' && user.vipExpiresAt) {
    return new Date(user.vipExpiresAt) > new Date();
  }
  return false;
}
```

### 5.2 每日重置

```js
function checkAndResetDailyQuota(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.watermarkQuota.lastResetDate !== today) {
    user.watermarkQuota.dailyUsed = 0;
    user.watermarkQuota.adCredits = 0;
    user.watermarkQuota.vipUsedToday = 0;
    user.watermarkQuota.lastResetDate = today;
  }
}
```

### 5.3 剩余次数计算

```js
function getRemainingQuota(user, settings) {
  if (isVip(user)) {
    const limit = settings.quota.vipDailyLimit;
    if (limit === 0) return Infinity;
    return Math.max(0, limit - (user.watermarkQuota.vipUsedToday || 0));
  }
  const free = Math.max(0, user.watermarkQuota.dailyFree - user.watermarkQuota.dailyUsed);
  return free + user.watermarkQuota.bonusCredits + user.watermarkQuota.adCredits;
}
```

### 5.4 消耗次数（保存图片时）

```js
function consumeQuota(user, settings) {
  if (isVip(user)) {
    const limit = settings.quota.vipDailyLimit;
    if (limit > 0) {
      if ((user.watermarkQuota.vipUsedToday || 0) >= limit) throw 403;
      user.watermarkQuota.vipUsedToday = (user.watermarkQuota.vipUsedToday || 0) + 1;
    }
    return;
  }
  const remaining = getRemainingQuota(user, settings);
  if (remaining <= 0) throw 403;
  // 优先扣 dailyFree，再扣 adCredits，最后扣 bonusCredits
  if (user.watermarkQuota.dailyUsed < user.watermarkQuota.dailyFree) {
    user.watermarkQuota.dailyUsed++;
  } else if (user.watermarkQuota.adCredits > 0) {
    user.watermarkQuota.adCredits--;
  } else if (user.watermarkQuota.bonusCredits > 0) {
    user.watermarkQuota.bonusCredits--;
  }
}
```

## 6. 客户端

### 6.1 水印叠加组件

**新建 `mobile/src/components/WatermarkOverlay.tsx`**

- Props: `watermark: WatermarkConfig`（从 profile 获取）
- 渲染：`position: absolute`，`pointerEvents="none"`，平铺文字水印
- 使用 RN `View` + 多个 `Text`，按 spacing 参数排列
- 旋转通过 `transform: [{ rotate: '-30deg' }]` 实现

### 6.2 RemoteImage 扩展

- 新增可选 `showWatermark: boolean` prop
- `showWatermark=true` 时，内部叠加 `<WatermarkOverlay>`
- 画布图片、画廊图片、历史版本缩略图均可控制

### 6.3 App.tsx 扩展

- 登录成功后调用 `/api/user/profile`
- 全局存储 `userProfile: UserProfile | null`
- 下发给 WorkspaceScreen、HomeScreen 等页面
- 切换主题时不需要重新拉取

### 6.4 WorkspaceScreen 保存逻辑改造

现有 `saveCurrentImage()` 改造：
1. VIP 用户 → 直接下载原图保存
2. 非 VIP 且有剩余次数 → 弹确认对话框「消耗 1 次免水印机会保存原图？」→ 确认后调 `/api/user/watermark-save` → 下载原图 → 保存 → 更新剩余次数
3. 非 VIP 且无剩余次数 → 弹提示「今日免费次数已用完」→ 引导开通 VIP 或观看广告

### 6.5 ModelsScreen 管理后台

新增第 4 个 Tab「运营」：
- **水印配置区**：文字输入、字号、透明度、间距、颜色、旋转滑块 + 实时预览
- **次数配置区**：每日免费次数、广告获得次数、VIP 每日上限、广告开关
- **用户 VIP 管理区**（在用户 Tab 中增强）：
  - 用户卡片显示 VIP 徽章和剩余次数
  - 操作菜单增加「设为 VIP」「调整次数」

## 7. 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `server/users.mjs` | 修改 | 扩展用户结构、VIP 判定、配额计算、每日重置、消耗逻辑 |
| `server/index.mjs` | 修改 | 新增 7 个 API 路由，settings 读写扩展水印和配额配置 |
| `mobile/src/api.ts` | 修改 | 新增 7 个 API 方法 |
| `mobile/src/types.ts` | 修改 | 新增 UserProfile、WatermarkConfig、QuotaConfig 类型 |
| `mobile/src/App.tsx` | 修改 | 登录后拉取 profile，全局存储 userProfile |
| `mobile/src/components/WatermarkOverlay.tsx` | 新建 | 水印叠加组件 |
| `mobile/src/components/RemoteImage.tsx` | 修改 | 增加可选 showWatermark prop |
| `mobile/src/screens/WorkspaceScreen.tsx` | 修改 | saveCurrentImage 改造为消耗次数逻辑 |
| `mobile/src/screens/ModelsScreen.tsx` | 修改 | 新增运营 Tab，用户卡片增加 VIP/次数管理 |

## 8. 实施顺序

1. **服务端数据层**（users.mjs + settings）— 扩展数据结构、VIP 判定、配额逻辑
2. **服务端 API**（index.mjs）— 新增 7 个路由
3. **移动端类型和 API**（types.ts + api.ts）— 类型定义和接口封装
4. **移动端全局状态**（App.tsx）— profile 拉取和存储
5. **水印组件**（WatermarkOverlay + RemoteImage）— 展示层
6. **保存逻辑**（WorkspaceScreen）— 消耗次数保存原图
7. **管理后台**（ModelsScreen）— 运营 Tab + 用户 VIP 管理
8. **构建安装验证**
