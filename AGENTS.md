# Layerive：给后续 AI 的项目说明

> **维护契约（必须遵守）**：只要改动了项目的功能、架构、数据结构、API、模型适配、运行方式、文件位置或重要约束，必须在同一次改动中更新本文件。先核对相关实现，再更新受影响章节；不要仅凭 README 推断。纯格式调整且不改变行为时可不更新。  
> 更新时请同步修改本文的“最后核对”日期和相应内容；若现有描述不再可信，优先修正文档而不是保留过期说明。

**最后核对**：2026-10-08
**项目定位**：Layerive（移动端产品名「像素变换」）是一个仅本地运行的、以“项目 + 图片版本树”为中心的 AI 图片创作工作台。它将文生图、基于图片的编辑、文字编辑、局部编辑、扩图、去水印、对话记录和项目备份统一保存到本机；同一套后端同时服务浏览器版、Electron 桌面版和 Expo React Native 移动端。

## 1. 运行与边界

- 技术栈：React 19 + TypeScript + Vite 前端；Node.js 原生 `http` 服务端；`node:sqlite` / SQLite 数据库；Sharp 负责局部替换的图片解码、裁剪与合成；Electron 将同一套本地产品打包为桌面应用；`mobile/` 为 Expo SDK 53 + React Native 0.79 的移动端 App（「像素变换」），复用同一后端 API。
- Node 版本要求：`>= 22.13.0`（依赖内置 `node:sqlite`）。
- 开发：`npm run dev` 同时启动 Vite `127.0.0.1:5173` 和后端 `127.0.0.1:8788`；Vite 将 `/api`、`/files`、`/gallery-files` 代理至后端；后端新增的顶层路径前缀必须同步加进 `vite.config.ts` 的 proxy，否则开发模式下会被 SPA fallback 回 `index.html`。
- 生产：先 `npm run build`，再 `npm start`。后端从 `dist/` 托管前端，同时提供 API 和本地图片文件。
- 移动端开发：`cd mobile && npm start` 用 Expo 启动；真机访问电脑后端时，电脑端以 `PIXELFLOW_API_HOST=0.0.0.0 npm start`（或 `npm run dev`）开启局域网监听，手机登录页填写 `http://<电脑局域网IP>:8788` 并用 admin / admin 登录；所有 `/api`、`/files`、`/gallery-files` 请求携带 `Authorization: Bearer <token>`，`Image` 组件用 `source={{ uri, headers }}` 鉴权加载。移动端为纯客户端：**不能在 App 内配置模型提供商，只能浏览、选择已有模型作为使用者**。
- 移动端 Android 构建：`mobile/android/` 由 `npx expo prebuild --platform android --no-install` 生成后含手工调整，重新 prebuild 会丢失，改动需保留——`build.gradle` 将腾讯 Maven 镜像置顶（本机直连 google/mavenCentral/阿里云均不稳定），`gradle.properties` 加大依赖下载超时至 180s，`AndroidManifest.xml` 开启 `android:usesCleartextTraffic="true"`（release 包默认禁明文 HTTP，不开启则所有 `http://` 请求报 Network request failed；该设置同时经 `app.json` 的 `expo-build-properties` 插件持久化）。构建需 NDK 27.1.12297006；本机 sdkmanager 不可用时从腾讯镜像下载 `android-ndk-r27b-darwin.zip` 解压平铺到 `~/Library/Android/sdk/ndk/27.1.12297006/`。构建模拟器 / 真机 APK：`cd mobile/android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`（Apple Silicon 模拟器为 arm64-v8a，装 x86_64 包会 INSTALL_FAILED_NO_MATCHING_ABIS）。模拟器联调后端：`adb reverse tcp:8788 tcp:8788` 把模拟器内 `127.0.0.1:8788` 转发到宿主机（Host 头仍为本机名，可通过服务端本机访问守卫，模拟器重启后需重新执行）。真机走局域网 IP + `PIXELFLOW_API_HOST=0.0.0.0` 时注意：登录请求本身无 token，Host 非本机名会被 `assertLocalUiRequest()` 拒绝（403），现依赖真机浏览器场景外的放宽尚不存在，勿擅自放宽守卫。
- 桌面开发：`npm run desktop:dev` 先构建相同的前端，再由 Electron 启动本地服务和原生窗口；`npm run desktop:dist` 构建安装包。Electron 专属代码只在 `electron/main.cjs`，不得复制 `src/`、`server/` 或 `public/` 到另一个桌面项目。
- CI 发布：推送 `v*` tag 触发 `.github/workflows/build.yml`，矩阵包含 Windows x64、macOS arm64 / x64、Ubuntu x64；各任务先在运行器架构执行 `npm ci` → `npm run build` → `npm test`，再执行 `npm ci --cpu=<arch>` → `electron-builder --<arch> --publish never`，按目标架构安装 Sharp 原生依赖。独立 release 任务发布非草稿 GitHub Release，三端均未签名。桌面服务位于资源目录 `app/server`，所需 Sharp、`@img`、`detect-libc`、`semver` 由 `extraResources` 放在同级 `app/node_modules`；新增或升级图像依赖时必须核对该运行时依赖清单，不能只依赖 `app.asar` 内的模块。
- 检查：`npm run lint`（TypeScript no-emit）；`npm run build`（先类型检查再构建）；`npm run test` 使用 Node 内置测试和本地模拟模型运行全部服务端测试（也可单独运行 `npm run test:local-edit` / `npm run test:generate` / `npm run test:request-guard`）：`test:local-edit` 验证图片处理、日日新输入图规范化、三种视觉协议、局部编辑任务及取消；`test:generate` 验证批量生成的并发上限、限流退避重试、多图意图自动判断与提示词拆分、部分成功时提示词与图片对齐、文字编辑输出继承修改后的识别缓存（含多候选和全部删除）、变量批量处理与批量文生图的逐张返回/失败续跑/取消保留、日日新编辑请求及多图版本 ZIP 下载；`project-data.test.mjs` 验证导入路径穿越防护、草稿图片 ID 重映射、缺文件素材与文字缓存兼容及默认模型回退；`backup-restore.test.mjs` 验证恢复前拒绝损坏、路径穿越和模式不兼容数据库，恢复后的项目目录重建及安全备份；`restore-concurrency.test.mjs` 验证恢复会取消并等待在途生成，再由桌面宿主重启；`model-connection.test.mjs` 验证模型端点错误不会被标记为连接成功；`test:request-guard` 验证本机访问限制与会话认证（未带有效会话的同源调用返回 401、跨站调用返回 403、响应不带 CORS 授权、LAN Host + 有效会话 token 放行供移动端使用、Vite 代理与非浏览器调用仍可用）；`queue-auth.test.mjs` 验证管理后台守卫与任务队列（非管理员访问 `/api/admin/*`、模型写入与备份返回 403；最后一个管理员不可降级或删除；改角色 / 改密 / 删除用户撤销其会话；队列并发设置钳制 1–8；Key 池逐任务轮询、429 退避自动换 Key、掩码保存保留原 Key；并发 1 时任务全局串行、排队中取消不触达供应商，SIGKILL 重启后 queued / generating 任务统一标记失败且已完成任务保留）。除 `request-guard` 中的放行断言外，其余测试均先经 `server/test-auth.mjs` 的 `login()` 获取 token 并在后续请求带 `Authorization` 头。测试仅使用生成的图片和 `work/*-test-*` 内的独立数据/配置，不读取真实用户数据或调用真实模型；测试文件不打入桌面服务资源。
- Windows 双击启动入口：`Layerive.bat`。该文件使用固定的工作目录，移动仓库后需要同步更新。
- 项目不依赖云端数据库或第三方后端。账号存于 `DATA_ROOT/users.json`（无注册入口，首次启动播种内置 admin / admin 管理员），角色分 `admin`（可用模型配置页与「用户与队列」管理后台）与 `user`（仅项目内使用）；API 与文件访问需通过 `/api/auth/login` 换取 Bearer 会话 token（响应含 `username` / `role`）。会话持久化在 `DATA_ROOT/sessions.json`，服务重启后仍有效；改密、改角色、删除用户会立即撤销该用户的全部会话。队列并发等运行设置存于 `DATA_ROOT/settings.json`。模型请求会发送给用户配置的模型服务；其他项目数据留在本机。
- 许可：项目以 LGPL-3.0-or-later 发布，根目录 `LICENSE` 为 GNU LGPL v3.0 全文（参考 Wei-Shaw/sub2api 的做法）；`package.json` 的 `license` 字段与之保持一致。对外分发或商用前应遵守该许可条款。

## 2. 功能清单（改动时必须同步维护）

这是当前已实现的功能基线。新增、移除、合并或显著改变任一功能时，必须更新本节，以及受影响的流程、API 和数据模型说明。

### 项目与数据管理

