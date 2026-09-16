# Dashboard 正式交付切片

本文件把[接手执行计划](codex-takeover-audit-and-plan-2026-09-16.md)批次 C 拆成可实施切片，供接手开发与验收使用。状态均为 **本轮待办**；本次只读核对代码，不代表功能或发布验收完成。

原任务范围和完整完成条件仍以 [Deep2D 剩余任务表](deep2d-remaining-tasks-2026-09-16.md) P0-01、P0-03、P0-04、P0-06 及[终局方案](Deep2D-跨时代发布终局方案-2026-09-15.md)为准。本文件不删除文字、图片、KPI、表格、图表、筛选、阴影、页面外观、绑定和离线交付要求。P0-05/07/08 的三端事务、golden、像素与输入验收继续保留在原批次 D；相关代码变化时仍须回归。

## 当前代码事实

- `apps/web/src/delivery/compileDashboardContent.ts` 只输出组件背景与限定形状；文字 pass 只解算样式和行框。对象状态仅有 degraded/blocked，`publicationReady` 固定为 false。调用集中在测试与 golden 生成，尚未接入正式发布消费方。
- `packages/contracts/src/dashboardDocument.ts` 已有完整作者快照、入口页及引用校验；`compileDashboardLayout.ts` 已派生稳定节点身份，不需重建作者文档。
- `packages/deep-engine/src/runtimePackage/chart.ts` 已有 ChartIR/sim 包；`player_content_chart_entry.rs` 已重建 Native 图表宿主。包 v4 明确禁止 chart 与 deep2d 并存，且只有单 chart 入口，无法直接表达完整多组件 Dashboard。
- `apps/api/src/applicationRoutes.ts` 已有应用发布与历史版本读取。Native 候选链路当前只处理 SceneSnapshot/models，尚无 Dashboard 编译、证据和产物接线。

以上是当前源码边界。历史二维窗口 smoke、固定 golden 或三维产物报告不能替代正式 Dashboard 发布证据。

## C1：Dashboard 组合运行合同

**状态：本轮待办。归属：P0-01/03/06 的共同前置。**

最小切片：定义静态二维内容与多个动态图表的版本化组合、页面逻辑尺寸、节点资源引用、局部坐标与命中归属。复用 ChartIR、Deep2D、已有包校验、prewarm 和 LKG；不放宽旧 v4 的互斥规则，不引入第二套 loader。

关键源路径：

- `packages/deep-engine/src/runtimePackage/{types,builder,validation,chart,deep2d}.ts`
- `packages/deep-engine-native/src/runtime_package/`
- `packages/deep-engine-native/src/player_content.rs`
- `packages/deep-engine-native/src/player_content_chart_entry.rs`

依赖：确定组合根的身份、引用闭包、预算和旧版本拒绝规则，再实现双侧解析与宿主组合。当前 `PlayerContent.chart` 为单运行时，不能只改包 schema 而漏掉输入/更新消费方。

验收：旧包与旧 golden 不变；双图表在同页独立更新，组件布局和命中归属正确；重复节点、串页引用、缺资源、坏 hash、超预算与不支持版本拒绝；失败候选保留旧画面，只有整页成功 present 后提交 LKG。

现有测试入口：`runtimePackage/chart.test.ts`、`runtimePackage/dashboard.test.ts`、Native `chart_runtime_golden`、`dashboard_runtime_golden`、`dashboard_content_golden`。新增组合 golden 使用真实 producer，不能手写期望包冒充编译输出。

## C2：完整内容与资源编译

**状态：本轮待办。归属：P0-01。**

按资源链顺序补文字/图片，再补冻结数据上的 KPI、表格、筛选与图表组合，最后核对组件阴影及页面外观。文字必须产出真实字形/atlas，图片必须带校验后的真实像素；数字来源必须是明确绑定或作者数据，不能猜值。

关键源路径：

- `apps/web/src/delivery/{compileDashboardContent,dashboardWidgetContent,dashboardTextContent,dashboardShapeContent}.ts`
- `packages/deep-engine/src/deep2dDisplayList.ts`
- `packages/deep-engine/src/runtimePackage/deep2d.ts`
- `packages/deep-engine-native/src/deep2d/{validate_text,painter_atlas}.rs`
- `packages/deep-engine-native/src/platform_text/` 与 `src/chart/presentation.rs`

依赖：C1 提供动态组合承载；文字资源链复用 P1-18/19 的必要合同和授权字体能力。Native 要求 atlasId+bakedGlyphs，当前 TS 裸 text 不能直接视为已支持。完整 OS IME 等 E 批任务不因本切片提前扩张。

验收：逐对象内容、布局、裁剪、z 序与命中一致；中文/组合字素、空值、长文本、缺字、坏图片、越界表格、绑定缺失均有结果或明确阻断；不得以仅背景的命令统计表示内容完成。视觉修改执行 design-taste-digitaltwin 的双轮截图与完整验收要求。

