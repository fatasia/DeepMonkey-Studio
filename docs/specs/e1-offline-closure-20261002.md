# E1 断网整机闭包验收（2026-10-02）

任务表 61 行 E1：断网整机闭包——安装包→导入→仿真→报告→保存重开→证据与录制复盘。
依赖 C/H/T24 均已收口；本地离线依赖；估时 4-8h。本文档为该行唯一规格与证据索引。
证据目录：`test-output/e1-offline-20261002/`。

## 现状核查（六步，2026-10-02 执行）

| 步骤 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 1. 全仓 grep（offline/断网/host-resolver-rules/OBJECT_STORE/录制） | `apps/web/scripts/gate-online-flow.mjs`（793 行）+ 17 个 `onlineFlow*.mjs` 模块的完整 e2e 骨架；`onlineFlowRecovery.mjs` 的 `verifyOfflineWorkspaceRecovery`；`DashboardOfflinePackage*`、`audio/offlineAudioAudit.ts` 等离线特性；`apps/api` 的 `OBJECT_STORE`（config.ts / productionConfig.ts / serviceObservability.ts）已有 local 口径 | 全仓无任何 `--host-resolver-rules` 使用；不存在"断网下整机八步闭包"的 runner |
| 2. 契约层 | contracts 已有 `EventRecordingFile/EventRecordingManifest/assessEventRecording/attachRecordingEvidence/IndustrialStudyRecord`、`WhatIfStudyRequest/WhatIfStudyRecord`（studio-core `evaluateWhatIfOperatingEnvelope`，deterministic-local-elasticity-envelope 引擎，全本地） | 无缺 |
| 3. 依赖 | playwright-core（`apps/cloud-render-worker/node_modules/playwright-core`，gate 既有取用路径）、本机 Chrome、node:http 静态服务、Rapier WASM（ScenePhysicsPanel）已在用 | 无新依赖 |
| 4. 消费方 | C4：`EventRecordingPanel` ← `OperationsCenter` "现场监控" tab（路由 `/operations`），录制 API `POST/GET /api/projects/:id/data/recordings[/...]`（eventRecordingRoutes.ts，临时文件原子落盘）；仿真：`ScenePhysicsPanel`（Rapier 真实 step，工具坞"仿真与开发"菜单）与 `WhatIfOperatingEnvelopePanel`（"工况推演" tab，"运行并留证"）；报告：`SceneEngineeringAnalysisPanel`（"查看与分析"→"工程分析与导出"，客户端几何分析 + blob 下载）；保存：`保存项目`→`PUT /workspace`；导入：`input[type=file][accept*=.glb]`→`POST /api/projects/:id/models` | 无缺，全部真实消费方在产品 UI 可达 |
| 5. 测试与证据 | `test-output/online-flow/`（既有在线流证据）；`check-production-artifact.mjs` 生产包门禁；各面板 vitest（EventRecordingPanel.test.tsx 等） | `test-output/e1-offline-20261002/` 不存在，本任务新建 |
| 6. 规格 | `docs/specs/jc-i-continuation-20261001.md`（只读，本行上下文）、`c8-full-chain-closure-audit-20261001.md`（闭包核查范式）、工业格式硬门槛计划 | 本文档即 E1 规格，此前不存在 |

**结论**：e2e 骨架、录制/仿真/报告/保存的全部产品入口、API local 对象存储均已存在（不重建）；
真实缺口只有一个——一个在"外网域名全部解析阻断、仅保留 127.0.0.1/localhost"的 Chrome 会话里，
把 安装包产物→启动→导入→仿真→报告→保存→重开→C4 录制与证据复盘 八步连续跑通并逐步留证的验收 runner。
本任务只建该 runner + 证据目录，不新增任何产品 UI/面板。

## 口径声明（硬约束）

- **禁 cargo**：`apps/desktop/src-tauri/target/` 下无既有安装包产物，Tauri 安装包构建跳过。
  采用与 `gate:online-flow` 相同口径：**生产构建产物**（`apps/web/dist`，2026-10-03 00:15 构建；
  `apps/api/dist`，2026-10-02 11:42 构建）+ 本地静态服务器 + 本地 API（`OBJECT_STORE=local`）。
  本地对象存储/元数据 JSON 全部落盘在证据目录 data/ 下，属"本地构建产物整链"而非"安装包整链"，如实登记。
- **断网方式**：Chrome 启动参数 `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`。
  不真断物理网卡。验收断言：全程任意外部域名 0 个成功响应；外部域名请求失败统一归类
  `expectedOfflineBlocks`，本地（127.0.0.1/localhost）请求失败才是缺陷。
