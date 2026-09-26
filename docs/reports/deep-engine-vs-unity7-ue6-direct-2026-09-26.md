# Deep Engine 对 Unity 7 / UE6：全量能力与交付差距审计（2026-09-26）

## 现状核查

- **源码/未跟踪项**：已全仓检索 `packages/*/src`、`apps/*/src` 的引擎、Unity/Unreal、渲染、动画、物理、网络与交付实现，并核查未跟踪目录；既有 Unity Bridge 只算互操作，不算 Deep 原生能力。本报告不改发布暂存目录。
- **合同**：`packages/contracts/src/scene.ts`、`modelFormatCapability.ts`、`simulationEngine.ts` 已定义场景、物理、动画、格式验证和工业仿真合同；不重复建设。
- **依赖**：Web 已用 Three.js/Rapier/ECharts，Deep 为 TypeScript WebGPU + Rust/wgpu Native/WASM 路线；对比无需新增库。
- **消费方**：Web 作者态、发布编译与 Native/WASM 运行包均消费上述合同。`ROADMAP.md` 指定 Three WebGL 为作者态基线，Deep 是可切换后端，Native 单独验证。
- **测试/证据**：已有多后端单测、浏览器与 Native 门禁及内部配对基准；没有与 Unity 7/UE6 的实测，且未来版本尚未正式发布。最新内部结果和明确缺口见 `docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md`。
- **规格**：已查 `docs/specs/`、`docs/handoffs/`、`docs/reports/`、`test-output/`；工作区指令提及的工业格式总计划、恢复台账在当前 checkout 的对应路径缺失。以现存合同、代码、报告和官方公开计划为准。

**已有（不重建）**：RenderPacket、PBR、WebGPU/WASM/Native、LOD/meshlet/Hi-Z、流送/驻留、探针和后处理、基本动画/物理、工业数据语义和发布门禁。**真实缺口**：统一作者态、多端一致性、生产级画质与角色/物理/大世界工具链、平台/网络/生态、可复现的跨引擎证据。

## 版本口径

