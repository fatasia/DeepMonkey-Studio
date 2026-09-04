# 夜间全面测试与极致优化执行方案

状态：执行方案 v1（GLM-5.3 白天规划，夜间 GLM-5.3-Flash 免费时段执行）
日期：2026-09-04
适用分支：`dev-studio`，接手基线提交 `821ca74 fix: polish editors and stabilize sessions`

## 1. 目标与范围

用户 2026-09-04 目标原话：**"页面、性能、交互体验 优化到极致，可以全面对标 thingjs、山海鲸、帆软，部分对标 Unity、西门子 PS/PD/Plant。"**

本方案把该目标转化为夜间可执行的测试与优化任务。范围边界：

- 只做修复、补齐、验证和轻量重构，遵守总计划 §28.1 范围冻结，不新增功能域。
- 对标结论只作为内部质量门槛，产品源码、页面、模板、素材名不出现竞品名称（AGENTS.md 品牌门禁）。
- 上一轮（2026-08-31 冻结范围）已全部闭环；本轮是新的体验极致优化轮，验收基准是 `docs/industrial-studio-product-experience-roadmap-2026-09-02.md` 的批次 DoD 与 `docs/market-feature-comparison-2026-08-26.md` 的"仍缺什么"列。

## 2. 基线状态（2026-09-04 白天已验证）

在 `821ca74` 上全部通过，夜间可直接开工：

- `pnpm --filter @bim-studio/web typecheck` 通过。
- 交接聚焦 UI 测试 8 文件 30 项、server-sdk 54 项、桌面 Rust 测试全部通过。
- `pnpm quality:source-size`：1,628 个源文件全部 ≤800 行，无豁免。
- `git diff --check` 通过；工作树干净，与 `origin/dev-studio` 同步。
- API 生产服务健康（`http://127.0.0.1:4100`），Web 开发服务器运行中（5173）。
- 交接文档基线状态已更新：`docs/zcode-glm53-handoff-2026-09-04.md` §6/§7。

## 3. 测试面清单

### 3.1 页面与工作区（完整路由，自研路径解析 `src/appRoute.ts`）

| 路径 | 页面组件 | 说明 | 夜间必测 |
|---|---|---|---|
| `/`（默认兜底） | SceneManager.tsx (488) | 场景管理：场景卡、搜索、发布、复制 | 双主题 × 3 分辨率 |
| `/studio/:projectId/applications/:appId/pages/:pageId` | DashboardWorkspace.tsx (**799**) | 2D 工作区：页面与图层、资源库、模板库、吸附 | 1280×720 与窄窗口无溢出 |
| `/studio/.../scenes/:sceneId`、旧式 `/studio/:sceneId` | AppStudioShell.tsx (647) | 3D 编辑器：场景树、检查器、剖切、爆炸、测量 | 双主题，控制台零错误 |
| 脚本编辑器（编辑器内 Overlay） | ProfessionalCodeEditor.tsx (**645**) | 多文件、AI、依赖、Git、分屏 | 保存语义与 2D/3D 一致 |
| `/projects/:projectId/applications/:appId/topologies/:topologyId` | TopologyEditorPanel(View).tsx (510/**783**) | 节点、连线、2.5D、扩展属性 | 100+ 节点平滑 |
| `/data` | DataCenter.tsx (**645**) | 连接、管道、数据集、接口发布 | 向导式主链 10 分钟 |
| `/vision` | VisionCenter(Workspace **690**/Dialogs **641**) | 图片/视频源、ONNX 任务、事件 | 任务卡输入/输出完整性 |
| `/operations?task=maintenance\|commissioning\|battery\|logistics\|energy\|whatif` | OperationsCenter.tsx (**765**) | Study、虚拟调试、物流、What-if | 首屏风险优先层级 |
| `/optimizer` | ModelOptimizer.tsx (**760**) | 减面、Draco、贴图、光照烘焙 | 可取消、结果校验 |
| `/branding`（仅 admin） | BrandingSettingsPage.tsx | 主题深/浅、Logo、系统名 | 主题切换全站生效 |
| `/view/:sceneId`、`/published/:sceneId` | AppStudioShell + PublishedViewerToolDock | 保存版与发布版浏览；另有 viewer-only 独立交付构建（`src/delivery/SceneViewerRoot.tsx`，离线 mock） | 底部工具栏、匿名读取 |
| `/docs/:documentId?` | DocsCenter.tsx | 15 篇离线指南（standalone 模式，绕过连接门禁） | 术语与当前 UI 同步 |
| `/system`（仅 admin） | SystemCenter.tsx (480) | 用户、健康度、审计、AI 配置 | 非管理员权限视图 |
| 登录/会话恢复 | DesktopConnectionGate 等 | 二次复核、断网重试 | 见 §5 专项 |

