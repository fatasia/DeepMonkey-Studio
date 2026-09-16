# Dashboard 正式交付切片

本文件把[接手执行计划](codex-takeover-audit-and-plan-2026-09-16.md)批次 C 拆成可实施切片，供接手开发与验收使用。C1～C5 整项仍为 **本轮待办**，已验证的子片与剩余边界分别记录在各节。

原任务范围和完整完成条件仍以 [Deep2D 剩余任务表](deep2d-remaining-tasks-2026-09-16.md) P0-01、P0-03、P0-04、P0-06 及[终局方案](Deep2D-跨时代发布终局方案-2026-09-15.md)为准。本文件不删除文字、图片、KPI、表格、图表、筛选、阴影、页面外观、绑定和离线交付要求。P0-05/07/08 的三端事务、golden、像素与输入验收继续保留在原批次 D；相关代码变化时仍须回归。

## 接手时代码事实

- `apps/web/src/delivery/compileDashboardContent.ts` 只输出组件背景与限定形状；文字 pass 只解算样式和行框。对象状态仅有 degraded/blocked，`publicationReady` 固定为 false。调用集中在测试与 golden 生成，尚未接入正式发布消费方。
- `packages/contracts/src/dashboardDocument.ts` 已有完整作者快照、入口页及引用校验；`compileDashboardLayout.ts` 已派生稳定节点身份，不需重建作者文档。
- `packages/deep-engine/src/runtimePackage/chart.ts` 已有 ChartIR/sim 包；`player_content_chart_entry.rs` 已重建 Native 图表宿主。包 v4 明确禁止 chart 与 deep2d 并存，且只有单 chart 入口，无法直接表达完整多组件 Dashboard。
- `apps/api/src/applicationRoutes.ts` 已有应用发布与历史版本读取。Native 候选链路当前只处理 SceneSnapshot/models，尚无 Dashboard 编译、证据和产物接线。

以上是当前源码边界。历史二维窗口 smoke、固定 golden 或三维产物报告不能替代正式 Dashboard 发布证据。

## C1：Dashboard 组合运行合同

**状态：本轮待办。归属：P0-01/03/06 的共同前置。**

2026-09-16 进展：[包合同与 Native 组合宿主](dashboard-composition-runtime-2026-09-16.md) 已提交并验证。[通用资源准备基础](dashboard-resource-prewarm-2026-09-16.md) 已分离三维 bake 依赖并提交。Web 已新增隐藏画布 WebGPU 准备、整页原子 publish、Deep2D path/atlas 绘制及真实包探针；真实 C2 包候选提交、tick、空诊断与控制台清洁均已浏览器验证。双动态图表的 Web 真实 GPU 页面和完整输入/换页矩阵仍待补齐，C1 全项保持待办。

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

2026-09-16 进展：[冻结字体 producer](dashboard-frozen-text-producer-2026-09-16.md)、[文字/图片编译子片](dashboard-frozen-raster-content-2026-09-16.md) 与[冻结数据内容子片](dashboard-frozen-data-content-2026-09-16.md) 已通过独立闭包、真实 Native 与 GPU 验证；表格冻结首列有序绘制与六类图表 Web/Native 几何对照已提交。真实 C2 包的 7/9 双柱共享零基线并通过 Native 像素分析，WebGPU 页面也已目检。筛选、完整页面外观及运行行为仍待补齐，本项保持待办。

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

2026-09-16 进展：已提交纯冻结合同，绑定 publication/application/revision、同 revision 文档指纹、canonical 数据 hash、字体/图片实际 bytes hash、资源 revision、消费者节点、私有对象 key、字体 face/license 与预算；候选准备前后和提交前均复核 authority/resource，33 项专项与 Application 回归通过。该模块采用注入式 reader，尚未接入正式存储、路由和发布下载链，C3 全项保持待办。

把 DashboardDocument 绑定至权威 Application 发布版本，冻结作者组件、数据绑定结果和字体/图片闭包；候选生成及提交均校验作者 revision，草稿变化不得污染已发布版本。

