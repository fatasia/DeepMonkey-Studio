# SIM-1a 本轮中间态 · 2026-09-05

> 最新状态：最小闭环源码、功能及最终主题验收已完成。权威四组浏览器 gate 为 `scene-plant-flow-2R3HHn`；队列参数展开、浅 980 时间线与深 1440 回放已目视确认。早期目录及“尚未验证”仅为恢复过程记录，以本段及末尾为准。主代理已集成源码本地提交 `c77c503`；本文件与 spec 最后证据由其另行统整，不自行 stage/commit。

负责人：Codex agent_recovery。工作目录 `D:\Documents\bim\bim-studio`，分支 `dev-studio`。只本地提交、不 push；账号、环境、存储、原场景未改。主代理统一构建，子代理不能重建共享 dist。

## 当前范围

已有实体树/静态路径不重做。本轮最小闭环：对象绑定 source / queue-buffer / station / sink → 显式 flowLink → 既有 Plant Lite → 原 Study API → 同一回放器驱动临时场景覆盖层。不写仿真算法、不另建结果存储，不包含认证动力学/OLP。停靠/自动隐藏暂不扩展。

## 已写，尚未验证

- `packages/contracts/src/simulationEntities.ts`：可选新增 flowNode 实体。
- `packages/contracts/src/plantLiteModel.ts`：可选 sceneBinding 权威运行快照，兼容旧模型。
- `apps/web/src/controllers/sceneSimulationController.ts`：同场景替换配置、历史记录。
- `apps/web/src/controllers/sceneImportRebinding.ts`：flowNode 对象重绑。
- `apps/web/src/components/SceneSimulationEntitiesSection.tsx`、`SceneSimulationEntityInspector.tsx`：新实体展示/检查器。
- `apps/web/src/components/SceneFlowNodeFields.tsx`：复用既有分布编辑工具的参数控件。
- `apps/web/src/simulation/scenePlantModel.ts`：编译为既有 PlantLiteModel，引用失效显式错误。
- `apps/web/src/simulation/sceneSimulationOverlay.ts`：旧静态路径适配器跳过 flowNode。

## 阶段更新：源代码接线完成，等待统一构建与浏览器验证

已新增 `ScenePlantQuickRun.tsx/.css`，真实 Study API、重复提交防护与卸载取消；`scenePlantPlaybackOverlay.ts` 固定缓冲区真实事件点位；`useScenePlantPlayback.ts` 清理；`PlantLitePlayback.tsx` 帧回调；`SceneTimelinePanel.tsx` 仿真轨道；`SceneSimulationPanel.tsx` 快速物流与保留高级入口；`AppStudioViewport.tsx` 同场景/同项目运行归属、覆盖层、署名接线。回放自动收起作者面板避免遮住视口。新增 `sceneBindingValidation.ts`，不改 DES 算法。

聚焦 Web 6 文件 24 测试通过（2026-09-05 23:25），覆盖编译/失效绑定/重复角色/旧模型/动态释放/导入重绑/陈旧编辑/面板尺寸/既有回放模型。后续 API 新测试、最终类型检查、真实浏览器仍待验证。

## 验收过程记录（最终状态见末尾）

1. API 真实运行/复现测试与 API/Web 最终 typecheck。
2. 主代理统一 build 后隔离真实浏览器 gate、截图及原作者配置无污染验证。
3. SIM-001 独立回填、显式自有路径本地提交。

## 验证与恢复

已验证：`pnpm --filter @bim-studio/web typecheck` 通过；Web 聚焦 6 文件 24 测试、API `src/scenePlantStudy.test.ts` 2 测试通过。主代理统一根构建已包含新包与 API，并另行维护全仓证据。浏览器沿用 `apps/web/scripts/isolatedStudioGate.mjs` 创建隔离 API、数据和 Chrome，不读浏览器 token、不写原业务场景。

若额度耗尽：先修到可构建，明确未验证边界；不要删除其他代理改动。旧 Agent 批已独立提交 `0967ef6`，不要重复建设或混入本批。

## 最终源码清单（供主代理集成，不包含其他代理文件）

