# Deep Engine：对标五类引擎的差距与超越方案

> 历史版本：最新源码复核、修正结论与82张执行任务卡见[全面复核与执行方案](deep-engine-comprehensive-plan-2026-09-16.md)。Dashboard、动态Chart与文本修复等状态已有更新，后续派工以新方案和最新源码为准。

日期：2026-09-16。对象：Deep Monkey Studio 维护者与引擎研发团队。目标：超越 Three.js、Babylon.js、Unity、Unreal Engine、Godot；以逐领域、逐任务的实测结果确认领先。

## 1. 判断与目标

**Deep 已具备有价值的自研渲染内核，但距离综合引擎领先，主要差在正式能力覆盖、跨端统一、工具深度、资产生态与可复现的性能证据。**

最有胜算的突破口是：大规模工业场景的加载与交互、频繁状态变化的增量处理、二维三维同版本联动、可追溯的离线交付。与此同时，通用材质、动画、物理、扩展与工具链必须持续补齐，否则领域优势会被实际使用中的阻断项抵消。

目标分三层，每层单独公布结果：

1. **运行内核领先**：同画质、同任务下，帧延迟、显存、加载或增量更新优于对手。
2. **产品任务领先**：导入真实项目→配置数据→交互分析→发布→离线恢复，全流程更快、错误更少。
3. **综合平台领先**：渲染、资产、动画、物理、工具、扩展、交付等领域分别达标；未支持的目标平台或工作流继续计入差距。

工业任务领先是首个里程碑，不自动等于综合超越。不能用更窄的功能分母得出“全面超过 UE/Unity”。

### 证据范围

- 检查了当前工作树的引擎、Three 桥、Studio Viewer、静态发布编译器、原生渲染/拾取/文字/Chart 入口，以及最近总账和交接规格。
- 基线 HEAD：`e75d797b15083f2512c8e382dd361a1a1f3756be`。工作树含大量后续改动；本报告描述检查时的工作树，不代表该提交的发布版。
- 本轮实跑：Deep Engine 类型检查通过；引擎5文件71测试、Web5文件71测试通过。测试明细见第10节。
- 原生GPU、发布与坐标结果引用现存报告和总账，未在本轮重跑。没有运行五引擎同机竞赛，也没有本轮浏览器截图/OS输入实测。
- 按工作区要求加载了 design-taste-digitaltwin。本文是分析文档，不交付视觉实现；不凭源码给画质或“Kimi-95”分数。

## 2. 先纠正旧报告

| 旧结论 | 当前代码和证据 | 真正待解决的问题 |
| --- | --- | --- |
| Deep 只在 Lab，未接 Studio | [StudioDeepWebGpuBridge](../../apps/web/src/viewer/StudioDeepWebGpuBridge.ts) 创建 Deep 候选、验证首帧、切画布并保留作者状态 | 支持面有限；作者场景、输入与交互仍依赖 Three |
| 相机/选择/测量全部没有 | Web 的 [ViewerEngineCore](../../apps/web/src/viewer/viewerEngineCore.ts) 已有 Three 控制器/拾取和工具状态；Native 有 player_picking、player_measurement、player_state | 分别区分宿主复用、Deep 独立能力与真实输入证据；不能把存在宿主交互等同于所有 Deep 效果兼容 |
| 项目没有物理 | [viewerEngineSimulation](../../apps/web/src/viewer/viewerEngineSimulation.ts) 实际创建 Rapier World 并固定步进；Web 依赖 Rapier 0.19.3 | 脱离 Three 的 PhysicsWorld 接口、Native 同语义、复杂碰撞体与回放证据 |
| LOD/meshlet/剔除全未接入 | Studio 已传 authorChunks、deformation、meshlets；PbrRenderer 正式帧编码含 LOD、剔除、Hi-Z、阴影提交 | 真实 BIM 混合负载、流式与交互并发、端到端收益仍需证明 |
| 大坐标完全不支持 | v5 编译有局部坐标帧；Native 拾取转换 f64 世界点；已有十亿偏移与原点转换 GPU 证据 | 连续重基点、持久化标注世界合同、内部顶点精度、独立阴影/法线误差 |
| 中文字体只有预烘焙，没有实现 | Native 已依赖 cosmic-text 0.19.0 并实际栅格化中文；Chart/IME helper 已有 | 离线字体身份、完整文字布局、产品 IME/焦点、跨端一致性 |
| 原生离线包/启动器从零待建 | 已有冻结资源、私有运行包、CLI 校验、同 ZIP 启动、正常窗口报告 | 普通场景覆盖、浏览器真实落盘、系统断网、故障恢复及正式安装更新 |
| 自研 WebGPU 本身就领先 Three/Babylon | 两者已有 WebGPU 路线；Babylon 还提供完整工具与丰富特效 | 要测业务收益，不能把 API 选择计作领先 |