### 3.2 自动化门禁（全部夜间重跑，含前置条件）

| 门禁命令 | 覆盖 | 前置条件/备注 |
|---|---|---|
| `pnpm typecheck` | 21 个工作区类型 + 体量门禁 | 先跑，快 |
| `pnpm test` | 全仓测试（基线 2,078 项；web 侧 304 个同目录测试文件） | 约 20-40 分钟 |
| `pnpm build` | 全仓生产构建 + bundle 预算 + API smoke | 以下四个门禁依赖构建产物 |
| `pnpm --filter @bim-studio/web gate:production-artifact` | dist 无 QA 标记泄漏（`__visualQa` 等） | 需构建 |
| `pnpm --filter @bim-studio/web gate:product-browser` | 3 档视口、25 次场景切换、图像相似度、画质区域评估、运营工作流 | 需构建；Playwright 驱动本机 Chrome（`BIM_STUDIO_CHROME_PATH` 可指定） |
| `pnpm --filter @bim-studio/web gate:online-flow` | 起真实 api+web 生产产物：离线恢复、Worker 崩溃注入、Unity、AskData、拓扑、键盘、发布等 30 步 | 需构建；最大 E2E，核心链路 |
| `pnpm --filter @bim-studio/web gate:asset-material-flow` | 素材/材质闭环 | 需构建 |
| `pnpm --filter @bim-studio/web gate:data-center-flow` | 数据中心页面流 | 需构建 |
| `pnpm --filter @bim-studio/web gate:webgpu` | 强制 WebGPU 后端的 product-browser | 需构建；双后端短时资源/画质/恢复 |
| `pnpm --filter @bim-studio/web gate:viewer-soak` | 长稳浸泡（默认 480 分钟！） | **必须设 `BIM_STUDIO_SOAK_MINUTES=10~15` 短时跑**，8 小时已被用户排除 |
| `pnpm --filter @bim-studio/web benchmark:render-engines` | three-webgl vs three-webgpu，静态/动态 × 120/1000 对象、几何一致性容差 | 记录数字入报告 |
| `pnpm test:unity-bridge` | Unity 桥接与离线包一致性 | |
| `pnpm quality:public-brand` | 品牌隔离 | 改动 UI 后必跑 |

### 3.3 视觉验收页（开发模式专用）

`http://127.0.0.1:5173/?__visualQa=<mode>`，mode ∈ `dashboard` / `viewer` / `commissioning` / `operations-planning`。夹具在 `src/visualQa/`（含 industrialWorkflowFixtures），用于稳定复现固定场景做像素级检查。生产构建默认不含 QA 分支（`VITE_VISUAL_QA` 控制），`gate:production-artifact` 会阻断泄漏。

### 3.4 代码体量与已知薄弱点（2026-09-04 盘点）

