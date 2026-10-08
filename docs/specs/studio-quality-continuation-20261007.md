# Studio 品质续作（2026-10-07）

按用户最新顺序：①处理逻辑/本体图谱版面与拖拽连线；②Deep 贴图、Native MegaLights、cluster-LOD、发布贴图、React/滑条、RT 二反弹和性能；③三引擎一致性与切换、发布全链和目标安装。以实际场景、实际后端和可溯源测量验收，保留其他会话改动。

## 现状核查

- 源码/未跟踪：当前图谱 ReactFlow 受控 nodes 没有变更回调，四向端口角色与方位算法不匹配，浏览器实际只显示 2/6 边；处理逻辑为 DOM 横排，保存/插入/删除调用 normalizeLinearPipeline，丢弃自由位置和拓扑。Native benchmark/MegaLights 有其他会话在途修改，不覆盖。
- 契约：ontologyGraph 已定义方向、证据、查询深度；data.ts 已定义节点 position、edges 和 merge。无需新增存储合同。
- 依赖：React Flow 12.12.0、Dagre 3.1.1、data-runtime 已有，零新增依赖。
- 消费方：DataPipelineStudio→API→executeDataPipeline 已有 DAG 拓扑排序、分支、merge 和循环/端口校验，真实缺口在作者端；图谱查询/筛选/聚簇/行动检查器已有。
- 测试/证据：已读 pipeline runtime 与编辑器测试、图谱 SSR/布局测试；当前真实页面 7 节点/6 契约边仅 2 条可见，用户图为基线。补自由位置保存、分支拓扑不变、连线拒绝、拖拽与全边可见测试。
- 规格：已读 13:36 交接、剩余复盘、基准专属交接、恢复台账；已加载 design-taste-digitaltwin、engineering-taste、testing-taste。

**已有（不重建）**：查询/检查器/聚簇、DAG 执行器、图引擎与布局依赖、品牌与双主题令牌。

**真实缺口**：图谱受控位置/全方向端口/平行与自环布线/容器 resize；处理流程自由画布/连接与重新连接/草稿拓扑保存/分支合并入口；嵌套滚动裁切、低对比和长字段显示。

## 设计与实现边界

Design Read：参考 KWeaver 官方 ADP 的对象/关系/行动分类和图谱拖拽、缩放、并行边处理；采用资产导航—主画布—详情检查器，令牌唯一来源 base.css，保留用户品牌。关系阅读优先，辅助信息折叠，相关断点与深浅主题两轮截图。

参考原文：
- https://github.com/kweaver-ai/adp/blob/main/bkn/README.zh.md
- https://github.com/kweaver-ai/adp/blob/main/web/src/pages/KnowledgeNetworkMain/Overview/index.tsx
- https://github.com/kweaver-ai/adp/blob/main/web/src/pages/KnowledgeNetworkPreview/index.tsx （process-parallel-edges、drag-element、drag-canvas、zoom-canvas、auto-fit；本次直接读取官方源码）
- https://reactflow.dev/learn/customization/handles
- https://reactflow.dev/learn/concepts/the-viewport

实现复用 React Flow/Dagre，不复制 KWeaver 代码或其固定色。图谱拖拽只改变本地阅读布局；处理流程位置和拓扑写入已有草稿合同。画布拖拽期间 state 留在画布，结束后一次提交作者草稿；保存不线性化。拒绝自环、重复边、循环、输出再出边、源节点入边和普通节点多输入；合并节点允许多输入。删除连线是可撤销的草稿编辑，保存/运行前调用权威 DAG 校验；未接完的拓扑保留在可撤销的本地草稿，服务端继续拒绝非法拓扑。

边界：异步加载/空图/筛选无结果/节点与边移除/重复连接/反向与多边/resize/键盘/Esc/品牌与主题/窄屏；不改用户本体语义或原始场景。GPU/Cargo/共享 dist 构建串行，第二阶段 Native 接管前重新核对文件归属。

## 进度和验收

- 第一阶段：拖拽画布、连接/改接、关系配置已实现，浏览器交互与主题/断点检查通过。
- 第二、三阶段：按上述顺序接续，未验收。
- 完成时回填聚焦测试、类型检查、浏览器交互、两轮截图、10 维评分、来源指纹和遗留项。

### 第一阶段验证（14:50 更新）