Web 包 README 仍写“不接入正式应用”；Native README 的 clip/dash/text 等“尚未完成”也与后续代码冲突。建议能力文档由当前合同、调用链和证据索引生成；旧报告保留日期并标为历史输入。

证据入口：[最新三维任务表](deep-engine-next-development-tasks-2026-09-15.md)、[Deep2D剩余表](deep2d-remaining-tasks-2026-09-16.md)、[总账](../active-task-recovery-ledger.md)。

## 3. 当前架构与结构性限制

当前存在三条不同路径：

- **Studio Web**：SceneSnapshot/Three 作者场景→ThreeProjectionBridge→RenderPacket→Deep WebGPU；输入与部分工具继续由 Three 作者 Viewer 承担。
- **原生发布**：保存快照→静态编译 recipe v5→版本化 Runtime Package→Rust wgpu Player；已支持的编译语义明显少于 Studio 作者语义。
- **原生二维**：Dashboard/Chart/Deep2D 合同、CLI 和运行模块已形成多条路径；动态 Chart 从正式包启动仍有断点。

### 3.1 作者状态仍以 Three 对象为运行中心

保留 Three 有迁移价值，但会带来作者对象、投影快照、GPU驻留的多份状态与失效传播成本。是否成为实际瓶颈，需要把桥接耗时和两侧资源一起测量。

增强方案：

- 复用 contracts、studio-core、scene-sdk，明确唯一作者语义：稳定ID、层级、变换、可见性、材质、单位、坐标系、数据绑定与行为。
- 分离作者语义和渲染缓存。Three 逐步成为输入/兼容适配器；Deep WebGPU/Native 消费相同的版本化运行数据。
- 以对象/资源 revision 与脏字段集合驱动增量；逐个迁出测量、选择、剖切与动画任务，不进行整仓重写。
- 保留旧后端回退，验证同一状态在两后端切换后的选择、相机、未保存修改一致。

### 3.2 RenderGraph 规划与真实执行尚未统一

[renderGraph.ts](../../packages/deep-engine/src/renderGraph.ts) 能计算拓扑与 transientSlot；[pbrFrameGraph.ts](../../packages/deep-engine/src/webgpu/pbrFrameGraph.ts) 描述帧依赖。当前源码中未发现生产 renderer 消费这些 transientSlot 的分配路径；[PbrRenderer](../../packages/deep-engine/src/webgpu/pbrRenderer.ts) 仍显式编码实际 pass，[renderTargets](../../packages/deep-engine/src/webgpu/renderTargets.ts) 自行分配目标。

因此，**有资源寿命规划，不能直接宣称已实现生产纹理复用或显存下降。**

增强方案：图编译产出实际执行计划→同格式/尺寸/采样数/usage兼容的纹理池→真实pass绑定→按提交生命周期回收。先接 AO/TAA/Bloom 一段，保留参考路径作像素和资源对照。WebGPU 不承诺原生驱动级任意内存别名，先做 API 允许的纹理对象复用。

### 3.3 两端共用合同，不等于两端渲染一致

Browser 有 MRT、GTAO、TAA、OIT 等路径；Native 实际帧链以 culling/LOD→CSM→opaque/transparent→postprocess→Deep2D 为主。WGSL 与ABI有共享基础，但材质、阴影、透明和后处理仍有实现差异。

增强方案：建立材质特性与pass的生成来源、双端golden和逐特性能力报告；按透明、环境、阴影、动画逐项打通，不另维护口头“已对齐”清单。