- **18 个组件超 500 行预警线**（800 为阻断线）：DashboardWorkspace 799、TopologyEditorPanelView 783、OperationsCenter 765、ModelOptimizer 760、DashboardInspectorData 760、DashboardWidgetVisualization 711、VisionCenterWorkspace 690、DataEndpointStudio 675、DataPipelineStudioParts 672、CloudRenderControl 660、ProfessionalCodeEditor 645、DataCenter 645、VisionCenterDialogs 641、BatteryIntelligencePanel 579、InteractionFlowInspector 561、DataCenterForms 550、TopologyEditorPanel 510、SceneManagerView 508；另有 api.ts 792、App.tsx 781、AppPlatformRoutes.tsx 737。DashboardWorkspace 799 已逼近阻断线，**本轮禁止再向其添加职责**。
- **浅色主题是容器白名单覆写**（`base.css` 54-83 行只重定义部分容器表面），非全量令牌化——双主题巡检时的重点风险，发现浅色下硬编码背景/对比度问题按 U 类问题记录。
- `src/hooks/` 9 文件 2,137 行**零测试**；`components/` 346 文件扁平无子目录（重组属升级项，不夜间动）。
- 设计令牌齐全：`base.css` `:root` 定义表面/分隔线/文本/品牌青 `--accent-primary:#3ec6c1`/语义色/圆角/间距/阴影，全局基字号 13px，暗色默认。
- viewer 引擎为 mixin 分层（Contract→Core→Interaction→Rig→Simulation→Bim→ObjectState→Pointer），性能监控模块齐全（framePerformanceMonitor、gpuFrameTimeMonitor、mainThreadLongTaskMonitor、RendererDiagnosticsPanel 等），夜间性能检查优先复用这些既有设施，不新造轮子。

## 4. 对标差距 → 夜间检查映射

来源：`market-feature-comparison-2026-08-26.md`"仍缺什么"列 + 体验路线图差距总表。只列夜间可验证/可修复项：

### 4.1 页面与交互（全面对标山海鲸/帆软/ThingJS 的编辑与看板体验）

| # | 检查项 | 对标来源 | 验收标准 |
|---|---|---|---|
| U1 | 全站术语一致性（资源/组件/素材、设置/系统管理、确认/审批） | 路线图 P0 | 静态扫描无冲突术语；无"审批/多环境"残留文案 |
| U2 | 返回/关闭/Esc/浏览器后退规则统一 | 路线图 P0 | 所有二级页左上返回；编辑器逐级返回不丢上下文 |
| U3 | 保存/自动保存/加载/空态/失败态表达一致 | 路线图 P0 + 用户硬性要求 | 2D/3D/脚本三处保存语义一致；失败均有重试 |
| U4 | 无名图标按钮、treeitem 语义、键盘走通核心流程 | Unity Inspector/Hierarchy 规律 | WCAG 2.2 AA 基础项；场景树完整键盘操作 |
| U5 | 左右面板收起按钮交互和位置全站统一 | 用户硬性要求 | 2D/3D/脚本/拓扑一致，收起后画布真实扩展 |
| U6 | 页面无常驻说明废话 | 用户硬性要求 | 必要信息走 title/悬浮层/上下文错误反馈 |
| U7 | 4K 看板在 980px、125% 缩放、300 组件压力 | 对标矩阵 #2 | 无关键入口越界、编辑不卡顿 |
| U8 | 空项目、空场景、空数据、断网各页面状态 | 帆软报表空态规律 | 每页有可理解空态和下一步动作 |
| U9 | 中英文切换全站完整性 | 既有能力 | 主页面无漏翻译、无中英混排错位 |

### 4.2 性能（部分对标 Unity 的运行时与诊断）

| # | 检查项 | 对标来源 | 验收标准 |
|---|---|---|---|
| P1 | benchmark:render-engines 数字与上次对比不回退 | Unity Frame Timing 思路 | WebGL/WebGPU P95 ≤7.5ms 量级，记录入报告 |
| P2 | 3D 控制台无产品可控警告（阴影 API 弃用、着色器精度） | 路线图 P2 | gate 运行后控制台零警告 |
| P3 | 长资源列表（1,510 项）DOM 压力与滚动流畅 | 路线图 P2 | 滚动 60fps 量级；必要时虚拟化（升级项） |
| P4 | 场景切换/工作区切换内存与显存残留 | 对标矩阵 #13 | viewer-soak 通过；切回后无累积 |
| P5 | 首屏分块与预算不回退 | 既有门禁 | bundle budget 全绿 |
| P6 | 2D 编辑/运行态在 1024/1366/1440 的交互延迟 | 闭环报告基线 | P95 ≤8ms 量级不回退 |

