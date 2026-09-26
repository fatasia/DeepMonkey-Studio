# Deep Engine vs Unity 7 / UE6:能力对照证据化(2026-09-27)

以 T00 的 122 项处置为底,对"保留+裁剪"的 75 项逐项映射 Unity 7 / UE6 对应能力并做三层判定(领先/持平/落后),供后续工作包(T01–T23)的追赶与超越排序使用。本文只读审计,不改源码。

## 0. 现状核查(六步,文档任务)

| 步骤 | 结果 |
|---|---|
| 关键词检索 | 已读 122 项审计、24 工作包计划、T00 基线、性能报告四份输入;`docs/reports/` 下已有本主题 4 份文档(direct/gap/cocos-laya/本文),无重复建设对象 |
| 契约层 | `packages/contracts/src/{scene.ts,modelFormatCapability.ts,simulationEngine.ts}` 为映射的合同锚 |
| 依赖 | Three 0.185.1、Web Rapier 0.19.3、wgpu 30.0.1、cosmic-text 0.19.0(计划 §2.1 已核) |
| 消费方 | 75 项的处置与工作包映射直接沿用计划 §1 表;本文不新增处置 |
| 测试/证据 | `test-output/deep-core/T00/fair-r{1,2,7}-20260926-e616677a/`、`test-output/bevy-019-benchmark/`、`test-output/ordinary-picking-benchmark-2026-09-09.json`、`test-output/plant-lite-{bench-after,tier-bench}-2026*.json`、20+ 个 deep-fair-comparison cut 目录 |
| 规格 | 计划 `docs/specs/deep-engine-core-capability-development-plan-2026-09-27.md`、T00 `docs/reports/deep-core/T00-baseline.md` |

## 1. 证据口径与诚实条款(先于一切结论)

1. **vs Unity 7 / UE6 无任何配对基准**。Unity 7(计划 2026-12 Preview)与 UE6(计划 2027 年底 Early Access)均未正式发布,本机未安装,无同素材同设备跑分。本文所有跨引擎判定都是**能力存在性与成熟度对照**,仅供路线参考;**禁止从本文推出任何"Deep 性能超过/落后 Unity/UE X%"的定量结论**。
2. 我们有的配对数字只有三类:vs Three.js WebGL(同机浏览器全套)、vs Bevy 0.19.1(native-wgpu 单 fixture)、vs 自身 A/B(DES、BVH)。如实列于第 2 节。
3. 第 3 节的 Unity/UE 能力名**基于训练知识(2026 年前公开文档),版本归属以官方文档为准**;官方链接沿用 09-26 审计已核验来源。
4. 判定规则:**领先**=我们有实测/实现且 Unity/UE 无第一方直接等价(限域内,逐项注明域);**持平**=双方都有且量级相当,或双方均无成熟方案(裁剪项按裁剪后域内判定);**落后**=Unity/UE 有成熟产品级实现而我方无实现/无闭环证据/明确更弱。证据等级沿用 T00(A 直接/B 间接/C 未测)。
5. 三层判定是**对手成熟度视角**,与 T00 的 A/B/C 证据等级正交:落后≠没做,领先≠全面超越。查不到的一律"未验证"。

## 2. 已有配对证据登记(诚实基线,全部可复跑)

### 2.1 vs Three.js WebGL(同机 Chrome 153 + RTX 4060 Laptop,HEAD e616677a,r1/r2)

来源:`test-output/deep-core/T00/fair-r1,f2-20260926-e616677a/report.{json,md}`;历史优化链 `test-output/deep-fair-comparison-ab-baseline-20260925/` 至 `cut9-20260926/`。

| 指标 | Deep WebGPU | Deep WASM | WebGL | 判定(vs Three) |
|---|---|---|---|---|
| 静置帧时间 P95 | 7.1 / 7.3 ms | 7.2 / 7.2 ms | 7.1 / 7.1 ms | 追平 |
| 静置 P99(r1) | **7.2 ms** | 14.0 ms | 34.8 ms | **WebGPU 尾部显著更优** |
| 输入帧 P95 | 20.8 / 20.9 ms | 13.9 ms | 13.8 / 7.2 ms | 落后(14.0→20.8 回归未归因,T11 首项) |
| pointer→submit P95 | 2.4 / 2.8 ms | 3.4 ms | 2.4 / 1.5 ms | 同量级(优化前 47.4ms,`d9f3b093`) |
| 切后端首帧(冷/暖) | 4.6–5.0 s / 1.57 s(`d0c9afc5`) | 2.7–3.0 s | 0.80 s | 冷切落后 |
| 黑帧 / 位姿确定性 SSIM | 0 / 1.0×3 位姿 | 0 / 1.0×3 | 0 / 1.0×3 | 持平 |
| BVH 加速拾取 | **113×–6685×**(P50,20k–1M 三角形,0 mismatch) | — | 基线(Three CPU raycast) | 数量级领先(`test-output/ordinary-picking-benchmark-2026-09-09.json`) |

### 2.2 vs Bevy 0.19.1(native-wgpu 单 fixture 配对,5 轮中位数)

来源:`test-output/bevy-019-benchmark/paired-summary.md`(case `factory-instances/cubes-v2`,fixtureHash e65b4a8363c9)。