- 7 个 web 聚焦文件 67/67、2 个 API 文件 27/27。API 与 web typecheck 均通过。
- 真实页面：7 节点/6 边完整可见；处理流程移动后保存、重载位置不变；删除/重新连线、改接保留边 ID、撤销还原已有流程。拖 WorkOrder→Sensor 自动带入关系两端；改接 Device→WorkOrder 为 Device→Alarm 保留 key、映射和 42 条抽样证据；取消后原图仍为 6 边。没有修改用户发布本体。
- 深浅两主题与 1920/1280/980/800/480 检查；横向溢出 0。480 阅读列表，进入编辑后呈现 440px 可连线画布与 32 个对象端口。实际检查修掉节点子文字裁切、缩略图裁切和浅色标题/输入对比缺口。证据位于 `test-output/studio-graph-quality/`，主题已恢复深色。
- 异步对抗测试覆盖 A→B→A 迟到加载、保存期间继续编辑、编辑后迟到预览、跨项目保存返回。当前页面修改不会被这些旧请求覆盖。
- 真实 PostgreSQL 流程运行通过：源数据 60 行，条件过滤后输出 51 行；节点调试显示对应输入/输出。截图 `test-output/studio-graph-quality/pipeline-run-success-1920.jpg`。
- 10 维自评（主观视觉检查，非奖项结论）：层级 9、留白 9、中文可读性 9、色彩语义 9、令牌一致性 9、交互反馈 9、关系辨识 9、响应布局 9、错误/取消处理 9、性能结构 9。对标为上述 KWeaver 官方工作区交互；不把图谱页达标扩展为三引擎整体效果验收。

### 集成检查（15:05 更新）

root CLI 308/308、仓库治理、公共品牌、Unity bridge 均通过。非 desktop 全工作区生产构建通过（包括 API release host）；普通 web 首屏 JavaScript 330.8 KiB / gzip 108.7 KiB，290 个产物预压缩 83.52 MiB→19.48 MiB。专用只读 viewer、当前 Native GPU 和安装包接续验收，不能用旧包替代当前源码。

非 desktop 全工作区 typecheck、API production import smoke、普通 production-artifact 均通过。8919 个源文件全部通过 800 行硬门槛，没有豁免。专用只读 viewer build 通过；发布编译器在 flipY 修复后单独重建并记录输入 SHA。

Web 全套 Vitest：958 文件通过、3 文件跳过；6187 tests 通过、3 跳过，260.71s，退出 0（`test-output/studio-web-tests-20261007.log`）。此轮覆盖至 15:08 起跑时源码；之后新增轮询去重和后端驻留修复仍需聚焦复测。

### 当前剩余项（15:12 快照）

### 用户宽度反馈追加现状核查

检索数据中心/语义工作区全部 CSS 与未跟踪文件，确认既有合同、ReactFlow/Dagre 依赖和组件消费方不变；读现有断点截图、布局测试与本任务交接。已有（不重建）：数据中心页头、步骤、处理/发布工作区统一 1580px 上限。真实缺口：语义工作区缺少相同上限且额外左右 24px，1920 视口图谱边界为 60/1860，页头为 170/1750。将语义工作区纳入相同内容宽度并去掉重复横向内边距，按用户反馈复验。

| 用户顺序 | 已完成的具体工作 | 尚需关闭的验收 |
|---|---|---|
| ① 两个编辑页面 | 自由画布、连线/改接/撤销、图谱全边、本体拖线后配置；94 tests、双主题五断点与真实 51 行运行 | 第一阶段可用，保留后续共享代码回归 |
| ② Deep/发布贴图 | URL 解析、冻结字节与 SHA、UV live 更新、贴图方向和背景参数修复 | 最后同相机真 Deep 截图与 live 更新稳定性；当前离线包实证 |
| ② Native MegaLights | 真实 GBuffer、TLAS winner 可见性、去重计光、首帧权重/历史失效、模块拆分 | Vulkan/DX12 实机；1080p 显存预算、完整 PBR/特殊 IOR/雾一致性 |
| ② cluster-LOD | 生产 PBR/实例/逐节间接绘制，warming 回普通；双 section GPU 近景 0 像素差、远景 1600→256 三角形 | 最新 dist 的编辑器稳定性复验 |
| ② React/滑条 | 连续预览与尾沿一次提交、身份取消、撤销；真实 115 input handler P95 2.818ms | 相同项目轮询触发全壳更新修复与生产 App CPU 复测 |
| ② RT 二反弹 | 生产 encode 顺序/纹理用法修复；独立 128² GPU 对 CPU 第二命中参照通过 | 全编辑器 1080p 总帧预算不能由该微探针推断 |
| ③ 引擎切换/效果 | 候选首帧前保留活跃画布、失败保留原后端；缓存/曝光/雾/UV 对齐 | 冷切与暖切仍需优化、最新 live author/camera residency 并发回退复验 |
| ③ 发布/离线/安装 | 普通与专用 viewer 构建、CPU ZIP/冻结 SHA 验证与发布编译器已更新 | 最新 Windows 包离线启动/体积；当前 11/10 步全链、各目标安装实证 |