关键源路径：`packages/contracts/src/{dashboardDocument,dashboardDocumentReferences}.ts`、`apps/api/src/applicationRoutes.ts`、`apps/api/src/scenePublicationDependencyCapture.ts`、`scenePublicationDependencyStore.ts`、`prepareNativeSceneCandidate.ts`、`packages/studio-core/src/sceneClientResources.ts`。

依赖：复用现有应用保存/发布/版本读取、私有对象存储和资源哈希校验。Scene 资源选择器以 scene 为根，不能给纯 Dashboard 虚构一个场景；应抽取实际共用的资源读取机制，保留两种作者根的语义。

验收：保存→刷新得到同一作者 revision；编译中或提交前修改作者/资源则拒绝旧候选；修改草稿资源不改变已发布产物；字体许可缺失、签名 URL、超预算、取消、401/5xx 和断网有明确失败路径。

现有测试：`applicationRoutes.test.ts`、`scenePublicationDependencyCapture.test.ts`、`scenePublicationDependencyStore.test.ts`、`prepareNativeSceneCandidate.test.ts`。

## C4：权威能力报告与三种 hash

**状态：本轮待办。归属：P0-04。**

2026-09-16 进展：已提交 Dashboard 专用证据合同，以 C3 冻结候选作为唯一 authority/闭包；sourceSemanticHash 绑定 authority 与 freeze manifest，compileGraphHash 绑定服务器 compiler 身份与配置，targetArtifactHash 取实际 artifact bytes。Native 窗口收据必须同时匹配 authority/revision、三 hash、设备指纹、fixture 与冻结字体 hash/face；未被窗口实测覆盖的编译对象只能 degraded。39 项冻结/能力/Application 回归及 API 类型检查通过。正式候选服务、路由、存储 manifest 和下载接线仍待 C5，C4 全项保持待办。

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

## C1 实现合同草案：Dashboard 根 v1 / 运行包 v5

**状态：本轮待办。以下是实现对齐设计，尚无产品实现或验收证据。** 仅增加组合容器和严格引用规则；不新增作者文档、图表语言、loader、资源下载协议或脚本执行器。C2～C5 与原 P0 验收保持原范围。

### 版本与包入口

新增 `DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION = 5`、资源 kind `dashboard-runtime`，根载荷 schema 为 `deep-engine.dashboard-runtime`、schemaVersion 为 `1`。运行包 v5 保留现有 schema、packageId、packageVersion、resources、payloads、packageHash、materialBindings 字段；entrypoints **精确包含**：

```ts
{
  renderPacket: string;
  environment: string;
  shaderPackages: readonly string[];
  deep2d: null;
  chart: null;
  chartSim: null;
  dashboard: string;
}
```

v5 的唯一二维入口是 dashboard；其下资源通过根引用，不能同时占用顶层入口。C1 是纯 Dashboard 配置：renderPacket 保留现有空场景占位，geometry/material/instance/texture 均为空，shaderPackages 与 materialBindings 均为空，environment 使用现有 builtin 默认值；不接受 camera 字段或 scene-camera 资源。这样复用现有包外壳和预热，不引入尚无需求的二维/三维混合视口。

兼容规则必须按 `schemaVersion === n` 分支，不能把 v5 当作 `>= 4` 的单图表包。旧 v1～v4 builder、序列化和 wire golden 不变；v1～v4 拒绝 dashboard 字段及新资源 kind。既有 `buildDashboardRuntimePackage({deep2d})` 仍输出旧静态包，新建组合 builder，不隐式升级旧调用方。

当前差异：TS `runtimePackage/validation.ts` 的 `hasCamera = schemaVersion === 3`，v4 的字段白名单及资源 kind 均禁止 camera；Rust `runtime_package/validate.rs` 的 `chart_era >= 4` 则允许 v4 camera。这是既有不对称，不能把“v4 两端都支持 camera”写进设计。C1 分别锁定旧行为，新增 v5 两端一致拒绝 camera 的用例；旧 v4 差异另列兼容修复，不借 v5 放宽或改变旧 wire。

### 根载荷的精确字段

所有字段必填；nullable 字段不得省略；对象拒绝未知字段。下述类型是 wire 字段说明，不是新导出的产品 API。

