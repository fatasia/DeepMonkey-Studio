# GLM-5.3 交接文档：行业包/导出/V3 并行批次（2026-09-08）

> 交接对象：GPT-6。本文只记录本轮 GLM 会话的实际改动与验证状态，不重复既有总账。
> 权威入口不变：`docs/active-task-recovery-ledger.md`、`docs/continuation-checkpoint-2026-09-06.md`。
> 顺序仍按用户指令：**2 素材模板 → 3 填报导出 → 6 仿真AI → 1 V3 → 4 UI → 5 Vapor → 7 终验**；用户最新指令为 2/3/1 三项并行。

## 一、工作树状态（先看这个）

`bim-studio` 内层仓有两批未提交改动，均为本轮及前会话合法产物，**未 commit**：

1. **前会话遗留（非本轮）**：`sceneApplicationSync.ts` V3-P2 根因修补（剥离 3 个发布字段，聚焦测试 6/6 过）、`dashboardReportXlsx.ts/.test.ts/DashboardReportExport.tsx`（Excel 导出，已接线在 `DashboardWidgetVisualization.tsx:188`，3/3 测试过）、`vapor-mode-performance-plan-2026-09-06.md`、`shader-workbench-integration-plan-2026-09-06.md`（GLM 前会话规划稿）。
2. **本轮新增**（下文详列）。

## 二、本轮已完成（代码层）

### 第 2 项：行业深度包首包（制造设备运行包）

新增文件（均在 `apps/web/src/components/`）：

| 文件 | 职责 |
|---|---|
| `industryTemplatePackTypes.ts` | 包合同 + `validateIndustryTemplatePack` 校验器（引用完整/入口存在/工作流可达/包级联动参数一致；孤立页、断链、缺模板均抛错） |
| `industryPackSampleApply.ts` | `applyPackPageSample`：给布局工厂 9 节点绑示例数据；筛选器用**包级固定 key**（跨页联动靠它），数据组件共享页面级 sourceId（整组改数） |
| `industryPackManufacturing.ts` | 首包定义（5 页：生产总览→设备健康→告警处置→质量分析→维护计划，环形工作流）+ 5 份手工示例数据（A 线稳定/B 线质量损失/C 线老化告警的连贯故事） |
| `industryTemplatePackCatalog.ts` | 目录聚合，**模块加载时强校验**，坏包直接抛错不进目录 |
| `industryTemplatePackCatalog.test.ts` | 8/8 通过（含坏包拒绝、9 节点绑定、sourceId 独立、双语标题） |

接线改动：
- `dashboardContentController.ts`：新增 `insertIndustryPack(packId)`，每页一条插入命令（独立撤销单元）。
- `DashboardWorkspace.tsx`：解构与返回对象透出（两处，Python 脚本改的，注意核对）。
- `DashboardWorkspaceTemplateLibrary.tsx`：分类下拉新增"行业深度包"，包卡片（跨两列、动线展示、guide 进悬浮提示、搜索过滤）。
- `DashboardTemplateLibrary.css`：`.dashboard-template-pack` 样式。

**联动机制**（已实测有效）：filters 是会话级跨页保留（`ApplicationPlaybackState`），同包所有页 filter widget 共享同一 key（如 `pack:manufacturing-asset-ops:line`）+ 同名数据列（"产线"）→ 任何一页选 B，全部页联动。

**公共合同扩展**：`packages/studio-core/src/command.ts` 的 `createInsertDashboardPageCommand` 加了可选第三参 `index`（缺省追加，向后兼容）；`commandReducer.ts` 对应 splice。用途：**空应用导包时入口页插到 index 0**，因为发布无 profile 时公开页回退 `pages[0]`（`publishedApplicationModel.ts:14`），这样匿名页直达包入口。studio-core 测试全过。

### 第 3 项：导出与打印

- **Excel**：前会话已完成并接线（CSV+Excel 双按钮在报表组件，防重入、错误人话、OOXML 转义、16384 列/百万行拒绝），3/3 测试过，**无需重做**。
- **图片导出 PNG**（新）：`dashboardPageImageExport.ts` + `DashboardRuntimePreview.tsx` 控制面板"导出图片"按钮。
  - **重要教训**：先写的零依赖 SVG foreignObject 方案在 Chrome 必败（SVG-as-image 静态模式禁外部资源，`图片光栅化失败`），改用 **html-to-image@^1.11.13**（已 pnpm add，MIT，gzip ~4KB）解决。toBlob 按设计分辨率导出，transform 重置防缩放留白。
  - 测试 2/2 过；**浏览器实测已产出有效 PNG**（magic 0x8950、>20KB，见门禁输出）。
- **打印页眉页脚**（新）：`DashboardRuntimePreview.tsx` 加 `.dashboard-print-header`（应用名/页面名/本地化时间）与 `.dashboard-print-footer`（示例声明），`DashboardPrint.css` print-only fixed 每页重复；`@page` margin 改 `10mm 8mm` 并用 margin box `counter(page)/counter(pages)` 页码（Chrome 131+，不支持时静默缺失）。
  - **同步改了** `dashboardPrintLayout.ts` 的 marginY=10（原来上下也是 8，不同步会缩放偏差），6/6 测试过。
  - **修了一个真冲突**：既有打印净化规则 `.dashboard-runtime-preview > :not(.dashboard-runtime-surface) { display:none }` 会藏掉页眉，已加 `:not(.dashboard-print-header):not(.dashboard-print-footer)` 例外。

### 第 1 项：V3 修复（部分）