- 项目库：卡片 / 列表切换、搜索、最近更新时间排序、收藏、创建、重命名、复制与软删除项目。重命名有两个入口：项目库卡片 / 列表行的铅笔按钮弹出重命名对话框，工作台顶栏的项目名输入框失焦即保存（输入框右侧的铅笔图标提示其可编辑）。两者都只改名称，不影响图片、对话与版本。
- 项目持久化：保存项目描述、封面、当前图片/版本、默认图片模型和工作台草稿。工作台草稿每次变更先写入 `localStorage` 的 `layerive-draft:<projectId>` 恢复副本，服务端保存成功后删除；网络失败时阻止内部离开工作台，刷新 / 关窗后可从该副本恢复。
- 素材上传：无论项目是否已有图片，均可继续上传 PNG、JPEG、WebP（单文件最大 10MB）；服务端会解析并保存原图宽高。新上传图片会立即成为当前画布和下一次编辑的输入素材，输出比例优先跟随原图比例（自动取当前模型支持尺寸中最接近的一档）；从历史或候选图选用输入图时同样生效。也支持在工作台任意位置（含画布）直接 Ctrl+V 粘贴剪贴板图片，走同一上传流程；文本框内的粘贴始终以文本优先，上传进行中会忽略重复粘贴。
- 项目导出 / 导入：导出单项目 ZIP，导入时生成新的项目及关联 ID。
- 完整备份 / 恢复：备份 SQLite、项目图片、画廊配图和模型配置；导出与导入统一限制 ZIP 至 10,000 个条目、单条 512MB、总解压后 2GB。恢复会进入维护状态，取消并等待在途任务完成，再在隔离目录校验 ZIP 路径、数据库完整性、外键、必要表及字段；随后 checkpoint 并创建含同样内容的安全备份，最后替换数据并重启服务。服务启动时会为全部未删除项目重建标准素材目录，因此空项目也可在恢复后继续上传和生成。**清理策略**：`cleanupOrphanFiles` 定时跳过活跃项目（`generating/queued`）的文件，temp/ 子目录仅清理 mtime 超过 2 小时的旧临时文件。

### 图片创作与编辑

- 文生图：以提示词生成图片；可配置尺寸、1–4 张数量、质量、PNG/JPEG/WebP 输出和透明背景（格式 / 提供商能力受限）。多张结果作为同一版本的候选图保存和展示，不再提供「每张不同」开关：数量大于 1 且提示词非空时，工作台所选视觉模型自动判断用户是要同提示词的多个普通候选，还是明确要求分别生成不同内容；仅后一种情况拆成互不相同的子提示词逐张生成，消息中按序记录各图提示词。
- 图生图 / 提示词改图：选择上传图或历史图片作为输入，以文本继续生成或修改。
- 批量模式（右侧面板顶部有「对话 / 批量」两个模式标签，点「批量」默认进入批量文生图子模式；画布右上角的「批量处理」浮动按钮会跳到该面板并选中批量改图，原独立弹窗已移除）：面板内有「批量改图 / 批量文生图」两个子模式，共用「变量模板 / 提示词列表」两种录入方式，均为 2–50 张、逐张增量写入同一版本。开始局部修改、提取素材、编辑文字、扩图、变清晰或去水印等单图画布操作时，会自动切回对话模式。
  - 批量改图：始终以画布当前展示的图片作为统一参考图，在单个 `contenteditable` 模板编辑区内把光标放到目标位置并点击“插入变量”；前端写入内部 `{{变量N}}` 标记，并在同一文字流内显示为不可编辑、可整体删除的标签。一个模板最多插入 10 个变量，同名标签重复出现时复用同一列。设置 2–50 张数量后，变量值区域按“图片行 × 变量列”同步生成输入矩阵（缩小再放大数量会恢复此前已填内容），所有单元格必须填写，允许不同图片或不同变量复用相同值。每个子项始终从同一参考图出发，服务端同时替换该行全部变量，并在完整提示词外追加“仅替换变量、保持画风/构图/身体/姿势/背景/光影/色彩和其他区域一致”的批次约束，按图片行顺序串行调用图片编辑模型。提示词列表页可导入 TXT 或直接粘贴，每行一条完整提示词（可编辑文本框回显、行数即生成数量，2–50 条，单条上限 1000 字符），每行不再叠加变量批次约束，直接以该行提示词对画布图片逐张改图。
  - 批量文生图：无输入图的纯提示词批量（要求模型具备文生图能力），同样支持变量模板与提示词列表录入；提供「统一风格提示词」（默认带入项目风格提示词、可单独修改，≤2000 字符），服务端把它追加到每条最终提示词末尾，不叠加参考图批次约束。
  - 共同行为：每完成一张立即写入同一个版本并由轮询接口返回，画布下方实时展示缩略图、已完成/失败/剩余数量和按已处理项平均耗时计算的预估剩余时间；单项失败继续下一项，支持取消且保留已完成图片。
- 项目风格提示词：只自动叠加到无输入图的文生图请求。
- 图片改字：视觉模型识别图片文字为分段内容；用户可修改、删除或框选区域手动新增文字，再由视觉模型规划图片编辑提示词。点击“提交并改图”后立即关闭编辑弹窗并回到项目对话，从视觉规划阶段开始展示等待状态；创建失败时自动恢复弹窗和编辑内容。任务成功后，每张输出图都会按本次替换、删除和新增结果保存当前文字快照（包括空快照），用同一视觉模型配置继续改字时直接读取，不再重复识别。
- 局部编辑：支持两种圈选方式——「拖拽框选」可从画布图片内外起拖并越界框选，最终取图片内有效百分比选区；「笔刷涂抹」在图片上叠加蒙版画布（长边 1024、保持原图比例），画笔涂抹 / 橡皮修整 / 笔刷大小与边缘羽化（0–8px，`ctx.filter = blur()` 柔化笔画）/ 清除，导出静态 PNG data URL（≤10MB）随请求发送 `mask` 字段，服务端按蒙版 alpha 包围盒（外扩 1.5% 上下文）推导编辑区域，蒙版外像素严格保留原图、蒙版内按 alpha 权重羽化回填。两种方式互斥，切换时丢弃另一方式的选区。选区浮窗支持文字要求，或上传 / Ctrl+V 粘贴参考图（静态 PNG/JPEG/WebP，最大 10MB）。有参考图时文字可留空；涂抹模式下不附参考图且文字留空时按「移除涂选内容并自然补全背景」处理（按钮显示「涂抹消除」）。有参考图时视觉模型同时理解原图、选区与参考图，推断替换意图并返回两图主体坐标；后台裁剪参考主体、等比缩放并粘贴至目标位置，图片模型再按场景融合轮廓、背景、光影、透视和连接处。参考图模式最终仅回填选区内生成结果，边界向内羽化，框外保留原图解码后的像素，并以原图尺寸保存 PNG；纯文字方式继续使用原有模型输出。定位失败或目标超出选区时停止，不盲目拼贴。视觉规划、合成、生成、框外保留均在可取消任务中运行。选区浮窗的操作行提供「批量修改」入口：点击后在浮窗右侧展开批量面板，每行一条指令（2–50 条、单条 ≤1000 字符，可粘贴多行），复用 `/local-edit-batch`（任务 `operation_type` 仍为 `batch_edit`、版本 `operation_type` 为 `local_edit`）逐张运行同一条局部修改流水线并把全部输出追加到同一版本，支持框选 rect 与笔刷蒙版两种输入且所有指令共用同一蒙版；若浮窗已附参考图，所有指令共用该参考图（此时强制 PNG 输出）。进度复用画布下方的批量进度面板（`localEdit` 标记区分文案），支持取消并保留已完成图片。
- 图片变清晰：对当前图片调用图片模型的改图能力，提升细节和清晰度，同时约束模型保持原图的主体、文字、构图、比例、颜色和风格不变。
- 扩图：面板先按原图比例预选「原比例」目标（向四周自然补全），并列出主流比例（1:1、16:9、9:16、4:3、3:4、3:2、2:3，经 `mainstreamSizeOptions()` 映射到当前模型支持尺寸、按目标尺寸去重）与全部支持尺寸两组按钮；选定目标尺寸后以原图为核心自然补全新增画布区域。
- 去水印：视觉模型先判断 / 定位水印；确认存在后调用图片编辑模型修复遮挡区域。
- 提取素材：用户可在整个中间画布从图片内外起拖，且拖拽越过图片或画布边缘不会取消；最终选区取与图片相交的有效区域，前端用 canvas 截取该区域作为截图随请求上传（上限 2048px、最小边不足 256px 自动放大、宽高比超 2:1 时用边缘像素补边、超大自动转 JPEG，以满足模型平台 256–4096px 且比例 ≤2:1 的输入限制）；服务端保存截图为 `extract` 素材后，视觉模型识别用户想提取的主体（忽略圈入的边缘干扰和补边痕迹，可附加文字提示），生成“仅保留该主体、内容与原图一致”的改图提示词，再由图片编辑模型输出独立素材图。
- 提示词画廊：入口在工作台顶栏（模型选择旁带中文文案的「提示词画廊」胶囊按钮，窄屏自动收起副标题），对话与批量模式都可用。按分类浏览内置模板：对话模式把完整提示词填入对话框、风格提示词设为项目风格；批量模式把完整提示词追加为批量提示词列表的一行（自动切到列表页，满 50 条时拒绝追加），风格提示词在批量文生图时写入「统一风格提示词」、其余场景写项目风格。支持手动添加 / 编辑 / 删除“我的收藏”条目（可上传配图，纯文本亦可），上传图片后可调用视觉模型提炼完整提示词与风格描述；在工作台对画布主图、候选条、消息画廊中的图片点击右键，可一键收藏到画廊（视觉模型自动提炼提示词，失败时仅收图、提示词留空）。用户画廊数据存于 SQLite `gallery_entries` 表与 `data/gallery/` 目录，随完整备份 / 恢复。
- 暗色模式：`src/theme.tsx` 的 ThemeProvider 以 `data-theme` 属性切换 `html` 主题，偏好存于 localStorage（`layerive-theme`），暗色样式统一写在 `styles.css` 末尾的 `html[data-theme='dark']` 覆盖块；首页、工作台、模型配置三处顶栏均有切换按钮。