```text
apps/api/src/scenePlantStudy.test.ts
apps/web/scripts/gate-scene-plant-flow.mjs
apps/web/src/components/PlantLitePlayback.tsx
apps/web/src/components/SceneFlowNodeFields.tsx
apps/web/src/components/ScenePlantQuickRun.tsx
apps/web/src/components/ScenePlantQuickRun.css
apps/web/src/components/SceneSimulationEntitiesSection.tsx
apps/web/src/components/SceneSimulationEntityInspector.tsx
apps/web/src/components/SceneSimulationPanel.tsx
apps/web/src/components/SceneTimelinePanel.tsx
apps/web/src/controllers/sceneImportRebinding.ts
apps/web/src/controllers/sceneImportRebinding.test.ts
apps/web/src/controllers/sceneSimulationController.ts
apps/web/src/controllers/sceneSimulationController.test.ts
apps/web/src/hooks/useScenePlantPlayback.ts
apps/web/src/simulation/scenePlantModel.ts
apps/web/src/simulation/scenePlantModel.test.ts
apps/web/src/simulation/scenePlantPlaybackOverlay.test.ts
apps/web/src/simulation/sceneSimulationOverlay.ts
apps/web/src/viewer/scenePlantPlaybackOverlay.ts
apps/web/src/views/AppStudioViewport.tsx
packages/contracts/src/plantLiteModel.ts
packages/contracts/src/simulationEntities.ts
packages/plant-lite-simulation/src/modelValidation.ts
packages/plant-lite-simulation/src/sceneBindingValidation.ts
docs/specs/SIM-001-simulation-in-editor-design.md
docs/SIM-1a-in-progress-checkpoint-2026-09-05.md
```

最后复测命令：`node apps/web/scripts/gate-scene-plant-flow.mjs`。前置主代理完成全包构建（包括 Plant Lite 包），普通开发服务不受影响。产物为 `test-output/codex-2026-09-05/scene-plant-flow-*/report.json` 及 `*-queue-parameters.png` / `*-single-timeline-playback.png`，最新目录以实际执行结果为准。

## 准确边界

- 已完成：真实源/队列/工位/汇快速参数、显式连线、保存刷新、失效引用报错、同一 Study 快照与种子复现、单播放器动态事件覆盖层、关闭清理。
- 本轮待办：停靠/autohide、关闭后从历史 Study 恢复编辑器回放、运输资源/连续 AGV 轨迹与空间热力、更完整统一轨道（本次不是全部 SIM-1a 已完成）。
- 项目级后验收：真实客户场景、大规模网络、复杂班次/故障资源池由原高级工作台继续提供，本次四对象夹具不扩大为任意项目承诺；客户端停止等待不能保证服务端未保存已完成 Study。
- 明确排除：新增仿真算法、独立结果仓、OLP、认证动力学、控制器矩阵；不改原场景变换。

## 最终验收结果

`node apps/web/scripts/gate-scene-plant-flow.mjs` 已在主代理最终生产 bundle 上退出 0，证据：`test-output/codex-2026-09-05/scene-plant-flow-2R3HHn/report.json`。dark/light × 1440/980 四组均通过，零意外控制台错误；仅 dark1440 既有显卡编译精度 warning 单列。新增仿真时间线文字对比度最低 dark **7.569:1**、light **7.525:1**，标题动作无横向溢出。

已目视：`light-980-queue-parameters.png`（容量 12 与完整表单边界）、`light-980-single-timeline-playback.png`（浅色 token 背景、完整播放/倍速/状态、事件点与可用视口）、`dark-1440-single-timeline-playback.png`（深色一致）。`git diff --check` 通过。

旧 `dwVwxQ` 是主题修复前功能基线，不是最终视觉验收。其他早期失败为 gate 选择器/夹具错误（菜单 role、实际 workspace 保存 URL、重复全局 scene id），已修正为真实 menuitem、真实保存按钮/事务请求、每组 UUID，未借此修改业务代码。场景快速路径只使用一个现有播放器；高级运营工作台原有独立回放并未整体迁入统一轨道，不能宣称所有仿真域都已统一。