数据按各分支实际范围记录；局部单测或 GPU 微探针不代替整个编辑器性能定标。

### 全套 Deep 检查追加现状核查

全仓检索 C8 observer/输出审计及未跟踪文件；FragmentObservable、GPU 编译收据和源码 hash 合同已有；当前提交的 Three 依赖为 0.186.1，三个观察叶仍冻结 r185。消费方是现有 fragment/derivative GPU probes，不重建 runner。已读失败测试、原始 installed ShaderChunk、C8 10-01 规格与 Native author grading CPU/GPU 测试。真实缺口：r186 增加直接漫反射 Fresnel 混合与镜面补偿，RE/physical hash 和 single 观察点过期；Native 10-06 已接作者 vignette，但输出审计仍断言不存在。只更新隔离诊断源身份与已存在合同，保留实际着色公式和拒绝漂移守卫，历史 GPU 对拍继续保持历史身份；不放宽视觉阈值或宣称新 r186 parity 已通过。

同族 exact F32 观察器仍冻结移除虚拟阴影库前的整源。核对提交 `08cb9bd8`（级联档去掉不可达虚拟阴影库）与实际生成 shader，观察局部/绑定/默认导数接缝未变；重钉为当前 `f2c04d23…d618`，保留整源摘要与唯一接缝守卫。没有修改生产 shader。

### 作者白平衡一致性追加核查

同族追加检索确认 WebGL 的既有亮度/对比 ShaderPass 也在温度/色调全零时错误重归一化负亮度，分母缺 `abs`；现有 displayOutput 测试直接消费真实 ShaderPass，Three 依赖和作者合同不变。按 CPU/Native/Deep 同一已有语义补零参数守卫与绝对值分母，不重建后处理链。Three WebGPU TSL 的整个颜色分级仍有独立公式差异，后续真实对拍未过，不能据此宣称三后端颜色全部一致。

TSL 白平衡消费链同时补同样的作者亮度归一化、零参数旁路和绝对值分母，保留有符号线性颜色到既有输出变换。色相/饱和度完整公式对拍仍另计，不用白平衡修复代表整条材质链一致。

六步核对：全仓检索 author color/whiteBalance 与未跟踪；既有 PbrAuthorColorEffects/ScenePostProcessing 温度色调合同不变；无依赖新增；消费方是 pbrOutputShader/HDR display 与 Studio 作者后处理，TS CPU 和 Native author_grading 已用非零开关及绝对亮度分母；已有 CPU 参数/负值检查与输出审计；已读当前颜色对拍规格和本续作。真实缺口在 TS GPU：白平衡关闭仍做亮度归一化，负调色值会被非绝对分母放大。复用权威 CPU/Native 合同补 GPU guard+abs，正常关闭白平衡的画面保持作者值，同时少做无效乘法。补负色与开启白平衡检查及实际 WGSL GPU 对 CPU 读回，未测前不宣称像素通过。

检查：作者调色/输出审计 37 tests 通过；Deep src/lab/examples typecheck 通过。实际 production WGSL GPU 对 CPU 两轮：36 组负色/HDR/关闭与开启白平衡/vignette/组合调色，NVIDIA lovelace；最大绝对误差 6.748e-6、缩放误差 2.842e-7，GPU diagnostics 0。库 SHA `b7da2e9ac964d1dd591f1327c5d1f545c1066ba8d8790b732e1819eac400360d`；数值/截图在 `test-output/studio-author-color-20261007/`。临时 tab/server 已关闭；这项是调色函数验收，不外推完整 PBR parity 或帧时。

### 发布体量前置追加核查