### 版本、对话与任务

- 版本树：上传图首次编辑时补建起始版本；每次成功生成 / 编辑均产生可分支的版本节点与输出图片。
- 历史操作：选择历史版本查看、从历史版本继续创作、查看可缩放 / 可平移的完整版本树。历史列表中的多图版本以候选缩略图拼图、数量角标和“多图 · N 张”标签区分；可从版本卡片或当前画布工具栏把该版本全部输出图下载为 ZIP，包内按 `V<版本号>-<两位序号>.<扩展名>` 命名。
- 对比：提供并排和滑块式前后图片对比。
- 版本删除：软删除版本；有子版本时需确认强制删除，后代会连接至被删节点的父节点；正在增量写入的批量版本必须先取消或等待结束，不能删除。
- 对话记录：保存用户提示词、模型名、参数、生成结果、系统事件、失败与取消信息。
- 异步任务：生成请求立即返回任务 ID（`status` 固定为 `queued`，有空位时在响应返回前已被同步调度为 `generating`），前端轮询任务状态（`queued` / `generating` 均视为进行中）；支持取消，服务重启会将未完成任务标记为失败。批量任务（批量改图 / 批量文生图 / 批量局部修改）复用一个 `generation_tasks` 主任务并增量发布图片；启动恢复会按任务关联处理所有仍为 `generating` / `queued` 的版本（包含 `local_edit`）：已有输出保留为 `partial`，空版本自动软删除。复制或导入项目时，未完成任务会转为失败，关联版本按已有输出转换为 `partial` 或删除，不能留下没有执行器的生成任务。

### 模型管理

- 图片模型：新增、编辑、删除、连接测试、设置默认模型，并按能力控制工作台可用操作。所有模型写入操作（POST / PATCH / DELETE）仅 admin 角色可调用；普通用户只能浏览与选择模型。图片模型可配置 `apiKeys` 多 Key 池（与单 `apiKey` 字段并存）：服务端按任务在池内轮询取用，单个请求遇 429 / 限流退避重试时自动换下一把 Key；列表接口中两个字段全部掩码显示，保存掩码值不会覆盖已存 Key。
- 视觉识别模型：新增、编辑、删除、连接测试、设置默认识别模型；可选择 Anthropic Messages、Chat Completions 或 Responses API 格式（新建默认 Chat Completions），供改字、局部编辑、去水印、提取素材规划使用。工作台不再提供视觉模型选择，统一使用管理员设置的默认识别模型；显式传入的 `visionModelId` 仍会被严格校验。API Key 输入框可切换显示 / 隐藏。
- 已适配图像提供商：OpenAI 兼容、SenseNova、Gemini、Grok、Agnes；另有仅服务端兼容的本地 `mock` 演示路径。
- 已适配视觉请求：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses，并保留 SenseNova 和 Dots（`askdiandian.com`）旧配置兼容。

### 用户、角色与管理后台

- 账号与角色：管理员在管理后台创建同事账号（用户名不能为空且不含空格 / 路径分隔符、密码至少 4 位、角色 admin / user、不允许重名）；系统至少保留一个管理员，最后一个管理员不可降级或删除（返回 400）；改密、改角色、删除用户都会立即撤销该用户的全部会话（管理员自己改自己角色不撤销）。
- 管理后台入口：Web 端模型配置页顶部「模型 / 用户与队列」两个标签，后者仅 admin 角色可见（非管理员登录时整个模型管理入口隐藏）；移动端为纯使用者客户端，不提供任何管理界面。
- 「用户与队列」面板：用户列表支持角色即改即存、改密与删除（删除有确认提示，删除 / 改密后该用户需重新登录）；新建用户表单；任务队列卡片可设置全局并发 1–8（默认 2，越界值钳制，非数字返回 400）。
- 任务队列：所有生成 / 编辑 / 批量任务提交后进入全局 FIFO 队列，按并发上限逐个调度。有空位时任务在提交请求返回前被同步调度为 `generating`，否则保持 `queued` 并在任务轮询与移动端界面中可见（含「排队中」文案）；取消排队中的任务立即生效且不触达模型供应商（预建的批量空版本会被隐藏或软删除）；服务重启时 `queued` 与 `generating` 任务统一标记失败。

### 移动端 App（像素变换，`mobile/`）

Expo React Native 客户端，仅作为**使用者**接入同一后端：不能新增 / 编辑 / 删除模型或提供商，只能从已有模型列表中选择。

