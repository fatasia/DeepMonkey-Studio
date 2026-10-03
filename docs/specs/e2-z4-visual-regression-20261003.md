# E2/Z4 全页面关键路径两轮深色 1080 视觉回归（2026-10-03）

> 61 行任务表 **E2/Z4 行**：「全页面关键路径两轮深色 1080；只修实际视觉回归」（8–16h）。
> 本刀完成 **21 页 × 2 轮** 深色 1280×1080 全页面巡检：round1 **21/21 PASS**、round2 **21/21 PASS**；
> 抓出并根因修复 **2 处真实视觉缺陷**（均为主文本对比度不可读/令牌误用），runner 自身迭代修 5 处；
> 0 pageError、未分类 console error 0（4 条 probe-bake 404 为文档化设计语义，逐条登记理由）。
> 证据：`test-output/e2-z4-20261003/round{1,2}/`（各 21 张 1280×1080 深色截图 + report.json）。

## 现状核查（开工前六步）

1. **既有基建（复用，不重建）**：隔离环境骨架 `apps/web/scripts/isolatedStudioGate.mjs`（独立端口/独立数据
   目录/OBJECT_STORE=local/spawn api dist，登录夹具齐备）；两轮视觉门先例 `g2-s2a-visual-gate.mjs`
   （深色锁定路由 + round 参数 + report.json 结构）；全页面走查先例 `gate-ui-report-20260905.mjs`
   （导航按钮 in-viewport/hit 断言、底色精确断言）；对比度探针 `browserTextContrast.mjs`
   （Canvas2D 色彩解析 + 透明祖先合成，`gate-agent-recovery` 等在用）。`test-output/` 下
   `g2-s2a-visual-20261002`、`hc6s1-ui-20261002`、`p4-browser-20261002` 等为既有验收证据，均不覆盖
   「全页面×两轮×深色」口径——该口径即本行真实缺口，runner 为本刀唯一新增文件。
2. **契约层**：`apps/web/src/styles/base.css` 深色默认（`:root` 即深色，`--bg-0 #0b1114` 冷灰族、
   `--accent #d6aa4d` 运行时可覆盖、`--on-accent` 实心品牌底对比文字专用令牌）；路由枚举
   `appRoute.ts` 14 view + ManagerWorkspaceTab 4 tab + system 8 tab + operations 7 tab。
3. **依赖**：playwright-core（cloud-render-worker 内）、Chrome `C:/Program Files/Google/Chrome/Application/chrome.exe`。
4. **消费方**：10+ 既有 gate 消费 isolatedStudioGate；本 runner 同构复用。
5. **产物新鲜度**：web dist 落后源码 14 文件（H-C5-K17/K15/K16/K18 AI 域在途批）→ 先
   `pnpm --filter web build` 重建（tsc 门 0 错，此前 p4-b5 登记的两在途 commands 文件已收口）；
   api dist（10-02 11:42）经 hc6s1-monaco（10-03 01:15）实证可用，且 `apps/api` build 链含
   `build-industrial-worker-host.mjs` **会 spawn cargo（本行禁 cargo）**，故 API dist 保持现有可用构建不重建；
   contracts/studio-core dist 新鲜。
6. **规格**：`docs/specs/jc-i-continuation-20261001.md`（只读）行定义核对；账本
   `docs/active-task-recovery-ledger.md` 无 E2/Z4 归属冲突；E1 行登记的 gate-online-flow 旧选择器问题
   与本行无涉（本 runner 自带选择器）。

## 页面清单（21，全部走真实用户路径进入）