| 指标 | Deep(Native wgpu) | Bevy 0.19.1 |
|---|---|---|
| CPU 帧 P50 / P95 | 6.954 / 7.389 ms | 6.469 / 7.150 ms |
| CPU 帧 P99 | 7.572(P95 12.489)ms | 7.757(P95 13.415)ms |
| GPU 帧 P50 / P95 | 0.129 / 0.132 ms | 0.120 / 0.125 ms |

诚实结论:同机同 fixture 下 CPU/GPU 帧时间**同量级,互有毫秒级胜负**,无决定性差距;input-latency / cold-start 候选侧 5/5 轮缺失(报告内明示)。

### 2.3 vs 自身 A/B(行为指纹锁定)

- DES 内核:60 工位 **1,956 → 32,280 events/s(16.5×)**,同 seed 完工件数逐位一致(8165/4200/1445/300);小单线 2.5×、换型 2.4×、多 AGV 3.2×。数据 `test-output/plant-lite-bench-20260925.json`(before)/`plant-lite-bench-after-20260925.json`(after),commit `45e5f7da`。
- 档位基准(500/4000/10000 对象,commit `0923dbd4`):`test-output/plant-lite-tier-bench-20260926.json` — golden01 单线 1.06M events/s;500 对象 9.7k events/s;4000 对象 1.1k;10000 对象 442 events/s(随规模显著衰减,如实登记,是 T19 的真实工作项)。
- 切后端首帧链:3.89s → 1.57s(双切暖缓存,`d0c9afc5`);submit 47.4→2.2ms(`d9f3b093`);输入 20.8→14.0ms(`923f1ca4`)。证据:20+ 个 cut 目录 + `probe-deep-*.mjs` 探针(`7bae5c2b`/`4ec3c55f`/`9eb572d8`)。

## 3. 75 项逐项映射与三层判定

编号=09-26 审计编号;处置/WP=计划 §1;证据=仓内路径或 T00 §6 已登记 commit(`git show <hash>` 可验)。Unity/UE 能力名为训练知识(见 §1.3)。

### A. 渲染(14 项)

| # | 判定 | 处置/WP | Unity 7 对应(官方能力名) | UE6 对应(官方能力名) | 证据与判定依据 |
|---|---|---|---|---|---|
| 1 | 落后 | 裁剪/T01 | URP/HDRP Render Pipeline Asset + Quality 质量档体系 | Scalability Settings / 渲染路径矩阵 | renderGraph.ts、adaptiveQuality.test.ts(`407bd8d8`);质量档/降级契约未一体管理,B 级 |
| 2 | 落后 | 保留/T02 | Adaptive Probe Volumes(Unity 6)+ Surface Cache GI(6.7 beta,规划并入 7) | Lumen GI(动态漫反射基线) | probeSurfaceCache/probeClipmapUpdateScheduler/probeRelocationResolver;动态失效与收敛验收未做,B 级 |
| 3 | 落后 | 保留/T03 | HDRP Screen Space / Planar Reflections | Lumen Reflections + SSR | ssrRayExtension.test.ts、screenSpaceReflectionPass.test.ts;跨端回退闭环未实测,B 级 |
| 4 | 落后 | 保留/T04 | HDRP 光照/附加灯阴影体系 | MegaLights(5.5+ Production Ready) | worldLights/importanceBudget、shadow_map_tests.rs;64/256/1024 灯阶梯未测,B 级 |
| 5 | 落后 | 保留/T04 | HDRP 级联/附加阴影 | Virtual Shadow Maps(分页虚拟阴影) | pbrShadowState/packetShadowLodResources、shadow_fit_gpu_tests.rs;无分页阴影原型,B 级 |
| 6 | 落后 | 保留/T10 | HDRP Ray Tracing(DXR) | Hardware Ray Tracing(Lumen HWRT) | ray_tracing_capability.rs fail-closed 探测;能力探测≠渲染交付,B 级 |
| 7 | 落后 | 保留/T10 | HDRP Path Tracing(静帧) | Path Tracer(收敛/降噪/批量输出) | rayTrace* 7 测试、tlas/bvhBuilder;收敛曲线未测,B 级 |
| 8 | 落后 | 保留/T05 | Unity 7 规划高端几何(未见已交付等价) | Nanite Virtualized Geometry(簇层级/误差控制/流送一体) | meshletBuilder/virtualGeometryPages/Hi-Z、cluster-lod-gpu;自动簇层级与拾取一致性未闭环,B 级 |
| 9 | 落后 | 保留/T06 | Streaming Virtual Texturing | Virtual Texturing(RVT/UVTT,页反馈+作者预算) | pbrResidencyStream/packetResidencyWorkingSet;页表/GPU feedback 未证,B 级 |
| 10 | 落后 | 保留/T07 | DLSS/FSR 插件 + STP;Unity 7 规划神经升尺度 | TSR + DLSS/FSR/XeSS 插件生态 | temporalAa/temporalValidity(TAA 底座 A);升尺度/残影能量验收未测,B 级 |
| 11 | 落后 | 保留/T08 | Shader Graph + URP/HDRP 节点/变体/平台诊断 | Material Editor + Substrate(层叠/次表面/毛发) | pbrShader/shaderGraph 族;clearcoat/透射/SSS 未实现,B 级 |
| 12 | 落后 | 保留/T09 | HDRP Volumetric Fog/Clouds、Sky | Volumetric Clouds、Sky Atmosphere、Water(插件) | volumetricFog* 5 测试+GPU 脚本;水/云/天气无,B 级 |
| 13 | 持平(裁剪域) | 裁剪/T08 | ACES tone mapping + HDR Output(URP 官方文档) | 色彩管理/OpenColorIO | pbrColorGrading/pbrDisplayColor/author_grading.rs,A 级(裁剪域内线性色/截图一致已证;HDR 设备链对方强但已裁剪) |
| 14 | 持平(裁剪域) | 裁剪/T00/T01 | Profiler / Frame Debugger | Unreal Insights / RenderDoc | performanceTelemetry/frameCapture、telemetry*_tests.rs,A 级(内部计数+帧捕获直接产出证据;产品级 Profiler 弱于对手,已在裁剪范围) |