- 认证与连接：登录页（用户名 / 密码）可展开「连接其他服务器」填写后端地址（默认 `http://<电脑IP>:8788`），地址持久化于 AsyncStorage（`pixelforge-server-base`）；token 与主题同样持久化。图片经 `imageSource(url)` 以 `{ uri, headers }` 携带 Bearer 加载，下载 / 分享经 `downloadToCache()` 带 header 拉到缓存目录。**断网检测**：`api.ts` 维护 `onlineState` 全局状态，网络请求失败时自动标记离线、恢复成功时标记在线；`App.tsx` 注册回调并在顶部渲染 OfflineBanner（红色横幅），提示用户网络连接已断开。
- 项目库：列表、创建、重命名、收藏、复制、软删除、导出项目 ZIP（DocumentPicker 导入，>500MB 拒绝）、完整备份下载与系统分享；顶栏切换暗色模式。
- 工作台：对话生成 / 图生图、候选图与消息画廊点击切换画布、上传与粘贴式选图、异步任务轮询（含 `stage` 阶段文案）。专项操作覆盖改字（识别分段可编辑 / 手动新增）、局部编辑（`RectSelector` 百分比框选 + 指令 + 可选参考图）、扩图（`mobile/src/sizes.ts` 镜像 Web 尺寸目录：原比例优先置顶高亮，再列主流比例，按当前模型 provider 映射支持尺寸）、变清晰、去水印、提取素材（expo-image-manipulator 裁剪截图替代 Web canvas，含最小边放大 / 最大边缩小 / JPEG 压缩）。
- 批量：批量改图 / 批量文生图两个子模式，支持变量模板（≤10 变量）与提示词列表（2–50 条）录入，轮询 `/batch-edits/:taskId` 展示逐张缩略图、失败数、ETA 与取消。
- 版本与对比：历史版本列表（从历史继续创作即设 `parentVersionId`）、多图版本 ZIP 下载、版本删除（有子版本时确认 force）、父子版本滑块对比；对比模态框在有任一图为空时显示空状态提示。
- 提示词画廊：分类浏览、点击填入提示词、收藏当前画布图片（走 `/api/gallery/from-image` 自动提炼）。
- 暗色模式：`mobile/src/theme.tsx` 的 ThemeProvider + `makeStyles(colors)` 工厂（避免模块级 StyleSheet 缓存旧色值），偏好存 AsyncStorage（`pixelforge-theme-mode`）。
- 移动端改动要求：服务端能力变更时同步 `mobile/src/api.ts` 与 `mobile/src/types.ts`；新界面颜色一律走 `useTheme()` 色板，不得写死色值。
- **稳定性增强**：
  - `WorkspaceScreen` 画布支持 PanResponder 与触摸处理器共存：框选模式下 PanResponder 只响应单指（`touches.length < 2`），双指自由传递给双指缩放；Canvas 同时挂载两者，`handleCanvasTouch*` 内部检查 `!selectMode` 避免单指冲突。
  - Undo/redo 栈每项记录 `{ imageId, versionId, url }`；撤销/重做时同时更新 `currentImageId` 和 `currentVersionId` 并异步 PATCH 到服务端。
  - 提交生成使用 `submittingRef` 防止连点重复提交（重复时直接 return）。
  - 长任务/重试时 controller 登记到 `runningTasks` Map，`restore` abort 能中止进行中的重试。
  - `EditTextModal` 识别失败时显示错误信息和重试按钮（`retryRecognize`）；段落支持上/下移动排序（`moveSegment`）。
  - `useAsCurrent` / `useVersion` 在 PATCH 服务端失败时回滚乐观更新并显示错误 Toast。
  - `HomeScreen` 「最近」tab 过滤近 7 天内更新的项目并排序。
  - `App.tsx` 内置 `ErrorBoundary` 类组件，崩溃时显示错误信息 + 「点击重试」按钮（调用 `reset` 重新挂载子树）。
  - `api.ts` 请求封装支持幂等 GET 最多 2 次指数退避重试（500ms / 1500ms），429 和网络错误均触发重试；同时维护全局并发上限（`MAX_CONCURRENCY = 6`），超出时排队，避免连点/批量操作压垮本地服务端。
  - `LoginScreen` 表单提交前有 inline 错误提示（用户名/密码为空时拦截并显示）。
  - `GalleryModal` 顶部分类筛选 chip 行（全部 / 我的收藏 / 人像 / 场景 / 产品 / 风格 / 其他），实时过滤条目。
  - `BatchModal` 任务失败/取消且有 failed 项时显示「重试失败项」按钮，复用相同入参重新提交新任务。
  - `HistoryModal` 顶部「多选」入口进入批量模式，支持全选、批量下载 ZIP、批量删除（含子版本强制删除确认）。
  - `CropView` 选区有效性同时校验百分比（≥2% × ≥2%）和像素（≥32×32px），尺寸文本实时显示百分比和像素值，避免原图过小时裁剪出无效内容。
  - `HistoryModal` 接收 `notify` prop（Toast 反馈），内部不再使用空实现的 `notifyIfAvailable`；`parentNumberOf` 用 `idToNumber` Map 替代 `find` 查找父版本号，复杂度由 O(n²) 降为 O(n)。
  - `BatchModal` 轮询加 `pollStartRef` 与 `pollFailCountRef`，上限 `MAX_POLL_MS = 10 分钟`、连续失败 `MAX_FAILS = 5` 次后停止并报错，避免无限轮询耗电。
  - `TasksPanel` 轮询同模式加超时与失败计数（`MAX_POLL_MS = 10 分钟` / `MAX_FAILS = 5`），连续失败 5 次或超过 10 分钟自动停止，避免无意义挂起耗电。
  - `api.ts` 断网期间失败的幂等 GET 请求入 `pendingRetryQueue`（最多 20 条），网络恢复时由 `connectionRetryHandler` 重放并触发 `App.tsx` 的 `loadAll()` 刷新；`App.tsx` 通过 `setConnectionRetryHandler` 注册回调。
  - `CompareModal` 用 `stageRef.measureInWindow` 获取舞台屏幕绝对坐标替代 `onLayout` 的 `layout.x`，修复模态框内嵌套布局下水平偏移量计算偏差。
  - `HomeScreen` 搜索框加 250ms 防抖（`searchTimerRef` + `setDebouncedSearch`），过滤 `useMemo` 依赖 `debouncedSearch`，避免每次按键触发重算。
  - 抽取 `mobile/src/labels.ts` 集中管理中文标签与时间格式化函数（`OPERATION_LABELS` / `STATUS_LABELS` / `STAGE_LABELS` / `BATCH_STATUS_LABELS` / `TASK_OPERATION_LABELS` / `formatRelativeTime` / `formatDateTime` / `formatTaskTime`），`HistoryModal`、`BatchModal`、`WorkspaceScreen` 改为从此导入；`WorkspaceScreen` 因等待文案带 "…" 后缀（如「视觉定位中…」）保留本地 `STAGE_LABELS`，仅迁移 `OPERATION_LABELS`→`TASK_OPERATION_LABELS` 与 `formatTaskTime`。
  - `ModalSheet` body 统一包 `KeyboardAvoidingView`（iOS `padding` 行为），覆盖所有 sheet 内含 `TextInput` 的场景（`EditTextModal`、`BatchModal`、`CompareModal`、`GalleryModal` 等）；`HomeScreen` 顶部新建/重命名 Modal 单独包裹。
  - 各主要 `FlatList` 加 `initialNumToRender` / `maxToRenderPerBatch` / `windowSize`（HomeScreen 6/6/4、GalleryModal 6/6/5、HistoryModal 6/6/5、EditTextModal 10/10/5）减少首屏渲染压力。
  - 新增 `mobile/src/components/RemoteImage.tsx` 组件：`onError` 时显示占位卡片（"图片加载失败"），`source` 为 `undefined` 时直接显示占位，替换 11 处远程图片调用（HomeScreen 封面、GalleryModal 缩略图、BatchModal 进度缩略图、HistoryModal 版本图与子版本图、WorkspaceScreen 候选图/画布缩略图/预览图/消息气泡图、CompareModal 前后图）；`Image.getSize` 与 base64 source 仍用原生 `Image`。
  - 新增 `mobile/src/screens/workspace/ProjectFormModal.tsx` 组件：封装项目创建/编辑共用表单（标题 + 名称 + 描述 + 提交/取消），内置 `KeyboardAvoidingView` 防键盘遮挡；HomeScreen 的两个内联 Modal 替换为 `<ProjectFormModal>`，减少约 50 行重复代码。

## 3. 目录职责

```text
src/                        React 单页应用
  main.tsx                  React 挂载入口
  App.tsx                   顶层视图路由、全局项目/模型状态与登录 role 判定
  theme.tsx                 暗色模式 ThemeProvider（data-theme + localStorage）
  LoginView.tsx             登录界面（换取 Bearer token 与角色）
  HomeView.tsx              项目库、创建、导入、备份恢复入口
  WorkspaceView.tsx         三栏工作台、图片操作、任务轮询、版本树/对比
  ModelConfigView.tsx       图片模型、视觉识别模型配置界面；admin 角色另有「用户与队列」管理后台标签
  api.ts                    前端唯一的 HTTP API 封装及下载/上传辅助函数
  types.ts                  前后端共享的数据形状（前端侧）
  sizes.ts                  按提供商的尺寸、格式、校验规则
  gallery.raw.json          提示词画廊源数据
  gallery.ts                由脚本生成、供 UI 使用；不要手改
  styles.css                全站样式
server/
  index.mjs                 HTTP 路由、用户与角色守卫、任务队列、生成任务、模型调用、项目与备份逻辑；含结构化访问日志（reqId / 耗时 / 用户 JSON）和僵尸任务扫描定时器（60s，将 generating 但内存无 entry 的任务标记失败）
  db.mjs                    SQLite 初始化、目录常量、DTO 转换
  users.mjs                 DATA_ROOT/users.json 账号存储、登录校验与用户增删改（至少保留一个管理员）；写操作原子化（tmp+rename）
  models.mjs                config/models.json 的读写、脱敏与模型规范化（含 apiKeys Key 池轮询）；写操作原子化
  png.mjs                   演示图和缩略图的 PNG 工具
  local-edit.mjs            Sharp 图片规范化（含日日新请求副本）、坐标校验、参考主体裁剪合成、框外像素保留；preserveOutsideRegion 分块 yield 减少 OOM
  local-edit.test.mjs       局部编辑的隔离图片处理与 HTTP 集成回归测试
  backup-restore.test.mjs   备份恢复前校验、安全快照与重启信号回归测试
  restore-concurrency.test.mjs 恢复与在途生成互斥的回归测试
  model-connection.test.mjs 模型连接测试错误状态回归测试
  project-data.test.mjs     项目导入、草稿 ID、缺文件缓存和默认模型回归测试
  zip.mjs                   无额外依赖的 ZIP 读写
  test-auth.mjs             测试共享登录 helper（admin/admin → Bearer token）
  queue-auth.test.mjs       管理后台守卫、用户管理、Key 池轮询与任务队列（串行 / 排队取消 / 重启恢复）回归测试
electron/
  main.cjs                  桌面窗口、原生菜单与本地服务生命周期；运行时将用户数据根目录传给 server/
mobile/                     Expo React Native 移动端 App「像素变换」（独立 npm 工作区）
  src/api.ts                移动端唯一 HTTP 封装（动态服务器地址、Bearer 鉴权、缓存下载、并发限流、断网重试队列）
  src/labels.ts             集中管理中文标签与时间格式化函数（OPERATION_LABELS/STATUS_LABELS/STAGE_LABELS 等）
  src/sizes.ts              镜像 Web 尺寸目录与主流比例映射（扩图预设用）
  src/theme.tsx             移动端暗色模式 ThemeProvider（light/dark 色板 + AsyncStorage）
  src/App.tsx               认证守卫与 home / workspace / models 视图切换；注册 setConnectionRetryHandler
  src/screens/              LoginScreen、HomeScreen、WorkspaceScreen 及 workspace/ 下各弹窗
  src/components/           RectSelector（百分比框选）、ModalSheet（含 KeyboardAvoidingView）、RemoteImage（onError 占位）、Icon 等
  src/screens/workspace/    HistoryModal、BatchModal、EditTextModal、CompareModal、ProjectFormModal（创建/编辑共用表单）、GalleryModal 等
  android/                  `npx expo prebuild --platform android` 生成后手工调整过的原生工程（见第 1 节构建说明）
scripts/
  dev.mjs                   并行启动前端和后端
  parse-gallery.mjs         从外部 GPT-Image2-Skill 参考资料生成画廊源 JSON
  build-gallery-ts.mjs      从 gallery.raw.json 生成 src/gallery.ts
  build-gallery-images.py   构建画廊图片素材
  make-icons.mjs            生成 PWA 图标
public/                     静态图标、PWA manifest、画廊缩略图
data/                       浏览器本地版的运行时 SQLite、users.json 账号、settings.json 运行设置、sessions.json 会话、项目图片、画廊配图（data/gallery）、恢复安全备份（被 Git 忽略）
config/models.json          浏览器本地版的运行时模型配置，可能含 API Key（被 Git 忽略）
dist/                       构建产物（被 Git 忽略）
release/                    Electron 构建产物（被 Git 忽略）
work/                       临时工作目录（被 Git 忽略）
```

