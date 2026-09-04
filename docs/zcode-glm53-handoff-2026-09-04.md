# Deep Monkey Studio → Zcode GLM5.3 开发交接

更新时间：2026-09-04（Asia/Shanghai）  
仓库：`D:\Documents\bim\bim-studio`  
分支：`dev-studio`  
交接基线提交：`168168c fix: hide managed development consoles on Windows`

## 1. 接手时先做什么

当前改动在未提交工作树中。不要执行 `git reset --hard`、`git checkout -- .`、`git clean`，也不要从基线提交重新实现；这些操作会丢掉本轮已经完成并验证的修改。

按以下顺序读取：

1. 仓库根目录 `AGENTS.md`。
2. 本文档。
3. `docs/active-task-recovery-ledger.md`，重点看第 12 节。
4. `git status --short` 和 `git diff --stat`。
5. 按本文第 7 节运行接手检查。

可直接给 Zcode GLM5.3 的第一条指令：

```text
继续开发 D:\Documents\bim\bim-studio。先完整阅读 AGENTS.md、docs/zcode-glm53-handoff-2026-09-04.md 和 docs/active-task-recovery-ledger.md 第 12 节，再检查当前未提交工作树。禁止 reset、checkout 或覆盖现有改动。先运行交接文档第 7 节的聚焦检查；若通过，以当前工作树为基线继续。严格保留用户的 UI、交互、登录稳定性和“不显示无意义提示”的硬性要求。
```

## 2. 用户不可回退的要求

这是产品验收条件，不是建议：

- 页面、交互和代码质量按成熟商业平台处理，可参考帆软和山海鲸，但要与现有 Deep Monkey Studio 设计系统一致。
- 页面和面板不常驻无意义说明；必要信息使用清晰图标、`title`、悬浮层或错误发生时的上下文反馈。
- 已反馈问题必须查根因、补验证、一次修好，避免反复修改和浪费 token。
- 2D 默认显示“页面与图层”；页面只允许一个管理入口。
- 2D/3D 左右面板的收起按钮交互和位置统一。
- 图片、视频、页面背景和组件背景支持直接本地上传。
- 主题可配置，内置深色和浅色。
- 2D、3D、脚本的手动保存和自动保存逻辑必须一致。
- Web 和 Windows 客户端都不能因公共接口 401、网络波动或临时服务错误频繁退出登录。
- 所有 UI 改动需要真实浏览器截图/尺寸/溢出检查，不能只靠静态代码判断。

## 3. 本轮已经完成的产品改动

### 场景管理与通用排版

- 场景卡片高频动作精简为预览、编辑、发布、更多；重命名和复制发布链接进入更多菜单。
- 修复场景卡片菜单和导出子菜单的宽度、方向和遮挡。

主要文件：

- `apps/web/src/components/SceneManagerView.tsx`
- `apps/web/src/styles/managerSceneCards.css`
- `apps/web/src/components/SceneManagerView.test.tsx`

### 2D 工作区

- 默认左侧页签由资源改为“页面与图层”。
- 删除底部重复页面标签与新增入口，底栏只保留当前页上下文和运行状态。
- 左右面板开关移到画布边缘，样式/交互与 3D 统一。
- 顶部去掉常驻快捷键句子；快捷键集中在问号按钮悬浮层。
- 吸附、参考线改为紧凑图标；分组、对齐、分布仅在选区满足条件时出现。
- 工具栏不再有横向滚动条；空画布说明精简。
- 页面属性中的尺寸说明段落已删除。

主要文件：

- `DashboardWorkspace.tsx`
- `DashboardWorkspaceHeader.tsx`
- `DashboardWorkspaceView.tsx`
- `DashboardWorkspacePageBar.tsx`
- `DashboardWorkspaceCanvas.tsx`
- `DashboardPageViewportEditor.tsx`
- `EditorEmptyState.tsx`
- `styles/dashboard-workspace.css`

### 资源组件与行业模板

- 资源分类收敛为“图表 / 控件 / 媒体 / 3D / 资源”，分类在窄面板中保持单行。
- 删除联动诊断、行业模板引导大卡、点击插入说明、数据在线等常驻提示。
- 组件说明保留在鼠标悬浮标题中；卡片只显示预览、名称和添加动作。
- 媒体分类顶部新增“上传图片 / 上传视频”；上传后自动插入并绑定项目资源。
- 选中图片或视频组件后，右侧检查器也可直接上传替换。
- 页面背景、组件背景继续使用已有项目图片上传链路。
- 行业模板库的根因是 CSS Grid 自动行高度塌陷，不是接口无数据；已设定 `grid-auto-rows: 286px` 和 `align-content: start`。
- 模板库真实展示 120 个模板；弹窗标题区已精简。