### 4.3 一致性与连贯性（对标图扑统一 DataModel 思想）

| # | 检查项 | 验收标准 |
|---|---|---|
| C1 | 2D→3D→脚本→拓扑往返上下文保持 | 选择、草稿、视口、返回路径完整 |
| C2 | 跨页面设计令牌一致（颜色/间距/字号/圆角/阴影/状态色） | 双主题下无硬编码背景、对比度达标 |
| C3 | 同一动作在不同页面交互语言一致（多选/右键/拖拽/撤销） | 与 Unity "命令同一化"规律对齐 |
| C4 | 发布/预览/浏览三态所见即所得 | 同一份数据与渲染规则 |

### 4.4 工业深度（部分对标西门子 PS/PD/Plant，只验证不扩张）

| # | 检查项 | 验收标准 |
|---|---|---|
| I1 | Plant Lite / PS Lite / PD Lite 聚焦测试全绿（plant-lite 5、workcell 9、ppr-lite 3、factory-flow 11、virtual-commissioning 4） | 不回退即达标 |
| I2 | 统一 Study 谱系、复现、证据链浏览器走查 | 歧义场景不猜测绑定 |
| I3 | 机器人轨迹预览、工位碰撞、节拍结果定位 | 结果可定位到 3D 对象 |

### 4.5 明确不做（夜间同样禁止）

- 新功能域、新引擎、新格式集成、FineBI 级语义建模、插件市场生态（对标矩阵中属产品缺口而非本轮范围）。
- 8 小时 WebGPU 长稳、工业格式真实转换验收、电池上线、Fathom、Docker、Rust sidecar 等 §28 排除项。
- ApplicationDocument 与旧 SceneSnapshot 并存的架构合并（记录为升级候选，不夜间动）。

## 5. 专项：登录与会话稳定性（用户硬性要求）

Web 与 Windows 客户端不能因公共接口 401、网络波动或临时服务错误退出登录。夜间用在线门禁 + 定点故障注入验证：

1. `gate:online-flow` 全链路含登录/刷新恢复。
2. 手动验证：启动恢复时断网 → 保持凭据自动重试；业务 401 → 二次复核后才退出；5xx/网络错误不清令牌。
3. 相关代码不许无证据修改：任何清空令牌的路径必须有明确服务端 401 证据（交接文档 §8）。

## 6. 夜间执行阶段（任务驱动，非时钟驱动）

按序执行；任何阶段发现的问题先记录入问题清单，修复循环集中在阶段 D，避免边测边修导致门禁基线漂移。

### 阶段 A：全量自动化门禁（预计 2.5-3.5 小时，含构建）

```powershell
Set-Location 'D:\Documents\bim\bim-studio'
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @bim-studio/web gate:production-artifact
pnpm --filter @bim-studio/web gate:product-browser
pnpm --filter @bim-studio/web gate:online-flow
pnpm --filter @bim-studio/web gate:asset-material-flow
pnpm --filter @bim-studio/web gate:data-center-flow
pnpm --filter @bim-studio/web gate:webgpu
$env:BIM_STUDIO_SOAK_MINUTES='12'; pnpm --filter @bim-studio/web gate:viewer-soak
pnpm --filter @bim-studio/web benchmark:render-engines
pnpm test:unity-bridge
```

每个门禁结果（通过/失败 + 关键数字）记入 `test-output/nightly-2026-09-04/report.md`。失败先判断是环境问题还是代码回归，环境问题（端口占用、服务未起）可自行处理，代码回归进问题清单。

### 阶段 B：真实浏览器 UX 巡检（预计 2-3 小时）

对 §3.1 全部页面执行：

1. 深色 + 浅色双主题各过一遍（`/branding` 切换）。
2. 分辨率 1280×720、1440×900、1920×1080；2D 加测 980px 窄窗。
3. 每页记录：控制台错误/警告、横向溢出、小于 12px 文字、小于 28px 点击目标、无名控件、死按钮。
4. 键盘走查核心流程：场景树导航、2D 画布、对话框 Esc/焦点。
5. 空态/错误态抽查：空项目、空场景、删除数据源后、断网（DevTools offline）。
6. 截图存 `test-output/nightly-2026-09-04/`，命名沿用 `NN-页面-状态.png` 规范。