小结:12 落后 / 2 持平。渲染域无领先项——对手在 GI/阴影/虚拟化/超分上的产品级成熟度是全面差距,T01–T10 的价值是把 B 级底座推到可验收。

### B. 场景规模与资产(10 项)

| # | 判定 | 处置/WP | Unity 7 对应 | UE6 对应 | 证据与判定依据 |
|---|---|---|---|---|---|
| 15 | 落后 | 保留/T11 | Addressables + 场景流送(内容目录管理) | World Partition / HLOD / Data Layers | sceneChunkResidency.integration、world_partition.rs;HLOD 生成与预取策略无,B 级 |
| 16 | 落后 | 保留/T11/T12 | Memory Profiler + 资产预算实践 | 资产预算/内存审查工具链 | pbrTransientTextureBudget/resourceAdmission;每设备预算闭环未证,B 级 |
| 17 | 落后 | 保留/T12 | Asset Import Pipeline v2(增量导入) | Datasmith Reimport + Derived Data Cache | AssetReimportCoordinator 底座;长期生产验证未测,B 级 |
| 20 | 落后(裁剪域) | 裁剪/T13 | Terrain(高度场/材质绘制/植被) | Landscape + Procedural Vegetation Editor(实验) | 无模块(C 级);裁剪域内接受,追赶靠 T13 |
| 21 | 落后(裁剪域) | 裁剪/T13 | 无第一方 PCG 图(第三方为主) | PCG Framework(规则图/seed/调试) | linearPrefabPath(工业参数化);通用 PCG 无,B 级(裁剪域) |
| 22 | 落后(裁剪域) | 裁剪/T12 | 无第一方建模模式(第三方插件) | Modeling Mode(建模/UV/LOD/碰撞几何) | generatedNormals/topologySpatialGeometry;UV/简化切片未建,B 级 |
| 23 | 落后 | 裁剪/T12 | Search/Asset Database 依赖索引 | Asset Manager / Reference Viewer | assetPackage*、assetCompatibility;跨项目引用影响分析未证,B 级 |
| 24 | 落后(成熟度)/性能未验证 | 保留/T11/T05 | 产品级流送加载(多年生产) | 产品级 Cook/流送 | 冷切 4.6–5.0s vs WebGL 0.80s、暖切 1.57s;整页冷启动 unmeasured(T00 明示),A 级(内部实测) |
| 25 | 落后 | 保留/T05 | GPU Resident Drawer(Unity 6,GPU-driven 实例剔除) | Nanite GPU-driven 剔除(产品化) | gpu_occlusion(_consume)_tests.rs;剔除→拾取/轮廓消费链未核验,T05 首项,B 级 |
| 26 | 落后 | 裁剪/T11 | 多年 device-lost 处理积累 | 多年平台异常恢复积累 | pbrRendererDisposal/resourceCleanup;device lost/OOM 复现矩阵未测,B 级 |

小结:10 落后。对手在"分区→流送→剔除→恢复"全链是产品级,我方是底座+实测点。

### C. 动画、角色与镜头(12 项)

| # | 判定 | 处置/WP | Unity 7 对应 | UE6 对应 | 证据与判定依据 |
|---|---|---|---|---|---|
| 27 | 落后 | 保留/T14 | Animator / Timeline(完整剪辑/层/曲线工具) | Sequencer / Animation Blueprint | SceneAnimationMixer/stateMachine/sampling(A 级底座);可视化曲线/层/遮罩作者链缺 |
| 28 | 落后 | 保留/T14 | glTF/FBX 导入器(全格式) | Interchange Framework / glTF Importer | decodeSkinnedGlb/decodeMorphGlb/sparseDeformationAccessors(A 级 glTF 核心解码);广度与异常修复认证不足 |
| 29 | 落后 | 保留/T15 | Animation Rigging(IK/约束) | Control Rig / IK Rig | viewer/ik.test.ts(A 级局部);全身 IK/复杂约束缺。域内注记:工业机器人 FK/DLS-IK(`9f11df30`)为对手第一方所无 |
| 30 | 落后 | 保留/T15 | Avatar 重定向(成熟) | IK Retargeter(成熟) | 无实现,C 级 |
| 31 | 落后 | 保留/T15 | Motion Matching 包(Unity 6) | Motion Matching(5.4+) | 无实现,C 级 |
| 32 | 落后(裁剪域) | 裁剪/T15 | Animation Rigging 图 | Control Rig 完整编辑器 | 无实现,C 级(裁剪域) |
| 33 | 落后 | 保留/T16 | Character Controller(成熟) | Mover / Character Movement(成熟) | characterMotion.test.ts、rapierCharacterController;root motion/坡度台阶跨端未证,B 级 |
| 34 | 落后(裁剪域) | 裁剪/T08/T16/T18 | 数字人方案(合作方生态) | MetaHuman / MetaHuman Animator(产品级) | morph/deformation 底座在;面捕/口型/数字人无,B 级(裁剪域) |
| 35 | 落后(裁剪域) | 裁剪/T14/T16 | Cinemachine 3.x(多镜头/避障/抖动) | Cine Camera / Camera Rig | cameraFraming.test.ts + runtime-camera-v1/v2 fixtures;多镜头混合缺,B 级(裁剪域) |
| 36 | 落后(裁剪域) | 裁剪/T14/T16 | Timeline(多轨) | Sequencer(镜头/动画/材质/事件多轨) | viewer/timeline.test.ts、SceneTimelinePanel(502 行);多轨联动缺,B 级(裁剪域) |
| 37 | 落后 | 保留/T14 | GPU Skinning + Burst(规模成熟) | GPU Skinning / 动画 LOD(规模成熟) | pbrDeformationShader、native_animation_controller.rs;100/1000 角色阶梯未测,B 级 |
| 38 | 落后 | 保留/T14 | 资产管线版本治理 | 资产版本/重导入工作流 | runtimeDecodeTelemetry、deformation/validation;压缩/版本迁移工作流未证,B 级 |