### 3.4 正式发布仍是静态子集

[compileSceneRuntimePackage](../../apps/web/src/delivery/compileSceneRuntimePackage.ts) 的 scope 仍为 static-render-packet；目前编译场景字段主要是 camera。环境、灯光、后处理、天气、有效动画/数据/工具状态等未消费语义通过 [sceneInactiveFields](../../apps/web/src/delivery/sceneInactiveFields.ts) 与 [scenePublicationCompatibility](../../apps/web/src/delivery/scenePublicationCompatibility.ts) 阻断。

这意味着有些 Studio 普通场景不能直接变成同效果 Native 包。只让 Box 正常启动无法解决这一问题。

增强方案：按真实场景频次扩展编译器和对应 Native 消费者，优先环境/灯光/材质/剖切→动画→数据→二维联动；每项绑定同一快照的三端证据。

## 4. 五个对手，分别要赢什么

| 对手 | 官方能力与当前差距 | 超越路线与胜出标准 |
| --- | --- | --- |
| Three.js | WebGPURenderer 可走 WebGPU/WebGL2；glTF loader 覆盖广，Deep 材质桥和独立解码器有明显缺口 | 保持高频资产保真，真实 BIM 场景 P95、加载、显存、开发步骤更优；提供可脱离 Studio 使用的稳定 SDK |
| Babylon.js | 已有集群光照、体积光、Frame Graph、材质/粒子/渲染图工具、Inspector、Havok 接入 | 补完材质/物理/交互/诊断的端到端体验；在大场景驻留、变化传播和工业数据联动上形成可测优势 |
| Unity | GPU Resident Drawer/资源管理等已有成熟产品能力；Deep 的原生工具、动画、资产构建与交付厚度不足 | 原生同画质测性能，同时测工业项目搭建与更新发布成本；形成轻量、可复现、可恢复的部署流程 |
| Unreal Engine | Nanite、Lumen、World Partition 构成几何、光照与世界管理体系；meshlet/probe存在不代表等价 | 先赢大 BIM 可编辑性、工业精度、低资源交付和业务联动；高端渲染另设专项，逐项追赶并验证 |
| Godot | 多渲染器、2D/3D、物理、文字、脚本与导出形成完整引擎；Deep Native 尚缺同等级可用覆盖 | 统一运行合同、文字/GUI/交互、插件开发和导出；用真实工程任务证明更低搭建/维护成本与更好性能 |