### 阶段 C：对标专项（预计 1-1.5 小时）

按 §4.1 U1-U9、§4.3 C1-C4 逐项检查并记录；§4.2 P1-P6 取阶段 A 数字比对；§4.4 I1-I3 跑聚焦测试 + 浏览器走查。

### 阶段 D：修复循环（剩余全部时间）

问题清单按优先级排序修复，每修一项：

1. 根因定位（禁止表面修补；已反馈问题不得反复返工——AGENTS.md）。
2. 修复 + 聚焦测试（改动文件对应的最小测试集）。
3. UI 改动必须有真实浏览器截图证据（交接文档 §2 硬性要求）。
4. 修完 5 项或涉及公共样式/品牌时，加跑 `pnpm quality:public-brand` 和相关门禁。

### 阶段 E：收尾（09:00 前必须完成，不可挤占）

1. 回归：改动涉及的聚焦测试 + `pnpm --filter @bim-studio/web test` + `pnpm typecheck` + `pnpm quality:source-size`。
2. 更新 `docs/active-task-recovery-ledger.md`（新增第 13 节：本轮夜间执行记录、问题清单、修复状态、升级清单）。
3. 更新本方案文档的执行状态。
4. 提交：信息格式 `fix: <领域> <一句话>`，一次连贯提交；不推送由用户决定。

## 7. GLM-5.3-Flash 决策规则（夜间执行模型）

### 直接修（有把握，测试可验证）

- 孤立 CSS 布局/溢出/间距/字号问题，模板和令牌已存在的样式补齐。
- 缺失的 `title`/`aria-label`/控件名称、treeitem 语义补齐。
- 术语/文案不一致（按 U1 术语表）、残留"审批/多环境"文案清除。
- 控制台错误有明确单一根因（如弃用 API 替换、事件监听泄漏）。
- 空态/错误态缺失但同页面已有可复用模式。
- 测试失败且根因明确指向单个文件。
- 图片/视频/背景上传入口缺失但有既有上传链路可复用。

### 记录升级清单（不夜间修，写入总账第 13 节）

- 超过 300 行的新拆分或对 >500 行文件的职责重构（§3.4 的 18+3 个文件；DashboardWorkspace.tsx 799 已贴阻断线，夜间只减不增）。
- 需要基准对比才能验证的性能优化（长列表虚拟化、渲染管线、资源生命周期）。
- 浅色主题全量令牌化改造（当前容器白名单覆写，涉及 30+ CSS 文件梳理）。
- `src/hooks/` 补测试、components 扁平目录重组等结构性治理。
- 跨模块状态管理、ApplicationDocument 单事务化等架构项。
- 鉴权语义相关（除 §5 列出的明确验证外）。
- 需要产品决策的交互改版（信息架构调整、导航结构）。
- 任何拿不准的：宁可记录，不许猜测式修改。

### 绝对禁止

- `git reset --hard` / `git checkout -- .` / `git clean` / 丢弃或重写现有改动。
- 删除或跳过测试来"修复"失败；恢复旧 UI 来消除报错。
- 新增功能域、新依赖、新页面入口。
- 竞品名称进入产品源码/页面/模板/素材名。
- 把固定夹具结果写成任意客户场景结论；把"未验证"写成"已完成"。

## 8. 证据与产物规范

- 夜间产物统一目录：`test-output/nightly-2026-09-04/`（报告、截图、门禁输出），不进 Git。
- 报告模板：`report.md`（门禁结果表）、`issues.md`（问题清单：编号/页面/现象/根因/修复状态/升级标记）、`escalations.md`（升级清单，供 GLM-5.3/GPT-5.6 白天处理）。
- 总账第 13 节只保留经核验的结论：做了什么、证据在哪、什么没做、为什么。
- 用户消息不改变方向，作为输入记录；遇到方向性歧义按本方案和 AGENTS.md 默认规则执行，并在报告中注明。