小结:12 落后。角色生产链是保留域内差距最大的区域之一(5 项 C/无实现)。

### D. 物理、导航、仿真(11 项)

| # | 判定 | 处置/WP | Unity 7 对应 | UE6 对应 | 证据与判定依据 |
|---|---|---|---|---|---|
| 39 | 落后 | 保留/T17 | PhysX 集成(材质/约束/CCD 成熟) | Chaos 刚体(成熟) | compileScenePhysicsRuntime.test.ts、native_physics.rs(A 级局部双路径);材质/休眠/跨端容差矩阵待补 |
| 40 | 落后 | 保留/T17/T12 | 编辑器内建 collider 生成/凸包 | 凸分解/碰撞几何工具(编辑器内建) | roadPrefabPhysics.test.ts;CAD→collider 生产链未建,B 级 |
| 41 | 落后 | 保留/T17 | ConfigurableJoint 等(成熟) | Chaos 约束/马达(成熟) | rapierPhysicsJoint.test.ts(A 级局部);大规模约束验证未测 |
| 42 | 落后 | 保留/T17 | Continuous Collision Detection(成熟) | Chaos CCD(成熟) | 无测试,C 级 |
| 43 | 落后(裁剪域) | 保留/T18 | Cloth(基础) | Chaos Cloth(5.8 Production Ready)/Geometry Collections | deformation/morph 底座;布料/破碎无,B 级(底座) |
| 44 | 落后(裁剪域) | 保留/T18 | 车辆物理(第三方为主) | Chaos Vehicles(成熟) | 无实现,C 级(裁剪域) |
| 45 | 落后 | 保留/T19 | NavMesh(成熟产品) | Navigation System / Mass 导航(成熟) | runtime_navigation_tests.rs(A 级 Native 局部);坡度/步高真实窗口闭环证据未公开 |
| 46 | 落后 | 保留/T19 | ECS 人群(第三方生态) | Mass / ZoneGraph(人群) | transportNetwork.test.ts(AGV 网络,B 级);多代理局部避障无 |
| 47 | **领先(域内)** | 保留/T19/T23 | 无第一方制造业 DES;物理确定性两家均不承诺(训练知识) | 同左 | goldenPlant.test.ts(SEED 指纹确定性层)+ plantLitePortCrossBoundary.test.ts(worker 跨边界字节等值指纹,`1251bd76`)——固定步长/seed 的可复现仿真在游戏引擎无第一方等价,A 级 |
| 48 | 落后(通用域) | 保留/T19 | DOTS/ECS/Jobs/Burst(成熟) | Mass Entity(成熟) | perf/bench.test.ts、`45e5f7da`;通用 ECS 无、实体阶梯未测。域内注记:DES 16.5× 为自身 A/B,非通用框架 |
| 49 | **领先(域内)** | 保留/T23 | 无第一方工业仿真验证体系(依赖第三方仿真软件) | 同左 | golden-07 碰撞/08 联锁/09 数字线程(`1251bd76`)+ experimentAnalysis(`f7d2e3a1` LHS/CRN/Welch)+ RPW(`74e363d5`)+ 复合瓶颈判据(`a6cbe32f`)+ MTM/遗传试点(`ed31ef24`),A 级(合成验证集;真实现场校准未做,如实注明) |

小结:9 落后 / 2 领先。领先项集中在**确定性仿真与工业仿真可证性**——这是游戏引擎产品形态外的域。

### E. VFX(3 项)

| # | 判定 | 处置/WP | Unity 7 对应 | UE6 对应 | 证据与判定依据 |
|---|---|---|---|---|---|
| 50 | 落后 | 裁剪/T20 | VFX Graph(图编辑/事件/模板生态) | Niagara(CPU/GPU 混合系统+内容生态) | gpuParticleRuntime/Emitters/BurstStage/pbrParticlePass(A 级底座);事件/排序/灯光/seed 统计复现未测 |
| 51 | 落后(裁剪域) | 裁剪/T20 | VFX Graph 编辑器 | Niagara 编辑器 | 无实现,C 级(裁剪域;不建 VFX 图编辑器) |
| 52 | 落后(裁剪域) | 裁剪/T20 | 无第一方流体 | Niagara Fluids(烟/流体) | modelFireEffect 消费方;流体/烟无,B 级(裁剪域) |

### G. UI、2D、输入(7 项)