```ts
type DashboardRect = readonly [number, number, number, number]; // x,y,width,height
interface DashboardRuntimeV1 {
  schema: "deep-engine.dashboard-runtime";
  schemaVersion: 1;
  id: string;
  revision: number;
  documentId: string;
  documentRevision: number;
  entryPageId: string;
  pages: readonly DashboardRuntimePageV1[];
}
interface DashboardRuntimePageV1 {
  id: string;
  width: number;
  height: number;
  nodes: readonly DashboardRuntimeNodeV1[];
}
interface DashboardRuntimeNodeV1 {
  id: string;
  revision: number;
  frame: DashboardRect;
  clip: DashboardRect | null;
  zOrder: number;
  visible: boolean;
  hitId: string | null;
  deep2d: string | null;
  chart: string | null;
  chartSim: string | null;
}
```

- 根 id/revision 必须等于资源索引；revision、documentRevision、node.revision 为 `1..Number.MAX_SAFE_INTEGER`。documentId 是冻结 Application metadata.id 的原值，非空 UTF-8、最多 256 字节，拒绝控制字符；documentRevision 是该作者版本。C3 在发布 manifest 校验作者身份，C1 不添加第二份作者快照或可信能力声明。
- 根/资源 id 复用现有 runtime resourceId 规则。页面与节点使用 `compileDashboardLayout.ts` 已有的确定性 `page.<sha256>` / `node.<sha256>` 身份；相同 app/page/sourceNode 输入得到相同 id，不把 revision 或数组位置编码进 id。pages 按作者页面顺序保存，entryPageId 必须命中一个页面；根内页面 id 唯一、节点 id 全局唯一。作者原始 id 的映射保留在编译报告，不能靠拆分哈希反推。
- page width/height 为有限正数，最大 16,777,216；frame 的 x/y 绝对值及 width/height 不超过同一界限，尺寸必须为正。坐标统一使用页面逻辑像素，原点左上。节点内容以 `(0,0)` 为局部原点，通过 frame.x/y 平移；frame.width/height 是实际内容布局尺寸，禁止暗中缩放另一尺寸的 ChartIR。ChartIR 本身没有视口字段；组合宿主必须用 frame.width/height 构造 ChartRuntime，替代旧单入口 assemble 中固定 640×360 的尺寸。C1 不新增节点旋转/嵌套 transform；现有 Deep2D 内部 transform 原样保留。
- clip 是**节点局部**矩形，有限坐标、正尺寸，同一数值界限；null 表示无节点外层裁剪。最终裁剪为页面矩形、外层 clip（若有）与内容内部 clip 的交集。frame 不隐式裁剪，避免吞掉合法阴影。绘制和命中使用同一变换与交集。
- zOrder 是 i32。producer 将 nodes 按 `(zOrder, id)` 升序序列化，validator 检查顺序；绘制同序、命中反序，同 z 不依赖语言排序稳定性。一个节点是连续绘制组：先 deep2d 静态底层（容器、阴影、背景），后 chart 动态内容；需要上层静态装饰时输出独立节点，不允许跨组插队。隐藏节点不绘制、不命中，但仍校验依赖和预算。
- hitId 为 null 则节点整体不接输入；非空则必须等于 node.id，避免第二套可串节点身份。命中返回 `{pageId,nodeId,hitId,subHitId}`，前三者由组合宿主填入，subHitId 来自局部内容，可为 null。静态 quad 缺少内部命中标识时仅返回节点身份；动态图表保留自身 action/series/data 身份，不能把两个图表相同的局部 id 当作全页 id。布局 letterbox 逆变换后再按节点局部坐标测试。换页/换包成功后，旧页面的 focus、capture 和迟到输入不得转交给新节点。

### 静态、动态资源及唯一所有权

每节点 deep2d/chart 至少一个非空；chartSim 非空必须同时有 chart。deep2d 引用既有 `deep2d-runtime` v1/v2，chart 引用既有 `chart-runtime` v1，chartSim 引用既有 `chart-sim-runtime` v1；资源信封 id/revision/hash 与索引一致，内部结构继续调用原 validator。sim.fixture.chartId 必须匹配**本节点所引用 ChartIR 的内部 id**，不是包资源 id。

静态图表可以作为 deep2d 产物；需要 tooltip、数据刷新、legend 等行为的图表必须保留 chart 引用。不能用静态像素替代动态验收。图表自身背景与节点静态底层由 producer 明确分工，不能双画同一背景。