`README_ZH.md` 是用户说明，`README.md` 是英文版；它们不是实现真相。功能改动若影响用户使用，也应酌情同步 README。

## 4. 前端结构与状态

`App.tsx` 用内存状态在以下视图切换，不使用前端路由库：

1. `home`：项目列表、导入/导出/完整备份、模型设置入口（仅 admin 角色可见模型设置入口，`role` 来自登录响应）。
2. `workspace`：指定 `projectId` 的创作工作台。
3. `models`：图片模型和视觉识别模型的增删改、测试、设为默认；页面顶部有「模型 / 用户与队列」两个标签，后者仅 admin 角色可见。

`WorkspaceView.tsx` 是核心 UI。它加载 `ProjectBundle`，把项目 `draft` 作为可恢复的工作台草稿；草稿修改会立即写入项目专属 localStorage 恢复副本，并在 900ms 防抖后 PATCH 回服务端，成功后清理副本。该组件还：

- 右侧对话面板以「对话 / 批量」模式标签切换（组件状态，不入草稿；直接点「批量」默认进入批量文生图）：对话模式保留原消息列表与输入区；批量模式整体替换为批量面板，表单内容在 `.batch-panel-scroll` 内独立滚动，「开始生成」按钮和校验错误常驻底部 `.batch-panel-footer`，不随内容滚走。面板内含「批量改图（需画布图片 + `edit_prompt` 能力，画布「批量处理」浮动按钮会强制选中它）/ 批量文生图（需 `text_to_image` 能力）」子模式、变量模板编辑器、提示词列表（含 TXT 导入）、变量值矩阵；批量文生图子模式额外展示尺寸 / 输出格式 / 透明背景（后两者仅 openai 提供商）与「统一风格提示词」输入框（初始值取项目风格提示词）。提示词画廊按钮位于工作台顶栏（模型选择旁），两种模式都可用；`useGalleryPrompt` / `useGalleryStyle` 按当前面板和子模式把条目写入聊天输入框、批量提示词列表、项目风格或批量统一风格。
- 每 1.5 秒轮询正在生成的任务；完成后重新读取项目 Bundle。图片改字点击提交时会先用任务 ID 为空的 `activeTask` 表示视觉规划阶段，立即关闭文字编辑弹窗、在项目对话中展示等待状态并自动滚动到最新消息；服务端返回真实任务 ID 后开始轮询，提交失败则清除等待状态并重新打开原弹窗。
- 批量任务（批量改图 / 批量文生图 / 批量局部修改）共用约 900ms 的独立进度轮询分支；每当已处理数量增加就重新读取 Bundle，使新增图片、生成中的版本和项目当前图片立即可用。批量进度保留在画布下方，按任务的 `textBatch` / `localEdit` 标记区分文案，显示词条状态、缩略图、剩余数量与 ETA，任务结束后仍可查看或手动收起；切换到非该批次产出的历史版本时自动收起，避免候选列表与当前画布不一致。批量模板编辑器是命令式渲染的 `contenteditable`，只在面板/标签页/参考图变化时按状态重建，输入过程不重渲染以免光标跳动。
- 局部编辑提交后立刻显示等待状态，取得任务 ID 后收起浮窗，并按任务 `stage` 显示视觉定位 / 合成 / 生成 / 框外还原进度。失败或取消时在同一工作台会话恢复选区、文字与参考图；成功后清空。参考图只在本次操作中使用，不替换当前画布或项目草稿；切换画布图片会清除旧参考图并使未完成的文件读取失效。局部编辑浮窗有选区时，图片粘贴优先进入参考图，文本框仍保持文本优先。
- 监听 document 的 `paste` 事件：剪贴板含图片时复用上传流程（画布可直接 Ctrl+V 贴图）；文本框内文本优先，上传进行中忽略重复粘贴。
- 维护当前查看图片、下一次编辑的输入图片、尺寸、输出格式、数量、透明背景等本地状态。工作台不再提供图片模型 / 视觉识别模型选择：图片生成一律使用管理员设置的默认图片模型，视觉理解统一使用默认识别模型（组件仍把该模型 ID 以 `visionModelId` 随视觉请求发送，便于服务端严格校验与识别缓存命中）。
- 使用百分比坐标 `{ x, y, width, height }` 记录文字/局部编辑/提取素材选区；局部编辑和提取素材通过画布级 Pointer Events 与指针捕获支持从图片外起拖及越界拖拽，再将结果限制为图片内 0–100% 的有效交集；笔刷涂抹模式由蒙版画布上的 Pointer Events 接管（`stopPropagation` 阻断画布级框选处理），指针坐标按画布显示尺寸换算到蒙版分辨率；选区显示层必须以 `inset: 0` 对齐图片内容边缘，不能因容器已有边框而再次向内缩进；服务端和视觉模型提示词均以此为准。
- 提取素材在圈选完成后立即用 canvas 生成截图预览（`cropImageRegion()`），提交时随请求发送截图 base64；局部修改与提取素材、扩图等模式互斥，切换时自动关闭其他模式。
- 在版本树中按父子关系布局；从历史节点继续编辑会成为新的分支。

前端不要直接访问 SQLite、`data/` 或模型配置文件；新增服务端能力时，先在 `src/api.ts` 增加封装和类型，再由组件调用。

## 5. 核心数据模型与不变量

浏览器本地版数据库在 `data/app.db`；桌面版数据库在 Electron `userData/data/app.db`。启动时由 `server/db.mjs` 创建表并启用外键和 WAL。`LAYERIVE_DATA_ROOT` 和 `LAYERIVE_CONFIG_ROOT` 可分别覆盖数据和模型配置目录，Electron 必须传入其 `userData` 子目录，确保升级不覆盖用户项目、图片或 API Key。数据库模式没有迁移框架；变更表结构时必须实现对旧本地数据库安全的迁移/兼容策略，并更新本文件。

| 表 | 用途 | 关键关系 / 约束 |
| --- | --- | --- |
| `projects` | 项目元数据与工作台草稿 | 维护封面、当前版本/图片、默认模型、收藏和软删除时间 |
| `messages` | 对话和系统事件 | 按项目保存用户提示词、生成结果、错误与取消记录 |
| `generation_tasks` | 异步生成任务 | 保存模型快照（去掉 API Key）、参数、输入、状态（`queued` / `generating` / `success` / `failed` / `canceled` / `partial`）和错误 |
| `image_versions` | 可分支版本节点 | `parent_version_id` 指向父版本；删除为软删除 |
| `images` | 上传和生成图片元数据 | 文件实际位于 `data/projects/<projectId>/...` |
| `version_inputs` | 版本输入图片关系 | 关联编辑/生成版本和源图片 |
| `text_recognitions` | 图片文字识别缓存 | 以图片、视觉模型 ID 和模型配置指纹缓存成功的文字分段；同一配置直接复用，切换或修改视觉模型则重新识别 |
| `gallery_entries` | 用户自建提示词画廊条目 | 配图存于 `data/gallery/`；source 为 manual / project；删除条目时同步删除配图 |

重要不变量：

