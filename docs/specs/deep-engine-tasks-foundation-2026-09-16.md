# Deep Engine 可执行任务：基础与核心

2026-09-16。32 张任务卡；总目标、证据口径与范围见[综合方案](deep-engine-comprehensive-plan-2026-09-16.md)，机器可读清单见[任务JSON](deep-engine-execution-tasks-2026-09-16.json)。

这些是后续执行计划，不表示本轮已经编码。已有三维 D01–D28、Deep2D P0–P3 和格式 PLAN 任务保留；相同工作只计一次。领取前重新检查 git、总账和调用链，新进展优先于本文件的历史基线。

**执行粒度**：每卡是一个可验收结果。超过5个业务文件或5工程人日时，执行前拆为“版本合同/参考测试→运行消费→真实交付验证”三个子PR；各PR必须保持旧路径可用，整卡只在最终通过标准满足后关闭。估算不包含硬件/样本/许可证等待；不可直接当日历承诺。

**全局约束**：固定账号、postgres+minio和既有数据保持；不覆盖并行改动。视觉卡必须执行 design-taste-digitaltwin 两轮截图、十维评分与同族排查。性能卡冻结画质与原始样本，失败也入报告。

## A · 对标证据与基准

<a id="a01"></a>
### A01 · 冻结五引擎目标矩阵

- **排程**：P0｜本轮待办｜责任角色：架构/性能QA｜初估 2–3 工程人日。
- **已有基础**：已有benchmarkContract与旧90%合同；没有五平台领先结论。
- **代码入口**：[packages/deep-engine/src/benchmarkContract.ts](../../packages/deep-engine/src/benchmarkContract.ts)；[docs/specs/deep-engine-competitive-benchmark-contract-2026-09-12.md](../../docs/specs/deep-engine-competitive-benchmark-contract-2026-09-12.md)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：新增v2矩阵：版本/渲染器/平台/任务/必选能力/禁止退化项；分别保留公共子集和最佳质量赛道。
- **通过标准**：五张矩阵可独立判定；未实现/未验证有固定分母；排除项不被计成通过。
- **边界/失败验证**：删分母、改权重、缺证据均使结果无效。
- **依赖**：无前置实现；先复核当前工作树与任务证据。
- **验证**：T（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：benchmark v1；D24。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a02"></a>
### A02 · 冻结真实资产与交互轨迹

