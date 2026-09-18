# Deep Engine 可执行任务：产品与能力

2026-09-16。40 张任务卡；总目标、证据口径与范围见[综合方案](deep-engine-comprehensive-plan-2026-09-16.md)，机器可读清单见[任务JSON](deep-engine-execution-tasks-2026-09-16.json)。

这些是后续执行计划，不表示本轮已经编码。已有三维 D01–D28、Deep2D P0–P3 和格式 PLAN 任务保留；相同工作只计一次。领取前重新检查 git、总账和调用链，新进展优先于本文件的历史基线。

**执行粒度**：每卡是一个可验收结果。超过5个业务文件或5工程人日时，执行前拆为“版本合同/参考测试→运行消费→真实交付验证”三个子PR；各PR必须保持旧路径可用，整卡只在最终通过标准满足后关闭。估算不包含硬件/样本/许可证等待；不可直接当日历承诺。

**全局约束**：固定账号、postgres+minio和既有数据保持；不覆盖并行改动。视觉卡必须执行 design-taste-digitaltwin 两轮截图、十维评分与同族排查。性能卡冻结画质与原始样本，失败也入报告。

## E · 渲染与画质

<a id="e01"></a>
### E01 · 冻结双端色彩与材质参考

- **排程**：P0｜本轮待办｜责任角色：图形/QA｜初估 3–5 工程人日。
- **已有基础**：Web/Native均有PBR/IBL/ACES，Dashboard曾修sRGB错误。
- **代码入口**：[packages/deep-engine/src/webgpu/pbrShader.ts](../../packages/deep-engine/src/webgpu/pbrShader.ts)；[packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl](../../packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：同HDR环境、曝光、灯光与材质校准；区分线性计算、纹理解码、tone mapping与最终输出。
- **通过标准**：色卡/金属/粗糙度梯度的两端误差和曝光行为达到预冻结阈值。
- **边界/失败验证**：双重sRGB、负值/NaN、HDR溢出、镜像法线和透明合成覆盖。
- **依赖**：[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)、[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D14/D24。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e02"></a>
### E02 · 普通场景环境灯光进入Native包

- **排程**：P0｜本轮待办｜责任角色：发布/双端图形｜初估 5–8 工程人日。
- **已有基础**：静态编译仍只声明camera等有限语义；底层有IBL/灯光。
- **代码入口**：[apps/web/src/delivery/compileSceneRuntimePackage.ts](../../apps/web/src/delivery/compileSceneRuntimePackage.ts)；[apps/web/src/delivery/sceneInactiveFields.ts](../../apps/web/src/delivery/sceneInactiveFields.ts)；[packages/deep-engine-native/src/runtime_package](../../packages/deep-engine-native/src/runtime_package)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：从SceneSnapshot消费环境/曝光/主光/阴影设置，冻结资源并接Native读取；明确点/聚光支持分批。
- **通过标准**：普通带光照场景可导出同版本Native，变化反映到画面且不再仅因已实现字段被阻断。
- **边界/失败验证**：丢环境、未知灯光、资源hash错、编辑中发布拒绝旧候选。
- **依赖**：[E01](deep-engine-tasks-product-2026-09-16.md#e01)、[C03](deep-engine-tasks-foundation-2026-09-16.md#c03)。
- **验证**：T+N+W+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D14；D07–D10扩展。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e03"></a>
### E03 · GI探针接实际场景更新

- **排程**：P1｜本轮待办｜责任角色：GI/图形｜初估 6–10 工程人日。
- **已有基础**：ProbeClipmap控制器/adapter/调度均存在，创建调用主要Lab。
- **代码入口**：[packages/deep-engine/src/webgpu/probeClipmapPbrController.ts](../../packages/deep-engine/src/webgpu/probeClipmapPbrController.ts)；[packages/deep-engine/src/webgpu/probeClipmapRuntime.ts](../../packages/deep-engine/src/webgpu/probeClipmapRuntime.ts)；[apps/web/src/viewer](../../apps/web/src/viewer)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：用真实场景光照/几何脏域驱动探针capture；接Studio质量档与Native对应能力报告。
- **通过标准**：移动灯光/遮挡物会更新间接光；budget可控，漏光/时序收敛有参考。
- **边界/失败验证**：相机传送、换包、device lost、旧generation、更新取消不发布脏卷。
- **依赖**：[E01](deep-engine-tasks-product-2026-09-16.md#e01)、[B02](deep-engine-tasks-foundation-2026-09-16.md#b02)、[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)。
- **验证**：T+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有ProbeClipmap；P2-04。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e04"></a>
### E04 · 局部反射与SSR首个切片

- **排程**：P2｜本轮待办｜责任角色：图形｜初估 6–10 工程人日。
- **已有基础**：已有IBL；本轮未确认生产SSR。
- **代码入口**：[packages/deep-engine/src/webgpu](../../packages/deep-engine/src/webgpu)；[packages/deep-engine/src/postprocess](../../packages/deep-engine/src/postprocess)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先可配置反射探针，再实现单bounce SSR+离屏回退；声明透明/粗糙限制。
- **通过标准**：镜面设备样本有空间变化反射；离屏与遮挡变化稳定，成本单列。
- **边界/失败验证**：屏边、薄物体、低粗糙、快速相机、历史失效反例覆盖。
- **依赖**：[E01](deep-engine-tasks-product-2026-09-16.md#e01)、[B03](deep-engine-tasks-foundation-2026-09-16.md#b03)。
- **验证**：T+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：反射增强新增。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e05"></a>
### E05 · 软阴影与局部灯光质量

- **排程**：P1｜本轮待办｜责任角色：图形｜初估 5–8 工程人日。
- **已有基础**：已有CSM/局部阴影/缓存，PCF基础不能算高级软阴影。
- **代码入口**：[packages/deep-engine/src/shadows](../../packages/deep-engine/src/shadows)；[packages/deep-engine/src/webgpu/localSpotShadowRuntime.ts](../../packages/deep-engine/src/webgpu/localSpotShadowRuntime.ts)；[packages/deep-engine-native/src/shadow_cache.rs](../../packages/deep-engine-native/src/shadow_cache.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先优化CSM稳定和bias，再加预算受控软阴影；支持范围与影子atlas分配可诊断。
- **通过标准**：移动相机/灯光的细管阴影稳定；边界过渡、穿帮和GPU预算有视频证据。
- **边界/失败验证**：薄面/尺度跨度、镜像、级联边界、缓存脏漏和剖切覆盖。
- **依赖**：[E01](deep-engine-tasks-product-2026-09-16.md#e01)、[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)、[D03](deep-engine-tasks-foundation-2026-09-16.md#d03)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：CSM/localSpotShadowRuntime。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e06"></a>
### E06 · 时序抗锯齿与细线保护

- **排程**：P1｜本轮待办｜责任角色：图形/QA｜初估 4–7 工程人日。
- **已有基础**：已有motion/TAA/FXAA/GTAO，静态像素不能证明稳定。
- **代码入口**：[packages/deep-engine/src/postprocess/temporalAaWgsl.ts](../../packages/deep-engine/src/postprocess/temporalAaWgsl.ts)；[packages/deep-engine/src/webgpu/pbrPostProcessChain.ts](../../packages/deep-engine/src/webgpu/pbrPostProcessChain.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：补变形/透明历史拒绝和相机cut，针对BIM细线/高亮/文字周边做稳定性调优。
- **通过标准**：固定运动视频拖影/闪烁满足阈值；AA切换不影响选择与细节识别。
- **边界/失败验证**：遮挡显露、暂停恢复、resize、曝光突变、低帧率覆盖。
- **依赖**：[E01](deep-engine-tasks-product-2026-09-16.md#e01)、[F02](deep-engine-tasks-product-2026-09-16.md#f02)。
- **验证**：T+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有temporalAa。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e07"></a>
### E07 · 天空雾与体积效果首片

- **排程**：P2｜本轮待办｜责任角色：图形/产品｜初估 6–10 工程人日。
- **已有基础**：已知解析雾/环境背景；未确认体积生产路径。
- **代码入口**：[packages/deep-engine/src/webgpu/studioEnvironment.ts](../../packages/deep-engine/src/webgpu/studioEnvironment.ts)；[apps/web/src/viewer/studioDeepEnvironment.ts](../../apps/web/src/viewer/studioDeepEnvironment.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：接可用天空/太阳参数，首片低分辨率体积雾，复用灯光与history；提供低配退路。
- **通过标准**：厂房/园区氛围有可控密度和遮挡；低档保持工程标识清晰，GPU成本可关。
- **边界/失败验证**：近远裁剪、室内漏光、剖切/透明叠加、相机cut覆盖。
- **依赖**：[E01](deep-engine-tasks-product-2026-09-16.md#e01)、[E05](deep-engine-tasks-product-2026-09-16.md#e05)、[B08](deep-engine-tasks-foundation-2026-09-16.md#b08)。
- **验证**：T+GPU+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：氛围增强。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="e08"></a>
### E08 · 双端渲染特性一致性

- **排程**：P2｜本轮待办｜责任角色：双端图形｜初估 6–10 工程人日。
- **已有基础**：Browser/Native能力与实现栈不同。
- **代码入口**：[packages/deep-engine/src/shaderAbi](../../packages/deep-engine/src/shaderAbi)；[packages/deep-engine-native/src/renderer/frame.rs](../../packages/deep-engine-native/src/renderer/frame.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：按E01冻结的必选AO/AA/透明/阴影特性逐项完成Native对等消费；记录非等价实现而非强行改hash。
- **通过标准**：同源场景两端必选视觉/行为矩阵全过；质量档与包能力报告一致。
- **边界/失败验证**：未知pass/ABI版本、设备limits不足与降级场景不静默错误。
- **依赖**：[E02](deep-engine-tasks-product-2026-09-16.md#e02)、[E05](deep-engine-tasks-product-2026-09-16.md#e05)、[E06](deep-engine-tasks-product-2026-09-16.md#e06)、[B06](deep-engine-tasks-foundation-2026-09-16.md#b06)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D14/D24。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## F · 动画、物理与媒体

<a id="f01"></a>
### F01 · 动画时间轴与TRS正式包

- **排程**：P1｜本轮待办｜责任角色：动画/Native｜初估 4–7 工程人日。
- **已有基础**：SceneAnimationMixer/glTF已有；Native正式动态场景不足。
- **代码入口**：[packages/deep-engine/src/animation/SceneAnimationMixer.ts](../../packages/deep-engine/src/animation/SceneAnimationMixer.ts)；[packages/deep-engine/src/runtimePackage](../../packages/deep-engine/src/runtimePackage)；[packages/deep-engine-native/src/player_content.rs](../../packages/deep-engine-native/src/player_content.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：统一tick/clip/loop/event revision；TRS打包并接Native播放/暂停/跳转，复用原mixer语义。
- **通过标准**：同时间点两端姿态及事件一致，时间步与显示解耦。
- **边界/失败验证**：负/超大dt、loop边界、零时长、迟到clip、切包取消覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[E02](deep-engine-tasks-product-2026-09-16.md#e02)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D13。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f02"></a>
### F02 · 蒙皮Morph与变形边界

- **排程**：P1｜本轮待办｜责任角色：动画/GPU｜初估 6–10 工程人日。
- **已有基础**：GPU skin/morph/deformation已存在且Studio有动画桥测试。
- **代码入口**：[packages/deep-engine/src/webgpu/gpuSkinning.ts](../../packages/deep-engine/src/webgpu/gpuSkinning.ts)；[packages/deep-engine/src/webgpu/gpuMorphDeformation.ts](../../packages/deep-engine/src/webgpu/gpuMorphDeformation.ts)；[packages/deep-engine-native/src/renderer](../../packages/deep-engine-native/src/renderer)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：接同源动画包到两端变形，维护前帧姿态、bounds和shadow变形；冻结组合能力。
- **通过标准**：三组skin/morph/组合样本同时间pose相符；剔除与motion不漏变形。
- **边界/失败验证**：权重异常、骨骼丢失、负缩放、重载跳时、buffer扩容覆盖。
- **依赖**：[F01](deep-engine-tasks-product-2026-09-16.md#f01)、[C02](deep-engine-tasks-foundation-2026-09-16.md#c02)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D13；已有GPU deformation。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f03"></a>
### F03 · 动画状态机最小可用切片

- **排程**：P2｜本轮待办｜责任角色：动画/工具｜初估 5–8 工程人日。
- **已有基础**：mixer支持层/混合，未验证完整状态机编辑产品。
- **代码入口**：[packages/deep-engine/src/animation](../../packages/deep-engine/src/animation)；[apps/web/src/components](../../apps/web/src/components)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：增加显式状态/条件/过渡资源，先idle/run/fault机械案例，接轻量编辑和运行诊断。
- **通过标准**：转移确定、blend可查、导出重载一致；状态机不持有Three对象。
- **边界/失败验证**：循环过渡、缺clip、相同tick多条件、取消过渡恢复覆盖。
- **依赖**：[F01](deep-engine-tasks-product-2026-09-16.md#f01)、[H01](deep-engine-tasks-product-2026-09-16.md#h01)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：AnimationMixer复用。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f04"></a>
### F04 · PhysicsWorld宿主中立接线

- **排程**：P1｜本轮待办｜责任角色：物理/Native｜初估 5–8 工程人日。
- **已有基础**：Web已Rapier固定步进、cuboid刚体。
- **代码入口**：[apps/web/src/viewer/viewerEngineSimulation.ts](../../apps/web/src/viewer/viewerEngineSimulation.ts)；[packages/deep-engine-native/src](../../packages/deep-engine-native/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：抽取身体ID/形状/约束/查询/step合同，先同一刚体落地案例接Web与Native候选后端。
- **通过标准**：位姿/碰撞事件在冻结容差内复现；运行参数可打包，版本记录完整。
- **边界/失败验证**：帧率变化、删除刚体、暂停重启、跨原点、异步初始化失败覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[D01](deep-engine-tasks-foundation-2026-09-16.md#d01)。
- **验证**：T+N+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D18；viewerEngineSimulation。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f05"></a>
### F05 · 机械约束与碰撞工具

- **排程**：P2｜本轮待办｜责任角色：物理/工业｜初估 6–10 工程人日。
- **已有基础**：Web示例主要cuboid；工业仿真另有模块。
- **代码入口**：[packages/workcell-validation-plugin](../../packages/workcell-validation-plugin)；[packages/virtual-commissioning-plugin](../../packages/virtual-commissioning-plugin)；[apps/web/src/viewer/viewerEngineSimulation.ts](../../apps/web/src/viewer/viewerEngineSimulation.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：在F04上增加一个铰链机械单元的运动学/关节/凸体与碰撞调试视图；复用现有workcell数据。
- **通过标准**：范围/限位/碰撞结果可追溯，参数编辑可保存；与渲染视觉同步。
- **边界/失败验证**：关节闭链非法、CCD高速、穿透初态、缩放不支持明确报错。
- **依赖**：[F04](deep-engine-tasks-product-2026-09-16.md#f04)、[D07](deep-engine-tasks-foundation-2026-09-16.md#d07)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：workcell/virtual-commissioning。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f06"></a>
### F06 · 导航与碰撞漫游跨端

- **排程**：P2｜本轮待办｜责任角色：交互/空间｜初估 5–8 工程人日。
- **已有基础**：Studio有navigation工具，Deep独立与Native覆盖待证。
- **代码入口**：[apps/web/src/viewer/viewerEngineNavigationTools.ts](../../apps/web/src/viewer/viewerEngineNavigationTools.ts)；[packages/deep-engine-native/src/player_state.rs](../../packages/deep-engine-native/src/player_state.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：抽取轨道/漫游输入动作，接碰撞胶囊与可达路径；首片单层厂房路线。
- **通过标准**：相同路径任务两端可走，焦点/速度/碰撞反馈明确。
- **边界/失败验证**：卡墙、楼梯/坡度、加载区缺几何、失焦、传送覆盖。
- **依赖**：[D01](deep-engine-tasks-foundation-2026-09-16.md#d01)、[D07](deep-engine-tasks-foundation-2026-09-16.md#d07)、[F04](deep-engine-tasks-product-2026-09-16.md#f04)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D11；navigation。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f07"></a>
### F07 · 粒子预设编辑与数据驱动

- **排程**：P2｜本轮待办｜责任角色：VFX/产品｜初估 5–8 工程人日。
- **已有基础**：已有GPU粒子和告警/扩散/流线基础。
- **代码入口**：[packages/deep-engine/src/webgpu/gpuParticleRuntime.ts](../../packages/deep-engine/src/webgpu/gpuParticleRuntime.ts)；[apps/web/src/components](../../apps/web/src/components)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：把一个告警/流向发射器做成版本资源，参数编辑→数据绑定→Web/Native能力消费。
- **通过标准**：同seed行为可回放；包声明和实际支持匹配，实例预算可见。
- **边界/失败验证**：过量粒子、绑定坏值、切场景、暂停/恢复和设备丢失释放覆盖。
- **依赖**：[B05](deep-engine-tasks-foundation-2026-09-16.md#b05)、[G06](deep-engine-tasks-product-2026-09-16.md#g06)。
- **验证**：T+N+W+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：gpuParticleRuntime；Deep2D行为。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="f08"></a>
### F08 · 媒体与XR能力首个验证

- **排程**：P2｜本轮待办｜责任角色：媒体/XR｜初估 5–8 工程人日。
- **已有基础**：Web已有spatialAudio/xrSession，不等于Deep/Native完整支持。
- **代码入口**：[apps/web/src/viewer/viewerEngineSpatialAudio.ts](../../apps/web/src/viewer/viewerEngineSpatialAudio.ts)；[apps/web/src/viewer/xrSession.test.ts](../../apps/web/src/viewer/xrSession.test.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先核对并接一个空间音源与视频纹理到Deep；XR单独验证WebGPU支持的设备路径，未支持准确降级。
- **通过标准**：媒体生命周期与离线资源可追踪；XR报告真实设备、后端、输入路径，缺设备保持未验证。
- **边界/失败验证**：权限拒绝、解码失败、音频焦点、XR session退出/设备丢失覆盖。
- **依赖**：[E08](deep-engine-tasks-product-2026-09-16.md#e08)、[H06](deep-engine-tasks-product-2026-09-16.md#h06)。
- **验证**：W+GPU+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：viewerEngineSpatialAudio/xrSession。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## G · 二维、数据与发布

<a id="g01"></a>
### G01 · 补完Dashboard组合宿主矩阵

- **排程**：P0｜本轮待办｜责任角色：二维/Web/Native｜初估 3–5 工程人日。
- **已有基础**：v5包/Native组合/Web整页候选已有，不再新建Chart入包。
- **代码入口**：[packages/deep-engine/src/runtimePackage/dashboardCandidateController.ts](../../packages/deep-engine/src/runtimePackage/dashboardCandidateController.ts)；[packages/deep-engine-native/src/dashboard_runtime](../../packages/deep-engine-native/src/dashboard_runtime)；[packages/deep-engine/src/webgpu/deep2d](../../packages/deep-engine/src/webgpu/deep2d)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：补Web双动态图表、换页输入、clip/命中归属；同一事件序列复跑Native，核对整页提交。
- **通过标准**：两个图表独立更新/换页/失败回退保持同页一致；复用现有candidate。
- **边界/失败验证**：第二组件失败、缺字体、迟到数据、resize与换页并发覆盖。
- **依赖**：[A01](deep-engine-tasks-foundation-2026-09-16.md#a01)、[A02](deep-engine-tasks-foundation-2026-09-16.md#a02)。
- **验证**：T+N+W+GPU+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：C1；P0-05/07/08。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g02"></a>
### G02 · 筛选器与页面外观编译

- **排程**：P0｜本轮待办｜责任角色：二维/产品｜初估 4–7 工程人日。
- **已有基础**：文字/图片/KPI/表格/六类图表已新增；筛选/完整页面样式未闭合。
- **代码入口**：[apps/web/src/delivery/compileDashboardContent.ts](../../apps/web/src/delivery/compileDashboardContent.ts)；[apps/web/src/delivery/lowerDashboardChart.ts](../../apps/web/src/delivery/lowerDashboardChart.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：在现有compileDashboardContent补一个筛选器及容器/阴影/背景语义；使用现有令牌和对象报告。
- **通过标准**：筛选实际改变表格/图表数据；编译内容/命中/z序与作者一致。
- **边界/失败验证**：空结果、缺绑定、长中文、overflow/深clip与隐藏组件覆盖。
- **依赖**：[G01](deep-engine-tasks-product-2026-09-16.md#g01)。
- **验证**：T+N+W+GPU+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：C2剩余；P0-01。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g03"></a>
### G03 · 正式权威资源读取适配

- **排程**：P0｜本轮待办｜责任角色：API/发布｜初估 4–6 工程人日。
- **已有基础**：C3 freeze、C4 capability、AuthorityAdapter和artifact合同已存在；route仍需核查。
- **代码入口**：[apps/api/src/dashboardPublicationAuthorityAdapter.ts](../../apps/api/src/dashboardPublicationAuthorityAdapter.ts)；[apps/api/src/dashboardPublicationFreeze.ts](../../apps/api/src/dashboardPublicationFreeze.ts)；[apps/api/src/applicationRoutes.ts](../../apps/api/src/applicationRoutes.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：接可信derive/resolveData/readResource到实际发布记录和私有对象存储，禁止客户端提供hash或能力；注册服务前做依赖闭包。
- **通过标准**：真实PG/MinIO发布版本生成不可变候选；草稿/字体/图片变化正确拒绝或保持旧版本。
- **边界/失败验证**：401、指针替换、取消、资源覆写、坏hash、并发准备覆盖。
- **依赖**：[G01](deep-engine-tasks-product-2026-09-16.md#g01)。
- **验证**：A+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：C3/C4现有模块；D06复用。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g04"></a>
### G04 · Dashboard正式编译与窗口证据

- **排程**：P0｜本轮待办｜责任角色：发布/Native｜初估 4–7 工程人日。
- **已有基础**：C5候选服务dashboardNativeCandidateService、实际artifact接受合同已新增；尚需正式依赖注入与HTTP持久化接线。
- **代码入口**：[apps/api/src/dashboardNativeCandidateService.ts](../../apps/api/src/dashboardNativeCandidateService.ts)；[apps/api/src/dashboardRuntimeArtifactCompiler.ts](../../apps/api/src/dashboardRuntimeArtifactCompiler.ts)；[apps/api/src/dashboardPublicationCapability.ts](../../apps/api/src/dashboardPublicationCapability.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用现有候选服务与compiler/artifact合同，接真实worker/window verifier、候选持久化登记和正式route；节点证据写manifest，逐步完成而不再新建service。
- **通过标准**：真正v5包通过正常窗口验证；compiled但未实际呈现对象不升级supported。
- **边界/失败验证**：编译器身份错、EXE变化、串字体/设备、worker超时拒绝发布。
- **依赖**：[G02](deep-engine-tasks-product-2026-09-16.md#g02)、[G03](deep-engine-tasks-product-2026-09-16.md#g03)。
- **验证**：A+N+GPU+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：C4/C5；D10复用。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g05"></a>
### G05 · 动态Dashboard真实下载离线交付

- **排程**：P0｜本轮待办｜责任角色：发布/Web/QA｜初估 4–7 工程人日。
- **已有基础**：Dashboard离线归档合同已新增；归档字节模块在并行施工，三维ZIP/launcher可复用。
- **代码入口**：[apps/api/src/dashboardOfflineArchive.ts](../../apps/api/src/dashboardOfflineArchive.ts)；[apps/web/src/delivery](../../apps/web/src/delivery)；[scripts/run-scene-client-native.mjs](../../scripts/run-scene-client-native.mjs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：先核对并复用dashboardOfflineArchive/Bytes新增产物，再接应用下载/历史重试UI和launcher；实际同ZIP在断网Windows启动，多页动态图表保留交互。
- **通过标准**：浏览器落盘hash=验证/启动hash；数据/字体完整离线，多页动态图表可运行。
- **边界/失败验证**：取消下载、坏包、历史重试、撤回后访问、断网重启与字体缺失覆盖。
- **依赖**：[G04](deep-engine-tasks-product-2026-09-16.md#g04)、[H06](deep-engine-tasks-product-2026-09-16.md#h06)。
- **验证**：A+N+W+WEB+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：C5；P0-06；D10。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g06"></a>
### G06 · 统一数据连接与二维三维联动

- **排程**：P1｜本轮待办｜责任角色：数据/运行时｜初估 5–8 工程人日。
- **已有基础**：离线sim/数据消息/数据源状态机已存在；不能等同真实HTTP。
- **代码入口**：[packages/deep-engine-native/src/chart/data_source](../../packages/deep-engine-native/src/chart/data_source)；[packages/data-runtime](../../packages/data-runtime)；[apps/web/src/viewer](../../apps/web/src/viewer)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：将一个受控HTTP连接接正式宿主；同dataRevision驱动Chart和构件颜色/状态，保留旧数据时间。
- **通过标准**：同revision可回放和定位告警；超时/断网显示stale，取消后不继续写入。
- **边界/失败验证**：401/5xx、乱序、重复、空值、频率过高、切场景、权限撤销覆盖。
- **依赖**：[G01](deep-engine-tasks-product-2026-09-16.md#g01)、[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[G03](deep-engine-tasks-product-2026-09-16.md#g03)。
- **验证**：T+A+N+W+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D17–D19；P1-13。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g07"></a>
### G07 · 接现有文本/IME合同到产品

- **排程**：P1｜本轮待办｜责任角色：文本/Native/Web｜初估 6–10 工程人日。
- **已有基础**：Unicode/undo/redo缺陷已修；字体字节冻结/栅格已有；真实输入仍欠。
- **代码入口**：[packages/deep-engine-native/src/platform_text/ime_session.rs](../../packages/deep-engine-native/src/platform_text/ime_session.rs)；[packages/deep-engine-native/src/platform_text/text_document.rs](../../packages/deep-engine-native/src/platform_text/text_document.rs)；[packages/contracts/src](../../packages/contracts/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：冻结TS/Rust文本golden，接一个可编辑字段的焦点/preedit/commit/caret/undo；字体身份沿用包合同。
- **通过标准**：真实中文输入、emoji/ZWJ删除、RTL与DPI候选窗按支持矩阵验收；文档元数据不越界。
- **边界/失败验证**：组合期换页/失焦、缺字fallback、撤销重做、版本溢出、失败提交覆盖。
- **依赖**：[G01](deep-engine-tasks-product-2026-09-16.md#g01)、[G04](deep-engine-tasks-product-2026-09-16.md#g04)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：P1-18/19/20；已修A/B不重做。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="g08"></a>
### G08 · 按证据接数据增量优化

- **排程**：P1｜本轮待办｜责任角色：二维/性能｜初估 4–7 工程人日。
- **已有基础**：ChartRows统计缓存/系列增量/失效记账已有，ChunkedRows还需核对接线；部分arena/atlas改造被测量否决。
- **代码入口**：[packages/deep-engine-native/src/chart/chunked_rows.rs](../../packages/deep-engine-native/src/chart/chunked_rows.rs)；[packages/deep-engine-native/src/chart/rows.rs](../../packages/deep-engine-native/src/chart/rows.rs)；[packages/deep-engine-native/src/deep2d_vertex_transfer.rs](../../packages/deep-engine-native/src/deep2d_vertex_transfer.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：用真实滚动数据接现有分块行，测snapshot/validate/geometry/upload/present；仅优化实测热点。
- **通过标准**：数据正确性同全量参考；主要热点收益可复现，全量/小图不回退。
- **边界/失败验证**：窗口淘汰、共享旧快照、分类/中文/null、隐藏系列、内存预算覆盖。
- **依赖**：[G01](deep-engine-tasks-product-2026-09-16.md#g01)、[G06](deep-engine-tasks-product-2026-09-16.md#g06)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)。
- **验证**：T+N+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：P1-03/04/05/06/08/10。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## H · 工具、SDK与交付

<a id="h01"></a>
### H01 · 独立SDK最小消费体验

- **排程**：P1｜本轮待办｜责任角色：SDK/工具｜初估 4–6 工程人日。
- **已有基础**：private引擎包和scene-sdk已有，独立消费者覆盖不足。
- **代码入口**：[packages/scene-sdk](../../packages/scene-sdk)；[packages/deep-engine/package.json](../../packages/deep-engine/package.json)；[scripts/gate-sdk-consumer.mjs](../../scripts/gate-sdk-consumer.mjs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：新增SDK consumer示例完成加载/相机/选择/更新/释放/恢复；清晰公开入口与版本策略。
- **通过标准**：Studio外空项目可构建运行；只引所需模块，API错误可定位。
- **边界/失败验证**：多实例、dispose两次、热重载、SSR误导入、取消加载覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[C01](deep-engine-tasks-foundation-2026-09-16.md#c01)。
- **验证**：T+W+SDK（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：gate:sdk-consumer复用。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h02"></a>
### H02 · 对象到GPU的诊断Inspector

- **排程**：P1｜本轮待办｜责任角色：工具/Web｜初估 4–7 工程人日。
- **已有基础**：Studio诊断/FrameMetrics已有。
- **代码入口**：[apps/web/src/components/RendererDiagnosticsPanel.tsx](../../apps/web/src/components/RendererDiagnosticsPanel.tsx)；[apps/web/src/viewer/StudioDeepPerformance.ts](../../apps/web/src/viewer/StudioDeepPerformance.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：把稳定对象ID映射到几何/材质/batch/pass/资源；首片解释不可见、未合批、超预算三类问题。
- **通过标准**：点击对象能定位实际draw或拒绝原因，导出脱敏诊断可复现。
- **边界/失败验证**：已删除对象、设备重建、共享资源、无GPU统计不能展示假值。
- **依赖**：[B02](deep-engine-tasks-foundation-2026-09-16.md#b02)、[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)、[D07](deep-engine-tasks-foundation-2026-09-16.md#d07)。
- **验证**：T+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有RendererDiagnostics。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h03"></a>
### H03 · 统一帧Profiler与性能回归

- **排程**：P1｜本轮待办｜责任角色：工具/性能｜初估 4–7 工程人日。
- **已有基础**：已有GPU timer与阶段遥测，缺跨宿主完整关联。
- **代码入口**：[packages/deep-engine/src/webgpu](../../packages/deep-engine/src/webgpu)；[packages/deep-engine-native/src/telemetry_gpu.rs](../../packages/deep-engine-native/src/telemetry_gpu.rs)；[apps/web/src/viewer/StudioDeepPerformance.ts](../../apps/web/src/viewer/StudioDeepPerformance.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：接作者变更→投影→上传→GPU→present关联ID，首片记录一次慢帧并定位到对象/资源。
- **通过标准**：原始trace可回放；诊断开销单独测，明确GPU与CPU口径。
- **边界/失败验证**：采样丢失、重叠帧、后台/暂停、device lost不串帧。
- **依赖**：[A03](deep-engine-tasks-foundation-2026-09-16.md#a03)、[B02](deep-engine-tasks-foundation-2026-09-16.md#b02)、[B03](deep-engine-tasks-foundation-2026-09-16.md#b03)。
- **验证**：T+N+W+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：telemetry/StudioDeepPerformance。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h04"></a>
### H04 · 轻量材质创作与调试

- **排程**：P2｜本轮待办｜责任角色：Shader/工具｜初估 5–8 工程人日。
- **已有基础**：DeepSL/typed IR/热更LKG已有，完整复杂Graph现范围排除。
- **代码入口**：[packages/deep-engine/src/shaderAuthoring](../../packages/deep-engine/src/shaderAuthoring)；[packages/deep-engine/lab/shaderWorkbench.ts](../../packages/deep-engine/lab/shaderWorkbench.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：接预设+参数+文本编辑到选中材质，源码错误回指和跨端预览；保留受支持pass预算。
- **通过标准**：一次材质修改可预览/撤销/保存/发布，错误保留最后正确效果。
- **边界/失败验证**：语法错误、ABI不符、过量编译、迟到结果、设备丢失覆盖。
- **依赖**：[C04](deep-engine-tasks-foundation-2026-09-16.md#c04)、[H02](deep-engine-tasks-product-2026-09-16.md#h02)。
- **验证**：T+N+W+GPU+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：DeepSL已有；不新建复杂Graph。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h05"></a>
### H05 · 行为命令与插件生命周期

- **排程**：P1｜本轮待办｜责任角色：SDK/运行时｜初估 5–8 工程人日。
- **已有基础**：shared-scene-script-protocol/scene-sdk与Native行为总线已存在。
- **代码入口**：[packages/contracts/src](../../packages/contracts/src)；[packages/scene-sdk](../../packages/scene-sdk)；[packages/deep-engine-native/src/behavior_ir](../../packages/deep-engine-native/src/behavior_ir)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：冻结一个高频插件能力接口，接选择→告警定位命令和撤销；权限/预算/版本检查复用现有合同。
- **通过标准**：Web/Native支持集合可枚举；插件卸载取消全部在途命令，事件回放一致。
- **边界/失败验证**：ID耗尽/复用、迟到settle、权限缺失、插件崩溃、预算溢出覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[G06](deep-engine-tasks-product-2026-09-16.md#g06)、[H01](deep-engine-tasks-product-2026-09-16.md#h01)。
- **验证**：T+N+SDK+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：P1-21/22；共享脚本协议。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h06"></a>
### H06 · Windows可分发运行包

- **排程**：P1｜本轮待办｜责任角色：发布/Native/QA｜初估 4–7 工程人日。
- **已有基础**：已有portable脚本/ZIP launcher/哈希与窗口验证。
- **代码入口**：[packages/deep-engine-native/scripts](../../packages/deep-engine-native/scripts)；[scripts/run-scene-client-native.mjs](../../scripts/run-scene-client-native.mjs)；[packages/deep-engine-native/src/player_cli.rs](../../packages/deep-engine-native/src/player_cli.rs)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：绑定EXE/运行包/字体/解码器版本，补干净Windows离线启动与文件关联/启动诊断；签名环境明确外部前置。
- **通过标准**：无开发工具机器可解压启动；非ASCII路径/DPI/缺资源报错可操作。
- **边界/失败验证**：EXE/包错配、临时目录失败、杀进程、运行依赖缺失覆盖。
- **依赖**：[G01](deep-engine-tasks-product-2026-09-16.md#g01)。包分发先覆盖已支持内容；普通三维环境与光照由E02及M1另行验收，不阻塞二维下载链。
- **验证**：N+INTEGRATION+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D20/D21。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h07"></a>
### H07 · 增量更新与原子回滚

- **排程**：P2｜本轮待办｜责任角色：发布/Native｜初估 6–10 工程人日。
- **已有基础**：内容hash/包校验/LKG可复用，完整安装更新缺证据。
- **代码入口**：[packages/deep-engine-native/scripts](../../packages/deep-engine-native/scripts)；[packages/deep-engine-native/src/runtime_package](../../packages/deep-engine-native/src/runtime_package)；[apps/desktop](../../apps/desktop)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：首片Windows单用户更新：下载/校验/候选启动/原子切换/失败回退；复用现有资源缓存。
- **通过标准**：升级前后用户数据保留；失败回到旧EXE+旧包匹配版本，可离线再次启动。
- **边界/失败验证**：断电/磁盘满/坏签名/并发启动/版本降级/清理失败覆盖。
- **依赖**：[H06](deep-engine-tasks-product-2026-09-16.md#h06)、[G05](deep-engine-tasks-product-2026-09-16.md#g05)、[C07](deep-engine-tasks-foundation-2026-09-16.md#c07)。
- **验证**：N+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D22/D23。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="h08"></a>
### H08 · AI可撤销创作与诊断首片

- **排程**：P2｜本轮待办｜责任角色：AI/产品/QA｜初估 4–7 工程人日。
- **已有基础**：平台已有AI/工业编排，不代表引擎特性领先。
- **代码入口**：[packages/industrial-agent-orchestrator](../../packages/industrial-agent-orchestrator)；[apps/web/src/ai](../../apps/web/src/ai)；[apps/api/src/ai](../../apps/api/src/ai)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：让一个自然语言任务生成受约束场景命令diff，预检→应用→撤销；首片批量告警着色/定位。
- **通过标准**：固定任务集记录成功率、人工修正和耗时；模型不在帧循环执行。
- **边界/失败验证**：对象幻觉、越权操作、过期revision、错误材质与超时拒绝变更。
- **依赖**：[H05](deep-engine-tasks-product-2026-09-16.md#h05)、[H02](deep-engine-tasks-product-2026-09-16.md#h02)。
- **验证**：T+A+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：复用现有AI/industrial-agent-orchestrator。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。


## I · 通用创作与复杂场景

<a id="i01"></a>
### I01 · Prefab实例与覆盖编辑

- **排程**：P2｜本轮待办｜责任角色：编辑器/运行时｜初估 5–8 工程人日。
- **已有基础**：平台prefab模块已有；未核实Deep跨端完整实例覆盖语义。
- **代码入口**：[apps/web/src/prefabs](../../apps/web/src/prefabs)；[packages/studio-core/src](../../packages/studio-core/src)；[packages/deep-engine/src/scene](../../packages/deep-engine/src/scene)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用现有prefab定义，冻结实例override/源更新/重置合同；首片设备模板更换后保留实例数据绑定。
- **通过标准**：模板→百实例→源更新→单实例覆盖→撤销→发布两端一致。
- **边界/失败验证**：源删除、循环嵌套、冲突override、稳定ID变化和共享材质覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[D07](deep-engine-tasks-foundation-2026-09-16.md#d07)、[H01](deep-engine-tasks-product-2026-09-16.md#h01)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：复用apps/web/src/prefabs。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i02"></a>
### I02 · 多人编辑版本冲突与恢复

- **排程**：P2｜本轮待办｜责任角色：编辑器/API｜初估 5–8 工程人日。
- **已有基础**：已有保存revision与发布CAS；未核实引擎中立协作产品。
- **代码入口**：[apps/api/src](../../apps/api/src)；[packages/contracts/src](../../packages/contracts/src)；[apps/web/src/controllers](../../apps/web/src/controllers)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：首片两个会话同时改同一设备，复用服务版本机制，提供冲突diff/重试/撤销；先不新建CRDT全套。
- **通过标准**：无静默覆盖；离线变更重连可恢复；作者命令与发布快照可追溯。
- **边界/失败验证**：重复消息、乱序、重连、权限撤销、删除与编辑竞争覆盖。
- **依赖**：[B01](deep-engine-tasks-foundation-2026-09-16.md#b01)、[H05](deep-engine-tasks-product-2026-09-16.md#h05)、[G03](deep-engine-tasks-product-2026-09-16.md#g03)。
- **验证**：T+A+W+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：现有协作/保存路径先盘点。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i03"></a>
### I03 · 程序几何到工业可编辑资产

- **排程**：P2｜本轮待办｜责任角色：工业几何/产品｜初估 6–10 工程人日。
- **已有基础**：已有parametric-modeling与工程格式模块。
- **代码入口**：[packages/parametric-modeling-plugin](../../packages/parametric-modeling-plugin)；[apps/web/src/optimizer](../../apps/web/src/optimizer)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：首片参数化管道/孔洞几何生成，复用现有几何内核，接修改/属性/剖切/发布；只声明经验证拓扑范围。
- **通过标准**：参数变化保持构件身份与材质；尺寸和网格质量可复算。
- **边界/失败验证**：退化参数、自交、单位不符、几何失败回退和取消覆盖。
- **依赖**：[C08](deep-engine-tasks-foundation-2026-09-16.md#c08)、[D08](deep-engine-tasks-foundation-2026-09-16.md#d08)。
- **验证**：T+N+W+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：parametric-modeling-plugin；格式计划。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i04"></a>
### I04 · 点云与3D Tiles混合园区

- **排程**：P2｜本轮待办｜责任角色：GIS/大场景｜初估 6–10 工程人日。
- **已有基础**：已有七格式计划涉及点云/Tiles，Deep真实混合驻留未验证。
- **代码入口**：[docs/specs/industrial-3d-format-work-plan-2026-09-16.md](../../docs/specs/industrial-3d-format-work-plan-2026-09-16.md)；[packages/deep-engine/src/streaming](../../packages/deep-engine/src/streaming)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：消费已验收规范化瓦片/点块，接D05调度、世界坐标与对象选择；首片离线园区模型+点云。
- **通过标准**：同预算下点/网格共存，远近LOD/拾取/精度可追踪；不丢坐标元数据。
- **边界/失败验证**：缺块、远程外链、量化误差、不同坐标系和快速移动覆盖。
- **依赖**：[C08](deep-engine-tasks-foundation-2026-09-16.md#c08)、[D04](deep-engine-tasks-foundation-2026-09-16.md#d04)、[D05](deep-engine-tasks-foundation-2026-09-16.md#d05)。
- **验证**：T+N+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：格式3D Tiles/E57/LAS方向。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i05"></a>
### I05 · 骨骼重定向与双骨IK

- **排程**：P2｜本轮待办｜责任角色：动画/工具｜初估 6–10 工程人日。
- **已有基础**：已有mixer/skinning，未核实完整重定向/IK工作流。
- **代码入口**：[packages/deep-engine/src/animation](../../packages/deep-engine/src/animation)；[packages/deep-engine/src/deformation](../../packages/deep-engine/src/deformation)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：首片双骨IK与两骨架映射，显示约束诊断并打包映射；与F03状态机独立插拔。
- **通过标准**：端点误差在预冻结容差内，保持关节限位；两端同姿态。
- **边界/失败验证**：骨长0、不可达目标、镜像骨架、缺骨和过渡中切换覆盖。
- **依赖**：[F02](deep-engine-tasks-product-2026-09-16.md#f02)、[F03](deep-engine-tasks-product-2026-09-16.md#f03)。
- **验证**：T+N+W+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：高级动画新增。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i06"></a>
### I06 · 时间轴与媒体事件轨

- **排程**：P2｜本轮待办｜责任角色：动画/媒体/工具｜初估 5–8 工程人日。
- **已有基础**：Studio timeline/空间音频已有，跨端完整电影/演示工作流未证。
- **代码入口**：[apps/web/src/viewer/viewerEngineTimelineRuntime.ts](../../apps/web/src/viewer/viewerEngineTimelineRuntime.ts)；[packages/deep-engine/src/animation](../../packages/deep-engine/src/animation)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用timeline，首片相机+TRS+告警+音频轨同步，支持scrub/暂停/循环并发布。
- **通过标准**：固定时刻状态可回放；跳转不重复外部副作用，媒体不同步可诊断。
- **边界/失败验证**：反向跳转、loop边界、缺媒体、帧率抖动/失焦覆盖。
- **依赖**：[F01](deep-engine-tasks-product-2026-09-16.md#f01)、[F08](deep-engine-tasks-product-2026-09-16.md#f08)、[H05](deep-engine-tasks-product-2026-09-16.md#h05)。
- **验证**：T+N+W+WEB（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：viewerEngineTimelineRuntime。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i07"></a>
### I07 · 可复现故障包与设备诊断

- **排程**：P1｜本轮待办｜责任角色：QA/运行时｜初估 3–5 工程人日。
- **已有基础**：已有诊断、scope与错误记录；客户现场最小复现未形成统一入口。
- **代码入口**：[packages/deep-engine-native/src/player_diagnostics](../../packages/deep-engine-native/src/player_diagnostics)；[apps/web/src/components/RendererDiagnosticsPanel.tsx](../../apps/web/src/components/RendererDiagnosticsPanel.tsx)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：首片导出脱敏场景命令、资源指纹、设置、崩溃/设备epoch诊断；本地replay同一失败。
- **通过标准**：无需客户凭据可定位一次设备恢复/坏包问题；明确哪些资源未包含。
- **边界/失败验证**：敏感配置泄露、超大日志、设备缺特性、报告篡改与丢资源覆盖。
- **依赖**：[H02](deep-engine-tasks-product-2026-09-16.md#h02)、[H03](deep-engine-tasks-product-2026-09-16.md#h03)、[B06](deep-engine-tasks-foundation-2026-09-16.md#b06)。
- **验证**：T+N+INTEGRATION（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D26；现有diagnostics。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="i08"></a>
### I08 · 误差受控的层级几何生成

- **排程**：P2｜本轮待办｜责任角色：几何/GPU｜初估 8–12 工程人日。
- **已有基础**：meshlet/LOD运行已有，不等于Nanite连续层级系统。
- **代码入口**：[packages/deep-engine/src/geometry](../../packages/deep-engine/src/geometry)；[packages/deep-engine/src/assetBakePlan.ts](../../packages/deep-engine/src/assetBakePlan.ts)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：复用bake，首片离线生成误差有界的cluster层级并保留边界/构件映射；接D06选择器。
- **通过标准**：相邻块不裂缝，误差随屏幕像素预算受控；构建时间/缓存大小/运行收益有证据。
- **边界/失败验证**：薄壁/小孔/非流形/材质边界/跨块边界不被过度简化。
- **依赖**：[C07](deep-engine-tasks-foundation-2026-09-16.md#c07)、[D06](deep-engine-tasks-foundation-2026-09-16.md#d06)。
- **验证**：T+N+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：Nanite Lite深度；不冒充完整Nanite。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

