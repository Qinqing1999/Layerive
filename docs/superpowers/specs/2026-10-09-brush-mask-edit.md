# 笔刷蒙版局部修改 + 涂抹消除 Spec

> 2026-10-09 | 主题①（见 `docs/plans/2026-10-09-feature-gap-roadmap.md`）

## 背景

现有局部修改仅支持矩形框选：从画布拖出 `rect`（百分比），无参考图时整图交给模型按 rect 约束重生成（不做像素级回填）；有参考图时走「视觉定位 → 裁剪拼贴 → 生成 → `preserveOutsideRegion` 框外保留」流水线。竞品（Canva Magic Edit / 即梦局部重绘 / InvokeAI）均为笔刷涂抹蒙版，可贴合任意轮廓。本 spec 将矩形选区升级为可选的笔刷蒙版，并提供「消除」快捷入口（对标 Magic Eraser / 局部消除）。

## 目标

1. 局部修改面板支持「框选 / 涂抹」两种圈定方式；涂抹模式下用画笔在图片上涂白蒙版，可调粗细、橡皮擦除、一键清空。
2. 提交时前端把蒙版导出为原图分辨率的灰度 PNG（白=修改区，透明=保留区），随请求上传。
3. 服务端从蒙版自动推导包围盒 rect（复用现有视觉规划与提示词约束），生成后按蒙版逐像素羽化回填：蒙版内用生成结果，蒙版外严格保留原图像素。
4. 新增「消除」入口：预填默认指令「移除涂选区域内的物体，并自然补全背景」，走同一条蒙版流水线；蒙版 + 无指令 + 无参考图时服务端也默认使用该指令。

## 非目标

- 移动端涂抹 UI（RN 端画布成本高，本次仅同步 `mobile/src/api.ts` / `types.ts` 的可选字段，UI 后续跟进）。
- 批量局部修改的蒙版 UI（服务端 `/local-edit-batch` 同步支持 `mask` 入参，前端批量面板暂仍以矩形选区为准）。
- 参考图 + 蒙版的最终回填：参考图路径仍按 rect 羽化回填（蒙版只用于推导 rect 与提示词约束），避免蒙版裁掉拼贴主体的边缘。

## 服务端设计

### `server/local-edit.mjs` 新增

- `maskBytes(mask)`：校验 data URL（仅 PNG、base64 ≤10MB），返回 Buffer。仿照 `referenceBytes`。
- `maskRegion(bytes, width, height)`：将蒙版 resize 到原图尺寸（不一致时），返回灰度 raw + alpha 包围盒（像素 + 百分比 rect）。alpha 阈值 >16（6%）计为涂选。
- `preserveOutsideRegion(source, output, rect, mask = null)`：扩展第 4 参。传 mask 时权重取蒙版 alpha（先 blur 羽化，sigma = `clamp(min边×1%, 1, 12)`），仍只在 rect 包围盒内逐像素混合、每 64 行 yield；不传 mask 时行为与现状完全一致。

### `server/index.mjs` 修改

- `editImageRegion`：接受可选 `input.mask`。有蒙版时用 `maskRegion` 推导 rect（四周外扩 1.5% 并钳制到图内，再 `validateRect`），指令为空且无参考图时默认消除指令；无蒙版时行为不变。蒙版原始 PNG 以 `local_mask` 素材类型落盘并挂到版本素材。
- `prepareLocalEdit`：无参考图 + 蒙版路径解码原图并返回 `source`，使生成结果能按蒙版回填（现有纯文字 rect 路径保持整图生成、不回填，不受影响）；提示词追加「仅涂选蒙版内的结果会被采用，其余区域保留原图像素」。
- `runGenerationTask` / `runLocalEditBatchTask`：回填时传 `reference ? null : mask` 给 `preserveOutsideRegion`。
- `startLocalEditBatch`：同步接受 `input.mask`，推导 rect 后传入每条指令的流水线。
- 任务 `input_json.localEdit` 只存 `hasMask: true`，不把蒙版字节写进 JSON；蒙版 buffer 经内存上下文传递。
- `version_inputs` 关联查询的 `source_type IN (...)` 加入 `local_mask`。