| # | 判定 | 处置/WP | Unity 7 对应 | UE6 对应 | 证据与判定依据 |
|---|---|---|---|---|---|
| 74 | 落后 | 裁剪/T21 | 2D 特性集(Tilemap/Sprite/2D 物理/骨骼 2D) | Paper2D(能力有限,差距小于对 Unity) | deep2dDisplayList/deep2dGoldenContract + Native deep2d_*gpu_tests 12+ 文件(A 级既有渲染域);游戏 2D 制作链缺 |
| 75 | 落后 | 裁剪/T21 | UI Toolkit / UGUI | UMG / CommonUI | dashboard 命令/交互族(B 级);手柄焦点/HUD 动画缺。域内注记:工业看板是我方主场但非本判定域 |
| 76 | 落后 | 裁剪/T21 | Input System(动作资产/重绑定) | Enhanced Input(动作映射) | xrInput.test.ts(浏览器面,B 级);统一动作资产/重绑定缺 |
| 77 | 落后 | 裁剪/T21 | TextMeshPro(富文本/复杂脚本) | Slate 文本(复杂脚本支持) | text_raster_gpu_tests.rs、filter_glyph、IME trace fixture(B 级);RTL/中英阿混排 golden 缺 |
| 78 | 落后 | 裁剪/T21 | Accessibility 包 | Slate Accessibility | SceneEnvironmentAccessibility.test.tsx + Cargo UIA 依赖(B 级);读屏/键盘全链未证 |
| 79 | 落后(裁剪域) | 裁剪/T21 | 移动输入(成熟) | 移动输入(成熟) | 无矩阵,C 级(裁剪域;移动 Native 已排除) |
| 81 | 落后(广度) | 保留/T21 | UI Toolkit 动态虚拟化 | UMG 大列表需自建 | virtualSceneRows.test.tsx(1 万行窗口化断言)+ Native virtual_list.rs + vertex_transfer 预算/时序 GPU 测试(A 级@1 万行档);10 万行与混排 golden 缺,产品广度落后 |

### J/K. 工业格式、语义与性能质量(18 项)

| # | 判定 | 处置/WP | Unity 7 对应 | UE6 对应 | 证据与判定依据 |
|---|---|---|---|---|---|
| 103 | 落后(广度)/治理面领先 | 保留/T22 | Unity Industry/Studio + PLM Pipeline Automation(扩张中) | Datasmith 支持矩阵(STEP/IFC/JT/X_T 直连) | modelFormatCapability 三态契约、`3a64f10a`(JT/X_T 质量报告)、`416f8508`(X_T fallback 档/X_B 阻断),A 级。覆盖广度与成熟度落后;逐工件机器可读损失报告+fail-closed 阻断为治理面领先(见 §5) |
| 104 | 落后(广度) | 保留/T22 | CAD 导入 tessellation(Industry) | Datasmith CAD 曲面细分(成熟) | xtGenericConverter/jtGlbConverter + corpus expected JSON 数值锚(A 级解析层);装配/布尔跨格式公差统计未建 |
| 105 | 落后 | 保留/T22 | 语义映射(Industry) | Datasmith metadata 管线 | jtMaterialResolution/jtOccurrenceAcceptance/`93b0e0a6`(类库属性继承,A 级局部);端到端保真率统计未建 |
| 106 | 落后 | 保留/T22/T12 | Unity Studio PLM 自动化(规划)/增量导入 | Datasmith Direct Link / Reimport | assetReimportCoordinator(B 级);源版本差异/稳定 ID 冲突矩阵未测 |
| 107 | 落后 | 保留/T22 | Industry 大模型案例(营销口径,未验证) | Datasmith 大装配+HLOD 实践 | topologyViewportGeometry、player_picking*_tests.rs(B 级);千万构件 P95 未测(依赖 S3 三档样本,均为真实缺口) |
| 108 | 持平(裁剪域) | 裁剪/T23 | 数据绑定靠项目开发 | 数据绑定靠项目开发 | dataWriteback/directBinding(B 级);本地 schema/单位/绑定验证已在裁剪域内;网络连接两侧均非引擎第一方 |
| 109 | 持平(双方均无成熟方案) | 保留/T22 | 无第一方跨建筑标准模型规范 | 同左 | scene.json floors/engineeringAnalysis 字段 + sceneBindingValidation.test.ts(B 级);完整空间语义规范两侧均未公开 |
| 110 | **领先(域内)** | 保留/T23 | 无第一方工业 DES 校准体系 | 同左 | goldenPlant(golden01–06)+ experimentAnalysis(`f7d2e3a1`)+ RPW/瓶颈判据/联锁(`74e363d5`/`a6cbe32f`/`64046086`)+ MTM(`ed31ef24`);A 级(合成验证集,真实现场校准 unmeasured) |
| 111 | 持平(裁剪域) | 裁剪/T23 | 告警链路靠项目开发 | 同左 | trace.ts/studyReport.test.ts(回放谱系,B 级);本地"告警定位→原因→回放复核"已在域内;工单/远程控制排除 |
| 112 | **领先(治理维度)** | 约束/T22 | 商业闭源导入链/SaaS 产品线 | Datasmith 内置但闭源,无逐工件许可治理交付 | `data/external-assets/industrial-format-plan/`(corpus-manifest.json + 7×SHA256SUMS 共 463 行 + license-supplements + self-made-negative 负样本)+ X_B 阻断策略(`416f8508`),A 级;格式广度仍落后(103 注记) |
| 113 | 持平(方法论) | 保留/T00/T05/T11 | 无对我方场景的公开基准;跨引擎对比依赖第三方 | 同左 | fair-comparison r1/r2 三后端配对 + benchmarkTargetMatrix 合同(A 级内部配对);vs Unity/UE unmeasured 且明确不作承诺 |
| 114 | 持平(方法论)/数值互有胜负 | 保留/T00/T05/T11 | — | — | §2.1 配对数据如实:静置 P95 追平、submit 同量级、输入 P95 落后 20.8 vs 13.8、拾取领先 113–6685×、冷首帧落后;A 级(全部配对实测) |
| 115 | 落后 | 保留/T11 | Memory Profiler(成熟) | 内存统计工具(成熟) | benchmarkSampleSchema 已定义 memory 通道,heapUsedMb=0 未接通 → **unmeasured**(C 级,不填零) |
| 116 | 落后 | 裁剪/T00/T11/T12 | 多年构建/迭代计时积累 | Zen Server/增量 Cook | `d0c9afc5` packet 编译缓存+阶段 mark(B 级);全流程计时(导入/shader 编译)未测 |
| 117 | 持平(裁剪域) | 裁剪/T00 | 公开平台要求矩阵 | 公开平台要求矩阵 | gate:deep-p0:{browser,native,studio} + modelFormatCapability 三态(A 级门禁存在);公开绿黄红矩阵未发布(C 面,行内注明) |
| 118 | 持平(方法论/单机) | 保留/T00+ | Unity Test Framework 图像比较 | Automation 截图比较(成熟) | renderImageSimilarity.mjs(SSIM/MAE)+ 确定性守卫(r1 位姿 SSIM=1.0,A 级单机);跨 GPU/驱动矩阵未测(C 面) |
| 119 | 落后 | 保留/T00+ | 多年多项目回归积累 | 多年内容规模回归积累 | S8 语料+样本清单(B 级);长周期企业场景回归未建 |
| 120 | 持平(裁剪域) | 裁剪/T00/T11 | 线上遥测生态 | 线上遥测生态 | fair-comparison guards(r3–r6 实证捕获 502 楔死,A 级捕获);归因统计未建;线上遥测两侧均超出本仓域(已排除) |