- **禁帧时/性能测量**；**不 commit/push**；Chrome 实例与其他线串行、用完即关；
  不改 `packages/deep-engine/src/physics/`、`apps/web/src/ai|hooks`、`docs/specs/jc-i-continuation-20261001.md`。

## 闭包链路与验收门（每步证据 = 截图 + evidence.json 步记录）

| # | 步骤 | 验收门 |
|---|---|---|
| 0 | 产物准备 | web dist manifest 与 api dist 入口存在；fixture GLTF 落盘 |
| 1 | 断网证明 | `http://example.com` 与 `https://www.baidu.com` goto 失败（~NOTFOUND）；全程外部成功响应数=0 |
| 2 | 启动+登录 | API `/health` OK；本地服务器起服；admin 登录进入 `.scene-manager-page` |
| 3 | 建项目/场景 | 新建项目→新建场景→进入工作区；`POST /applications` 201 返回 application+scene |
| 4 | 导入模型 | 场景编辑器上传 `e1-offline-cube.gltf`→`POST models` 202→`waitForModelReady`→资源行载入→保存后 workspace.scene.models 引用该模型 |
| 5 | 仿真真实运行 | (a) 物理：Rapier 面板 启用→播放→2s 真实 step→状态按钮翻转；(b) What-if：`运行并留证`→确定性本地引擎产出 Study（含 result、execution.deterministic=true）。两项独立留证，任一失败如实记录 |
| 6 | 报告生成 | 工程分析 `运行分析`→产出结果→`空间报告 JSON` 下载落盘→JSON 含对象数/QTO 行 |
| 7 | 保存场景 | `保存项目`→`PUT /workspace` 200 |
| 8 | 重开验证 | 断网状态下 reload→登录态/项目/模型资源行/场景对象恢复；录制与 Study 同样断网可读 |
| 9 | C4 录制与证据复盘 | 建立录制（注入事件）→写入 2 事件→关闭录制段→导出录制 JSON（eventCount=2、integrityOk）→断网 reload 后从历史重开同一录制→选 What-if Study 导出证据副本 JSON（study+recording+assessment） |
| 10 | 汇总 | evidence.json：steps 全记录、console/pageErrors、expectedOfflineBlocks、0 外部成功；exit code |

失败处理：每步失败即停并如实写 evidence.json 与本文档"缺陷与修复"，不美化；
发现产品真缺陷→根因最小修复+回归测试；验收不通过的步骤保持 FAIL 记录。

## 执行记录（2026-10-02 实跑）

Runner：`apps/web/scripts/e1-offline-closure.mjs`（新增，复用 onlineFlowAuditSupport/onlineFlowProductServer）。
最终一轮 **exit 0，12/12 步 PASS**（evidence.json：`passed=true`、0 未分类 console error、0 pageError、
0 本地请求失败、**外部域名成功响应 0**、外部阻断探针 2/2 生效）。证据全部在 `test-output/e1-offline-20261002/`。