| # | 页面 | 进入路径 | 核心在场断言 |
|---|---|---|---|
| 01 | 登录页 | `/` 未登录 | 用户名/密码/登录 |
| 02 | 项目工作台·项目场景 | 登录后默认 tab | 搜索/新建场景/tab 导航；**1280 宽全部导航按钮在视口内且 hit-test 可命中** |
| 03 | ·资源 | 一级导航「资源」 | tab active 态 |
| 04 | ·拓扑 | 一级导航「拓扑」 | 「新建拓扑」按钮 |
| 05 | ·示例场景 | 一级导航「示例场景」 | shell |
| 06 | 新建场景对话框 | 「新建场景」 | 标题/名称输入/创建并进入 |
| 07 | 二维工作区 | 场景卡「编辑场景」/创建并进入落地 | `.dashboard-workspace` + topbar |
| 08 | 三维编辑器 | studio 深链路由 | `.viewport canvas` + 左右面板（渲染稳定 2.5s 后截） |
| 09 | AI 助手面板 | 管理台「AI 助手」 | 面板 + 提问框（Esc 关闭验证） |
| 10 | 拓扑编辑器 | 拓扑 tab「新建拓扑」 | `.topology-editor` |
| 11–15 | 模型优化/参数化/数据中心/视觉中心/智能运营 | 各自导航入口→「返回场景管理」回 | 各页容器类 |
| 16–17 | 系统设置·用户/云渲染 | 「设置」→ 页内 tab | `.system-center-page` |
| 18 | 品牌设置 | 「品牌设置」 | `.branding-settings-page` |
| 19 | 使用文档 | 「文档」 | `.docs-center-page` |
| 20 | 场景浏览 | `/view/<sceneId>` 深链 | canvas + 初始化指示器消失后截 |
| 21 | 已发布浏览 | 卡片「发布场景」→发布对话框「发布」（等 POST 201）→`/published/<id>` | canvas |

studio 各面板（环境/灯光/物理/行为图/Monaco）已有专属两轮视觉门覆盖（`g2-s2a-visual-20261002`、
`p4-b5-lighting-20261002`、`hc6s1-monaco-20261003`），本行不重复堆面板截图，遵守页面简洁纪律。

## 每页统一断言包

1. **深色令牌生效**：`data-theme ≠ light`；shell 计算底色 ≠ `rgb(0,0,0)`（对标山海鲸「禁止纯黑裸背景」红线）；
   manager 系页面底色精确等于 `--bg-0` `rgb(11,17,20)`。
2. **核心交互元素在场且可见**（上表第 3 列）。
3. **无横向溢出**（`scrollWidth ≤ innerWidth+1`，布局破碎第一信号）。
4. **对比度**（复用 browserTextContrast，只测真实绘制的文本）：主文本（button/a/strong/th/label）≥4.5，
   全文（small/span/p/h1-3/td/summary/input/code）≥3.0 硬地板。空文本节点（图标位/状态点，color 不参与
   绘制）与全透明文本（ECharts 隐藏测量节点）剔除出测量域——首轮实测二者产假阳性（见 runner 缺陷③）。
5. **console 卫生**：pageerror=0；console error 逐条分类，白名单每条必须带理由：
   - `probe-bake` 404：`modelSceneApi.loadProbeGridBake` 注释明示「未命中（404=无）由调用方降级处理」，
     文档化设计语义（studio/dashboard/view/published 共 4 条，同一条 sourceHash）。
6. **manager 导航布局**：1280 宽下所有导航按钮 in-viewport + elementFromPoint hit-test（遮挡检测）。

## 发现并修复的真实视觉缺陷（2 处，均首轮抓出、两轮复检通过）

1. **拓扑编辑器「发布」主按钮文字不可读（对比度 1.86:1）**。
   `apps/web/src/components/TopologyEditorPanel.css:95` 实心品牌底主按钮写成
   `color: var(--text-faint)`（#738189 灰）叠 `background: var(--accent)`（#d6aa4d 金）——主 CTA 标签几乎不可见。
   **同族清剿**：全仓 `background: var(--accent)` 实心主按钮 15+ 处统一用 `color: var(--on-accent)`
   （base.css 专为此设的令牌：「实色品牌按钮的对比文字；品牌同步按亮度选择」），唯此处偏离。
   **修复**：`var(--text-faint)` → `var(--on-accent)`。溯源：该行来自旧批量 checkpoint（cd9850b1），
   非并行在途批引入；无测试引用。