主要文件：

- `DashboardComponentLibrary.tsx`
- `DashboardMediaInspector.tsx`
- `DashboardWorkspaceLeftPanel.tsx`
- `DashboardWorkspaceTemplateLibrary.tsx`
- `styles/dashboardComponentLibrary.css`
- `styles/dashboard-workspace.css`

### 3D 编辑器与检查器

- 默认场景背景改为 `#0b1419`。
- studio 环境色、软盒灯、网格和坐标轴降低亮度/透明度，去掉灰白雾面底板观感。
- 右侧检查器宽度和信息层级重新整理。
- 数据绑定区删除“数据产品直接驱动当前对象”和 REST/WebSocket 说明段落；必要解释移动到控件悬浮提示。

主要文件：

- `appDefaults.ts`
- `viewer/viewerEngineEnvironment.ts`
- `viewer/sceneGrid.ts`
- `SceneDataBindingEditor.tsx`
- `styles/base.css`
- `styles/scene-workspace.css`

### 本地恢复提示

- 草稿与服务器版本比较时忽略根级 `updatedAt`；只有内容真实不同且草稿更新时才弹恢复提示。
- 内容等价的陈旧草稿自动删除。
- 恢复弹窗删除英文眉题和三块统计卡，收紧宽度/间距，按钮可换行。

主要文件：

- `studio/workspaceRecoveryStore.ts`
- `hooks/useAppSceneSyncEffects.ts`
- `WorkspaceRecoveryDialog.tsx`
- 对应测试与 `styles/scene-workspace.css`

### 脚本编辑器

- 顶部删除对象/SDK/Worker 等冗余说明，只保留当前目标。
- 分屏、悬浮、独立窗口合并为一个布局菜单；AI、依赖、版本、设置进入更多工具。
- 保存按钮使用清晰文字；自动保存开关直接显示。
- 脚本保存先写入脚本模块，再调用与 2D/3D 相同的 `saveActiveApplication`，保存语义统一。
- 分屏宽度改为 React 状态；拖动期间 `.is-resizing` 禁止过渡，释放时一次写入状态和偏好，解决闪屏/回弹。

主要文件：

- `BehaviorPanelHeader.tsx`
- `SceneBehaviorPanel.tsx`
- `views/AppBehaviorOverlay.tsx`
- `styles/centers.css`
- `styles/base.css`
- `SceneBehaviorPanel.test.ts`

### 发布浏览工具栏

- 工具栏改为底部居中的紧凑横向工具条。
- 高级视图、漫游、显示功能在“更多”中展开，不再产生高大的空白竖栏。

主要文件：

- `styles/scene-workspace.css`
- `components/PublishedViewerToolDock.tsx`（结构沿用，样式重做）

### 明暗主题

- `SystemBrandingSettings` 新增 `themeMode: "dark" | "light"`，默认深色。
- API 对旧配置做兼容归一化。
- 品牌设置增加深色/浅色选择，预览同步。
- 文档根节点写入 `data-theme` 和 `color-scheme`；主要壳层、面板、工具栏和弹窗增加浅色变量覆盖。

主要文件：

- `packages/contracts/src/index.ts`
- `apps/api/src/system.ts`
- `branding/documentBranding.ts`
- `BrandingSettingsPage.tsx`
- `styles/base.css`
- `styles/platform-pages.css`

### Web 与 Windows 登录稳定性

Web 根因有两个，均已处理：

1. `ServerClient` 过去会对任何 401 调用 `onUnauthorized`，包括未携带登录令牌的公共请求。现在只有请求实际携带当前令牌才进入会话失效流程。
2. Web 过去收到一次业务 401 或启动时 `/auth/me` 任意失败就清空令牌并跳登录。现在业务 401 会使用同一令牌直接请求 `/api/auth/me` 二次复核；仅复核明确返回 401 且令牌没有变化时才退出。断网、5xx、公共请求 401 均保留令牌。启动恢复会话遇到断网/5xx 时每 2 秒重试，不显示登录页。

Windows 客户端还有第三个根因：旧 `TauriHostAdapter` 完全忽略 `remember` 参数，只把令牌放内存。现在：

- 新增 `get_auth_token`、`set_auth_token`、`clear_auth_token` 三个最小权限 Tauri 命令。
- remembered token 使用 Windows DPAPI 当前用户加密后原子写入 `auth-token.bin`，不把 bearer token 明文放进 WebView 存储。
- 桌面连接门禁启动时恢复加密令牌；退出登录/明确失效时删除密文文件。
- Rust 测试验证磁盘内容不包含明文、可解密恢复、可删除。

