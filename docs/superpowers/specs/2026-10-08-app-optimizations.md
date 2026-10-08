# 像素变换 App 优化 Spec

> 2026-10-08 | Layerive mobile (Expo SDK 53)

## 背景

近期完成画布框选交互重构、生成比例前端化、画廊增强、远程演进线合并。本次针对剩余体验问题做系统优化。

## 现状（勘查后确认的缺口）

### 1. 比例入口两处不同步
- **画布页**：底工具栏 `ToolBtn icon="crop" label="比例"`（WorkspaceScreen.tsx:1391），active 态高亮，弹出 size sheet
- **对话页**：`countRow` 内 `batchPill`（L1494），显示 `genSizeEffective.label + value`，同样弹 size sheet
- 两处都能改 `genSize`，状态共享，但**视觉上独立**：在画布页看不到当前比例值（只有 chip 文字「比例」），切到对话页才能看到具体值；用户在画布页调比例后，要切到对话页确认生效

### 2. 服务器无连通检测
- `api.ts` 已有 `getServerBase/setServerBase` 读写 AsyncStorage
- 所有 fetch 走同一 `base`，无预检；服务不可达时所有请求静默失败
- `GalleryModal` 顶部有 `服务器：{base}` 文字，但仅展示 URL，不 ping
- 登录页无任何连通提示

### 3. 任务历史只看活跃任务，无法回溯已完成/失败任务
- 服务端 `listGeneratingTasks`（server/index.mjs:2237）SQL `WHERE status IN ('generating','queued')`——**已完成/失败/取消的任务不在列表**
- app 端 `api.listGeneratingTasks` 调用该接口
- 现有「历史」Tab 实际是版本树浏览器（`HistoryModal`），展示 `bundle.versions`（图片版本血缘），不展示任务记录
- 任务失败后只能在对话消息流里看到一条 error，无批量回溯入口

## 目标

1. **统一比例入口**：保留画布工具栏 chip 为主入口，对话页 `batchPill` 同步显示当前值（已是该行为，无需改），关键修复：**画布页 chip 也显示当前比例值**（像对话页一样）
2. **服务器健康检查**：app 启动时 ping 一次，失败时登录页显示醒目警告条 + 重试按钮
3. **任务历史增强**：服务端 `listGeneratingTasks` 改为可选返回所有状态（新增 `?all=1` 参数），app 新增「任务记录」面板（在对话页顶部 sheet 入口或独立 sheet），列出最近 30 天所有任务（含已完成/失败），支持重跑/取消/查看对话位置

## 约束

- Expo SDK 53，TypeScript strict
- 不引入新 UI 库（复用 `ModalSheet`/`Icon`/主题 token）
- 服务端改动最小化（只加查询参数，不动表结构）
- 任务记录 UI 与现有 `HistoryModal` 风格一致（卡片式列表 + RefreshControl）

## 技术方案

### 任务 1：画布页比例 chip 显示当前值

**现状**：L1391 `<ToolBtn icon="crop" label="比例" active={Boolean(genSizeEffective)} />` —— `label` 固定为「比例」，不显示 `genSizeEffective` 的值

**目标**：当 `genSizeEffective` 存在时，`label` 改为 `${genSizeEffective.label}`（如「原比例」「16:9」），保持简洁；active 态不变

**改动**：
- `mobile/src/screens/WorkspaceScreen.tsx` L1391：`label` 从 `'比例'` 改为 `genSizeEffective ? genSizeEffective.label : '比例'`

### 任务 2：服务器健康检查

**现状**：
- `api.ts` 无 `pingServer`
- `App.tsx` 启动时直接走 `loadModels`，失败显示 error 但不区分「服务器不可达」与「业务错误」
- `LoginScreen.tsx` 无连通状态提示

**目标**：
- `api.ts` 新增 `pingServer(base?: string): Promise<boolean>`：fetch `{base}/api/health` 5 秒超时，2xx 返回 true，否则 false
- `App.tsx` 启动时调用 `pingServer`，结果存 `serverReachable` state，传给 `LoginScreen`
- `LoginScreen.tsx` 接收 `serverReachable: boolean | null` prop：null=检测中，false=显示黄色警告条「服务器不可达，请检查地址」+ 重试按钮，true=不显示
- 服务端确认 `/api/health` 路由存在（若无则加一个轻量路由返回 `{ok:true}`）

**改动文件**：
- `mobile/src/api.ts`：新增 `pingServer`
- `mobile/src/App.tsx`：启动 ping + state
- `mobile/src/screens/LoginScreen.tsx`：警告条 UI
- `server/index.mjs`：确认或新增 `/api/health` 路由

### 任务 3：任务历史记录面板

**现状**：
- 服务端 `listGeneratingTasks(projectId)` 只返回活跃任务
- app `api.listGeneratingTasks` 调用该接口
- 无独立 UI 查看历史任务

**目标**：
- 服务端 `listGeneratingTasks` 支持可选参数 `all`：`true` 时返回所有状态任务（最近 30 天，按 `created_at DESC` 限制 100 条）
- 路由 `/api/projects/:id/tasks` 支持 `?all=1` 查询参数
- app `api.listAllTasks(projectId)` 新增方法调用 `?all=1`
- app 新增 `TaskHistorySheet` 组件（ModalSheet 形式）：卡片列表，每项显示「操作类型 chip + 状态 chip + 时间 + 错误信息（失败时）」，操作：重跑（调 `api.retryTask` 如有，否则提示「暂不支持」）、取消（仅活跃任务）、点击跳转对话（暂不实现，先展示）
- 入口：对话页顶部输入栏新增「任务记录」按钮（icon `history`），点击打开 sheet

**改动文件**：
- `server/index.mjs`：`listGeneratingTasks` 加 `all` 参数；路由解析 query
- `mobile/src/api.ts`：新增 `listAllTasks`
- `mobile/src/types.ts`：`GenerationTask` 补充 `finishedAt` 等字段（如需）
- `mobile/src/screens/workspace/TaskHistorySheet.tsx`：新建组件
- `mobile/src/screens/WorkspaceScreen.tsx`：引入 sheet，对话页加入口按钮

## 优先级

任务 1（最小改动，立即可做）→ 任务 2（中等）→ 任务 3（最大）

## 不做的

- 不重构 `HistoryModal`（版本树浏览器保持原样）
- 不引入新依赖
- 不改服务端表结构
- 任务重跑若服务端无对应接口，先做 UI 占位