- 上传图片先作为未版本化素材保存；服务端用 `readImageDimensions()` 读取 PNG/JPEG/WebP 的宽高并写入 `images.width` / `images.height`。第一次拿它编辑时，`ensureUploadVersion()` 会补建 `upload` 起始版本。
- 局部替换参考图和初步合成图保存在项目 `local-edits/`，`images.source_type` 分别为 `local_reference` / `local_composite`，保持未版本化并带所属 `task_id`。成功版本的 `version_inputs` 同时关联原图、参考图和合成图，父节点始终来自原图；中间图不成为画布当前版本。它们作为普通项目图片随复制、导出导入及备份保留，失败任务已保存的参考素材也会留存。`generation_tasks.input_json` 可附加 `stage`、`localEdit`（选区、意图、双图百分比坐标、规范化尺寸及视觉模型 ID）、`effectivePrompt`，或批量任务（`batch_edit` / `batch_generate`）的 `versionId` / `versionNumber` / `batch`（变量模式存模板与变量名数组，提示词列表模式存 `prompts` 数组；批量文生图任务额外带 `textBatch: true` 且无输入图；批量局部修改的 `batch` 额外带 `local: true` 且 `prompts` 为指令数组、逐项映射为 `{ 指令: 行内容 }`，任务同时带 `localEdit` 选区字段；均含总数、当前序号，以及逐项的变量值映射、状态、图片 ID、耗时和错误）；不存 API Key，不新增表或列，读取进度时兼容旧任务的单变量结构。
- 每个成功生成任务都会创建一个版本、写入所有输出图片、选第一张作为 `selected_image_id`，并更新项目的当前图片/版本/封面。前端点击候选条或消息画廊中的任意候选图时，同时更新 `currentImageId` 和 `inputImageId`，确保画布所见候选就是下一次继续创作的输入。
- 所有图片生成和编辑任务都把 `params.count` 规范为 1–4。`callImageProviderBatch()` 以提示词数组为输入：单提示词时 OpenAI / Grok 优先使用原生 `n` 批量请求，兼容接口若忽略或拒绝 `n`，会按缺口补发单图请求（首波全部为限流错误时不再补发）；多提示词（拆分模式）一律逐条发 `count=1` 请求，输出顺序与提示词一一对应。所有扇出经 `mapWithConcurrency()` 限制为并发 2，单个请求对 429 / 限流类错误最多退避重试 2 次（约 1.5s / 4s，优先响应 `Retry-After`）。成功返回的图片统一写入同一版本，前端候选条与对话画廊展示全部结果；单图接口的多张生成意味着多次计费请求。
- 项目 Bundle 会隐藏软删除版本所属的图片，未版本化上传图片仍可见。
- 删除版本只软删除记录，**不会删除图片文件**。如被后续版本引用，须显式强制删除，后代会重新连接到被删节点的父节点。
- 服务重启时所有仍为 `generating` 或 `queued` 的任务会被标为失败，不能尝试恢复执行。账号（`users.json`，含密码哈希）、运行设置（`settings.json`）与会话（`sessions.json`）存于 `DATA_ROOT`、不进 SQLite；完整备份 ZIP 只包含数据库、项目图片、画廊配图与 `config/models.json`，不包含这三个文件，账号与队列设置不随备份 / 恢复迁移。

## 6. 一次图片创作的后端流程

所有图片任务最终通过 `startGeneration()` → `runGenerationTask()` 处理：

```text
前端 POST 操作
  → 校验项目、模型能力、输入图片与参数
  → 写 user message + generation_tasks(queued)，进入全局 FIFO 任务队列
  → 队列按管理员设置的并发上限调度（有空位时提交返回前即同步调度为 generating）
  → 异步调用供应商（常规总超时 120 秒 + 每多一张 +30 秒、多图意图判断另 +60 秒；局部编辑含规划与图像处理总超时 300 秒；AbortController 与超时预算仅在调度时创建）
  → 成功：写 image_versions、images、assistant result、更新项目指针
  → 失败/取消：只更新 task 并写 assistant error/canceled message
前端轮询 GET /tasks/:taskId，完成后重新 GET 项目 Bundle
```

- `operation: auto`：有输入图时为 `edit_prompt`，否则为 `text_to_image`。
- 选择上传图片作为改图输入时，前端通过 `closestSizeForDimensions()` 把生成尺寸切换为当前提供商允许的最接近宽高比；固定尺寸模型只能保证比例尽量一致，不能保证输出像素值与原图完全相同。
- 日日新 U1.5 Lite 的所有带图编辑在发往平台前会由 Sharp 生成临时请求副本：按 EXIF 方向转正并转为 sRGB，以工作台选中的合法尺寸作为画布（无合法尺寸时自动限制到 512–4096px、32px 整倍数及最大 3:1），等比缩放并用边缘像素补边，不改写项目原图；PNG 超过 10MB 时回退高质量 JPEG。`/images/edits` 固定传 `size: "auto"`，由规范化参考图决定输出比例。平台仍拒绝输入时，任务错误会保留经过截断与空白清理的原始平台信息，不能再用旧的统一尺寸文案覆盖具体原因。
- 项目风格提示词只追加到无输入图的文生图，避免重绘已有图片的风格。
- `/generate` 的多图意图判断在 `runGenerationTask()` 内使用全局默认视觉模型（请求显式携带 `visionModelId` 时严格校验并采纳，缺省回退全局识别默认模型）：数量大于 1 且提示词非空时把任务 `stage` 置为 `planning`，要求模型返回 `different` 与恰好 N 条可选子提示词。仅当 `different=true`、条数正确且互不重复时进入 `different` 模式并逐条生成；普通候选、含糊判断、条数不足或重复提示词均保守回退 `same` 模式，继续按原提示词生成 N 张。判断结果写入 `generation_tasks.input_json.promptMode`；不同提示词模式会为每个成功输出保留原始提示词索引，若部分请求失败则任务与版本为 `partial`，消息中的 `prompts` 只和实际输出图片一一对应。单张或空提示词不调用视觉模型；多图请求提交时即校验视觉模型存在，视觉请求硬失败则任务失败。旧消息的 `splitPrompts` 仅为历史展示兼容，新请求忽略该字段。
- `/batch-edit` 不走 `/generate` 的多图意图判断，也不使用图片接口原生 `n`：`startBatchEdit()` 校验模板中的全部变量及其等长值列表，先创建一个 `generating` 批量版本和主任务；`runBatchEditTask()` 再按图片行同时替换多个变量，形成完整提示词，并以 `count=1` 串行调用同一模型和同一参考图。旧调用方仅传一个变量的 `values` 数组时仍兼容。每张输出文件写完后用独立 SQLite 事务追加 `images`、更新任务 JSON；第一张同时设置版本选中图和项目指针。全部完成后写一条结果消息；混合成功/失败为 `partial`，全失败时软删除空版本，取消时保留已有输出。
- `/batch-generate` 复用批量任务的增量发布框架但不带输入图：`startBatchGenerate()` 校验模型 `text_to_image` 能力与模板 / 提示词列表（校验逻辑与 `/batch-edit` 共用），预建 `batch_generate` 版本与主任务；`runBatchGenerateTask()` 逐行替换变量或直接取列表提示词，可选 `stylePrompt`（≤2000 字符）以「，」追加到每条最终提示词末尾，不叠加参考图批次约束，`count=1` 串行调用文生图接口。任务 JSON 带 `textBatch: true`；增量发布、partial / 取消 / 空版本处理与 `/batch-edit` 一致。`/batch-edits/:taskId` 进度接口同时兼容两种 `operation_type`，并返回 `textBatch` 标记。
- `edit_text` 与 `local_edit` 先调用视觉模型生成严格 JSON 的编辑提示词，再调用图片生成模型。文字编辑允许替换、清空删除及手动框选新增；文字编辑和局部修改提交时按源图片宽高匹配当前图片模型最接近的支持比例，不能回落到模型默认的 1:1。
- `local_edit` 在校验后立即返回 202，视觉规划移入 `runGenerationTask()`。带 `reference: { data, mimeType, name? }` 时，后台用 Sharp 按 EXIF 方向规范化两图，最多解码 4000 万像素；参考图等比缩小至最长边不超过 4096px。视觉模型看到的图片与坐标计算使用同一份规范化数据，返回 `intent` / `target_rect` / `reference_rect` / `edit_prompt`。坐标必须有限且处于各自全图 0–100% 内，目标至少 80% 位于选区内，再限制为交集，否则终止。裁剪主体等比放入目标框，矩形裁剪残留背景交由模型在选区内修复。生成后将结果缩放回原图尺寸，只拷贝选区像素并在内部最多 12px 羽化，以 PNG 避免框外二次有损压缩。自然融合质量仍依赖所选模型，选区应为主体衔接留出空间。
- 局部编辑各阶段共享 AbortController；视觉请求另有 120 秒上限。所有生成任务写完输出文件后再次检查取消，再用无异步间隙的 SQLite 事务写版本、输入关系、图片记录、结果消息、任务状态和项目指针，避免取消时发布成功版本。文件写入失败 / 取消可能留下未被数据库引用的输出文件，但不会发布部分成功记录或覆盖原图。
- `recognize-text` 首次成功识别某张图片后，将分段结果持久化至 `text_recognitions`；再次打开“编辑文字”时，若工作台所选视觉模型 ID 和其 provider / API 格式 / Base URL / 模型名均未变化，则直接复用缓存，不再发送识别请求。`edit_text` 任务把修改后的完整文字快照与视觉模型指纹记录在 `generation_tasks.input_json.textEdit`，成功时为每张输出图写入对应 `text_recognitions`；替换后的文字成为新的 `originalText`，删除项不再返回，手动新增项保留框选坐标，全部删除时缓存合法的空数组。切换视觉模型会读取该模型自己的缓存或重新识别；缓存会随项目复制、导出导入和完整备份保留。
- `outpaint` 直接构建保留原图、仅扩展新增区域的提示词；`enhance` 直接构建提升清晰度、但不改变原图内容的改图提示词。
- `remove_watermark` 先让视觉模型判断并定位水印；若未发现水印则拒绝提交编辑。
- `extract_asset` 请求体内携带前端 canvas 截图（base64），服务端先保存为 `source_type='extract'` 的未版本化素材（存于 `data/projects/<projectId>/extracts/`），再让视觉模型聚焦主体生成改图提示词，最后以截图为输入图调用编辑模型；版本挂在原图片所在版本的下游。
- 模型必须声明能力。局部编辑、改字、扩图、去水印、提取素材映射为图片模型的 `edit_prompt` 能力；视觉识别模型仅用于理解与规划，不能出图。