2. **dashboard 面板计数徽标不可读（对比度 2.52:1，低于 3.0 硬地板）**。
   `apps/web/src/styles/dashboard-workspace.css:40` `.dashboard-panel-label small { color: #4f5c62 }`
   与 :158 `.dashboard-canvas-toolbar > span small`（同族共 2 处，全仓 grep 恰此两处）。
   深色 `--bg-0` 上 2.52:1；且 #4f5c62 为令牌外硬编码。**修复**：→ `var(--text-muted)`（深色 6.46:1）。
   诚实备注：浅色主题下该值 4.38:1（≥3.0 地板、略低于 4.5，为 10px 数字徽标）；原硬编码值浅色 6.05:1
   但深色 2.52:1 不可读——令牌化后双主题均过地板，深色主题大幅改善。
3. **聚焦测试**：`TopologyEditorPanel.test.tsx` + `dashboardTypographyBoundary.test.ts` 等 vitest 自动扩到
   相关 10 文件 **70/70 绿**；`pnpm --filter web build`（tsc + vite + bundle 预算）全门通过后重跑两轮。

## runner 自身缺陷（5 处，修复不放宽断言）

1. `getByLabel("搜索场景")` strict 冲突（label 包裹层与 input 双命中）→ 改 `input[aria-label=…]`。
2. 新建场景对话框无 `role="dialog"`（`form.dialog`）→ 按真实 DOM 定位。
3. 卡片「发布场景」实为打开发布对话框；且以 `body.innerText.includes("已发布")` 等发布完成会被
   场景状态筛选器的「已发布」选项文本假命中 → 改为对话框内「发布」按钮 + 等 POST `/publish` 201。
   （修复前 /published/ 的 404 是**未真正发布**所致，非产品缺陷——发布→浏览链路实为通。）
4. 对比度测量域误纳空文本装饰元素与全透明文本（dashboard 图标钮 3.6:1、studio `status-dot` 1.07:1
   假阳性）→ 剔除不可绘制节点，见断言包第 4 条。
5. viewer 页 2s 定发截在「正在初始化 WebGL」→ 补初始化指示器消失等待；summary 分类统计漏 url 字段 → 修。

## 两轮结果与一致性

- round1 **21/21 PASS**、round2 **21/21 PASS**；两轮均 0 pageError；console error 共 4 条/轮，全部为
  probe-bake 404（已分类，理由见上），未分类 0。
- 底色：21 页全部 `rgb(11,17,20)`（--bg-0），无纯黑裸背景，无浅色回退。
- 对比度：主文本最低 4.63（07-dashboard，修复后）/最高 7.72；全文最低 3.84（05-示例场景空态文案），
  两轮逐位一致。
- 截图哈希：6 页两轮逐字节一致；15 页差异全部归因**运行时刻文本**（场景卡「变更于 HH:mm」、AI 会话
  时间等，两轮相隔 9 分钟）与 3 个 canvas 页的 WebGL 帧噪声（08-studio/20-view/21-published，按设计
  不要求逐位一致）；对比度/布局指标两轮完全一致 → 判定**两轮一致，无回归**。

## 10 维度自评（design-taste-digitaltwin，以两轮截图证据为准）