- **V3-P4 日志可读性（完成）**：新增 `serviceLogFormat.ts` + 测试 8/8 过，接线 `SystemObservabilityPanels.tsx`。pino JSON（`request completed · {"level":30,...}`）→ `request completed GET /api/projects 200 3.15ms`；解析失败保留原文；审计用户列 UUID 归"系统"（`formatAuditActor`）。
- **V3-P3 重名场景提示（预防项完成）**：`SceneManagerView.tsx` 场景卡标题后条件渲染 `TriangleAlert` 小图标 + title 显示同名数量（`duplicateSceneNames` Map 统计）；样式 `managerSceneCards.css` `.scene-card-duplicate`。**数据去重工具本身未做**（需用户确认清单，见 V3 报告工单）。
- **V3-P2 返回二维**：根因修补在前会话遗留 diff 里（`sceneApplicationSync.ts` 82-84 行剥离 publicationMode/publicationPerformance/publicationToolbarVisible），检查点已声明真实根因在此、**不是** V3 报告推测的 desktopLocalApi。浏览器复验在门禁脚本 C1 段，**未跑完**（见下）。
- **V3-P1 /view 刷新降级**：代码排查到 `useAppSceneSyncEffects.ts:245-273`（view/published 加载 effect 有错误处理，疑似 `engine` 依赖时序问题导致 fetch 永不触发）。门禁 C2 段会输出 `viewRefreshReproduced` 复现取证字段，**未跑完**。

## 三、门禁脚本（最重要交接物）

`apps/web/scripts/gate-industry-packs.mjs`（新增，自包含隔离环境，两轮×深1440/浅980）：

流程：建项目场景 → 清空首页 → 模板库"行业深度包"分类 → 断言包卡片动线 → 导入 → 断言 6 页签/9 节点/共享联动 key → 保存 → 浏览态筛选 B 联动（920/82%/2/96%）→ **图片导出断言 PNG magic** → 返回编辑 → 发布 → 匿名页断言 2600/联动 C→600 → print 模拟断言页眉页脚 → C1 返回二维无 schema 错误 → C2 /view 刷新复现取证。

**调试状态**：A 段（导入/保存/联动/图片导出）已逐项跑通；最后失败在**匿名页 2600 断言**——根因已定位并修掉两处：
1. 发布无 profile 回退 pages[0] 空首页 → 已加 insert index 参数 + 空应用入口页置首；
2. 门禁脚本没清空首页 nodes → 已补 `authored.pages[0].nodes = []` 的 PUT（与既有 dashboard-samples gate 同款）。

**最后一次运行被用户取消（token 保护），修正后尚未复跑。接手第一件事：`cd apps/web && node scripts/gate-industry-packs.mjs`，从匿名页断言处继续看结果。**

已产出的有效证据目录：`test-output/codex-2026-09-05/industry-packs-*`（35y7qY 有 print-headerfooter.png；wFYG0P 有 runtime-filter-B.png 证明联动正确；HqLYca 有导出 PNG）。

## 四、验证状态（诚实条款）

- 聚焦单测：industryTemplatePackCatalog 8/8、serviceLogFormat 8/8、dashboardPageImageExport 2/2、dashboardPrintLayout 6/6、dashboardReportXlsx 3/3、sceneApplicationSync 6/6 全过。
- Web 全量：1647/1647 过；**1 个既有失败文件** `scripts/browserTextContrast.test.mjs` 是 node:test 脚本被 vitest 误收集（"No test suite found"），`node --test` 实跑 fail 0，**非本轮回归**，之前会话的报告未提及此差异，建议 GPT-6 核实收集口径。
- 根 typecheck：EXIT 0。Web 构建：3.4s 通过（既有大 chunk 提示不新增）。
- **浏览器门禁：未完整通过**（如上，A 段实跑通过、断言逐步修绿中被打断）。视觉闭环 ≥2 轮未完成，不宣称 Kimi-95。
- 163 模型视觉审核、扩到 10 包/300 页、填报写回、第 6/4/5/7 项：未动。

## 五、GPT-6 下一步（按优先级）

1. 跑完 `gate-industry-packs.mjs`（构建已是最新），修剩余断言直至 4/4 两轮，人工复看截图（视觉闭环第二遍）。
2. V3-P1 若 C2 复现：修 `useAppSceneSyncEffects` view 加载（engine 未挂载时也应 fetch 或给出可见错误+重试）。
3. 本批本地 commit（建议拆三个：行业包+index 命令、导出+打印、V3-P4/P3；V3-P2 修补与 Excel 归属前会话可合入对应提交）。**严禁 push**。
4. 回填 `active-task-recovery-ledger.md` 与 `continuation-checkpoint-2026-09-06.md`（本轮新增文件与门禁状态）。
5. 之后按总顺序继续第 2 项剩余（扩包、163 模型审核）→ 第 3 项剩余（填报校验写回——合同语义：作者示例数据≠业务填报，填报需权限/冲突处理，见 dashboard-sample-verification 待办段）。

## 六、坑与纪律提醒

- html-to-image 是**本轮唯一新依赖**（用户授权"任务范围内可直接实施"口径下加的，交接时在提交说明里声明）。
- `DashboardWorkspace.tsx` 有两处 Python 脚本改的透出点，review 时注意 LF/CRLF。
- 包示例数据列名是**数据层标识不随 locale 翻译**（中文"产线"），标题/筛选器名本地化——与 applyProductionSample 行为不同但有意为之（数据一致性优先），测试里有断言锁住。
- 隔离门禁的登录密码是 `isolated-field-flow-admin`，不动正常 admin/admin。
- 本批未改 .env/拓扑/原场景/GPT 接入，协作仍排除，第3/6项旧暂停项仍暂停。