## 7. 模型适配和安全注意事项

模型配置在 `config/models.json`（或 `LAYERIVE_CONFIG_ROOT/models.json`），由 `server/models.mjs` 管理。常规模型列表向前端返回时使用 `publicModel()`，`apiKey` 与 `apiKeys` 池全部显示为掩码；保存掩码值时按位置保留原 Key。管理员点击显隐按钮时，前端才通过 `POST /api/models/:id/api-key` 按需读取该模型的真实 Key；响应禁止缓存，不得把真实 Key 加回常规模型列表响应。

**角色与管理守卫（不要放宽）**：`requireAdmin()` 守卫三类入口——`/api/admin/*` 全部路由、`/api/backup` 与 `/api/backup/restore`、以及 `/api/models` 的所有非 GET 写操作；非管理员返回 403。用户账号由 `server/users.mjs` 存于 `DATA_ROOT/users.json`（sha256 加盐哈希），任务队列并发等运行设置存于 `DATA_ROOT/settings.json`；两者虽不进完整备份 ZIP，但都在 `DATA_ROOT` 中含有敏感内容，目录权限与模型配置同等对待。

**API Key 池轮询（`pickApiKey`）**：请求发出时按模型 ID 的内存计数器在 `apiKeys` 池内取模轮转（池为空回退 `apiKey`）；同一请求对 429 / 限流错误退避重试时会换下一把 Key 再试。Key 只在发往供应商的请求头中使用，绝不写入任务快照、消息或日志。

**本机访问限制（不要放宽）**：服务默认只监听 `127.0.0.1`（设置环境变量 `PIXELFLOW_API_HOST=0.0.0.0` 才会改为局域网监听，供移动端真机使用），这挡得住局域网，挡不住浏览器——用户打开的任意网页都能请求 `127.0.0.1`。因此 `/api/`、`/files/`、`/gallery-files/` 一律先过 `assertLocalUiRequest()`：`Sec-Fetch-Site` 为 `cross-site` 的请求、Origin 主机名不是 `127.0.0.1` / `localhost` / `[::1]` 的请求，以及 Host 不是本机名的请求（DNS rebinding）都返回 403；不带浏览器 fetch 元数据的调用（curl、测试、Electron 健康检查）没有环境凭据，继续放行。在此之上所有 `/api/` 路由（除 `/api/health` 与 `/api/auth/*`）还需 `requireAuth()` 的有效 Bearer 会话，未登录返回 401；`assertLocalUiRequest()` 对持有效会话 token 的请求直接放行（移动端真机经 LAN Host + token 使用），而浏览器里的外部页面拿不到 token，跨站与 DNS rebinding 防护完整保留。所有响应都不再发送 `Access-Control-Allow-Origin`，跨源页面即使发出请求也读不到响应体。浏览器版全部使用同源相对路径（`npm run dev` 经 Vite 代理到达），桌面版由本机页面发起，均不需要 CORS 授权。放宽任何一条都会让外部网页能够下载 `/api/backup`——那个 ZIP 里带着 `config/models.json` 和其中的 API Key。前端应用外壳（非 `/api/` 的 GET）不受本机来源限制，以免从别处点链接打开应用时被拦。

| 提供商 | 图像适配实现 | 备注 |
| --- | --- | --- |
| `openai` | Images `generations` / `edits` | 编辑走 multipart；文生图走 JSON |
| `sensenova` | 复用 OpenAI 适配的专用 JSON 分支 | 生成默认 `watermark: false`、`prompt_extend: true`；编辑输入自动规范化并使用 `size: auto` |
| `gemini` | `/interactions` | 尺寸映射为 aspect ratio，返回图片块 |
| `grok` | Images `generations` / `edits` | 输入图以 data URL 放入 JSON |
| `agnes` | Images `generations` | 图生图也走 `/images/generations` + `image` 数组（非 `/images/edits`）；仅支持 `n:1`，不支持 `quality`/`output_format`/`background`；T2I 用 `return_base64: true`，I2I 从返回 URL 下载图片；默认模型 `agnes-image-2.0-flash`，Base URL `https://apihub.agnes-ai.com/v1` |
| `mock` | 本地演示 PNG | 仅服务端兼容路径；配置 UI 的常规提供商集合不包含它 |

- 视觉模型以独立的 `apiFormat` 字段选择 `anthropic_messages`、`chat_completions` 或 `responses`。该字段缺失的旧配置不会被重写：`askdiandian.com` 自动沿用 Anthropic Messages，其余配置沿用 Chat Completions；旧 `provider` 字段继续原样保留，视觉请求根据 Base URL 识别 SenseNova 专用端点，避免隐藏的旧提供商值干扰用户修改后的地址。
- 前端不再提供视觉模型选择，视觉请求通常不携带 `visionModelId`，`visionModelOrThrow()` 沿用全局 `active_vision_model`（无默认时取第一个视觉模型，都没有则 400）；显式携带时严格解析，模型不存在返回 400，不得静默切换到另一个模型。图片模型同理：`modelId` 缺省用 `active_model`，显式传入时严格校验并采纳。
- `visionEndpoint()` 根据 Base URL 和 API 格式补全 `/v1/messages`、`/chat/completions` 或 `/responses`；若用户已填写完整端点则不会重复拼接。
- `callVision()` 同时接受单张图片或按顺序排列的图片数组；Anthropic Messages、Chat Completions（含 SenseNova 两条兼容路径）、Responses 均按各自协议发送多张图片。局部替换固定图1为原图、图2为参考图；不支持多图理解的模型会使该任务失败，不降级为只看一张。
- SenseNova 视觉模型有两条不同的兼容路径：旧融合模态服务 `api.sensenova.cn/v1` 使用 `/llm/chat-completions` 和 `max_new_tokens`；Token Plan 的 `sensenova-6.8-flash-lite` 等模型使用 `token.sensenova.cn/v1/chat/completions`、标准 `max_tokens` 与 OpenAI Vision 图片块。不得仅按 `sensenova.cn` 域名笼统选择旧路径。
- `normalizeBaseUrl()` 会移除末尾的 `images/generations` 或 `images/edits`，避免重复拼接路径。
- 不要读取、输出、提交或写入示例真实 API Key；`config/` 和 `data/` 已被 Git 忽略。
- 新增供应商或参数时，必须同时检查：`types.ts`、`ModelConfigView.tsx`、`sizes.ts`、`models.mjs`、`index.mjs` 的调用适配和模型测试逻辑。

## 8. HTTP API 概览

所有 JSON 错误为 `{ error }`；生成与编辑接口返回 `202` 和 `{ taskId, status, userMessageId }`。除 `/api/health` 与下表认证路由外，所有 `/api/` 调用需带 `Authorization: Bearer <token>`，缺失 / 失效返回 401。