## 4. 数量统计(75 项)

| 判定 | 项数 | 占比 | 项号 |
|---|---|---|---|
| **领先(域内)** | **4** | 5.3% | 47、49、110、112 |
| **持平** | **10** | 13.3% | 13、14、108、109、111、113、114、117、118、120 |
| **落后** | **61** | 81.3% | 其余全部(A 域 12 项、B 域 10 项、C 域 12 项、D 域 9 项、E 域 3 项、G 域 7 项、J/K 域 8 项) |

结构解读:领先项全部集中在**工业仿真确定性/可证性与格式治理**——即游戏引擎产品形态之外的域;持平项集中在**裁剪域内的本地能力与内部证据方法论**;渲染/角色/UI/平台等通用引擎核心域全面落后,与 09-26 审计"必须追/按需选做/不追全量"的取舍一致。**任何"完全超越 Unity/UE"的表述当前不成立**;成立的是:域内 4 项独有 + 内部配对方法体系完整。

## 5. 领先 TOP-10(已实现/独有,全部附仓内证据;性能项仅内部配对,不作跨引擎宣称)

| # | 能力 | 证据 | 性质 |
|---|---|---|---|
| 1 | 工业格式离线自研/开源链 + 机器可读质量报告 + fail-closed 阻断契约 | `3a64f10a`(JT/X_T 质量报告,losses/approximations/metrics 绑定输入 SHA-256 + 逐工件证据哈希)、`416f8508`(X_T 通用 fallback 档 + X_B 阻断策略)、`c179bfb2`(schema catalog 路线) | 治理/审计维度独有;Unity/UE 导入链闭源且无逐工件损失报告(训练知识) |
| 2 | 工业格式语料许可治理体系 | `data/external-assets/industrial-format-plan/`:corpus-manifest.json(JT/X_T/RVT/E57/3D Tiles/3DM/SLDPRT 七方向)+ 7 份 SHA256SUMS(463 行)+ license-supplements + self-made-negative 负样本 | 对手无等价的"样本级来源/哈希/许可/预期几何"入库治理 |
| 3 | Plant 仿真 golden 指纹体系 | golden01–06(`goldenPlant.test.ts`,SEED=fingerprint64Labeled)+ golden-07 碰撞/08 联锁/09 数字线程(`1251bd76`)+ plantLitePortCrossBoundary.test.ts(worker 跨边界字节等值指纹) | 固定 seed 全链确定性,游戏引擎无第一方制造业 DES 等价 |
| 4 | DES 内核吞吐(自身 A/B) | `45e5f7da` + `plant-lite-bench-after-20260925.json`:60 工位 16.5×(32,280 events/s),同 seed 指纹锁定;`0923dbd4` + `plant-lite-tier-bench-2026.json`:500/4000/10000 对象三档 | 仅 vs 自身配对;规模档衰减已如实登记 |
| 5 | 机构运动学 + 多机器人联锁 + 人因标准层 | `9f11df30`(FK/阻尼最小二乘 IK/循环节拍轨迹)、`64046086`(多机器人信号联锁调度)、`e616677a`(ANSUR-II 百分位人体/NIOSH 提举/OWAS) | 工业域专属;Unity/UE 无第一方人因标准层(训练知识) |
| 6 | 仿真实验设计与分析闭环 | `f7d2e3a1`(sweep/grid/LHS、CRN、敏感度、Welch)、`74e363d5`(确定性 RPW 产线平衡)、`a6cbe32f`(利用率×阻塞/饥饿复合瓶颈判据)、`ed31ef24`(MTM 工时 + 种子遗传优化) | 仿真工具链闭环;对手生态靠第三方仿真软件 |
| 7 | BVH 加速拾取(配对微基准) | `test-output/ordinary-picking-benchmark-2026-09-09.json`:20k–1M 三角形 P50 **113×/1566×/6685×**,128k 管结 535×,mismatches=0(vs Three CPU raycast 同机配对) | 数量级领先,但仅浏览器 CPU 拾取口径 |
| 8 | 浏览器端 WebGPU 工业 PBR 三后端全链 | T00 fair r1/r2:静置 P95 追平、**静置 P99 7.2ms vs WebGL 34.8ms**、黑帧 0、位姿 SSIM=1.0;`benchmark:render-engines` 可复跑入口 | 本地浏览器运行的成本结构差异真实存在;vs Unity WebGPU/UE Pixel Streaming 无配对数据(§1.1) |
| 9 | 瞬态通道(beyond useFrame) | `57d5c85f`:transientChannel.ts + useTransientValue + 6 单测;变更驱动(非逐帧)、帧内合并、空闲零开销;`react-3d-boundary-audit-2026-09-27.md` 四条热路径实测 | 对 R3F/Unity DOM-3D 混合方案的工程边界改进;无跨引擎基准 |
| 10 | 提交背压→修订缓存→packet 指纹缓存优化链(证据链工程) | `d9f3b093`(submit 47.4→2.2ms)、`923f1ca4`(输入 20.8→14.0ms)、`d0c9afc5`(双切首帧 3.9→1.57s);20+ 个 cut 目录 + 长任务归因探针(`7bae5c2b`/`4ec3c55f`/`9eb572d8`) | 方法论级领先:每刀 A/B 配对+指纹+失败台账;绝对值仅 vs Three 配对 |