Unity 7 计划 2026 年 12 月发布 Preview、2027 年第一季度正式发布；当前 Unity 6.6 已发布，6.7 正在 Beta。UE6 计划 2027 年底 Early Access，正式版预计再晚 12–18 个月；UE 5.8 是当前已发布版，UE 5.9 只是可能追加。下表的 **规划** 是官方方向，**现有** 是 Unity 6.6 / UE 5.8 已有能力。不能把规划当交付承诺，也不能对尚未发布的引擎做性能定量结论。[Unity 2026 发布计划](https://unity.com/blog/unite-seoul-keynote-2026-recap)、[UE6 发布路线](https://www.unrealengine.com/news/the-road-to-ue-6)。

## 审计方法与判定口径

本报告比较的是 **Unity 7 继承 Unity 6.6/6.7 的能力及其公开规划**、**UE6 继承 UE5.8 的能力及其公开规划**，不是仅罗列下一版本新增项。统一分四个状态：**已交付**（本仓存在运行时、作者入口、消费方和测试）、**底座/局部**（有模块或测试，但闭环/跨端/场景覆盖不足）、**未见闭环证据**（检索不到可交付的完整链路，不能由此断言绝对不存在）、**规划**（对手尚未交付）。每个“缺口”都指可制作、运行、调试、发布、复现的产品能力，而不是同名函数。

核查范围：`packages/deep-engine/src`、`packages/deep-engine-native/src`、`apps/web/src`、`packages/contracts/src`、`package.json`、`Cargo.toml`、测试与 `docs/reports`；外部只取 Unity/Epic 官方文档、发布说明和路线。并未安装 Unity 7/UE6（尚未正式发布），没有同素材跨引擎跑分。下文性能、画质排序属于**待实测**，不得把本仓内部 WebGL/WebGPU 配对值外推到 Unity/UE。

### A. 渲染架构、画质和光照（14 项）

Unity 基线是 URP/HDRP、Shader Graph、烘焙与探针、后处理和平台分级；Unity 7 规划高端图形及神经升尺度。UE 基线是 Nanite、Lumen、VSM、TSR、Path Tracer、材质系统，且这些能力受渲染路径和硬件条件限制。参见 [Unity 6.6 渲染设置](https://docs.unity.com/en-us/engine/6000.6/manual/render-pipelines/universal-render-pipeline/urp-reference/universalrp-asset)、[Unity 7 路线](https://unity.com/releases/unity-7)、[UE5.8 渲染路径矩阵](https://dev.epicgames.com/documentation/unreal-engine/supported-features-by-rendering-path-for-desktop-with-unreal-engine)、[UE Lumen](https://dev.epicgames.com/documentation/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)。

1. **管线配置**：已有 WebGPU render graph/Native render graph；缺与 URP/HDRP 或 UE 相当的作者态渲染路径、质量档、设备能力、回退与发布配置的一体化管理。
2. **动态漫反射 GI**：已有 probe/clipmap/bake；缺对动态物体、遮挡变化、室内外混合、低端降级的统一质量与时序验证；不等于 Lumen 或 Unity 新 GI。
3. **动态镜面反射**：有局部 SSR/探针能力线索，未见完整的粗糙度、动态几何、离屏反射和跨端回退闭环。
4. **多灯与阴影**：有阴影图和更新分类；缺 MegaLights 类大量动态灯的可扩展吞吐、阴影缓存、光泄露诊断和场景作者工具。
5. **虚拟阴影**：有 shadow map，不等于 UE VSM 的高分辨率分页、反馈、驻留、远距裁剪及 Nanite 协同。
6. **硬件光追**：Native `ray_tracing_capability.rs` 是能力探测；未见可交付的 DXR/RT 管线、加速结构维护、材质/阴影/反射整合与降级。
7. **路径追踪与离线出图**：未见对标 UE Path Tracer 的收敛、降噪、材质覆盖、批量高分辨率输出闭环。
8. **几何虚拟化**：已有 meshlet/LOD/Hi-Z/virtual pages；缺 Nanite 类任意高模导入后的自动簇层级、误差控制、流送预算、光照/阴影/拾取一致性。
9. **纹理虚拟化**：已有纹理驻留/上传；未见完整的页表、GPU feedback、mip 反馈、失配回退、作者预算和可视化诊断。
10. **时域重建**：已有 TAA/temporal validity，**不是没有 TAA**；缺 TSR/FSR/DLSS/XeSS 或神经升尺度级的运动矢量、透明物/粒子、动态分辨率、抖动与鬼影调试闭环。
11. **材质与着色器**：已有 Shader Graph、IR、变体和 WGSL；缺 Unity/UE 的大规模节点库、子图迁移、平台编译器诊断、复杂材质（层叠、次表面、透射、毛发等）和内容作者生态。
12. **体积与大气**：已有 volumetric fog/环境；缺天空、云、水、体积材质、GI/阴影/天气相互作用及长期稳定性矩阵。
13. **颜色与显示链**：已有 ACES/PBR/后处理；缺 HDR display、广色域、色彩管理、输出设备校准、视频/截图一致性和项目级审色流程。Unity URP 已文档化 HDR 输出及色域变换：[官方说明](https://docs.unity.com/en-us/engine/6000.6/manual/materials-and-shaders/graphics-color/hdr/hdr-in-urp/hdr-output)。
14. **GPU 与画质诊断**：已有遥测/帧捕获；缺按 pass/材质/资源/场景对象贯通的 CPU-GPU 时间线、过度绘制、带宽/驻留、shader 变体和像素差异定位。

本仓关键证据：`packages/deep-engine/src/{renderGraph.ts,postprocess/temporalAa.ts,geometry/meshletBuilder.ts,virtualGeometryPages.ts,shaderGraph/,webgpu/gpuRenderResidencyRuntime.ts}`、`packages/deep-engine-native/src/{render_graph.rs,ray_tracing_capability.rs,probe_gi_grid.rs}` 及相邻测试。状态主要为**底座/局部**；不能把模块存在写成产品级等价。

### B. 场景规模、内容生产与资产管线（12 项）

对手基线：Unity 6.6 的内容目录/构建分析、Terrain 和资产导入；UE 的 World Partition、HLOD、Data Layers、PCG、Cook/DDC、Datasmith。UE5.8 已加入分区流送诊断；Mesh Terrain 与 Procedural Vegetation Editor 仍属实验。参见 [Unity 内容目录](https://docs.unity.com/zh-cn/engine/6000.6/manual/assets-and-media/assets-managing-runtime/content-directories/create)、[UE PCG 与 World Partition](https://dev.epicgames.com/documentation/unreal-engine/using-pcg-with-world-partition-in-unreal-engine)、[UE5.8 说明](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)。

15. **超大场景分区**：已有 chunk/stream/residency；缺可视化分区、依赖闭包、增量重建、HLOD 生成、按位置/相机预取、跨场景测试及异常恢复的统一管线。
16. **资产预算**：缺每设备/项目的纹理、几何、着色器、IO、内存预算及超限阻断/定位闭环。
17. **增量再导入**：已有 `AssetReimportCoordinator`；缺像 Unity/UE 那样对源文件依赖、下游场景覆盖、重名/重定向、版本升级和错误修复的长期生产验证。
18. **格式变体与 Cook**：有运行包、哈希和验证；缺多平台独立纹理/几何/shader 变体与自动 Cook、分包、热更新、回滚全链。
19. **数据层/流式编辑**：缺 UE World Partition/OFPA 类多人编辑时按对象拆分、冲突规避、分区协同和远距预览。
20. **地形与植被**：未见 Unity Terrain/UE Landscape 级高度场编辑、材质绘制、植被分布、风、遮挡与烘焙完整工具。
21. **PCG 图工作流**：有工业参数化/预制体；未见通用规则图、seed 可复现、空间采样、调试与批量生成的成熟内容管线。
22. **几何建模/修补**：有参数化/BIM 几何线；缺 UE Modeling Mode 级常见建模、UV、法线、LOD、碰撞几何编辑的可视化工作流。
23. **资产浏览与依赖**：有资源库/缩略图；缺跨项目搜索、引用影响分析、重复资源合并、移动/重命名的全链安全性。
24. **大场景第一帧**：内部切 Deep 后端首帧约 1.57s，对同机 WebGL 约 0.84s；这是**内部切换**而非整页冷启动，更不能外推对 Unity/UE。缺不同资源规模/缓存状态/设备的首个可交互帧和完整质量帧曲线。
25. **实例级剔除**：已有 meshlet/Hi-Z；最新本仓分析仍把实例级 GPU 剔除列为未完全闭环，需连带拾取、测量、轮廓和作者 ID 验证。
26. **掉线/取消/设备丢失**：有恢复策略线索；缺不同资源阶段取消、GPU device lost、OOM、缓存损坏的可复现矩阵及作者态无损恢复。

本仓证据：`packages/deep-engine/src/{assetReimportCoordinator.ts,webgpu/packetResidencyLoader.ts,threeBridge/worldStreamingBridge.ts}`、`apps/web/src/prefabs/`、`docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md`。

### C. 动画、角色与镜头（12 项）

Unity 有 Animator/Timeline/Cinemachine/Animation Rigging 等包；UE 有 Control Rig、Sequencer、Motion Matching、MetaHuman 和角色动画调试。UE5.8 部分新混合功能仍是实验项。参见 [Unity 角色动画特性集](https://docs.unity.com/en-us/engine/6000.6/manual/packages-list/feature-sets/character-animation-feature)、[UE Control Rig](https://dev.epicgames.com/documentation/unreal-engine/animating-with-control-rig-in-unreal-engine)、[UE Motion Matching](https://dev.epicgames.com/documentation/unreal-engine/motion-matching-in-unreal-engine)。

27. **关键帧/混合**：已有 SceneAnimationMixer、状态机、采样；缺可视化曲线/层/遮罩、动画复用、嵌套时间线及跨端对照。
28. **骨骼导入**：已有 glTF 动画导入；缺对复杂骨架、非标准权重、压缩与错误修复的大样本认证。
29. **IK**：`apps/web/src/viewer/ik.ts` 已有 IK，**不能写成不存在**；缺全身 IK、复杂约束、作者控件、运行时跨端验证。
30. **重定向**：未见跨不同骨架比例/姿态的资产映射、批量校准和异常可视化闭环。
31. **Motion Matching**：未见姿态数据库、轨迹查询、索引构建、可视化调试和角色控制消费。
32. **Control Rig 类作者态**：未见骨骼/控制器/约束图与镜头时间线直接联动的完整制作环境。
33. **角色运动**：基础路径/导航能力有；缺 root motion、坡度/台阶/碰撞/相机/输入联动的跨端完整角色框架。
34. **面部与数字人**：未见脸部绑定、实时表情捕获、语音口型、头发/皮肤与角色资产库整合。
35. **摄像机系统**：有相机导航和工业相机预制体；缺 Cinemachine/UE Camera Rig 级多镜头混合、轨道、避障、抖动、镜头语言与编辑工具。
36. **影片时间线**：有场景时间线/回放，缺 Sequencer 级镜头、动画、材质、音视频、事件多轨联动及可重复输出。
37. **骨骼性能**：缺大量角色 GPU skinning、动画 LOD、姿态缓存、异步更新与平台剖析的公开交付证据。
38. **动画资产治理**：缺重定向/压缩/片段版本变更后的依赖迁移和批量回归工作流。

本仓证据：`packages/deep-engine/src/animation/`、`packages/deep-engine/src/gltf/animation*`、`apps/web/src/viewer/ik.ts`、`apps/web/src/components/SceneTimelinePanel.tsx`；**已有基础动画，角色生产链为局部**。

### D. 物理、导航、仿真（11 项）

对手基线：Unity 物理/Navigation/ECS；UE Chaos 刚体、布料、破碎、车辆、导航和 Dataflow。UE5.8 Chaos Cloth Production Ready，但 Control Rig Physics 为 Beta。参见 [Unity 特性集](https://docs.unity.com/en-us/engine/6000.6/manual/packages-list/feature-sets)、[UE5.8 发布说明](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)。

39. **刚体运行时**：Web Rapier、`compileScenePhysicsRuntime`、Native `native_physics.rs` 已有，**不是从零**；缺复杂场景材质/约束/CCD/休眠/确定性及 Web/Native 同资产行为比较。
40. **碰撞几何生产**：缺从 BIM/CAD 三角网到简化 collider、分层过滤、触发器、修补和可视化调试的通用作者闭环。
41. **关节与约束**：缺机械臂/多体约束强度、极限、马达、接触反馈等大规模可信验证。
42. **连续碰撞与高速物体**：缺 CCD 的跨端参数和极端速度回归矩阵。
43. **破碎/布料/毛发/软体**：未见与 Chaos 同量级的作者、求解器、缓存、回放链；对工业主线优先级可低。
44. **车辆/机电设备**：有工业预制体与轨迹；缺游戏车辆或复杂工业机构的物理驱动、摩擦/悬挂/接触控制。
45. **导航网格**：Native 有 `runtime_navigation.rs`；真实窗口的三角碰撞、坡度、步高、重力、跳跃、第一/第三人称尚需闭环证据。
46. **动态避障与人群**：未见多代理导航、动态重规划、局部避障、拥堵调试及作者工具。
47. **仿真时钟/确定性**：有工业仿真合同与回放；缺跨端同 seed、固定步长、时钟漂移、回滚及外部实时数据混用的统一语义与证据。
48. **大规模实体计算**：缺 Unity ECS/Jobs/Burst、UE Mass 类通用数据导向框架与作者/调试工具；已有工业仿真优化不能等同通用引擎 ECS。
49. **仿真结果可证性**：缺真实设备数据与物理/工艺模型的误差标定、参数版本、复现实验和失效边界公开证据。

本仓证据：`apps/web/src/delivery/compileScenePhysicsRuntime.ts`、`packages/deep-engine-native/src/{native_physics.rs,runtime_navigation.rs}`、`packages/contracts/src/simulationEngine.ts`、最新性能与能力报告。

### E. VFX、音频、视频与影视（10 项）

Unity 有 VFX Graph、Audio、Timeline；UE 有 Niagara、MetaSounds、Media Framework、Sequencer、Movie Render Graph、Live Link。UE5.8 把 Movie Render Graph 和 Live Link Hub 标为 Production Ready。[Unity 包清单](https://docs.unity.com/en-us/engine/6000.6/manual/pack-mini-toc)、[UE5.8 发布说明](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)。

50. **GPU 粒子**：已有 `gpuParticleRuntime`/emitters/burst，**不是没有粒子**；缺 Niagara/VFX Graph 级可视化系统、事件、碰撞、排序、灯光、跨平台降级和效果资产库。
51. **VFX 图与调试**：缺粒子与场景事件/音频/物理/材质统一图工作流、每发射器性能诊断与版本治理。
52. **复杂特效**：火焰/工业特效有消费方；缺流体、烟、异构体积、高质量透明/折射及离线缓存普适链。
53. **3D 音频**：Native `dashboard_audio.rs` 有底座；缺成熟混音器、总线、空间化、遮挡、混响、动态范围、设备切换和跨端一致性。
54. **程序化音频**：未见 MetaSounds 类图资产、信号流程和实时参数联动。
55. **视频播放**：Native Media Foundation/合成已存在；正式窗口 seek、控制、音频输出、音画同步仍需闭环。
56. **编码/直播**：有云渲染控件；缺多协议、低延迟、码率自适应、端到端监测、字幕/多轨音频的产品级证据。
57. **电影拍摄**：缺镜头/场记/Take Recorder、轨道录制、远程摄影机与剪辑交换。
58. **高质量离线输出**：缺 Movie Render Graph 类多通道、分帧、采样/降噪、色管、批量渲染与失败恢复。
59. **虚拟制片**：缺 Live Link/nDisplay 类跟踪、同步、多屏、摄影棚校准和现场运维工具。

### F. 编辑器、开发者工作流与扩展（14 项）

Unity 7 **规划** CoreCLR/.NET 10/C# 14、近即时 Play、部分热重载、CLI/MCP；UE6 **规划** Verse/Scene Graph 与 UE5/UEFN 融合，现有 Actor/Blueprint 先继续存在。两家现行版本已有成熟编辑器、包系统与测试/分析工具。[Unity 7](https://unity.com/releases/unity-7)、[UE6 官方路线](https://www.unrealengine.com/news/the-road-to-ue-6)、[UE 自动化测试](https://dev.epicgames.com/documentation/unreal-engine/automation-test-framework-in-unreal-engine)。

60. **纯 Deep 作者闭环**：Three.js WebGL 仍是作者基线；Deep 后端选择、拾取、gizmo、撤销、保存、重开、发布需同对象全链验证，当前为 P0 缺口。
61. **编辑/运行一致性**：Deep WebGPU、WASM、Native 各有运行路径；缺同一项目在作者态和交付态的功能、视觉、输入、脚本一致性矩阵。
62. **Play/Stop 迭代**：缺 Unity/UE 级状态隔离、快速热重载、失败回滚、运行态改动应用和调试器协同；Unity 7 具体提升仍属规划。
63. **通用脚本模型**：有受控 `studio.*` 和行为 IR；缺 C#/Blueprint/Verse 级通用组件生命周期、复杂控制流、调试、包管理和社区脚本生态。
64. **可视化逻辑**：缺 Blueprint 类大型图项目的层级、接口、版本、断点、单步、运行性能和安全迁移能力。
65. **Prefab/组件继承**：有工业预制体；缺任意组件预制体、变体、嵌套覆盖、断链修复及跨场景升级。
66. **编辑器插件**：有插件兼容/SDK；缺稳定扩展 API、二进制兼容承诺、权限隔离、生命周期、商店/审核与样例生态。
67. **Undo/Redo 事务**：局部编辑命令已存在；缺所有资源/场景/行为/材质/工业数据编辑的统一可逆事务及崩溃恢复。
68. **多用户同场编辑**：presence/lease 已有，不能当作完整实时协同；缺冲突合并、对象锁、变更归因、离线重连与版本管理。
69. **大项目定位**：缺全局查找引用、场景层级性能、批量属性编辑、内容审计和数万对象编辑响应的生产级证据。
70. **IDE/调试器**：缺脚本断点、跨 JS/Rust/WGSL 栈、热重载、错误定位、运行包符号与源码映射的统一体验。
71. **自动化与无头工具**：有多类 gate；缺 Unity CLI/UE Commandlet 类完整项目操作 API、批量导入/构建/截图/发布标准化接口和版本化兼容政策。
72. **Agent 工作流**：已有工业受控操作；对手也在做 MCP。缺操作权限、审计、模拟预览、失败回滚和多 Agent 冲突在大项目中的对照证据；不能把“有 MCP”当唯一优势。
73. **团队升级路径**：缺项目从旧运行包/合同/脚本/资源版本自动迁移、弃用提示、兼容测试及长期维护窗口的公开承诺。

本仓证据：`ROADMAP.md`、`apps/web/src/viewer/{StudioDeepWebGpuBridge.ts,StudioDeepWasmBridge.ts}`、`apps/web/src/hooks/useEditorPresence.ts`、`apps/web/src/studio/`、`packages/deep-engine/src/pluginCompatibility/`。

### G. UI、2D、输入与可访问性（9 项）

Unity 6.6 有专门 2D 特性集、UI/输入系统；UE 有 UMG/Slate/Common UI 等。对手在游戏 HUD、手柄和多设备适配方面积累较深。[Unity 特性集](https://docs.unity.com/en-us/engine/6000.6/manual/packages-list/feature-sets)、[UE5.8 系统总览](https://dev.epicgames.com/documentation/unreal-engine/unreal-engines-systems-and-workflows-overview-for-unity-developers)。

74. **2D 内容制作**：Deep2D/仪表盘已有；缺 Sprite、Tilemap、骨骼 2D 动画、2D 物理和关卡编辑一体化工作流。
75. **游戏 HUD/UI**：工业看板已强；缺跨游戏手柄焦点、导航、HUD 动画、UI 状态机、游戏世界空间控件的通用框架。
76. **输入动作映射**：缺统一键鼠/触摸/手柄/XR 动作资产、重绑定、设备切换、无障碍设置和运行包持久化。
77. **文本/国际化**：Native 有平台文本；缺富文本排版、复杂脚本、RTL、字体回退、复数/格式化及跨端视觉回归的完整证明。
78. **可访问性**：缺读屏语义、键盘导航、对比度、缩放、动作减少和无障碍测试的跨 Web/Native 一致性。
79. **移动触控**：缺手势冲突、软键盘、刘海屏、安全区、性能档及断网/后台恢复的大规模设备矩阵。
80. **XR UI**：缺立体 UI、手柄/手势/注视、空间锚和舒适性约束的完整作者与运行链。
81. **UI 性能**：Native virtual list/Deep2D 有底座；缺复杂动态布局、跨屏 DPI、字体 atlas、输入响应和大数据刷新跨端对照。
82. **设计系统与模板生态**：有工业模板；缺 Unity/UE 社区 UI 资产、插件、主题、迁移和跨项目复用规模。

### H. 网络、多人、在线服务（9 项）

Unity 6.6 包含 Netcode for Entities/Dedicated Server；UE5.8 Iris 按发布说明对许可用户已 Production Ready；UE6 的持久分布式世界/Verse 事务内存是**研究原型或计划**，不能算已交付。[Unity 包清单](https://docs.unity.com/en-us/engine/6000.6/manual/pack-mini-toc)、[UE5.8 发布说明](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)、[UE6 路线](https://www.unrealengine.com/news/the-road-to-ue-6)。

83. **运行时状态复制**：WebSocket/工业实时数据连接已有；未见权威服务器、对象复制、兴趣管理、差量快照的通用游戏多人框架。
84. **预测/回滚**：未见客户端预测、补偿、回滚重放、网络时钟和带宽抖动测试的完整链。
85. **专用服务器**：未见 headless 仿真/游戏服务器构建、部署、区域扩缩容和版本迁移闭环。
86. **会话与身份**：工业平台已有登录/权限；缺游戏大厅、匹配、组队、断线重连、语音聊天和跨平台账户的一体化框架。
87. **持久世界**：未见持久化世界分片、跨服迁移、事务状态、海量玩家并发验证；UE6 对应愿景也尚未交付。
88. **多人作者协作**：见第 68 项；不能把编辑 presence 与玩家运行时网络复制混为一谈。
89. **网络调试**：缺带宽/延迟/丢包可视化、网络录制重放、服务器性能和作弊/异常流量诊断的通用工具。
90. **边缘/弱网工业运行**：数据断连回退已有线索；缺场景资源、实时点位和用户编辑在断网/弱网下的统一同步策略与长时证据。
91. **在线服务生态**：缺云存档、遥测、A/B、远程配置、内容更新、支付等游戏运营 SDK 的内聚集成；对当前工业主线可低优先。

### I. 平台、XR、构建与发布（11 项）

UE5.8 官方打包文档覆盖桌面、移动、主机、XR，并有 UAT/Cook/Stage/Package/Deploy/Run；Unity 有跨平台构建工具，6.6 WebGPU 已脱离 Experimental。[UE 打包](https://dev.epicgames.com/documentation/unreal-engine/packaging-your-project)、[UE Build Operations](https://dev.epicgames.com/documentation/unreal-engine/build-operations-cooking-packaging-deploying-and-running-projects-in-unreal-engine)、[Unity 6.6 新功能](https://docs.unity.com/en-us/engine/6000.6/manual/whats-new/unity66)。

92. **平台覆盖**：Deep 主要 Web/Windows Native；缺 macOS/Linux/iOS/Android/主机等完整 SDK、渲染、输入、发布和支持矩阵。
93. **浏览器 WebGPU**：Deep 的浏览器本地运行是真实路线；Unity 6.6 亦支持 WebGPU，优势只能从包体、冷启动、编辑/发布成本、数据闭环实测证明。
94. **UE 浏览器交付**：UE Pixel Streaming 是服务器渲染；Deep 本地浏览器运行可能省服务器 GPU，但要测功能、画质、端侧设备和总体成本。[UE Pixel Streaming](https://dev.epicgames.com/documentation/unreal-engine/pixel-streaming-in-unreal-engine)。
95. **XR 平台**：WebXR 入口不等于 OpenXR/Quest/PSVR/visionOS 生产支持；缺设备特性、帧时、交互和发布认证矩阵。
96. **包体/分发**：有运行包校验；缺多平台 chunk、补丁、DLC、差分更新、断点续传、签名和可回滚发布的完整产品化。
97. **原生崩溃恢复**：缺设备丢失、驱动重启、媒体解码失败、显存压力、崩溃上报与用户现场诊断的规模化证据。
98. **平台功能抽象**：缺文件/剪贴板/通知/触觉/控制器/音频设备/窗口/显示器等跨端能力合同与兼容测试的系统性覆盖。
99. **分辨率与 HDR**：缺高 DPI、可变刷新率、动态分辨率、HDR display、多显示器、远程桌面的发布矩阵。
100. **安全与沙箱**：有受控脚本策略；缺第三方插件、脚本、模型、媒体输入在 Web/Native 全路径的权限隔离和恶意样本回归。
101. **长时运行**：缺 24h/7d 工业看板、断网/睡眠恢复、内存泄漏、GPU 资源碎片与自动更新的公开 soak 证据。
102. **企业部署**：有自托管/离线方向；缺大组织升级、镜像、灾备、监控、SLA 与多租户隔离的持续实证。

### J. 工业 CAD/BIM、语义与数据（10 项）

UE Datasmith 官方支持 STEP、IFC、JT、Parasolid `.x_t` 等格式（具体路径/质量按格式矩阵）；Unity Studio 已宣布浏览器协作与 PLM 自动化。不能把 Deep 的格式数量写成无条件领先。[UE Datasmith 矩阵](https://dev.epicgames.com/documentation/unreal-engine/datasmith-supported-software-and-file-types)、[Unity 2026 发布说明](https://unity.com/blog/unite-seoul-keynote-2026-recap)。

103. **格式 profile 覆盖**：本仓有 `modelFormatCapability.ts`、catalog 和验证；缺对各 CAD/BIM 格式**版本×特征×几何×语义**的完整真实样本矩阵，尤其工业复杂 profile。
104. **几何精度**：缺装配层级、曲面/布尔、拓扑修补、坐标系、单位与公差跨格式回归的公开统计。
105. **属性与语义**：缺材质、图层、构件 ID、系统关系、参数、变更映射在重导入/发布/查询中的端到端保真率。
106. **增量同步**：有再导入底座；缺与 CAD/BIM 源版本差异、对象稳定 ID、用户覆盖冲突和数据绑定迁移的整套证据。
107. **大装配交互**：缺千万构件条件下树、搜索、选中、隔离、测量、剖切、标注和数据刷新 P95/P99 实测。
108. **PLM/现场数据连接**：已有连接/数据集/绑定；缺供应商 PLM、BMS、SCADA、OPC UA、MQTT 的版本治理、历史回填、异常重试和权限审计通用矩阵。
109. **空间语义**：有设备/楼层等场景语义；缺跨建筑/工厂/产线标准模型、关系查询、时态事件和版本映射公开规范。
110. **工业仿真可信度**：有 Plant Lite 等模块；缺工艺/机械/物流/能耗仿真的真实数据校准、置信区间、验证案例和误差边界。
111. **可视化到行动**：已有告警/看板；缺告警定位→原因→工单/控制→复核的现场组织流程和第三方系统集成证据。
112. **离线内置交付**：路线应继续自研/开源、内置、本地离线；缺失 profile 要明确 inspect/preview/阻断和样本证据，不得把外部商业 SDK 或云转换当运行依赖。

### K. 性能、质量、测试与生态（10 项）

Unity 有 CPU/GPU/内存分析工具；UE 有 Unreal Insights、设备自动化、截图比较、UAT。Deep 有单测与多后端 gate，但生产成熟度需要代表性项目和真实设备来证明。[Unity Profiling Tools](https://docs.unity.com/en-us/engine/6000.0/manual/analysis/performance-profiling-tools)、[UE 自动化框架](https://dev.epicgames.com/documentation/unreal-engine/automation-test-framework-in-unreal-engine)、[UE 自动化系统](https://dev.epicgames.com/documentation/unreal-engine/automation-system-user-guide-in-unreal-engine)。

113. **同场景性能**：暂无 Deep、Unity 7、UE6 的同素材同设备同画质可重复测试；所有“超过/落后 X%”的跨引擎结论均未证实。
114. **本仓内部延迟**：最新配对 WebGPU 静置 P95 7.1ms vs WebGL 7.2ms，输入帧 14.0ms vs 7.1ms，切后端首帧 1.57s vs ~0.84s；这是明确的本地差距和追踪基线。
115. **内存/显存**：缺不同资产尺寸的峰值、稳态、碎片、上传抖动、设备丢失恢复和低显存退化的统一可视化。
116. **编译与迭代**：缺 Unity/UE 同等规模项目的导入、shader 编译、编辑器启动、热重载、发布全流程计时。
117. **功能覆盖矩阵**：已有 gate，但缺按 WebGL/WebGPU/WASM/Native × 设备 × 格式 × 功能的公开绿黄红矩阵和严格 fail-closed 发布策略。
118. **视觉回归**：缺跨 GPU/驱动/浏览器的 SSIM/差异热图、容差准则、动态内容稳定性及与参考渲染对照。
119. **内容规模回归**：缺企业真实大场景与匿名开放样本的长周期回归、性能趋势和故障定位数据。
120. **崩溃/遥测**：已有遥测，但缺现场故障聚合、版本回归归因、隐私约束与修复时长统计。
121. **文档/样例/生态**：Unity Asset Store 与 UE Fab/样例规模显著更大；Deep 需要足够的可运行示例、SDK 稳定性与迁移文档，不能用功能清单替代可用生态。
122. **授权与定位清晰度**：`LICENSE` 与 README 对许可/开源措辞需统一；仓库 `ROADMAP.md` 已明确不追通用游戏引擎全功能平权，外部比较应保持一致。

## 直接对比：40 个归纳索引（详细原子项见上）

### 1. 图形与大世界

| # | 能力 | 对 Unity 7 的差距 | 对 UE6 的差距 | 我们当前判断 |
| ---: | --- | --- | --- | --- |
| 1 | 动态 GI | Unity 6.7 的 Surface Cache GI 已进测试，预计延续到 7；缺同级动态几何/昼夜/移动端质量伸缩 | UE5 的 Lumen/Lumen Lite 基线将延续；缺同级动态光照和反射覆盖 | **大**：探针/近似 GI 已有，但非完整替代 |
| 2 | 实时多灯与阴影 | 缺成熟 URP/HDRP 光照配置、烘焙与质量分层 | UE5.8 MegaLights 已 Production Ready；缺大规模带阴影动态灯及调试 | **大** |
| 3 | 光线追踪/路径追踪 | 缺 HDRP 级 RT 与统一降级 | 缺 UE 硬件 RT、Path Tracer 的可交付品质 | **大**：能力探测不等于渲染交付 |
| 4 | 虚拟化几何 | 缺从资产导入到 GPU 的通用自动高模流送链 | 缺 Nanite 级自动簇、可见性、实例和显存闭环 | **大**：已有 meshlet/LOD/Hi-Z，不能称等价 |
| 5 | 虚拟纹理 | 纹理缓存、压缩和流送工具链深度不足 | 缺 Virtual Texturing 的页反馈、作者、打包和调试闭环 | **中/大** |
| 6 | 超分辨率/时间抗锯齿 | 已有 TAA；Unity 7 规划神经升尺度，缺成熟统一 Upscaler 与调试 | 缺 UE TSR 及硬件超分生态的统一接入 | **大** |
| 7 | 材质/Shader 作者生态 | 缺 Shader Graph + URP/HDRP 的完整节点/变体/平台预览 | 缺 UE Material/Substrate 的材质广度和工具成熟度 | **中**：已有 Shader IR/图底座 |
| 8 | 粒子与 VFX | 已有 GPU 粒子，缺 VFX Graph 的图编辑、事件、剖析与大量模板 | 缺 Niagara 的跨 CPU/GPU 系统和内容生态 | **大** |
| 9 | 地形/植被/PCG | 缺 Terrain、2D/3D 混合作者与大规模植被 | 缺 Landscape/PCG；UE5.8 Mesh Terrain/PVE 仍是实验项 | **大**，但非工业主线 |
| 10 | 体积、水、云、天气 | 有雾与天气，但缺统一物理光照、天气体积和水体系统 | UE 的电影级体积、云水和环境工具更广 | **中** |
| 11 | 大世界分区/预取 | 缺成熟场景流送、资产分层、远距内容生产工具 | 缺 World Partition/HLOD/OFPA 的大规模制作和诊断闭环 | **中**：已有 chunk/驻留底座 |
| 12 | 画质/性能可证性 | 无同资产同画质跨引擎 P95/P99、包体、内存数据 | 同左；不能据局部 GPU 算法宣称超过 Nanite/Lumen | **待测** |

### 2. 动画、仿真与多媒体

| # | 能力 | 对 Unity 7 的差距 | 对 UE6 的差距 | 我们当前判断 |
| ---: | --- | --- | --- | --- |
| 13 | 动画时间线与混合 | 缺 Timeline、Animation Rigging 的完整剪辑/层/曲线/工具 | 缺 Sequencer、Control Rig 的编辑和高质输出 | **中**：基础关键帧/状态机已有 |
| 14 | IK、重定向、motion matching | 已有局部 IK，缺重定向、姿态搜索与成熟角色动画工作流 | 缺 UE Retarget、Motion Matching、Control Rig 的完整链 | **大** |
| 15 | 数字人/面捕/群体 | 缺成熟角色资产和实时动作捕捉生态 | 缺 MetaHuman、面体捕获、Mass 群体制作 | **大**，工业主线可暂不追 |
| 16 | 刚体物理 | Unity 物理 API、调试和跨端生产证据更完善 | Chaos 物理与 Dataflow 作者体系更广 | **中**：Web Rapier 有，Native 验证不足 |
| 17 | 布料/毛发/流体/破碎 | 缺相关作者、求解、缓存和回放体系 | UE5.8 Chaos Cloth 已生产可用；破碎等体系已有 | **大** |
| 18 | 导航/角色控制 | Unity Navigation、角色输入及平台联调更成熟 | UE Navigation/Mover/预测与调试更广 | **大**：Native 三角碰撞/坡度/步高等未闭环 |
| 19 | 空间音频/视频 | 缺跨端混音、声场、音画同步和 Seek 完整消费 | 缺 MetaSounds 与视频/电影级音频工作流 | **大**：Native 尚有明确缺口 |
| 20 | XR | 缺 OpenXR 设备矩阵、手势/控制器、性能工具 | 缺 UE 多设备 XR 及虚拟制片周边 | **大**：WebXR 入口不等于跨设备方案 |
| 21 | 影视/虚拟制片 | 缺镜头/离线渲染/时间线的整套制作流程 | 缺 Movie Render Graph、Live Link、nDisplay | **大**，非当前必需 |

### 3. 编辑器、代码与团队生产

| # | 能力 | 对 Unity 7 的差距 | 对 UE6 的差距 | 我们当前判断 |
| ---: | --- | --- | --- | --- |
| 22 | 纯 Deep 作者态 | Unity 编辑、运行与发布是统一产品；7 还计划更快 Play Mode | UE Editor 到 Cook/运行管线成熟 | **P0**：Deep 选择/gizmo/撤销/保存/重开还未完全脱离 Three |
| 23 | 编辑迭代速度 | Unity 7 规划 CoreCLR/.NET 10/C# 14、局部代码重载、近即时 Play、快 Shader Build | UE 5.8 有增量 Cook/Zen Server；UE6 继续压缩迭代环 | **大** |
| 24 | 可视化逻辑与脚本 | 缺 C#/Burst/Jobs/ECS 的通用计算和编辑工具规模 | 缺 Blueprint 生态；UE6 规划 Verse + Scene Graph 新框架 | **大**：`studio.*` 有工业用途但非通用游戏框架 |
| 25 | 预制体/组件继承 | 缺 Prefab Variant 的成熟覆盖管理 | 缺 Blueprint 类与可复用组件生产体系 | **中**：工业预制体已有 |
| 26 | 资产再导入与构建 | 已有再导入协调器，缺 Unity Asset Pipeline/Addressables 级增量处理、跨平台变体 | 缺 Datasmith 再导入、Cook/Derived Data Cache 级内容流水线 | **中** |
| 27 | Profiler/调试器 | 缺统一 CPU/GPU/内存/脚本/流送/网络相关追踪 | 缺 Unreal Insights、RenderDoc/帧分析的工作流成熟度 | **中**：有遥测与帧捕获，但关联诊断不足 |
| 28 | 多人协作与版本工作流 | Unity Studio 已有浏览器实时同场编辑；7 将扩 CLI/API/MCP 协作 | UE OFPA/多用户；UE6 规划 UE5/UEFN 融合 | **大**：目前 presence/事务不等于实时协同编辑 |
| 29 | AI/Agent 工具 | Unity 7 计划免费 MCP、CLI、公开项目 API | UE5.8 已有 Experimental MCP，UE6 计划深入开放 | **中**：我们有工业受控事务，但“支持 MCP”不再稀缺 |
| 30 | QA、稳定性和内容规模 | 缺多年多设备/多项目回归和崩溃数据 | 同左；UE 的内容规模与故障分析工具更成熟 | **大**：代码测试多，不等于市场验证 |
| 31 | 插件、样例和开发者生态 | Unity Asset Store、官方包/教程持续扩大 | Fab、插件、官方样例及 UE6 互操作生态更大 | **大**，属于采用成本差距 |
| 32 | 2D 游戏/UI | 已有 Deep2D/工业看板，缺 Sprite/Tilemap/2D 动画/2D 物理/游戏 HUD 的完整体系 | UE 通用 UI/交互体系更成熟 | **大**；工业看板是另一条长处 |

### 4. 平台、网络与工业交付

| # | 能力 | 对 Unity 7 的差距 | 对 UE6 的差距 | 我们当前判断 |
| ---: | --- | --- | --- | --- |
| 33 | 平台矩阵 | iOS、macOS/Linux Native、主机、XR、嵌入式等差距 | 主机、移动、XR 与高端工作站交付差距 | **大** |
| 34 | 多人运行时/复制 | 缺 Netcode、预测、专用服务器和服务生态 | UE5.8 Iris 已生产可用；UE6 规划更大规模持久世界 | **大**，工业主线需区分协作与游戏多人 |
| 35 | 持久世界/在线运营 | 缺成熟会话、跨区、状态迁移和经济系统 | UE6 规划 Verse 事务、分布式持久世界；仍处研发，不能算已交付 | **大**，目前非目标 |
| 36 | 浏览器直接运行 | Unity 6.6 WebGPU 已生产支持，7 将延续；我们原先的 WebGPU 新颖性优势已消失 | UE 主要通过 Pixel Streaming 覆盖浏览器；我们本地浏览器运行在成本/部署上有差异 | **竞争点需实测** |
| 37 | CAD/BIM 导入 | Unity Industry/Studio 和 PLM Pipeline Automation 正扩张 | UE5.8 Datasmith 官方已有 STEP、IFC、JT、X_T 等直接/插件路线 | **中**：我们胜负在离线开源链、语义、审计，不在宣称格式最多 |
| 38 | 工业语义/现场数据 | Unity 行业产品已进入数字孪生与 PLM 管线；我们需证明从构件到数据/告警/仿真更省时 | UE Datasmith 强于资产，工业数据闭环常靠项目开发；UE6 互操作计划会降低集成门槛 | **待测**：这是我们的核心机会 |
| 39 | 交付完整性 | Unity 的构建、平台、资产和持续更新工作流更成熟 | UE Cook、补丁、Pixel Streaming/Native 交付更成熟 | **中**：我们有哈希/发布门禁，但 Native/WASM 功能不齐 |
| 40 | 技术与授权信任 | Unity 7 有连续升级路线与完整产品支持 | UE6 有 UE5 继承/迁移路线 | **中**：我们需发布可重现实验、兼容矩阵，且 README 的 MIT/开源措辞须与 DMCSL 许可一致 |

## 关键事实：未来两家正在追什么

1. **Unity 7**：官方重点是 CoreCLR 与开发迭代、多人/Agent 生产接口、跨平台高质量图形和神经图形；不是简单加几个渲染效果。Unity 6.6 的 WebGPU 已脱离 Experimental，6.7 Beta 中动态 GI/快构建等正在推进。Unity Studio 已公布浏览器实时协作和 PLM 资产自动化路线。
2. **UE6**：官方重点是 UE5 与 UEFN 合一、Verse/Scene Graph、持久大世界、开放互操作和 MCP。UE5.8 当前已有 Nanite/Lumen、MegaLights、Chaos、Sequencer、Datasmith、Pixel Streaming 等强基线。分布式事务内存、跨游戏资产经济仍属于规划和原型。
3. **我们不能用功能名数量评胜负**。同一个“GI”“WebGPU”“物理”“多人”，只有在作者编辑、稳定运行、多端发布、调试和复现五环都成立时才可称产品级可比。

## 取舍与追赶顺序

- **必须追**：Deep 纯编辑闭环；Web/WASM/Native 相同运行包的功能/视觉一致；大 BIM/工厂场景的首帧、输入延迟、内存和故障恢复；工业格式 profile 质量；可审计工业数据/仿真工作流。
- **必须测**：三类同素材项目分别在 Deep、Unity、UE 运行，记录首帧、可交互时间、CPU/GPU P95/P99、内存、包体、输入延迟、视觉差异及交付人时。没有这份实验，不声称综合性能超过任何一家。
- **按需求选做**：动态 GI、先进超分、更多平台、角色动画、XR。
- **目前不追全量**：Nanite/Lumen 全套、MetaHuman、电影虚拟制片、游戏多人/经济平台。复制这些会吞掉工业主线资源。

## 来源

- 本仓：`ROADMAP.md`、`README.md`、`LICENSE`、`packages/contracts/src/scene.ts`、`packages/contracts/src/modelFormatCapability.ts`、`packages/deep-engine/src/`、`packages/deep-engine-native/src/`、`docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md`。本报告为代码与文档审计；未运行新测试或跨引擎基准。
- Unity 官方：[Unity 7](https://unity.com/releases/unity-7)、[Unite Seoul 2026 技术说明](https://unity.com/blog/unite-seoul-keynote-2026-recap)、[Unity 6.6 新功能](https://docs.unity.com/en-us/engine/6000.6/manual/whats-new/unity66)、[Unity 6.7 Beta 公告](https://discussions.unity.com/t/unity-6-7-beta-is-now-available/1736830)。
- Epic 官方：[UE6 路线](https://www.unrealengine.com/news/the-road-to-ue-6)、[UE5.8 发布](https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available)、[Datasmith 支持矩阵](https://dev.epicgames.com/documentation/unreal-engine/datasmith-supported-software-and-file-types)、[Pixel Streaming](https://dev.epicgames.com/documentation/unreal-engine/pixel-streaming-in-unreal-engine)。