| # | 维度 | 分 | 依据 |
|---|---|---|---|
| 1 | 布局构图 | 9.3 | 21 页无溢出、manager 导航 hit-test 全过、面板无遮挡（截图+断言） |
| 2 | 令牌一致性 | 9.0 | 21 页底色全等 --bg-0；修复 2 处令牌外硬编码/误用；登记未修项见下 |
| 3 | 排版 | 9.2 | 对比度全过地板；tabular 数字正常；未见意外截断 |
| 4 | 交互状态完备 | 9.0 | 空态全部带引导 CTA（manager/数据中心/拓扑/运营）；对话框焦点环在证据中 |
| 5 | 动效质量 | 9.0 | 本行未改动动效；截图未见动效破碎（详见诚实声明①） |
| 6 | 3D 渲染质量 | 9.0 | studio/view/published：网格渐隐+雾纵深（山海鲸空气感）、无纯黑裸背景；材质光照属专属行不重复验收 |
| 7 | 信息设计 | 9.2 | 数据中心/运营/设置信息分组清晰；空态文案可读 |
| 8 | 反馈即时性 | 9.0 | 发布流程 201 响应、初始化指示器、保存态徽标均在证据中 |
| 9 | 响应式与主题 | 9.0 | 深色 1280×1080 两轮实测；浅色本行范围外（行定义为深色），见声明③ |
| 10 | 语义与文案 | 9.2 | 未见中英混排/状态词冲突；probe-bake 降级为文档化语义 |

单维度均 ≥9，判过。打分证据：`test-output/e2-z4-20261003/round{1,2}/*.png`（42 张）。

## 登记观察项（不属本行修复范围，如实移交）

1. dashboard 深色存在一批令牌外硬编码灰（如 `.dashboard-layer-action` #66747b 图标 3.6:1、
   `.dashboard-panel-label` #6f7c83 4.44:1），均 ≥3.0 且为长期存量，不构成「不可读」回归；
   本行只修了低于 3.0 地板者。后续令牌收敛行可统一（同族范围已 grep 清点）。
2. `DashboardPlayback.css:51` 用 `var(--accent-contrast, #14191b)` 旧变量名（回退值视觉等价 on-accent，
   可读性不受影响）；建议后续统一为 `--on-accent`。
3. manager 03/10 页 `skippedUnpainted` 计 55/41（资源/拓扑页图标密集），其图标色 3:1 口径未单独断言
   （WCAG 非文本对比度），如需可作后续行。

## 如实声明（未验证/边界）

1. **动效质量与帧时序未实测**：本行禁帧时测量；动效维度仅凭静态截图与既有动效门（缓动体系）背书，
   未跑录像回放。
2. **浅色主题不在本行范围**（行定义为深色两轮）；浅色仅在做对比度双主题复核时桌面推算（#4f5c62 修复项），
   未跑浅色全页面截图。
3. **1920/480 等其他断点不在本行口径**（行定义 1080 级 1280×1080）；gate-ui-report-20260905 已有
   1440/980/800/480 断点先例可复用。
4. **api dist 未重建**：build 链含 cargo（本行禁），保持 hc6s1 实证可用的现有构建；API 侧今日并行批
   （T1/T4、N5）的新端点不在本次验证范围。
5. **发布产物深度**：21-published 验证发布→浏览链路视觉与 console 卫生；客户端打包（EXE/云会话）
   属其他行。
6. **禁 cargo 达成**（本线零 Rust 触碰）；**不 commit 不 push**；改动清单：
   `apps/web/src/components/TopologyEditorPanel.css`（1 行）、`apps/web/src/styles/dashboard-workspace.css`
   （2 行）、新增 `apps/web/scripts/e2-z4-visual-regression.mjs`（未跟踪）；`apps/web/dist` 为构建产物
   （gitignored）。受保护域（physics/、ai/assistantErrorFraming*、useAssistantChatRun*、useAiProjectContext*、
   rendererCapabilityUserFace*、editorSnapshotFetchBridge*、jc-i-continuation 文档）零触碰。

## 复跑方式

```bash
node apps/web/scripts/e2-z4-visual-regression.mjs 1   # 轮 1
node apps/web/scripts/e2-z4-visual-regression.mjs 2   # 轮 2
```

前置：`pnpm --filter web build`（隔离 gate 服务的是 dist）。Chrome 路径可用 `BIM_STUDIO_CHROME_PATH` 覆盖。