| 路径 | 主要方法 | 用途 |
| --- | --- | --- |
| `/api/health` | GET | 本地服务健康检查（无需会话） |
| `/api/auth/login` | POST | 用户名 / 密码换取会话 token（响应含 `username` / `role`；账号存于 `DATA_ROOT/users.json`，首次启动播种 admin / admin） |
| `/api/auth/check` | GET | 查询当前 token 是否有效（响应含 `username` / `role`） |
| `/api/auth/logout` | POST | 注销当前会话 token |
| `/api/admin/users`、`/api/admin/users/:username` | GET / POST / PATCH / DELETE | 管理后台用户管理（仅 admin）：列表、新建、改角色 / 改密、删除；写操作即时撤销目标用户会话，最后一个管理员不可降级或删除 |
| `/api/admin/settings` | GET / PUT | 任务队列全局并发 `queueConcurrency`（1–8，默认 2；越界钳制，非数字 400；仅 admin） |
| `/api/projects` | GET / POST | 项目列表、创建 |
| `/api/projects/:id` | GET / PATCH / DELETE | Bundle 查询、项目/草稿更新、项目软删除 |
| `/api/projects/:id/images` | POST | 上传 PNG/JPEG/WebP（最大 10MB） |
| `/api/projects/:id/generate` | POST | 文生图、图生图、提示词改图；数量大于 1 且提示词非空时可传 `visionModelId`，服务端自动判断普通候选或分别生成 |
| `/api/projects/:id/batch-edit` | POST | 创建批量改图任务：变量模式传 `imageId`、`modelId`、含 1–10 个 `{{变量名}}` 的 `template`、`quantity`（2–50）、`variables: [{ name, values }]`（每个 values 长度等于 quantity）；提示词列表模式改为传 `prompts: string[]`（2–50 条、单条 ≤1000 字符，数量由行数决定），以及可选 `parentVersionId` / `params`；兼容旧单变量 `values`，返回任务和预建版本 ID |
| `/api/projects/:id/batch-generate` | POST | 创建批量文生图任务（无输入图）：`modelId`、同上的 `template` / `quantity` / `variables` 或 `prompts` 录入方式、可选 `stylePrompt`（≤2000 字符，追加到每条提示词）与 `parentVersionId` / `params`；要求模型具备 `text_to_image` 能力，返回任务和预建 `batch_generate` 版本 ID，进度走 `/batch-edits/:taskId` |
| `/api/projects/:id/batch-edits/:taskId` | GET | 查询逐项批量进度（兼容 `batch_edit` / `batch_generate`）、即时输出图片、完成/失败/剩余数量、`textBatch` / `localEdit` 标记及 ETA |
| `/api/projects/:id/{recognize-text,edit-text,local-edit,outpaint,enhance,remove-watermark,extract-asset}` | POST | 专项图片操作；使用视觉能力的请求可传 `visionModelId` |
| `/api/projects/:id/local-edit` | POST | `imageId`、`modelId`、`visionModelId?`、百分比 `rect` 或 PNG data URL `mask`（二选一，`mask` 时按蒙版 alpha 包围盒自动推导 rect）、`instruction`、`params?`；可附 `reference: { data, mimeType, name? }`，有参考图时 instruction 可为空；涂抹模式无参考图且留空 instruction 时按移除补全背景处理；校验后即返回 202，后台规划与合成 |
| `/api/projects/:id/local-edit-batch` | POST | 批量局部修改：`imageId`、`modelId`、`visionModelId?`、百分比 `rect` 或 PNG data URL `mask`（二选一）、`instructions: string[]`（2–50 条、单条 ≤1000 字符）、可选 `reference` / `parentVersionId` / `params`；每个子项独立运行局部修改流水线（含各自视觉规划与合成素材），逐张追加到同一 `local_edit` 版本，返回任务和预建版本 ID，进度走 `/batch-edits/:taskId` |
| `/api/projects/:id/tasks`、`/tasks/:taskId`、`/tasks/:taskId/cancel` | GET / GET / POST | 查询和取消生成任务 |
| `/api/projects/:id/tasks/:taskId` | GET | 单任务响应含可选 `stage: planning / compositing / generating / preserving`，旧任务为 null |
| `/api/projects/:id/versions/:versionId` | DELETE | 软删除版本，可加 `?force=1` |
| `/api/projects/:id/versions/:versionId/download` | GET | 将未软删除的多图版本全部现存输出图片打包为 ZIP；单图版本返回 400 |
| `/api/projects/:id/duplicate`、`/export` | POST / GET | 深复制项目、导出项目 ZIP |
| `/api/projects/import` | POST | 导入项目 ZIP（base64 请求体） |
| `/api/backup`、`/api/backup/restore` | GET / POST | 完整备份、恢复并重启服务（仅 admin） |
| `/api/models...` | GET / POST / PATCH / DELETE | 模型管理、默认设置、连接测试；POST / PATCH / DELETE 仅 admin；`POST /api/models/:id/api-key` 仅供本机配置页按需回显已保存密钥 |
| `/api/gallery` | GET / POST | 用户画廊条目列表、新增（可附 base64 配图） |
| `/api/gallery/analyze` | POST | 视觉模型从 base64 图片提炼标题 / 提示词 / 风格提示词，可传 `visionModelId` |
| `/api/gallery/from-image` | POST | 把项目内图片（projectId + imageId）收藏进画廊并自动提炼提示词，可传 `visionModelId` |
| `/api/gallery/:id` | PATCH / DELETE | 编辑（可替换 / 移除配图）、删除画廊条目 |
| `/gallery-files/<file>` | GET | 画廊配图访问（存于 `data/gallery/`） |
| `/files/<projectId>/<path>` | GET | 本地图片及按需缩略图访问 |

新增或改变 API 时，必须同步更新 `src/api.ts`、`mobile/src/api.ts`、前端与移动端调用处、`src/types.ts` / `mobile/src/types.ts`（需要时）、此表及 README 中受影响说明。

## 9. 导入、导出、删除与恢复

- 单项目导出格式为 ZIP（当前 `project.json` 格式版本为 2），含可选 `files/` 图片和文字识别缓存；所有 ZIP 写入和读取统一限制为最多 10,000 条、单条 512MB、解压后总计 2GB，避免导出应用自身不能导入的文件。导入会先校验全部 ZIP 条目和元数据图片路径为不含绝对路径 / `..` 的安全相对路径，在独立暂存目录写入并以 SQLite 事务创建项目。导入会生成新的项目及所有关联 ID，草稿、消息和任务中的图片/版本引用也会重映射；缺失的图片文件保留素材关系和文字缓存并提示。旧版本导出包缺少缓存字段时仍可正常导入。
- 项目“复制”也会复制磁盘图片和全部关系数据，并重映射 ID；草稿、任务 JSON 中的输入图、批量版本及批量项输出图片 ID 也必须同步重映射。
- 完整备份含数据库、所有项目图片、`data/gallery/` 画廊配图和 `config/models.json`，因此可能含 API Key。恢复会先进入维护状态，拒绝新请求，取消并等待在途任务完成；再解压到隔离目录，拒绝路径穿越和未知条目，以 SQLite `integrity_check`、外键检查以及当前全部必要表/字段校验备份。随后 checkpoint 当前数据库，在当前 `DATA_ROOT/backups/<timestamp>/` 留一份含数据库、项目、画廊与模型配置的安全备份，最后替换数据并启动新的服务进程。服务启动时根据数据库为所有未删除项目重建标准目录。桌面版由 Electron 接管恢复后的服务重启，不能由脱离的服务进程接管。
- 这些操作具有高数据风险。修改其逻辑前，必须先评估 SQLite WAL、一致性、失败回滚、路径穿越防护，以及 Windows 文件锁行为。

## 10. 修改指南

1. 先阅读相关文件和该功能的 API 路由；不要仅修改 UI 假装功能完成。
2. 保持 `src/types.ts`、`src/api.ts`、服务端响应和数据库 DTO 的字段命名一致（前端为 camelCase，数据库列为 snake_case）。
3. 增加图片操作时，复用异步任务机制、版本关系、消息记录和任务轮询；不要在请求中长时间阻塞 HTTP 响应。
4. 改动数据库、版本删除、导入导出或恢复前，保护用户现有 `data/`；不要使用会清空整个工作区的 Git/删除命令。
5. 改动样式前先确定组件实际使用的 class；全局样式均在 `src/styles.css`。
6. 修改画廊源数据后运行 `node scripts/build-gallery-ts.mjs`，并提交/保留生成的 `src/gallery.ts` 与源 JSON 的一致性。`parse-gallery.mjs` 依赖仓库外的 `GPT-Image2-Skill` 目录，不应作为日常构建步骤假定可用。
7. 完成后至少运行 `npm run lint`；涉及构建、静态资源或入口时运行 `npm run build`。涉及真实模型时不要擅自发送用户图片或消耗用户额度，除非任务明确要求。
8. **完成任何影响本说明范围的改动后，必须同步更新本 `AGENTS.md`。**