全仓查到 gate-online-flow 与 onlineFlowAuditSupport 都有恢复对话处理；合同是现有 page locator 与恢复 DOM，依赖不变。onlineFlowTopology 已消费公共 helper；脚本语法与恢复相关测试已有，11/10步链条定义在 root package.json，交接明确当前脚本802行超限。已有（不重建）：公共恢复 helper；真实缺口：gate 自带重复函数的轮数/恢复动作有不同语义，需把它们作为公共 helper 参数保留，然后去掉重复实现。只做体量前置，不据此宣称当前发布链全绿。

## 本体关系拖线编辑追加核查

用户已确认本体也支持新建/改接关系，拖线后补配置。已有 ontologyGraph 节点 ID 解析、OntologyRelationType（字段映射、基数、方向、来源与证据）、newRelationDraft、RelationForm、cloneOntologyDraft/updateOntologyPackage 与九条发布门禁；依赖不变。消费方是 OntologyWorkspace→useOntologyWorkspace→ontologyApi，服务端图仍投影真实本体，不新建第二套关系存储。已查本体工作区逻辑/SSR/API图谱测试与上述规格。真实缺口是画布端口创建/改接到关系表单的作者动线。实现复用现有表单，已发布包只在明确保存时开新草稿；取消不写包，保存前校验形态并检查最新版本，保留原关系 ID/证据与其它资产，绑定边继续由相应资产配置。

### Deep 冷启动 GI 调度现状核查（10-07）

六步核查已完成：搜索 packages/apps 与全部未跟踪文件；ProbeClipmapRequest/History/Plan、帧预算与取消代际合同均已存在；依赖无新增；正式消费为 DeepWebGpuProbeClipmapSession.captureTick → controller → ProbeClipmapUpdateScheduler；已有 planner/scheduler/capture executor/收敛测试与 cold CPU profile；已读 F5 捕获泵与当前交接。已有（不重建）：GI 捕获、确定性优先级、公平调度、验证后原子发布。真实缺口：每次捕获同步校验/重建全部 pending 探针，再反复距离排序，冷启动 profile 中 GI 规划有明显累计 CPU 开销；后续按导航起点校正发现最大长任务158ms来自 Three 首次 shader/Composer，不把 GI 累计156ms当作单块阻塞。复用同一规划实现分片让出主线程，保留同步 SDK 入口；代际和取消覆盖异步规划阶段，保持探针集合、预算及优先级不变。稳定视图后续批次复用已验证地址，避免重复几何计算。浏览器复测前不宣称卡死已解决。

### 后台空轮询审计现状核查

全仓检查 driver next/snapshot-request 与未跟踪项；AuditLogRecord 和 driver lease/事务合同已有，Fastify/PG 无依赖变化；正式 browser 每秒轮询两路，响应204表示无命令/无快照请求；已读注册路由、系统审计、关闭等待测试、PG并发合同及当前交接。真实数据库有效文档3.13MB，整表含历史TOAST占10.33GB、WAL累计130GB，最新日志每秒两条空轮询create，每条又重写全库。真实缺口：纯运输空轮询被按POST误记为作者create。仅跳过成功204的两条精确轮询路由；有真实请求200、事务结果、作者写入和全部失败仍审计，认证权限不变。

同族检查确认 presence PUT 只续租既有内存 EditorPresenceRegistry，不写作者场景；浏览器每15秒发一条。成功200续租同样取消整文档审计，失败、注销和真实驱动任务继续保留。实际数据库维护：先写私有本地备份，VACUUM FULL+ANALYZE+CHECKPOINT 1.043秒，10,545,758,208B→3,301,376B；revision48583、35项目、56场景前后一致，C可用恢复12.25GB。备份含私有数据，仅 test-output 留存，不进入代码包或发布资产。

### 引擎 URL 优先级同族核查

initialRendererBackend 已按 URL > 持久偏好初始化，但实际消费 useAppLifecycleEffects 在异步引擎就绪后无条件再次恢复 localStorage，覆盖显式renderer=wasm/webgpu/webgl/auto。合同与依赖不变；已读 useAppState、偏好阶段提交与生命周期 tests、默认引擎规格。真实缺口为后续恢复路径未尊重显式URL。只在有合法显式renderer查询时跳过自动偏好恢复，用户主动切换仍走原命令/成功后持久化。

GI 源码体量检查：原规划器增加浏览器让步后328行。同步 SDK 与生成器合同已存在，cooperative 测试直接消费正式入口，无新依赖。将仅浏览器恢复/让步叶移入 probeClipmapPlanYield.ts，主规划不改探针集合或优先级，保持源码体量门。