### API 契约

`POST /api/projects/:id/local-edit` 与 `/local-edit-batch` 请求体新增可选字段：

```json
{ "mask": "data:image/png;base64,...", "rect": null, "instruction": "" }
```

- `mask` 与 `rect` 二选一：有 `mask` 时 rect 由蒙版推导，传入的 `rect` 被忽略。
- `mask` 存在且 `instruction`、`reference` 均为空 → 服务端使用消除默认指令。

## Web 端设计（`src/WorkspaceView.tsx` + `api.ts` + `styles.css`）

- `api.localEdit` / `api.localEditBatch` 入参新增 `mask?: string`。
- 局部修改面板头部加「框选 / 涂抹」切换：
  - 框选：现有拖拽 rect 流程不变。
  - 涂抹：在 `canvas-image-wrap` 内叠一个 `<canvas>`（`local-mask-canvas`），内部分辨率 = 原图自然尺寸，CSS 铺满图片区域；画笔写白色圆头线条（CSS 半透明显示），橡皮 `destination-out`，粗细三档（约 1.5% / 3% / 6% 图宽）。
  - 涂抹时画布 Pointer 事件改走绘制分支（复用 stage 现有三个 handler，以 `localMaskPainting` ref 区分），坐标沿用 `canvasPointerRatio` 的图片百分比 × 自然尺寸。
- 提交：`canvas.toDataURL('image/png')` 作为 `mask` 上传；未涂选时禁用提交按钮。消除入口（画布工具栏新按钮「消除」）= 打开局部修改 + 涂抹模式 + 预填消除指令。
- 切换模式 / 退出时清理蒙版状态与画布。

## 测试（`server/local-edit.test.mjs` 追加）

1. `maskBytes` 拒绝非 PNG / 超限 / 非法 base64。
2. `maskRegion`：涂选两块区域时包围盒正确、百分比换算正确、空白蒙版报错。
3. `preserveOutsideRegion(..., mask)`：蒙版外像素逐位等于原图、蒙版内取生成结果、包围盒外严格不变；蒙版 resize 到原图尺寸后行为一致。
4. API 级：mock 模型 + 蒙版请求 → 落盘 `local_mask`、版本素材含蒙版、无指令时采用消除默认文案（沿用现有 loopback stub 模式）。

## 验证

`npm run lint`、`npm run test:local-edit`、`npm test` 全量。

## 实现记录（2026-10-09 完成服务端 + Web 端）

- 蒙版画布内部分辨率取长边 1024 并保持原图比例（低于原图分辨率更轻量，服务端 `maskRegion` 会自动 resize 回原图尺寸），CSS `opacity: .5` 仅降低显示透明度，导出 PNG 的 alpha 仍为实心——服务端只读取 alpha 通道，笔迹颜色不限。
- 画笔羽化用 `ctx.filter = blur(0–8px)` 在绘制时柔化笔画边缘（橡皮不做 filter）；服务端回填时再按 `min边×2.5%` clamp 到 1–12px 做 alpha 模糊，双层羽化叠加。
- 涂抹画布使用独立 Pointer handler（`onMaskPointerDown/Move/End`，指针捕获 + `stopPropagation`），不复用 stage 级框选 handler；`onCanvasSelectionStart` 在涂抹模式下直接返回兜底。
- 笔刷粗细为 4–160px 连续滑杆（非三档），提交校验：蒙版模式无参考图时允许空指令（走消除默认），框选模式维持原校验。
- 「消除」入口放在画布工具栏（局部修改旁），点击 = 进入涂抹模式 + 预填 `ERASE_INSTRUCTION`（与服务端默认指令文案一致）。
- 批量局部修改同样支持蒙版：`submitLocalBatch` 复用同一画布导出，所有指令共用同一蒙版（服务端 `startLocalEditBatch` 已同步）。
- 移动端 `mobile/src/api.ts` 的 `localEdit` 入参为 `Record<string, unknown>`，无需类型同步；RN 涂抹 UI 仍为后续项。