引用闭包固定为 `entrypoints.dashboard → pages[].nodes[] → deep2d/chart/chartSim`，无任意依赖图、跨包 URL、节点互引或页面互引。每个引用必须存在且 kind 精确匹配；**每个资源只有一个所有者**：顶层角色、组合根或一个节点字段。相同资源 id 被两个节点/页面引用即拒绝；未引用资源拒绝；同一内部 ChartIR id 在根内也必须唯一，避免 sim 与宿主路由歧义。不可用复制 payload 到根的方法绕过索引。

资源只存在于外层 resources/payloads，根只存 id。加载结果持有资源表，节点持资源句柄；不要同时在页面、节点、`PlayerContent.chart` 和组合宿主各存一份 ChartRuntime。旧单图表入口使用原字段；v5 的独立组合宿主持有按 node.id 索引的图表状态。Deep2D atlas 仍由原载荷拥有，不在 C1 拆出新 atlas kind；缓存可按已验证的 hash 复用不可变 bytes/GPU 句柄，不能共享不同节点的可变图表状态。

### 预算和事务

沿用包上限：输入 256 MiB、JSON 节点 2,000,000、深度 32、资源总数 132；组合根、空 renderPacket 和 environment 同样计数。C1 新增组合限额建议为 32 页、全包 128 节点、全包 32 个 chart；这是明确拒绝阈值，不是性能通过声明，TS/Rust 用共同边界 fixture 锁定。节点底层/图表/sim 各自占一个资源，资源上限先触顶即拒绝，不能按页面重新获得 132 额度。

各载荷继续遵守现有 ChartIR/Deep2D 限额；另对包内静态 atlas 解码字节累计应用既有 64 MiB 上限，防止拆成多节点绕过单载荷预算。活动页拼接后，命令/路径/quad/atlas 和动态文字产物必须再次通过现有最终帧及 GPU 字节预算，不能只验证每个图表。预热继续使用 `prewarmPlan` 的现有 item/byte 限额，在 RESOURCE_ORDER 中新增组合根且排在依赖资源之后；资源按 id 记账一次。非活动页也必须完成结构、hash、引用及解码预算校验；其 GPU 内容允许换页时按原预热事务准备。

包替换、换页与图表更新共用既有 candidate/LKG：validate → closure → prewarm → build frame → present → commit。全页候选同时冻结静态节点、各 ChartEpoch、资源句柄和命中索引；只有整页 present 成功才一起交换。单图表数据更新可复用其他节点不可变内容，但不能先提交其 ChartEpoch、游标或命中再等待全页 present。任意节点失败/超预算、取消、device epoch 变化或迟到候选都丢弃整页候选，旧画面、旧命中、旧图表数据及 sim 时钟仍保持；成功后才推进 replay checkpoint/LKG。候选身份至少绑定 packageHash、pageId、宿主 candidate generation 及 device epoch，这些是宿主事务状态，不新增可由包伪造的 wire 字段。

### 最小实施顺序与必须新增的证据

1. TS types/validator/builder 与 Rust envelope/types/payloads 同步增加精确 v5 分支；保留旧静态 builder。先补双语言共享的两页、静态内容加双 chart/sim producer golden，旧 v1～v4 fixture 文件不重写。
2. 补严格失败矩阵：缺字段/null 差异、未知版本/kind、重复节点/ChartIR id、跨页复用资源、缺资源/错 kind、sim 串图表、未引用资源、坏 hash、宿主布局尺寸与 frame 不匹配、非法 clip/排序、每项预算边界。v4 camera 差异用独立测试说明，v5 两端必须同判。
3. 在现有 prewarm 和 PlayerContent 组合宿主接线，补双图表独立动作、局部 clip、重叠 z/hit、letterbox 坐标、换页焦点/迟到事件，以及第二图表失败时旧页全保持。复用现有真实窗口/GPU车道验证，CPU golden 不代替 present/LKG 证据。

C1 只在结构和宿主事务验收后完成；文字/图片/KPI/表格/筛选真实内容、发布三种 hash、权威冻结和正式离线下载仍按 C2～C5 逐项交付。