| # | 步骤 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | 断网证明 | PASS | `http://example.com` 与 `https://www.baidu.com` 均 `net::ERR_NAME_NOT_RESOLVED`（独立探针页）；全程 extSuccess=0 |
| 2 | 启动+登录 | PASS | 本地 API `/health` OK；Chrome 带 `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`；admin 登录进入管理页（01 截图） |
| 3 | 建项目/场景 | PASS | `POST /api/projects` 201、`POST /applications` 201（02 截图） |
| 4 | 导入模型 | PASS | fixture `e1-offline-cube.gltf`（仓内生成，runner 内置单位立方体）→`POST models` 202→ready→资源浮窗"项目资源"→"载入"进场景→`PUT /workspace` 200 且 `scene.models` 引用该模型（revision 2；03 截图） |
| 5a | 物理真实运行 | PASS | Rapier·WebAssembly 面板：已启用+暂停（=播放中）active 双确认，真实 step 2.5s（04 截图） |
| 5b | What-if 仿真 Study | PASS | `deterministic-local-elasticity-envelope` 引擎，`execution.deterministic=true`，含 inputFingerprint 与 result（whatif-study.json + 05 截图） |
| 6 | 报告生成 | PASS | 工程分析：对象 1/违规 0/工程量行 1/疑似开放网格 0，模型限高通过（最高点 1.000m＜4m）、体积 1m³/面积 6m²（单位立方体精确值）；"空间报告 JSON" 下载落盘（06 截图 + downloads/*.json） |
| 7 | 保存场景 | PASS | `PUT /workspace` 200，modelReferences=1（revision 3；07 截图） |
| 8 | 断网重开 | PASS | reload 后模型 `data-model-status=ready`、项目 API modelStatus=ready（08 截图） |
| 9 | C4 录制 | PASS | 建立注入录制→写入 2 事件（temperature=27/pressure=101.3）→关闭录制段→导出录制 JSON：eventCount=2、全段闭合（09 截图 + downloads/rec-*.json） |
| 10 | C4 重开+证据复盘 | PASS | 断网 reload 后从历史重开同一录制：段已闭合·无已知缺口、事件 2；Study 证据副本（产线速度筛查）导出：study.result=true + recording + assessment.integrityOk=true（10 截图 + downloads/*-study-evidence.json） |

## 异常甄别与登记（无产品真缺陷；以下均为文档化设计语义）

断网会话共出现三类异常，逐条甄别后均**不是缺陷**，runner 已按依据分类（保留原始条目于 evidence.json 的
`expectedConsoleErrors` / `expectedLocalRequestCancels`）：

1. `GET /api/scenes/:id/probe-bake?sourceHash=…` 404（console error ×5）：`apps/api/src/probeGridBakeRoutes.ts`
   头注明示"未命中 404（=无，调用方静默降级，不报错）"，内容寻址缓存未命中语义。
2. `GET /api/projects/:id/data/replay?windowMs=…` 400（console error ×3）：`apps/api/src/dataReplay.test.ts`
   声明的空项目空态（"neither retained events nor datasets provide data"），`DataReplayPanel` catch 后展示
   "暂无可回放数据"指引（10 截图右上面板可见），与 gate:online-flow 对 asset-catalog 503 的预期同类。
3. `POST /api/editor-scene-driver/:id/next|snapshot-request` `net::ERR_ABORTED`（×14）：`mcpApi.ts` 会话轮询
   携带 AbortSignal，页面导航/卸载时被 AbortController 取消的预期生命周期行为。

**产品观察（登记后继，不在 E1 修复）**：`gate-online-flow.mjs` 的资源行选择器
（`.asset-row`/`.asset-main`/`.mini-button`、"项目资源"开关）与当前产品 UI
（资源浮窗 `.scene-resource-floating` → "项目资源" scope → `.scene-resource-row[data-model-id]` → "载入"按钮）
已不一致，该旧 gate 疑似随 UI 演进过期。此文件被其他线共用且 793 行，按最小改动纪律不在本行修改，
登记为 gate:online-flow 维护者的后继项。

**Runner 侧（非产品）修复 2 处**：断网探针改独立页面（chrome-error 导航污染主页面导致 goto 互相打断）；
资源交互改用当前 UI 链路（见上）。

## 诚实边界（未验证/口径限制）

- **安装包口径**：禁 cargo，`apps/desktop/src-tauri/target/` 无既有安装包产物；本验收用 web/api 生产构建产物
  （web dist 2026-10-03 00:15、api dist 2026-10-02 11:42）+ 本地静态服务器，属"本地构建产物整链"，
  不能声称为"安装包整链"。Tauri 安装包链路的实机验收仍开放。
- **断网口径**：DNS 解析级阻断（host-resolver-rules），非物理断网卡/拔线；防火墙级直连 IP 流量不在阻断范围
  （产品全程 0 外部请求，观察面覆盖）。
- **物理证据层级**：Rapier 真实 step 以面板启用/播放状态 + 0 错误 + 截图为证；未断言刚体位移
  （单位立方体贴地静置，无预期运动），不冒充物理数值验证。
- **What-if 引擎**是确定性本地数学引擎（非 Rapier 物理非动画）；物理(5a)与仿真 Study(5b) 双独立留证覆盖
  "物理/动画至少一项"要求。
- api dist 构建时间早于 web dist（同日），整链实跑全程功能正常；未重建 api。
- 未 commit/push；Chrome 单实例用完即关；未动 `packages/deep-engine/src/physics/`、`apps/web/src/ai|hooks`、
  `jc-i-continuation-20261001.md`。

## 关闭声明

E1 行可登记为**已关闭**：断网（DNS 级阻断）条件下，本地构建产物整链
启动→登录→建项目/场景→导入→物理真实运行→确定性仿真 Study→工程报告下载→保存→断网重开→
C4 事件录制/关闭段/断网重开/Study 证据副本导出，12 步全部实测通过且逐步留证；
0 外部成功响应、0 未分类 console error、0 pageError、0 本地请求失败。
关闭范围排除项（安装包实机链路、物理刚体位移断言、gate:online-flow 选择器过期维护）已如实登记于上节。