- **排程**：P0｜本轮待办｜责任角色：资产/QA｜初估 3–5 工程人日。
- **已有基础**：Lab已有Box/球体和材质夹具；格式团队已有语料计划。
- **代码入口**：[packages/deep-engine/lab/assets](../../packages/deep-engine/lab/assets)；[docs/specs/industrial-3d-format-work-plan-2026-09-16.md](../../docs/specs/industrial-3d-format-work-plan-2026-09-16.md)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用格式语料清单，选择工厂/BIM/园区三真实项目并补外观/动画/看板三任务夹具；固定hash、单位、轨迹、许可。
- **通过标准**：六类manifest、至少三真实项目、冷热缓存条件与材质统计齐全。
- **边界/失败验证**：缺许可/外部URL/资源不完整拒绝进入评分。
- **依赖**：[A01](deep-engine-tasks-foundation-2026-09-16.md#a01)。
- **验证**：T（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D24；格式PLAN-01/02。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a03"></a>
### A03 · 统一CPU/GPU/呈现采样

- **排程**：P0｜本轮待办｜责任角色：性能/图形｜初估 3–5 工程人日。
- **已有基础**：已有GPU timer和StudioDeepPerformance，Unity脚本仅cpu-frame-interval。
- **代码入口**：[packages/deep-engine/src/webgpu/gpuTimer.ts](../../packages/deep-engine/src/webgpu/gpuTimer.ts)；[apps/web/src/viewer/StudioDeepPerformance.ts](../../apps/web/src/viewer/StudioDeepPerformance.ts)；[packages/deep-engine-native/src/telemetry_gpu.rs](../../packages/deep-engine-native/src/telemetry_gpu.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：定义原始采样schema和共同时间边界；记录bridge/update/upload/GPU/present及实际样本数。
- **通过标准**：CPU提交、GPU timestamp、帧间隔、输入延迟分别输出；无timestamp写unavailable。
- **边界/失败验证**：丢样、失焦、计时器不支持、GPU lost不能输出伪零值。
- **依赖**：[A01](deep-engine-tasks-foundation-2026-09-16.md#a01)。
- **验证**：T+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D25；现有telemetry。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a04"></a>
### A04 · 复用Web成对基准runner

- **排程**：P0｜本轮待办｜责任角色：Web图形/QA｜初估 4–7 工程人日。
- **已有基础**：已有Three/Babylon隔离基准与Deep Lab。
- **代码入口**：[apps/web/benchmarks](../../apps/web/benchmarks)；[apps/web/scripts/gate-render-engine-comparison.mjs](../../apps/web/scripts/gate-render-engine-comparison.mjs)；[packages/deep-engine/lab/deepBenchmarkBackend.ts](../../packages/deep-engine/lab/deepBenchmarkBackend.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：接统一资产/设置/轨迹，轮换先后运行；串行独占GPU，记录双方标准优化和质量差异。
- **通过标准**：每case五组成对原始数据可重放；禁用/缺失效果显式invalid或不同赛道。
- **边界/失败验证**：低画质换性能、版本/hash不一致和后台页采样拒绝评分。
- **依赖**：[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：T+WEB+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：benchmark:render-engines。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a05"></a>
### A05 · 升级Unity原生基准

- **排程**：P1｜本轮待办｜责任角色：Unity/QA｜初估 4–7 工程人日。
- **已有基础**：UnityBenchmarkController已采立方体和帧间隔；不是完整竞品证据。
- **代码入口**：[tools/unity/bridge-smoke/Assets/UnityBenchmarkController.cs](../../tools/unity/bridge-smoke/Assets/UnityBenchmarkController.cs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用Unity bridge导入同资产；增加release player、URP档位、GPU/资源采样和固定轨迹。
- **通过标准**：Unity版本/管线/优化设置可复现；至少一真实项目与Deep Native成对跑通。
- **边界/失败验证**：-nographics、Editor代替Player、默认未优化对手不能出胜负。
- **依赖**：[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：tools/unity/bridge-smoke。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a06"></a>
### A06 · 建立Godot原生基准

- **排程**：P1｜本轮待办｜责任角色：Godot/QA｜初估 4–7 工程人日。
- **已有基础**：本轮未见完整Godot成对runner。
- **代码入口**：[tools](../../tools)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：新增tools下独立Godot项目，锁版本和Forward+/Compatibility档位；导入同项目、导出release并输出公共schema。
- **通过标准**：一真实项目静态/动态/加载三case可与Native复跑。
- **边界/失败验证**：导入丢材质/单位、VSync限制、脚本计时代替GPU标无效。
- **依赖**：[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D25新adapter。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a07"></a>
### A07 · 建立UE原生基准

- **排程**：P1｜本轮待办｜责任角色：UE/QA｜初估 5–8 工程人日。
- **已有基础**：本轮未见完整UE成对runner。
- **代码入口**：[tools](../../tools)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：新增独立UE benchmark工程；固定Lumen/Nanite/VSM设置，区分公共子集和UE最佳质量，使用打包产物。
- **通过标准**：一真实项目含相机轨迹和完整质量声明；捕获加载、帧尾延迟、显存。
- **边界/失败验证**：关Lumen得到的速度不能记入Lumen质量赛道；无可运行安装记录前置阻塞。
- **依赖**：[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D25新adapter。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="a08"></a>
### A08 · 自动生成证据与差距报告

- **排程**：P0｜本轮待办｜责任角色：QA/工具｜初估 3–5 工程人日。
- **已有基础**：旧报告与README存在状态漂移。
- **代码入口**：[packages/deep-engine/src/benchmarkContract.ts](../../packages/deep-engine/src/benchmarkContract.ts)；[scripts](../../scripts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：从矩阵/原始结果/源码构建身份生成报告；记录运行日期、commit+dirty文件hash、设备、置信区间和旧证据失效原因。
- **通过标准**：同输入同结论；五对手独立结论；缺项显式未验证，链接可复跑。
- **边界/失败验证**：旧EXE/新包混用、局部基准冒充整帧、调分母都被校验拒绝。
- **依赖**：[A01](deep-engine-tasks-foundation-2026-09-16.md#a01)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)、[A04](deep-engine-tasks-foundation-2026-09-16.md#a04)。
- **验证**：T（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D24–D28证据索引。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## B · 运行架构与性能

<a id="b01"></a>
### B01 · 统一场景变化所有权

- **排程**：P0｜本轮待办｜责任角色：架构/运行时｜初估 3–5 工程人日。
- **已有基础**：已有SceneTransformGraph/SceneSnapshot/studio-core；Studio仍持有Three作者对象。
- **代码入口**：[packages/deep-engine/src/scene/SceneTransformGraph.ts](../../packages/deep-engine/src/scene/SceneTransformGraph.ts)；[packages/contracts/src](../../packages/contracts/src)；[packages/studio-core/src](../../packages/studio-core/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用现有ID/变换图，冻结变化集字段和revision，明确作者/运行/GPU缓存所有权；实现最小隐藏与变换命令。
- **通过标准**：同一变更可投影Three与Deep；拒绝迟到revision，撤销不产生第二份权威状态。
- **边界/失败验证**：重parent、奇异矩阵、删除后迟到命令、未保存编辑不得串状态。
- **依赖**：[A01](deep-engine-tasks-foundation-2026-09-16.md#a01)。
- **验证**：T+W（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：SceneTransformGraph；D11。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b02"></a>
### B02 · 将Three投影改为可测增量

- **排程**：P0｜本轮待办｜责任角色：Web运行时｜初估 4–7 工程人日。
- **已有基础**：ThreeProjectionBridge已有full/instances路径。
- **代码入口**：[packages/deep-engine/src/threeBridge/ThreeProjectionBridge.ts](../../packages/deep-engine/src/threeBridge/ThreeProjectionBridge.ts)；[apps/web/src/viewer/StudioDeepWebGpuBridge.ts](../../apps/web/src/viewer/StudioDeepWebGpuBridge.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：为几何/材质/实例/层级增加实测脏域；复用full回退，补稳定资源映射与更新计数。
- **通过标准**：1%实例变化不重扫未变几何；与全量参考packet逐项相同，记录bridge耗时与内存。
- **边界/失败验证**：同ID新资源、共享材质、删除/复显、取消旧投影不漏更新。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：T+W+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有Three桥增量。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b03"></a>
### B03 · 把RenderGraph接到实际执行

- **排程**：P0｜本轮待办｜责任角色：图形｜初估 4–7 工程人日。
- **已有基础**：图已有拓扑/寿命，生产PbrRenderer仍手工编码。
- **代码入口**：[packages/deep-engine/src/renderGraph.ts](../../packages/deep-engine/src/renderGraph.ts)；[packages/deep-engine/src/webgpu/pbrFrameGraph.ts](../../packages/deep-engine/src/webgpu/pbrFrameGraph.ts)；[packages/deep-engine/src/webgpu/pbrRenderer.ts](../../packages/deep-engine/src/webgpu/pbrRenderer.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先让AO→TAA→Bloom子链由编译计划执行；实际pass声明读写、格式、尺寸、sample与usage。
- **通过标准**：计划与实际pass可追踪；开关组合/resize与旧路径画面一致。
- **边界/失败验证**：读未初始化资源、循环依赖、历史纹理误复用必须拒绝。
- **依赖**：[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：T+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：renderGraph/pbrFrameGraph。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b04"></a>
### B04 · 接真实临时纹理复用

- **排程**：P1｜本轮待办｜责任角色：图形/资源｜初估 4–6 工程人日。
- **已有基础**：transientSlot尚无生产分配消费证据。
- **代码入口**：[packages/deep-engine/src/webgpu/renderTargets.ts](../../packages/deep-engine/src/webgpu/renderTargets.ts)；[packages/deep-engine/src/webgpu/pbrPostProcessChain.ts](../../packages/deep-engine/src/webgpu/pbrPostProcessChain.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：依据B03兼容键复用GPUTexture；区分跨帧history与帧内目标，按queue生命周期回收。
- **通过标准**：分配计数/估算bytes实际下降；像素和帧时不退化，记录含staging峰值。
- **边界/失败验证**：resize、设备丢失、并行候选和失败提交不能复用在途纹理。
- **依赖**：[B03](deep-engine-tasks-foundation-2026-09-16.md#b03)。
- **验证**：T+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：已有寿命规划。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b05"></a>
### B05 · 统一资源预算与上传节流

- **排程**：P0｜本轮待办｜责任角色：资源/流式｜初估 4–7 工程人日。
- **已有基础**：已有geometry/texture residency与latest-wins，预算边界分散。
- **代码入口**：[packages/deep-engine/src/streaming](../../packages/deep-engine/src/streaming)；[packages/deep-engine/src/webgpu/gpuRenderResidencyRuntime.ts](../../packages/deep-engine/src/webgpu/gpuRenderResidencyRuntime.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：将阴影/后处理/staging纳入总预算报告；每帧上传配额与取消优先级接既有stream。
- **通过标准**：快速移动时保留可绘制粗层；预算溢出明确降级；峰值包含候选和旧资源。
- **边界/失败验证**：网络慢、超预算、等价请求取消、驱逐后取消与迟到上传回归。
- **依赖**：[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)、[B02](deep-engine-tasks-foundation-2026-09-16.md#b02)。
- **验证**：T+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：P0-10/11；streaming。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b06"></a>
### B06 · 统一设备恢复与场景Epoch

- **排程**：P1｜本轮待办｜责任角色：运行时/Native｜初估 5–8 工程人日。
- **已有基础**：设备epoch、包candidate/LKG和ChartEpoch已局部存在。
- **代码入口**：[packages/deep-engine/src/webgpu/deviceSession.ts](../../packages/deep-engine/src/webgpu/deviceSession.ts)；[packages/deep-engine/src/runtimePackage](../../packages/deep-engine/src/runtimePackage)；[packages/deep-engine-native/src/player_content.rs](../../packages/deep-engine-native/src/player_content.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：定义跨渲染/资源/命中提交边界，接一个3D+Dashboard混合候选的失败恢复。
- **通过标准**：显示/命中/数据同版本；重新建device后恢复最后成功状态且只发生一次发布。
- **边界/失败验证**：lost中上传、旧device回调、重建失败、换包取消保留正确旧状态。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[G01](deep-engine-tasks-product-2026-09-16.md#g01)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：Deep2D P0-05/P1-01；D14。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b07"></a>
### B07 · 后台资产准备与主线程预算

- **排程**：P1｜本轮待办｜责任角色：资产/运行时｜初估 3–6 工程人日。
- **已有基础**：已有离线bake和部分Worker；不能假定所有预处理已移出主线程。
- **代码入口**：[packages/deep-engine/src/assetBakePlan.ts](../../packages/deep-engine/src/assetBakePlan.ts)；[apps/web/src/optimizer](../../apps/web/src/optimizer)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：对A03热点将一个解码/meshlet/BVH准备路径接有界Worker队列；保留取消和缓存身份。
- **通过标准**：实测主线程长任务减少；首帧/总加载/内存无显著回退，结果同CPU参考。
- **边界/失败验证**：队列满、Worker崩溃、超时、重复请求、缓冲转移后误读覆盖。
- **依赖**：[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)、[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)。
- **验证**：T+W+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：assetBakePlan；已有Worker。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="b08"></a>
### B08 · 按设备预算自适应质量

- **排程**：P1｜本轮待办｜责任角色：图形/产品｜初估 3–5 工程人日。
- **已有基础**：Studio已有adaptiveRenderScale和帧监视；Deep多效果需统一决策。
- **代码入口**：[apps/web/src/viewer/adaptiveRenderScale.ts](../../apps/web/src/viewer/adaptiveRenderScale.ts)；[packages/deep-engine/src/webgpu/pbrRendererFeatures.ts](../../packages/deep-engine/src/webgpu/pbrRendererFeatures.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用已有控制器，先联动分辨率/AO/阴影三项，设迟滞和最小保持时间。
- **通过标准**：固定负载跃迁能回到档位预算；手动锁质量有效，诊断解释变化。
- **边界/失败验证**：失焦/零样本/静止按需帧不能触发质量震荡。
- **依赖**：[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)、[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)、[E01](deep-engine-tasks-product-2026-09-16.md#e01)。
- **验证**：W+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有adaptiveRenderScale。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## C · 资产与材质

<a id="c01"></a>
### C01 · 导入失败语料与能力清单

- **排程**：P0｜本轮待办｜责任角色：资产/QA｜初估 2–4 工程人日。
- **已有基础**：独立glTF和Three桥支持面不同，现有格式团队有自己的语料。
- **代码入口**：[packages/deep-engine/src/gltf](../../packages/deep-engine/src/gltf)；[packages/deep-engine/src/threeBridge/materials.ts](../../packages/deep-engine/src/threeBridge/materials.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：给A02资产跑direct/bridge/native三路径，逐对象记录材质/扩展/几何/动画失败码及频次。
- **通过标准**：产出优先级有样本依据；可render与保留语义分列，错误可定位资产字段。
- **边界/失败验证**：未知扩展/坏accessor/超预算不静默丢弃。
- **依赖**：[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)。
- **验证**：T+W（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：格式PLAN-01/03；D07。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c02"></a>
### C02 · 打通顶点色和平面着色

- **排程**：P0｜本轮待办｜责任角色：资产/双端图形｜初估 5–8 工程人日。
- **已有基础**：materials.ts显式拒绝vertexColors/flatShading。
- **代码入口**：[packages/deep-engine/src/threeBridge/materials.ts](../../packages/deep-engine/src/threeBridge/materials.ts)；[packages/deep-engine/src/renderPacketTypes.ts](../../packages/deep-engine/src/renderPacketTypes.ts)；[packages/deep-engine/src/shaderAbi](../../packages/deep-engine/src/shaderAbi)；[packages/deep-engine-native/src/mesh_abi.rs](../../packages/deep-engine-native/src/mesh_abi.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先冻结可选颜色流ABI和flat几何派生；接glTF/Three→packet→Web/Native，资源hash含派生设置。
- **通过标准**：彩色BIM与flat法线正背面一致；旧无颜色包/golden不变。
- **边界/失败验证**：缺颜色分量、NaN、共享indexed面、镜像/非均匀缩放覆盖。
- **依赖**：[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)、[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：旧材质兼容缺口。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c03"></a>
### C03 · 透明与双面状态保真

- **排程**：P0｜本轮待办｜责任角色：双端图形｜初估 4–7 工程人日。
- **已有基础**：已有OIT与Native BLEND，桥仍拒绝若干depthWrite/双面模式。
- **代码入口**：[packages/deep-engine/src/webgpu/weightedOit.ts](../../packages/deep-engine/src/webgpu/weightedOit.ts)；[packages/deep-engine/src/threeBridge/materials.ts](../../packages/deep-engine/src/threeBridge/materials.ts)；[packages/deep-engine-native/src/mesh_pass.rs](../../packages/deep-engine-native/src/mesh_pass.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：冻结支持的straight/premultiplied与双面语义，先补最常见双面玻璃路径；明确阴影参与。
- **通过标准**：重叠/交叉/镜像玻璃在两端符合各自声明；材质更新与发布保持设置。
- **边界/失败验证**：MASK+BLEND、背面、零alpha、相交透明和排序跳变覆盖。
- **依赖**：[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D14；material alpha。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c04"></a>
### C04 · 增加清漆与镜面材质子集

- **排程**：P1｜本轮待办｜责任角色：材质/资产｜初估 5–8 工程人日。
- **已有基础**：shader authoring存在部分能力，glTF/桥不完整消费扩展。
- **代码入口**：[packages/deep-engine/src/gltf/materialExtensions.ts](../../packages/deep-engine/src/gltf/materialExtensions.ts)；[packages/deep-engine/src/shaderPresets](../../packages/deep-engine/src/shaderPresets)；[packages/deep-engine-native/assets/shaders](../../packages/deep-engine-native/assets/shaders)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用可用BRDF，补KHR clearcoat/ior/specular参数与贴图合同、转换、双端shader和包序列化。
- **通过标准**：涂层金属/塑料三样本保真；每扩展有能量/极值/颜色空间对照。
- **边界/失败验证**：非法factor、贴图通道、缺切线、旧ABI混用拒绝。
- **依赖**：[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)、[C02](deep-engine-tasks-foundation-2026-09-16.md#c02)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有shaderPresets。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c05"></a>
### C05 · 玻璃透射与体积吸收

- **排程**：P2｜本轮待办｜责任角色：材质/图形｜初估 6–10 工程人日。
- **已有基础**：Physical非中性transmission/thickness当前被拒绝。
- **代码入口**：[packages/deep-engine/src/shaderPresets](../../packages/deep-engine/src/shaderPresets)；[packages/deep-engine/src/webgpu](../../packages/deep-engine/src/webgpu)；[packages/deep-engine-native/assets/shaders](../../packages/deep-engine-native/assets/shaders)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：单独实现薄玻璃，再接封闭实体厚度/吸收；screen-space近似与真正折射能力标记分开。
- **通过标准**：透射背景、厚度与粗糙度变化可见；离屏信息缺失有稳定回退，导入发布一致。
- **边界/失败验证**：多层玻璃、相机入内、无背景和重叠透明不黑屏/闪烁。
- **依赖**：[C03](deep-engine-tasks-foundation-2026-09-16.md#c03)、[C04](deep-engine-tasks-foundation-2026-09-16.md#c04)、[E04](deep-engine-tasks-product-2026-09-16.md#e04)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：材质扩展新切片。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c06"></a>
### C06 · 复用压缩解码并生成规范资产

- **排程**：P1｜本轮待办｜责任角色：资产/Worker｜初估 4–6 工程人日。
- **已有基础**：Three loader与纹理模块已有mesh压缩/KTX2相关能力。
- **代码入口**：[packages/deep-engine/src/gltf](../../packages/deep-engine/src/gltf)；[packages/deep-engine/src/textures](../../packages/deep-engine/src/textures)；[apps/web/src/optimizer](../../apps/web/src/optimizer)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先接导入期meshopt/Draco/Basis规范化到已有资源包；记录源hash、解码器版本和保真报告。
- **通过标准**：所选压缩样本与无压缩参考几何/材质相同；离线无需临时下载解码器。
- **边界/失败验证**：坏块、极端展开比、取消、缺依赖明确失败并释放资源。
- **依赖**：[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)。
- **验证**：T+N+W（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：格式PLAN-02/03；textures。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c07"></a>
### C07 · 增量资产构建与变体缓存

- **排程**：P1｜本轮待办｜责任角色：资产/构建｜初估 4–7 工程人日。
- **已有基础**：assetBakePlan/ShaderCache/内容hash已存在。
- **代码入口**：[packages/deep-engine/src/assetBakePlan.ts](../../packages/deep-engine/src/assetBakePlan.ts)；[packages/deep-engine/src/shaderCache](../../packages/deep-engine/src/shaderCache)；[packages/deep-engine/src/runtimePackage](../../packages/deep-engine/src/runtimePackage)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：将LOD/meshlet/纹理派生串成可恢复构建图；修改一张贴图只失效相关产物。
- **通过标准**：重复构建命中稳定；中断续建、版本升级重建边界可解释，输出manifest可追溯。
- **边界/失败验证**：缓存投毒、同ID异内容、错误并发、磁盘不足不发布半包。
- **依赖**：[C06](deep-engine-tasks-foundation-2026-09-16.md#c06)、[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)。
- **验证**：T+N+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：assetBakePlan；D06。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="c08"></a>
### C08 · 连接工业格式与语义资产

- **排程**：P1｜本轮待办｜责任角色：资产/工业｜初估 4–7 工程人日。
- **已有基础**：七方向格式计划已另立项；精确B-Rep与通用解码不能假定已有。
- **代码入口**：[packages/jt-reader](../../packages/jt-reader)；[apps/web/src/delivery/compileSceneRenderPacket.ts](../../apps/web/src/delivery/compileSceneRenderPacket.ts)；[docs/specs/industrial-3d-format-work-plan-2026-09-16.md](../../docs/specs/industrial-3d-format-work-plan-2026-09-16.md)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：消费格式团队标准输出；保留构件ID/层级/单位/属性/几何精度，接Deep导入和能力报告。
- **通过标准**：至少一个已验收格式profile贯通选择/属性/LOD/离线；局限与源版本显式呈现。
- **边界/失败验证**：损坏/不支持版本、丢属性、外部引用不能伪装完整导入。
- **依赖**：[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)、[C07](deep-engine-tasks-foundation-2026-09-16.md#c07)、[D01](deep-engine-tasks-foundation-2026-09-16.md#d01)。
- **验证**：T+N+W（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：复用工业格式PLAN，不重做7个reader。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## D · 空间与工业交互

<a id="d01"></a>
### D01 · Native实例空间索引

- **排程**：P0｜本轮待办｜责任角色：空间/Native｜初估 3–5 工程人日。
- **已有基础**：Native拾取遍历所有实例；Deep已有looseOctree/spatial工具。
- **代码入口**：[packages/deep-engine/src/spatial](../../packages/deep-engine/src/spatial)；[packages/deep-engine-native/src/player_picking.rs](../../packages/deep-engine-native/src/player_picking.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：建立实例包围盒索引并与对象变化集同步；优先复用既有设计，输出candidate稳定ID。
- **通过标准**：随机查询与暴力枚举一致；删除/变换只更新受影响项，查询成本随候选数变化。
- **边界/失败验证**：负缩放、空bounds、重复ID、极值和删除后迟到更新覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)。
- **验证**：T+N+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D11；spatial。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d02"></a>
### D02 · Native网格BVH精确拾取

- **排程**：P0｜本轮待办｜责任角色：空间/Native｜初估 4–7 工程人日。
- **已有基础**：player_picking逐三角，Web已有three-mesh-bvh经验。
- **代码入口**：[packages/deep-engine-native/src/player_picking.rs](../../packages/deep-engine-native/src/player_picking.rs)；[apps/web/src/viewer/ordinaryPickingRaycast.ts](../../apps/web/src/viewer/ordinaryPickingRaycast.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：网格按内容hash缓存BVH；D01粗选后局部射线查询，再转换f64世界点。
- **通过标准**：命中ID/点/近远裁剪与旧参考一致；冻结大模型P95与内存基准。
- **边界/失败验证**：退化三角、镜像、透明mask、LOD选择、取消构建和非法索引覆盖。
- **依赖**：[D01](deep-engine-tasks-foundation-2026-09-16.md#d01)、[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)。
- **验证**：N+BENCH+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D11；旧CPU pick作参考。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d03"></a>
### D03 · 统一剖切渲染和拾取

- **排程**：P0｜本轮待办｜责任角色：交互/图形｜初估 5–8 工程人日。
- **已有基础**：Native有单平面工具，Three材质clipping被拒绝。
- **代码入口**：[packages/deep-engine/src/threeBridge/materials.ts](../../packages/deep-engine/src/threeBridge/materials.ts)；[packages/deep-engine-native/src/player_state.rs](../../packages/deep-engine-native/src/player_state.rs)；[packages/deep-engine-native/src/shadow_map](../../packages/deep-engine-native/src/shadow_map)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：冻结世界剖切平面/盒合同；接Three桥、Web pass、Native pass与拾取过滤；先一平面后盒。
- **通过标准**：切掉部分不再可选；阴影按声明一致，保存重载/跨原点不漂移。
- **边界/失败验证**：平面反转、盒退化、边界epsilon、透明与蒙皮交叉覆盖。
- **依赖**：[D02](deep-engine-tasks-foundation-2026-09-16.md#d02)、[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[C03](deep-engine-tasks-foundation-2026-09-16.md#c03)。
- **验证**：T+N+W+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D12；clipping。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d04"></a>
### D04 · 连续重基点与持久标注

- **排程**：P1｜本轮待办｜责任角色：空间/运行时｜初估 5–8 工程人日。
- **已有基础**：已有十亿偏移与离散重载证据；连续运动/世界标注仍待。
- **代码入口**：[apps/web/src/delivery/sceneLocalCoordinates.ts](../../apps/web/src/delivery/sceneLocalCoordinates.ts)；[packages/deep-engine-native/src/player_annotations.rs](../../packages/deep-engine-native/src/player_annotations.rs)；[packages/deep-engine-native/src/player_picking.rs](../../packages/deep-engine-native/src/player_picking.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：坐标服务统一相机/拾取/剖切/标注，原点变更作为同一事务；标注存世界f64和对象锚。
- **通过标准**：同进程连续越界轨迹通过既有误差预算；保存恢复同世界位置。
- **边界/失败验证**：跨原点时旋转、编辑、失败候选、单位转换与局部顶点原始精度覆盖。
- **依赖**：[D02](deep-engine-tasks-foundation-2026-09-16.md#d02)、[D03](deep-engine-tasks-foundation-2026-09-16.md#d03)、[B06](deep-engine-tasks-foundation-2026-09-16.md#b06)。
- **验证**：T+N+GPU+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D09未完成部分。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d05"></a>
### D05 · 语义分区与预取策略

- **排程**：P1｜本轮待办｜责任角色：大场景/产品｜初估 4–7 工程人日。
- **已有基础**：已有authorChunks和驻留；尚缺复杂项目收益矩阵。
- **代码入口**：[packages/deep-engine/src/streaming](../../packages/deep-engine/src/streaming)；[packages/deep-engine/src/threeBridge/authorChunkStream.ts](../../packages/deep-engine/src/threeBridge/authorChunkStream.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：楼层/系统/空间chunk组合；告警与选择驱动优先预取，粗层保底，使用B05预算。
- **通过标准**：楼层钻取/跨区传送不出现无代理空白；冷/热加载和P99留证。
- **边界/失败验证**：预取风暴、快速反向、共享资产、下载失败与预算不足覆盖。
- **依赖**：[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)、[C07](deep-engine-tasks-foundation-2026-09-16.md#c07)、[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)。
- **验证**：T+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：P0-10/11；D25。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d06"></a>
### D06 · LOD与meshlet混合场景验证

- **排程**：P1｜本轮待办｜责任角色：GPU几何｜初估 5–8 工程人日。
- **已有基础**：已有选择/剔除/间接绘制和Studio开关。
- **代码入口**：[packages/deep-engine/src/webgpu/packetCulling.ts](../../packages/deep-engine/src/webgpu/packetCulling.ts)；[packages/deep-engine/src/webgpu/meshletCulling.ts](../../packages/deep-engine/src/webgpu/meshletCulling.ts)；[packages/deep-engine/src/webgpu/pbrRenderer.ts](../../packages/deep-engine/src/webgpu/pbrRenderer.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：把真实BIM、变形、透明、剖切同时接现有管线；补误差阈值/过渡与构件映射。
- **通过标准**：画质冻结下分别报告可见三角/CPU/GPU/驻留；选中构件跨LOD保持身份。
- **边界/失败验证**：Hi-Z旧历史、快速相机、变形bounds、间接缓冲扩容不漏画。
- **依赖**：[D05](deep-engine-tasks-foundation-2026-09-16.md#d05)、[C02](deep-engine-tasks-foundation-2026-09-16.md#c02)、[D03](deep-engine-tasks-foundation-2026-09-16.md#d03)、[F02](deep-engine-tasks-product-2026-09-16.md#f02)。
- **验证**：T+N+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：Nanite Lite既有主线。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d07"></a>
### D07 · 独立选择与变换任务流

- **排程**：P1｜本轮待办｜责任角色：编辑器/Native｜初估 5–8 工程人日。
- **已有基础**：Studio工具复用Three，Native有基础选择；不等同独立编辑器。
- **代码入口**：[apps/web/src/viewer/viewerEngineInteraction.ts](../../apps/web/src/viewer/viewerEngineInteraction.ts)；[packages/deep-engine-native/src/events.rs](../../packages/deep-engine-native/src/events.rs)；[packages/deep-engine-native/src/player_state.rs](../../packages/deep-engine-native/src/player_state.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：抽取选择命令/多选/隐藏隔离/定位和变换撤销为宿主中立服务；接Web/Native最小面板。
- **通过标准**：相同命令回放两端对象状态一致；重载/切后端不丢选择或未保存变更。
- **边界/失败验证**：隐藏对象、框选边界、锁定对象、空点、拖拽取消/焦点切换覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[D02](deep-engine-tasks-foundation-2026-09-16.md#d02)、[D03](deep-engine-tasks-foundation-2026-09-16.md#d03)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D11/D12。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="d08"></a>
### D08 · 工程测量与精确语义

- **排程**：P2｜本轮待办｜责任角色：工业几何/交互｜初估 5–8 工程人日。
- **已有基础**：已有点距和f64世界点；渲染LOD不应决定工程尺寸。
- **代码入口**：[packages/deep-engine-native/src/player_measurement.rs](../../packages/deep-engine-native/src/player_measurement.rs)；[apps/web/src/viewer/viewerEngineMeasurements.ts](../../apps/web/src/viewer/viewerEngineMeasurements.ts)；[packages/parametric-modeling-plugin](../../packages/parametric-modeling-plugin)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先交付角度/面积和面边吸附；标明网格/精确几何来源，接单位/公差与持久化。
- **通过标准**：已知尺寸样本误差小于预冻结预算；LOD变化不改变权威测量。
- **边界/失败验证**：非共面面积、退化边、源精度不足、尺度/单位错误不能给假精确值。
- **依赖**：[D04](deep-engine-tasks-foundation-2026-09-16.md#d04)、[D07](deep-engine-tasks-foundation-2026-09-16.md#d07)、[C08](deep-engine-tasks-foundation-2026-09-16.md#c08)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D12；格式精度报告。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