落选说明(近 TOP 但证据弱一档):JT/STEP/X_T 装配结构树 sidecar(`e2361970`)与 JT 量化/无损顶点属性解码(`227fd612`)并入第 1/2 项叙事;`df4b376f` OPC UA Live 模式属计划排除域,只记录存在不列为领先。

## 6. 差距 TOP-10(按 用户可见影响 × 差距大小 排序,映射工作包)

| # | 差距 | 用户可见影响 | 对手水位(训练知识) | WP |
|---|---|---|---|---|
| 1 | 大场景首帧/输入长帧/内存通道(#24/#114/#115):冷切 4.6–5.0s vs WebGL 0.80s;输入 P95 20.8 vs 13.8ms 回归未归因;内存 unmeasured | 每个用户每次打开/拖拽都感知 | 产品级流送加载多年积累 | **T11**(T00 已移交 5 项可执行动作) |
| 2 | 实例级 GPU 剔除→拾取/轮廓消费链未核验(#25) | 大装配(10 万+ 构件)浏览/选中体验 | Unity 6 GPU Resident Drawer / UE Nanite 产品化 | **T05**(T00 首批清单第 3 项) |
| 3 | 工业 format×版本×profile 矩阵与几何精度统计未建(#103/#104) | 真实客户模型"能否打开、打开对不对"——工业主线命脉 | Datasmith 支持矩阵+多年 CAD tessellation | **T22**(权威格式计划恢复为前置) |
| 4 | 动态 GI 消费闭环:动态失效/漏光/收敛未验收(#2) | 工业场景光照真实感第一印象 | Unity Surface Cache GI(6.7 beta)/UE Lumen | **T02**(S2 黄金场景先建) |
| 5 | 时域重建与升尺度:残影验收/动态分辨率未做(#10) | 中低端 GPU 帧率与画质可玩性 | UE TSR / Unity DLSS-FSR+STP 插件 | **T07** |
| 6 | 多灯与虚拟阴影:64/256/1024 灯阶梯未测、无分页阴影(#4/#5) | 车间灯海场景吞吐 | MegaLights(5.8 Production Ready)/VSM | **T04** |
| 7 | 物理四组黄金案例/CCD/跨端容差矩阵未建(#39/#42) | 机构仿真结果可信度 | PhysX/Chaos 多年生产验证 | **T17**(S5 fixture 化) |
| 8 | meshlet→虚拟几何闭环:自动簇层级/误差控制/拾取一致性(#8) | 高模 BIM/CAD 流畅浏览 | UE Nanite 全链 | **T05**(XL 切片) |
| 9 | 导航与多代理闭环:坡度/步高真实窗口证据、局部避障(#45/#46) | AGV/人员仿真可见行为 | NavMesh / Mass+ZoneGraph 成熟 | **T19**(10000 对象 DES 档衰减 442 events/s 亦在此包) |
| 10 | 重定向与姿态搜索完全缺失(#30/#31) | 角色/人因场景(ANSUR-II 人体的动起来) | Avatar Retargeting/IK Retargeter/Motion Matching 成熟 | **T15** |

候补(11–12):T20 粒子事件/排序/seed 统计(#50);T21 文本 RTL/中英阿混排 golden(#77)。

## 7. 结论与红线

1. 判定结论:**域内领先 4 项、持平 10 项、落后 61 项**。"功能性能都完全超越 Unity/UE"当前无证据支持;可成立的表述是"在工业仿真确定性/可证性、工业格式治理、浏览器内 WebGPU 工业链路上有独有实现,通用引擎核心域有完整底座但产品成熟度落后"。
2. 跨引擎性能数字一律禁止;对外引用本文时必须带 §1.1 声明。
3. 排序用途:差距 TOP-10 前 4 项(T11/T05/T22/T02)与计划"初期切片优先 T11/T05/T02/T17/T22"一致,可作为 W1–W2 资源倾斜依据。
4. 未验证项如实登记:vs Unity/UE 全部、内存通道(#115)、整页冷启动、千万构件档、真实现场仿真校准(#49/#110 的外部真值)。



## 9. 与 24 工作包计划的整合执行路线(2026-09-27 追加)

本报告的差距 TOP-10(第 6 节)与《核心能力开发执行计划》的波次高度重合——差距不是新发现,
而是对计划优先级的独立验证。整合结论:

### 9.1 差距 → 工作包 → 波次对照

| 差距排名 | 差距项 | 工作包 | 波次 | 整合说明 |
|---|---|---|---|---|
| 1 | 大场景首帧/输入长帧/内存 | T11 | W1 | 输入帧 14ms 与冷切 4.6s 已有本轮治理底座;剩可见闭包分阶段与内存通道 |
| 2 | 实例级 GPU 剔除→拾取链 | T05 | W2 | meshlet/Hi-Z/indirect 已有;缺消费闭环与 10k 实例 -50% 验收 |
| 3 | 工业格式矩阵与精度统计 | T22 | W2 | 本周已交付三档能力链+schema-aware B-Rep 解码;剩三角化 MVP(进行中)与 10 万+ 构件压测 |
| 4 | 动态 GI 消费闭环 | T02 | W2 | 探针系统已有;缺失效/漏光/收敛证据 |
| 5 | 时域重建与升尺度 | T07 | W2 | TAA 已有 jitter;缺失遮挡掩码与内部分辨率 |
| 6 | 多灯与虚拟阴影 | T04 | W2 | governor 已有;缺分页阴影原型 |
| 7 | 物理黄金案例/CCD | T17 | W2 | Rapier 双版本在用;缺四组黄金 fixture |
| 8 | meshlet→Nanite 级闭环 | T05 | W2 | 与 #2 同包 |
| 9 | 导航与多代理(含 DES 万档衰减) | T19 | W3 | 万档 442 ev/s 已实测;W3 需分批调度优化 |
| 10 | 重定向与姿态搜索 | T15 | W3 | kinematics FK/IK 已有(2026-09-27),重定向/姿态库缺 |

### 9.2 执行结论

1. **差距 TOP-4 全部落在 W1/W2**——按计划既有波次执行即可覆盖最高优先差距,无需重排。
2. **领先项不在工作包内**(确定性仿真/格式治理/人因标准等)——它们是域内领先的护城河,
   执行 W1-W4 时不得回归(执行计划第 6.2 节通用门槛已覆盖回归约束)。
3. **无配对基准的现实**:Unity 7/UE6 无可运行的 web 配对形态,性能对照只能做能力存在性与
   架构对照;可量化的超越目标以 vs Three WebGL(编辑器)、vs Bevy(native 渲染)、
   自身 A/B(DES)三组配对为准,持续维护。
4. DES 万档 442 ev/s 的衰减已在 bench 基建中固化三档场景(500/4000/10000 对象),
   W3 的 T19 分批调度优化以该数据为 before 基线。

## 8. 来源

- 仓内:`docs/reports/deep-engine-vs-unity7-ue6-direct-2026-09-26.md`、`docs/reports/deep-core/T00-baseline.md`、`docs/specs/deep-engine-core-capability-development-plan-2026-09-27.md`、`docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md`、`docs/reports/react-3d-boundary-audit-2026-09-27.md`;`test-output/deep-core/T00/`、`test-output/bevy-019-benchmark/`、`test-output/ordinary-picking-benchmark-2026-09-09.json`、`test-output/plant-lite-*.json`、`data/external-assets/industrial-format-plan/`。
- 提交(均可 `git show` 验证):`3a64f10a`、`416f8508`、`c179bfb2`、`1251bd76`、`45e5f7da`、`0923dbd4`、`9f11df30`、`64046086`、`e616677a`、`f7d2e3a1`、`74e363d5`、`a6cbe32f`、`ed31ef24`、`57d5c85f`、`d9f3b093`、`923f1ca4`、`d0c9afc5`、`e2361970`、`227fd612`、`7bae5c2b`、`4ec3c55f`、`9eb572d8`。
- 官方(沿用 09-26 审计已核验链接):[Unity 7](https://unity.com/releases/unity-7)、[Unite Seoul 2026](https://unity.com/blog/unite-seoul-keynote-2026-recap)、[UE6 路线](https://www.unrealengine.com/news/the-road-to-ue-6)、[UE5.8 发布说明](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)、[Datasmith 支持矩阵](https://dev.epicgames.com/documentation/unreal-engine/datasmith-supported-software-and-file-types)、[Lumen](https://dev.epicgames.com/documentation/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine)、[Unity URP HDR Output](https://docs.unity.com/en-us/engine/6000.6/manual/materials-and-shaders/graphics-color/hdr/hdr-in-urp/hdr-output)。
- 本文为文档审计;未运行新测试,未做跨引擎基准,未修改任何源码。
