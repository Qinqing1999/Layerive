# App 优化实施计划

> 基于 `docs/superpowers/specs/2026-10-08-app-optimizations.md`

## 任务列表

### Task 1：画布页比例 chip 显示当前值
- 文件：`mobile/src/screens/WorkspaceScreen.tsx` L1391
- 改动：`label` 从 `'比例'` 改为 `genSizeEffective ? genSizeEffective.label : '比例'`

### Task 2：服务器健康检查
- `server/index.mjs`：新增 `/api/health` GET 路由（返回 `{ok:true}`）
- `mobile/src/api.ts`：新增 `pingServer(base?)` 方法
- `mobile/src/App.tsx`：启动 ping，状态传给 LoginScreen
- `mobile/src/screens/LoginScreen.tsx`：接收 `serverReachable` prop，条件渲染警告条+重试

### Task 3：任务历史记录面板
- `server/index.mjs`：`listGeneratingTasks` 加 `all` 参数，支持查所有状态
- 路由 `/api/projects/:id/tasks` 解析 `?all=1` 查询参数
- `mobile/src/api.ts`：新增 `listAllTasks` 方法
- `mobile/src/types.ts`：GenerationTask 补 `finishedAt?`、`inputJson?` 字段
- `mobile/src/screens/workspace/TaskHistorySheet.tsx`：新建卡片列表组件
- `mobile/src/screens/WorkspaceScreen.tsx`：引入 sheet，对话页加入口按钮