官方依据：[Three WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html)、[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)、[Babylon能力和工具](https://www.babylonjs.com/featureDemos/)、[Havok接入](https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/physics/v2/usingPhysicsEngine.md)、[Unity GPU Resident Drawer](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/gpu-resident-drawer.html)、[Addressables](https://docs.unity3d.com/Packages/com.unity.addressables@2.7/manual/index.html)、[UE Nanite](https://dev.epicgames.com/documentation/unreal-engine/nanite-in-unreal-engine)、[Lumen](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)、[World Partition](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine)、[Godot能力](https://docs.godotengine.org/en/stable/about/list_of_features.html)、[渲染器](https://docs.godotengine.org/en/stable/tutorials/rendering/renderers.html)。

以上为文档能力比较，不是本机性能排名。Web 本地锁定 Three 0.185.1，Babylon 隔离包锁定9.26.1；外部文档可能已前进。正式比赛需要同时保存版本/commit和文档快照，并分别设置“固定可复现基线”和“当前稳定版挑战”。

Unity/UE/Godot 的原生结果与 Deep Native 成对比较；Web 路线独立报告。纯渲染比赛和完整产品任务比赛分开，避免把 Studio业务功能当作底层渲染器性能。

## 5. 十二个增强领域

### A. 材质与资产：最先解决真实导入失败

**已核实缺口**：[threeBridge/materials.ts](../../packages/deep-engine/src/threeBridge/materials.ts) 拒绝非中性 Physical 扩展、wireframe/flatShading/vertexColors、部分透明状态、lightMap/bump/displacement和材质clippingPlanes。独立 glTF 的 [materialExtensions.ts](../../packages/deep-engine/src/gltf/materialExtensions.ts) 只接受 emissive_strength 材质扩展；纹理扩展另有实现，不能据此说全部 glTF 扩展只支持一种。

- 第一批：顶点色、平面着色、法线/UV边界、透明双面、材质剖切；覆盖已有客户模型的高频失败原因。
- 第二批：unlit、clearcoat、ior/specular、transmission/volume；玻璃、涂层金属与设备材质优先。
- 第三批：按真实资产频次处理 anisotropy/sheen/iridescence；每项包括解码、IR、shader、阴影/透明交互、编辑与发布。
- 已有 Three loader/转换链可解码的压缩资产，先通过导入期规范化复用。按预处理保真和耗时评估，再决定是否新增独立解码器。
- 资产烘焙升级为可增量执行的任务图：稳定hash、依赖闭包、确定性派生、取消/恢复、LOD与纹理预算、构件ID映射。

**验收**：冻结真实资产集，记录每个材质/扩展/动画的支持状态；任何未保留语义都明示。渲染可见不等于元数据、材质和交互完整。

### B. 超大场景：从已有 GPU 组件走向综合吞吐领先

已有LOD、meshlet、Hi-Z、chunk驻留和间接绘制，应继续深化：

- 空间分块结合楼层/系统/设备语义；相机、选中、告警、任务路线联合决定预取优先级。
- 固定显存预算下同时管理几何、纹理、阴影、临时目标和 staging 峰值；防止细LOD抢占全部预算。
- 保留最粗可绘制代理，细节异步替换；快速转身/传送/告警定位时不能空白。
- 帧内限制上传字节和CPU准备时间；避免“稳定帧快，加载帧卡死”。
- 基于误差的离线简化层级与meshlet层级继续演进；BIM构件语义、选择和剖切不能被合批吞掉。
- 建立准确资源计数与估算边界：资源个数、分配载荷、驱动可见显存不能混写。

**验收**：稳定帧、流式帧、1%对象更新、快速跨区、选择/剖切同时测；报告可见三角形与总数据规模，不能仅报总面数。

### C. 大坐标与工业几何：精度成为产品优势

已有场景局部化、世界拾取、f64测量；仍须扩展为完整坐标服务：

- 权威世界变换保持f64，GPU使用局部坐标；相机、剖切、动画、拾取、标注与物理共享坐标帧身份。
- 连续重基点时同时更新所有参与者，在帧边界原子发布。
- 分离模型局部顶点精度和场景放置精度。导入前已丢失的float32细节不能靠之后平移补回。
- Reverse-Z已有部分helper支持，生产路径需核对投影、深度测试、Hi-Z、阴影和拾取整套约定后再启用。
- 精确测量使用几何/拓扑表示，渲染网格只作为显示与候选筛选；先复用现有工程几何与转换模块。

Godot 已有大世界坐标方案，原点转换本身不构成差异化；关键是把毫米级任务精度、模型语义和完整工具流做好。[Godot大坐标说明](https://docs.godotengine.org/en/4.6/tutorials/physics/large_world_coordinates.html)

### D. 拾取、剖切与编辑：独立引擎的使用主线

Native [player_picking.rs](../../packages/deep-engine-native/src/player_picking.rs) 当前逐实例、逐几何、逐三角遍历；场景增长后的查询成本有明确风险，实际时延仍需测量。

- 建立实例级空间索引和网格级BVH；用稳定ID而非GPU绘制序号返回对象。
- GPU ID pass用于可见对象粗选，CPU BVH用于精确点/面/边；异步读回应绑定相机和场景revision。
- 统一剖切后的显示/阴影/拾取语义；扩展剖切盒、面拖拽、剖面轮廓与按需封口。
- 覆盖框选、多选、隐藏/隔离、楼层钻取、对齐/吸附、测距面积角度、批量属性和撤销。
- 工程量精度与视觉LOD分离，避免用户看到或选到简化代理后得到错误尺寸。

**验收**：百万级数据集上测查询P95；遮挡/透明/剖切/隐藏/LOD切换/异步迟到/跨原点都有反例；UI结果与实际命中一致。

### E. 光照与画质：补广度，也补时序稳定

已有PBR、IBL、CSM、集群光照、GTAO、TAA、OIT。ProbeClipmap 已有 [PBR控制器](../../packages/deep-engine/src/webgpu/probeClipmapPbrController.ts)，当前创建调用主要见Lab；应先打通真实场景脏更新。

- 首批：真实环境与局部灯光贯通、材质保真、透明正确性、稳定阴影、TAA拖影/细线闪烁治理。
- 第二批：GI探针的可见性/漏光、动态遮挡与预算更新，接入正常Studio/Native运行。
- 第三批：软阴影、局部反射探针与SSR补偿、天空/雾和必要体积效果；按项目画面收益决定次序。
- DOF、Motion Blur、复杂天气/水体适合展示型任务，可排在工程读图清晰度后。
- 源码范围扫描未发现正式SSR/体积雾/DOF/Motion Blur/PCSS实现；不以关键词扫描推断整个产品或外部插件绝对没有。
- 不把ProbeClipmap叫作已实现Lumen；不把meshlet叫作已实现Nanite。P4光追文件目前是能力探测合同，未启用RT shader。

**验收**：固定输入下同时比较材质误差、细线/文字可读性、阴影稳定、透明排序、相机运动视频和帧预算。静帧相似度不足以证明时序画质。

### F. 动画、物理、VFX与工业仿真

- 复用SceneAnimationMixer、glTF骨骼/morph和GPU变形；补权威时钟、事件轨、状态机、重定向与Native包播放。
- 复用现有Rapier；把刚体/碰撞体/关节/触发器/查询抽成宿主中立服务，再决定Rust侧对应实现与版本合同。
- 当前Web物理主要见固定/动态刚体与cuboid碰撞体路径，需按机械装配、移动设备和人员漫游补复杂形状、运动学约束及CCD等覆盖。
- 渲染、动画、物理可不同频率运行；统一固定步、插值和回放事件。跨CPU/后端不默认逐bit确定，冻结数值容差。
- 粒子已有基础GPU运行能力；补发射器资源、轨迹/流向参数、预设编辑、绑定数据与生命周期，优先告警、泄漏、输送与流向。
- 复用virtual-commissioning、workcell、plant/ppr等工业模块，将设备状态/过程事件接入稳定ID与回放；物理动画不能替代经过校准的工程仿真。

**验收**：固定动作/输入回放后的姿态、碰撞事件和过程状态可核对；运行包换场景、暂停/跳转/失败恢复不串状态。

### G. Deep2D、文字与三维：最值得做深的差异化

已具备路径/图集、六类Chart系列、数据更新、部分增量几何和真实文字。当前 [PlayerContent::from_package](../../packages/deep-engine-native/src/player_content.rs) 仍将chart与chart_sim置空；独立CLI演示不代表动态包可交付。

- 先接动态ChartIR入包和Dashboard完整内容lowering，复用现有发布与资源闭包。
- 以统一Epoch提交document/data/layout/resources；图表、命中、文字和三维着色来自同一版本。
- 复用ChartRows/系列增量/顶点局部传输，继续补列式分块、统计缓存、稳定GPU分配和字体图集增量。
- 实现图表筛选→构件选择/着色→告警定位→回放，同步撤销与版本追溯。
- 文本必须形成GlyphRun/字体身份/布局/IME/无障碍完整链；不能依赖开发机恰好装有某字体。

**验收**：同一数据revision驱动二维、三维和命中，失败时保留完整旧Epoch；完整Dashboard正式离线包通过，而非只有Box或单图探针。

### H. 开发者工具与公共SDK

Deep包仍为private 0.1.0。已有Lab、诊断与Shader authoring基础，但没有充分证据支持其达到成熟独立引擎的使用体验。

- 独立最小SDK示例：加载模型、选择、绑定数据、释放、设备恢复；在Studio以外CI构建。
- Inspector显示对象→材质→pass→draw→资源依赖；解释为何不可见、为何无法合批、为何CPU上传过多。
- Profiler贯通作者更新、投影、解码、上传、GPU时间戳和呈现；一次慢帧能定位到具体对象/资源。
- 轻量DeepSL与预设保留；补源码定位、错误回指、热更、last-known-good和跨端编译一致性。
- 插件采用版本化能力接口、生命周期、预算与兼容测试；不开放任意内部对象作为公共ABI。

**验收**：外部开发者独立完成五个典型任务；记录时间、文档阻断和样板代码量，与对手公平比较。

### I. 发布、离线与资产更新

已有版本冻结、依赖hash、Native验证和启动器，重点是覆盖范围与用户任务完成度：

- 环境、动画、数据、字体与图表等同源进入正式包。
- 增量资源下载/补丁、原子切换、失败回滚、可诊断缓存与明确的离线配置。
- Windows签名/安装/更新/卸载、干净机器启动、非ASCII路径、高DPI、驱动差异。
- 包内凭据与运行配置分离；复用当前受保护数据访问、权限与连接合同。
- 撤回/历史恢复/断网/过期数据保持明确版本语义。

**验收**：用户从浏览器发布并下载的同一个ZIP，在干净Windows环境离线启动；动态交互、坏资源和更新失败有恢复证据。

### J. 稳定性、性能预算与质量档

已有错误作用域、设备丢失处理、候选提交、缓存和遥测，应补“全链一致性”：

- 统一设备Epoch、资源revision和场景Epoch；旧异步候选绝不能覆盖新状态。
- 质量档依据帧时/显存/输入延迟调节阴影、AO、GI、LOD与分辨率，使用迟滞避免抖动。
- 显式区分GPU时间、CPU提交时间、帧间隔和输入到可见结果；不能把Instant包围的主机耗时写成GPU时间。
- 普通场景、空场景、错误包、换包、设备恢复与20次构建销毁循环分别设预算。
- 定位测试竞争造成的波动，正式性能跑独占设备；保留原始样本和失败结果。

### K. 媒体、XR、平台覆盖与生态

这是“综合超越”不能省掉的一栏。Web Viewer已有音频/XR相关模块，但本次没有验证其Deep桥和Native完整消费；跨端媒体/XR覆盖仍应标未验证。

保持媒体/XR/外部开发者生态的目标矩阵，按项目需求安排；多平台、完整Three插件矩阵、复杂Shader Graph、重型光追和UE全套虚拟几何在既有范围中被明确排除。本文将它们保留为综合对标差距，不偷偷计作达标，也不在分析任务中重启研发。

新增“超越”目标不应被缩减成旧90%目标；若进一步实施综合平台扩张，应单列范围变化和资源投入，保留Windows/工业先行的交付线。

### L. AI辅助创作与运维

可复用现有AI、脚本、工业编排模块，但“能聊天”不能记作引擎领先。

- 让AI生成受约束的场景/行为变更，先预检、展示差异、支持撤销，再提交稳定ID与revision。
- 自动解释资产拒绝原因、提出可回滚的材质降级、定位慢帧和过量资源。
- 生成工作单元测试与回放场景；以成功完成率、修正次数、时间和破坏性回归衡量。
- 运行时保持确定、可测试的命令链，模型调用不进入逐帧关键路径。

## 6. 建议的超越基准

复用已有 [benchmarkContract](../../packages/deep-engine/src/benchmarkContract.ts) 与 [竞品基准合同](deep-engine-competitive-benchmark-contract-2026-09-12.md)。旧合同的90%是历史阶段目标；本次超越建议应另建版本，不能直接把旧分数叫领先。

### 数据集与场景

1. 重复设备工厂：大量实例、少数材质、设备状态变化。
2. 高异构BIM：多构件、多材质、透明管道/玻璃、剖切与测量。
3. 大坐标园区：远原点、连续跨区、毫米级尺寸与阴影。
4. 动态工作单元：机械动画、蒙皮、物理、事件与回放。
5. 混合看板：多Chart、中文文字、持续遥测、二维三维联动。
6. 外观展示：玻璃/涂层/金属、GI、透明、相机运动。

每类同时保留人工反例夹具和有权使用的真实项目。至少三种真实项目用于首次产品领先验收。合成球体或Box不得替代全部场景。

### 指标与建议目标

以下是研发目标，尚未实测达成。已有15%胜出/5%最大退化门槛保留为最低检查；建议领先目标更高。

| 指标 | 建议目标与口径 |
| --- | --- |
| 稳态/动态帧时 | 指定主要负载P95优于对手至少20%；每个关键case不退化超过5%；同时报告P99 |
| 资源效率 | 选定大场景峰值GPU资源预算降低至少25%；含临时资源、staging和迁移期作者侧成本 |
| 冷启动/加载 | 同机器/存储/网络及同可见质量，可交互时间降低至少30%；分别测冷缓存与热缓存 |
| 小范围更新 | 1%对象变化时验证工作量随变更规模增长；相对自身全量路径CPU更新成本目标降低50%，相对竞品单独报告 |
| 交互 | 标准独显档拾取/选择任务P95目标小于50ms；明确定义为从输入到可见反馈，不等于单次BVH耗时 |
| 工程精度 | 沿用已冻结的坐标/拾取/测量预算，并新增真实单位与复杂几何验证；不能事后放宽 |
| 交付效率 | 同模型和数据搭建→验证→发布→离线打开，任务耗时目标减少30%；独立于渲染比赛 |
| 正确性 | 必选资产/关键交互/版本一致性全部通过；不支持项明示，失败不污染旧状态 |
| 画质 | 冻结材质/光照/透明/时序下限；视频+工程细节+独立观察者评价，不能只用单一SSIM |

补充吞吐探索档：1080p、固定DPR，在指定独显/集显各自预算下测试10万/100万构件阶梯；报告总规模、驻留规模、可见三角形、材质与纹理分布。60fps或30fps的档位须在真实项目试跑后冻结，不将任意“亿级模型60帧”作为无条件承诺。

### 公平比较与结论规则

- 固定机器、供电、驱动、版本、场景hash、分辨率、DPR、轨迹与随机种子；至少5组成对交替，长尾使用足够逐帧样本与置信区间。
- 对手开启适用的标准优化；给予等量优化时间。不能拿未优化的逐对象绘制当成熟引擎代表。
- 分“等质量公共子集”和“各引擎最佳质量”两轨；关闭GI赢帧率不能算GI领先。
- Browser统计桥接与宿主成本；Native运行原生同任务。FPS、GPU时间和整机功耗各自报告。
- 平均分不掩盖关键域失败；每个领域发布领先/持平/落后/未验证。
- 只有全部关键领域达标且有足够优势面，才发布综合领先结论；生态广度和平台覆盖单列，不从分母消失。

现存 `test-output/render-engine-comparison/report.json` 的 scope 为 isolation-signal-only，覆盖120/1000对象的静态/变换负载，多个高级能力仍deferred；它不能支持当前五引擎综合排名。

## 7. 实施顺序：先形成可用覆盖，再扩大领先面

以下S0–S4是路线阶段名，不替代原任务状态或另开重复待办。

| 阶段 | 主要工作 | 退出条件 | 复用/对应 |
| --- | --- | --- | --- |
| S0 证据与阻断收敛 | 资产失败统计；材质/普通场景支持；冻结五引擎矩阵；清理文档状态漂移 | 三种真实项目可按能力报告运行；基准脚本可复跑 | 现有兼容/benchmark合同，D01–D10剩余 |
| S1 形成第一批领先 | RenderGraph实际资源复用、空间索引/拾取、增量更新、预算流式、连续大坐标 | 同质量指定case领先≥20%，关键case回退≤5%，输入/精度通过 | streaming、renderGraph、PbrRenderer、D09/D11/D12 |
| S2 完整工业任务 | 材质/环境/动画/物理消费、动态Dashboard/数据、跨端Epoch、正式离线发布 | 同一复杂项目跨端交互与版本一致，交付全流程通过 | D13–D19、Deep2D P0/P1 |
| S3 工具与画质深度 | GI/反射/软阴影、Inspector/Profiler、公共SDK、Windows安装更新 | 外部开发者任务通过，高质量场景/设备恢复通过 | D20–D23，现有shader与diagnostics |
| S4 综合平台挑战 | 高端渲染、媒体/XR、扩展生态与目标平台差距专项 | 每个对手分别完成全部关键域验收 | D24–D28项目后验收；明确排除项另列范围评审 |

S0与S1少量独立工作可并行，但共享Scene/Material/资源ABI必须先冻结。不能在核心合同每日变化时，让Web和Native各自追赶另一份实现。

### 资源估算

下列仅是规划假设：已有代码可复用，配备8–12名有图形/原生/前端/QA经验的工程师，且有固定项目样本、独占性能设备和持续集成。

- 前2周：完成源码/样本基线、失败频次和资源剖析，形成可信估算。
- 1–3个月：争取拿到若干真实场景的局部性能领先，同时补核心阻断项。
- 3–6个月：争取完整工业任务、跨端动态数据、工具和Windows交付领先。
- 6–12个月：争取经过多设备/多项目验证的工业平台领先；综合引擎全域仍需按实际差距重新估算。

以上不是交付承诺。未获知团队人数、每周产能和样本规模，不能给出可信的全面超越日期。AI可以加速实现与检查，真实设备验证、资产保真和用户工作流仍是关键路径。

## 8. 应避免的投入

- 因模块名已有Nanite/Lumen/RT相关词就重新设计同类系统；先查真实执行入口与收益。
- 在材质/剖切/发布仍阻断普通项目时优先做电影化后处理或完整节点编辑器。
- 为“自主”重写现有可用物理、解码器、字体整形或图表算法；优先自研统一合同、调度、预算和工具。
- 过早移除Three兼容路径，或长期让所有业务状态继续依赖Three内部对象；按任务逐步迁出。
- 使用函数耗时、资源个数或64×64首帧替代整机帧时、总显存或正式可用性。
- 以另一引擎缺少内置BIM业务功能作为渲染性能胜出的证据；产品任务优势和渲染优势分别成立。

## 9. 下一批最有价值的具体工作

1. 冻结3个真实项目的失败资产与运行阻断报告，优先补顶点色/flatShading/透明/剖切，以及普通场景环境灯光发布。
2. 接RenderGraph真实资源分配，做AO/TAA/Bloom子链的像素与峰值资源对照。
3. 给Native拾取加实例索引+网格BVH，统一世界坐标、剖切和稳定对象ID。
4. 对Studio桥接、驻留/流式和1%对象变化做端到端剖析，验证实际瓶颈后改增量结构。
5. 将动态ChartIR接正式包，补Dashboard→Epoch→三维联动；复用已建发布链。
6. 实作五引擎可复现runner与证据索引，把“领先哪项、落后哪项”变为持续更新的事实。

这些工作首先形成能交付、能测量、能持续迭代的引擎，再扩大领先领域。

## 10. 本轮验证与局限

本轮执行：

- `pnpm --filter @bim-studio/deep-engine typecheck`：通过，含src与Lab类型检查。
- Deep Engine：DeepWebGpuBackend、ThreeProjectionBridge、renderGraph、pbrFrameGraph、probeClipmapUpdateScheduler，5文件71测试通过。
- Web：StudioDeepWebGpuBridge、studioDeepEditorOverlay、scenePublicationCompatibility、compileSceneRuntimePackage、sceneNativeFrozenPayload，5文件71测试通过。
- 文档23个本地链接检查通过；`pnpm gate:repository`通过（治理测试5项及仓库检查）。

测试仅验证上述合同与逻辑，不证明画质、吞吐、Native全量或五平台胜出。未改运行代码；未重新构建原生或占用GPU测试窗口。

现有原生证据重点核对：

- [D09坐标规格](scene-local-coordinates-2026-09-15.md)：局部坐标、世界工具与重基点边界。
- [D10发布证据规格](scene-native-publication-evidence-2026-09-15.md)：正常窗口、冻结版本、同ZIP启动与尚缺的真实用户链。
- [Deep2D剩余任务](deep2d-remaining-tasks-2026-09-16.md)：45项任务的已有实现与未完成范围。
- 总账2026-09-16 00:45项明确：连续重基点、独立阴影/法线、系统断网、完整视觉与动态Dashboard等仍未完成。

**当前可以作出的结论：Deep具有值得深化的内核和跨端基础，尚无证据支持已超越五个平台。下一步应把普通项目支持、资源/增量架构、工业交互和跨端交付做成领先结果，再向高端渲染与综合生态扩展。**