现有测试：`compileDashboardContent.test.ts` 明确断言文字无命令、KPI 不猜值；`dashboardTextContent.test.ts`、`compileDashboardLayout.test.ts` 和 Native 内容 golden。实现后应更新已实现能力的断言，同时保留缺资源/未知能力拒绝测试。

## C3：作者版本、绑定与资源冻结

**状态：本轮待办。归属：P0-03。**

把 DashboardDocument 绑定至权威 Application 发布版本，冻结作者组件、数据绑定结果和字体/图片闭包；候选生成及提交均校验作者 revision，草稿变化不得污染已发布版本。

关键源路径：`packages/contracts/src/{dashboardDocument,dashboardDocumentReferences}.ts`、`apps/api/src/applicationRoutes.ts`、`apps/api/src/scenePublicationDependencyCapture.ts`、`scenePublicationDependencyStore.ts`、`prepareNativeSceneCandidate.ts`、`packages/studio-core/src/sceneClientResources.ts`。

依赖：复用现有应用保存/发布/版本读取、私有对象存储和资源哈希校验。Scene 资源选择器以 scene 为根，不能给纯 Dashboard 虚构一个场景；应抽取实际共用的资源读取机制，保留两种作者根的语义。

验收：保存→刷新得到同一作者 revision；编译中或提交前修改作者/资源则拒绝旧候选；修改草稿资源不改变已发布产物；字体许可缺失、签名 URL、超预算、取消、401/5xx 和断网有明确失败路径。

现有测试：`applicationRoutes.test.ts`、`scenePublicationDependencyCapture.test.ts`、`scenePublicationDependencyStore.test.ts`、`prepareNativeSceneCandidate.test.ts`。

## C4：权威能力报告与三种 hash

**状态：本轮待办。归属：P0-04。**

将 sourceSemanticHash、compileGraphHash、targetArtifactHash 绑定真实发布 manifest、资源闭包与可信平台证据。逐对象区分 supported/degraded/blocked/webview-only；保留字段级缺口与内容覆盖，支持范围必须匹配 fixture、设备和字体身份。

关键源路径：`compileDashboardContent.ts`、`apps/web/src/delivery/scenePublicationCompatibility.ts`、`packages/contracts/src/scenePublicationCompatibility.ts`、`apps/api/src/nativeSceneCandidateService.ts`、`nativeSceneWindowVerifier.ts`。

依赖：C2 的真实产物与 C3 的不可变身份；复用 Native 候选服务的窗口验证和证据绑定。不得硬改 publicationReady，也不得复用三维 BoxTextured 证据放行二维对象。

验收：内容变化、编译配置变化、字体/图片变化正确影响各 hash；篡改目标、串 revision、串设备/字体证据和客户端自报 supported 均拒绝；无匹配证据的对象保持阻断。

现有测试：`compileDashboardContent.test.ts`、`scenePublicationCompatibility` 相关测试、`nativeSceneCandidateService.test.ts`、`nativeSceneWindowVerifier.test.ts`。

## C5：正式动态离线交付

**状态：本轮待办。归属：P0-06，并回归 P0-03/04。**

为现有候选编译与交付机制增加 Dashboard 输入分支，复用正常窗口验证、ZIP launcher、下载、恢复检查点。动态包必须由正式发布结果生成，不从开发 fixture 旁路导出。

关键源路径：`scripts/native-scene-compiler-worker.mjs`、`apps/api/src/{nativeSceneCandidateCompiler,nativeSceneCandidateRoutes,nativeSceneCandidateService,prepareNativeSceneCandidate}.ts`、`apps/api/src/publishedSceneBundle.ts`、`apps/web/src/delivery/sceneClientPackage.ts`、`scripts/lib/sceneClientArchive*`、Native 包加载与恢复入口。

依赖：C1～C4。保留现有 Web Application 发布，不以新 Native 通道破坏旧入口；复用的 Scene 命名接口应先检查真实输入约束，再做最小领域拆分。

验收：编辑→保存→刷新→发布→公开或授权读取→下载→同包离线正常窗口启动；至少双图表及静态内容真实交互；取消、坏 hash/schema、资源缺失、连续换包、恢复和回滚不污染旧版。正常窗口、64×64 smoke、纹理读回和系统截图分别留证，不相互替代。

现有测试：`nativeSceneCandidateRoutes.test.ts`、`nativeSceneCandidateService.test.ts`、`publishedSceneBundle.test.ts`、`sceneClientPackageFrozen.test.ts`、根 `test:scene-client`；新增实际 Dashboard 用户流及离线证据。

## 交付边界

五个切片只是原批次 C 的实施分解。完成单个静态组件或一个 ChartIR 页面不能关闭 P0-01/03/04/06；每片更新证据后再按原任务表判断完成状态。项目级 V-01～V-05 与全部后续任务保持有效。