主要文件：

- `packages/server-sdk/src/serverClient.ts`
- `packages/server-sdk/src/serverClient.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/hooks/useAppLifecycleEffects.ts`
- `apps/web/src/adapters/tauriHostAdapter.ts`
- `apps/web/src/adapters/tauriHostAdapter.test.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/Cargo.lock`
- `apps/desktop/src-tauri/build.rs`
- `apps/desktop/src-tauri/capabilities/desktop-main.json`
- `apps/desktop/src-tauri/permissions/autogenerated/*_auth_token.toml`

## 4. 已完成的真实视觉验收

在 `http://127.0.0.1:5174/?__visualQa=dashboard` 验证：

- 默认显示“页面与图层”。
- `.dashboard-page-tabs` 数量为 0。
- 工具栏 `clientWidth = 744`、`scrollWidth = 744`、`overflow-x = visible`。
- 页面无常驻“空格/中键平移”长文，无“联动诊断”。
- 五个资源分类按钮均 42px 高、文字 `white-space: nowrap`。
- 媒体分类显示“上传图片”和“上传视频”。
- 模板库共 120 个 `article`；第一张卡片为 276×286px，无骨架空白。

在 `http://127.0.0.1:5174/?__visualQa=viewer` 验证：

- WebGL 场景 1280×720 正常渲染 120 个对象。
- 深色地面、弱化网格和坐标轴生效。
- 页面无横向溢出。

## 5. 已通过的自动验证

- `pnpm --filter @bim-studio/web test`：313 个测试文件、1,105 项测试全部通过（包含最后一次会话启动重试修改）。
- UI 聚焦：6 个文件、21 项测试通过。
- `@bim-studio/server-sdk`：4 个文件、54 项测试通过。
- Web 桌面/浏览器鉴权适配：2 个文件、9 项测试通过。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：5/5 通过。
- Web、API、contracts、server-sdk 类型检查通过。
- `pnpm quality:source-size`：1,628 个源文件均不超过 800 行，无豁免。
- `git diff --check` 通过。

## 6. 当前工作树边界

- 本轮尚未提交，也未推送；所有变更都在 `dev-studio` 的工作树中。
- 工作树中这些改动属于本轮交付，不应丢弃或从头重写。
- 不要把 `apps/desktop/src-tauri/target/` 加入 Git；它是 Rust 本地构建产物。
- 本轮没有执行全仓生产构建、安装包重打或在线发布；这些属于正式发布门禁，不代表上述产品修复未实现。
- 换模型后若只继续功能开发，先跑聚焦检查即可；准备正式发布时再跑 `pnpm verify:release` 和桌面 bundle 验证。

## 7. Zcode 接手检查

```powershell
Set-Location 'D:\Documents\bim\bim-studio'
git status --short --branch
git diff --check
pnpm --filter @bim-studio/web typecheck
pnpm --filter @bim-studio/web exec vitest run src/adapters/tauriHostAdapter.test.ts src/adapters/browserHostAdapter.test.ts src/components/DashboardWorkspace.test.tsx src/components/SceneBehaviorPanel.test.ts src/components/SceneManagerView.test.tsx src/components/WorkspaceRecoveryDialog.test.tsx src/studio/workspaceRecoveryStore.test.ts src/delivery/sceneViewerDelivery.test.ts
pnpm --filter @bim-studio/server-sdk test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm quality:source-size
```

全部通过后才能继续修改。若失败，先判断是否为现有工作树回归；不要通过删除测试或恢复旧 UI 来“修复”。

## 8. 继续开发时的检查清单

- 修改 2D：同时检查 1280×720 和较窄窗口，保证画布工具栏、左右面板、资源分类不溢出。
- 修改模板：断言真实卡片数量和首卡高度，不能只断言 DOM 中存在 skeleton。
- 修改脚本：同时验证手动保存、自动保存、2D/3D 目标、分屏拖动、悬浮和独立窗口。
- 修改鉴权：严格区分 401、网络异常、5xx 和公共接口；任何清空令牌的路径必须有明确服务端 401 证据。
- 修改 Tauri 命令：同步更新 `build.rs`、capability、autogenerated permission 和 Rust/TS 测试。
- 修改主题：必须同时看深色和浅色，检查文本对比度、硬编码背景、弹窗遮罩和输入控件。
- 每次重要修改同步更新 `docs/active-task-recovery-ledger.md`，避免再次依赖聊天上下文。
