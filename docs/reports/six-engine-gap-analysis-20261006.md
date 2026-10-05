# 六引擎对标差距调研(2026-10-06)

> 用户指令:持续对标 UE/GPUI/Bevy/Unity/three/Babylon,必须一线水平,不瞒报。
> 本文为纯调研(只读+本文档),不改任何产品代码。
> 与旧底稿的关系:先对账后补差——旧底稿缺口清单中今日已闭环的项一律剔除,只登记真实残余缺口。

## 0. 现状核查(六步,2026-10-06 执行)

| 步骤 | 结论 |
|---|---|
| 旧底稿检索 | 已读四份:`deep-engine-vs-unity7-ue6-direct-2026-09-26.md`(122 项审计)、`unity-ue-parity-evidence-2026-09-27.md`(75 项三层判定:领先 4/持平 10/落后 61)、`deep-engine-vs-unity-ue-gap-2026-09-26.md`(45 域)、`ue-class-leap-plan-20261003.md`(六专项);GPUI 线另有 `deep2d-gpui-parity-plan-20261005.md`。无本文档先例,不重复建设 |
| 今日战况 | `docs/specs/legacy-debts-closeout-plan-20261006.md` + git log:今日已收 B3 光追双通道(反射 closest-hit/RT 阴影自动选路)、ReSTIR 胜者可见性射线(megaLights M2)、簇级虚拟几何黄金用例、C3 LTC 面积光/C4 camera-relative/C5 大气散射/C10 接触阴影/C11 SSR 物理化/C12 白炉/C13 device-lost、F3 虚拟纹理/F4 时域超分/F8 自动曝光、G1-S1/S2 微多边形簇级+作者链路、J2B1/J2B2 WGSL 单源、J3/J4 双端对拍门与能力清单、A2 内存专项三刀、编辑器 9 项多刀(Shader Graph 节点图接活/HUD/Prefab)、deep2D GPUI 三刀全闭环、A1 首帧分级挂起 |
| 契约层 | `packages/contracts/fixtures/renderer-capability-manifest.json` 金样 45 行(新增 deep2d 三行);`rendererCapabilityManifest.ts` 双端登记生效 |
| 依赖 | three 0.185.1(最新上游 r186,落后 1 个 minor)、Web Rapier 0.19.3 / native Rapier 0.35.3(版本分轨)、wgpu 30.0.1(含实验 ray-query 已启用)、cosmic-text 0.19.0(与 GPUI/Zed 同源)、taffy(deep2d 布局,与 GPUI 同源) |
| 消费方 | 渲染 45 行能力由作者态/发布/双端 player 消费;本文不改消费关系 |
| 测试与证据 | `test-output/vsm-20261003/`(VSM M2 验收)、`test-output/deep-core/T00/`(三后端配对)、`test-output/bevy-019-benchmark/`(vs Bevy 0.19.1 配对)、`ts-rust-parity-audit-20261005.md`(双端 40→45 行逐行矩阵) |

**我方当前能力面(锚定口径)**:金样 45 行。Web 侧 44 supported + 1 degraded;Native 侧 11 full / 6 degraded / 23-27 absent(以 `ts-rust-parity-audit-20261005.md` 为准,当日后有新增提交,以 J4 纪律滚动同步)。双端均无:景深运动模糊质量链(native)、motionBlur、subsurface、ReSTIR-GI 级全路径追踪 GI、通用 ECS、角色重定向/Motion Matching、地形植被 PCG、VFX 图编辑器(裁剪)、音频混音器、游戏多人网络、平台矩阵(XR/主机)。

## 0.1 诚实条款

1. 跨引擎**能力存在性对照**基于各家官方 release notes/官方博客(见 §9 来源);**无任何跨引擎同素材性能基准**——唯一配对数据是 vs Three WebGL(同机浏览器)、vs Bevy 0.19.1(单 fixture)、自身 A/B 三组,不得外推。
2. 我方"落后"项如实写落后;"领先"项只写域内且附仓内证据;"持平"需双方能力面相近。
3. 版本时效:UE 5.8(2026-06-23 发布,UE5 最后一个大版本)、Unity 6.x 稳定 + 6.7 LTS 在途(SCGI 预览)、three r186(我仓 0.185.1)、Babylon 9.15(9.0 于 2026-03 发布)、Bevy 0.19(0.20 在研,Solari 系列持续)、Zed 1.0(2026-05)→ 最新稳定 1.20.x。

## 1. 与旧底稿对账:今日已闭环项(全部剔除,不再列为缺口)

旧 122 项审计中以下项**已在我方真实闭环**(均有提交/验收证据),本报告不再作为"缺口"重复登记:

| 旧项号 | 旧缺口描述 | 现状 | 证据 |
|---|---|---|---|
| #2 动态漫反射 GI | "缺动态失效/漏光/收敛验收" | Lumen 式三层混合落地:SDF-GI + 探针方向可见度 + SSR 物理化 | 金样 `sdf-gi`/`gi-probe-directions`/`ssr`;F5 门内遮蔽 0→280 |
| #4 多灯 | "64/256/1024 灯阶梯未测" | ReSTIR-DI 胜者可见性射线,megaLights M2(接 traceTwoLevelOccluded,ABI v2) | c59319b1;金样 `megalights` |
| #5 虚拟阴影 | "无分页阴影原型" | VSM 三环 clipmap(虚拟 16384²/页 128²/8 mip/Top-K 物化/动态失效/级联回退),M2 验收修复占位绑定与粗 mip 回退两根因 | `ue-class-b2-vsm-m2-acceptance-20261004.md`;`shadow-cascades` 双档 |
| #6/#7 硬件光追/路径追踪 | "能力探测≠渲染交付" | B3 光追双通道:native 硬件 ray-query(RT 方向阴影管线族)+ web compute BVH;RT 反射 closest-hit 帧通道;RT/级联逐像素混合自动选路 | 00871f4c、4988df13、1c193341;金样 `hardware-ray-query`/`ray-traced-shadows`/`ray-traced-reflections`(登记修正仍待做,见 §8 P0) |
| #8/#25 虚拟几何/实例剔除 | "自动簇层级/拾取一致性未闭环" | 簇级 LOD 端到端黄金用例(像素阈值驱动前沿)+ G1-S1 微多边形簇级绘制闭环 + G1-S2 作者链路接线 | 60ba4efe、G1-S1/S2 报告;金样 `cluster-lod`/`virtual-geometry` |
| #9 虚拟纹理 | "页表/GPU feedback 未证" | F3 全链真机证据(页表/驻留/预算/反馈,SSIM 0.9927≥0.99) | F3 报告;金样 `virtual-textures` |
| #10 时域重建/超分 | "残影验收/动态分辨率未做" | F4 时域超分上采样核落地;TAA/TSR 底座 | F4 报告;金样 `taa`/`temporal-upscale` |
| #3 SSR | "跨端回退闭环未实测" | C11 SSR 物理化 | I级第一批报告;金样 `ssr` |
| #12 体积大气 | "天空/云/水无" | C5 物理大气散射天空(雾/体积雾既有) | I-C6 报告;金样 `atmosphere-sky` |
| #13 色彩显示链 | — | author-grading、hdr-display-output、auto-exposure(F8)入金样 | 金样四行 |
| #26 掉线/设备丢失 | "复现矩阵未测" | C13 WebGPU device-lost 类型化恢复(fail-closed) | I级第二批报告;金样 `device-recovery(-bridge)` |
| #11 材质分层 | — | material-layered-304b 双端 304B ABI 互钉 + material-abi-192b 修复 | g1-material-abi-192b 报告;金样两行 |
| C 轴编辑器部分 | "关键帧/材质图/Shader Graph/HUD/Prefab 缺" | 编辑器 9 项补齐多刀:关键帧+相机路径、材质图契约 Tier-2、Shader Graph 节点图接活(死端画布→真实草稿态)、HUD 收口、Prefab 收口 | f3b06bca、92558697、b8f4d840 等 |
| deep2D GPUI 对位 | — | 三刀全闭环:视觉三命令(渐变/圆角/阴影)、taffy 组件布局、stencil-then-cover 动态路径填充;对位表三件全消 | `deep2d-gpui-parity-plan-20261005.md` §已闭环;金样 deep2d 三行 |

**旧底稿仍然成立的真实残余缺口**(本文主体):native 侧 21+ 项 absent、DoF/motionBlur/subsurface、ReSTIR-GI/specular GI、角色生产链、地形植被、协同编辑完整链、平台矩阵、生态,以及 A1 首帧 500ms(在跑)。

---

## 2. Unreal Engine 5.8(UE5 最后大版本,UE6 2027)

**当前能力面**(官方 release notes,2026-06):MegaLights Production Ready(降噪+性能优化)、Lumen Lite(60fps@Switch2)、Accumulation Depth of Field(5.8 新,电影级低成本)、Nanite/VSM/TSR/Path Tracer 基线、面部绑带+高级 morph+编辑器内面部雕刻、Control Rig、PCG/World Partition 改进、Movie Render Graph 与 Live Link Hub Production Ready、Iris 对许可用户 Production Ready。

### 2.1 它有我们没有(逐项)

| # | 能力 | 判定 | 理由 |
|---|---|---|---|
| 1 | ReSTIR-GI / 全路径追踪 GI(Lumen 硬件档 + Solari 式 specular GI) | **可补(native)** | 我方 B3 已有 RT 阴影+反射 closest-hit+ReSTIR-DI;缺的是 specular GI 全路径反弹与 RT-GI。native 硬件 ray-query 已启用,增量可行 |
| 2 | Accumulation Depth of Field / Motion Blur | **不宜补高优** | 工业大屏/看板几乎无需求;编辑器 DoF 开关已存在(web 侧),质量未验收;先做登记(0.5 人日),质量链等真实需求 |
| 3 | Subsurface / 毛发 Groom / 面部绑带 | **不宜补** | 数字人/角色链为裁剪域;Web+工业主线不消费 |
| 4 | Nanite 作者侧全链(mesh DAG 离线工具链+透明面卷+拾取光照全一致) | **可补(主线)** | 我方 cluster-lod 消费端已闭环(G1),缺 native 侧 geometry_dag 离线预处理工具链与亿级资产验证 |
| 5 | Sequencer/Movie Render Graph/nDisplay 虚拟制片 | **不宜补** | 裁剪域;离线出片已有 native dashboard_video 链 |
| 6 | World Partition HLOD 生成/预取策略/Data Layers 编辑 | **可补(中)** | 分区/桥双端已有,HLOD 生成与按位置预取策略缺;工业大厂区有价值 |
| 7 | Chaos Cloth PR/破碎/车辆 | **不宜补(native 暂缓)** | web 侧 XPBD 切片已有;native 软体移植按 `ts-rust-parity-audit` 评估(15+ 人日),等需求 |
| 8 | Unreal Insights/RenderDoc 级关联诊断(按 pass/材质/资源贯通 CPU-GPU 时间线) | **可补** | 我方有逐 pass GPU 计时+HUD+帧捕获,缺泳道可视化与热点归因面板(数据已在) |
| 9 | 平台矩阵(主机/iOS/Android 认证、Pixel Streaming) | **不宜补** | Web 本地运行+Tauri 桌面是既定路线;Pixel Streaming 与我方成本结构不同 |
| 10 | Iris 状态复制/专用服务器 | **不宜补** | 游戏多人域,工业 presence/lease+实时数据通道已覆盖主线 |

### 2.2 我们有它没有(如实)

1. **工业 DES 确定性体系**:golden01–09 SEED 指纹、跨 worker 字节等值、LHS/CRN/Welch 实验设计、MTM 工时——UE 无第一方制造业 DES 等价物。
2. **工业格式治理**:逐工件机器可读质量报告(losses/metrics 绑定输入 SHA-256)、fail-closed 阻断、语料许可治理(7 方向 SHA256SUMS 463 行)——UE Datasmith 闭源且无逐工件损失交付。
3. **浏览器内本地 WebGPU 全链**:UE 浏览器=Pixel Streaming(服务器渲染计费),我方零服务器本地运行(与 Three 配对静置 P99 7.2ms vs 34.8ms)。
4. **双端逐位对拍基础设施**:金样+checksum 链+三层漂移检测+identity golden——UE 无对外公开等价机制。
5. **人因标准层**(ANSUR-II/NIOSH/OWAS)与机器人 FK/DLS-IK——UE 无第一方。

### 2.3 优先级 Top5 刀位

| # | 刀位 | 工作量 | 验证口径 |
|---|---|---|---|
| 1 | native sdf-gi 移植(切片一:SDF 烘焙+天光圆锥追踪;切片二:探针 SH 更新) | 8–12 人日 | 昼夜循环 harness 逐帧像素差 p99≤3/255;封门 leakRatio 双端同口径;金样 sdf-gi native 升 supported |
| 2 | native megaLights(灯池 ABI 64B/灯 + RIS 核) | 8–15 人日 | 5000 灯 1080p p95≤12ms(native 门);与 web 解 RMSE≤0.05;金样升级 |
| 3 | native geometry_dag 离线工具链(virtual-geometry 作者侧) | 8–12 人日 | 1 亿三角形单资产 .dgc 编译+页驻留预算门(≤64MB/s 稳态);档位切换像素差 p99≤2/255 |
| 4 | RT specular GI(native 硬件 ray-query,1–2 bounce) | 8–12 人日 | 镜面场景 RT-on/off 像素差哨兵+帧预算门;金样新增行(J4 纪律先登记) |
| 5 | Profiler 泳道面板(逐 pass CPU/GPU 数据已在) | 2–3 人日 | 面板自身开销≤0.5ms;能定位单帧最贵 pass;与 HUD 收口共用入口 |

## 3. Unity 6.x / 6.7 LTS(SCGI 预览)

**当前能力面**:Unity 6 稳定(WebGPU 已生产);6.7 LTS 在途,Surface Cache GI(无烘焙动态漫反射 GI)预览并随 LTS 广泛可用;Fast Build Profile/PSO 预热;Unity Neural 神经升尺度规划;Unity 7(2027)统一 URP/HDRP、CoreCLR、MCP/CLI。

### 3.1 它有我们没有(逐项)

| # | 能力 | 判定 | 理由 |
|---|---|---|---|
| 1 | Surface Cache GI(表面缓存式动态 GI) | **可补(低优)** | 我方 sdf-gi 三层混合是不同技术路线(SDF+探针),web 已闭环;表面缓存式网格 atlas 路线可作 sdf-gi 增强,排 native 移植之后 |
| 2 | URP/HDRP 级管线资产+质量档一体管理 | **可补(文档/门)** | 我方有 renderGraph+adaptiveQuality+manifest,但"管线档×设备×能力行"公开绿黄红矩阵未产出;宜先文档化+gate 报告 |
| 3 | Shader Graph 节点生态广度+平台变体诊断 | **可补** | 我方节点图今日刚接活(草稿态);节点族广度(T20 曲线/LTC/天空/分层)与编译诊断定位有差距 |
| 4 | Addressables/内容目录/构建 Profile/PSO 预热 | **可补(中)** | packet 编译缓存+预热已有;统一构建 profile 与资产预算门(A1 500ms 主线的一部分) |
| 5 | Unity Neural 神经升尺度 / DLSS-FSR-STP | **不宜立即补** | 神经升尺度需模型分发与离线硬门槛冲突评估;我方自研 TSR 已闭环;挂评估 |
| 6 | Netcode/Services/专用服务器/2D 特性集/Terrain | **不宜补** | 裁剪域;deep2D 是看板非游戏 2D |
| 7 | Unity Studio 浏览器实时协同+PLM 自动化 | **可补(评估)** | 我方 presence/lease+受控写通道≠实时协同编辑;对象级锁+冲突合并先做 2 人日评估 |
| 8 | Asset Store 生态规模 | **不宜补** | 生态差距如实承认,靠可运行示例与 SDK 文档弥补,不靠平台 |

### 3.2 我们有它没有(如实)

同 §2.2 五项全部成立(Unity 同样无工业 DES 第一方、无逐工件格式治理、浏览器侧依赖 WebGPU 导出而非全链自研、无比特级双端对拍、无人因标准层);另有:deep2D CPU 权威 oracle 逐像素镜像(gpui-fast 文章口径下"我们更强"),工业看板信息密度纪律(FVS 对标已内化)。

### 3.3 优先级 Top5 刀位

| # | 刀位 | 工作量 | 验证口径 |
|---|---|---|---|
| 1 | Shader Graph 节点族扩展(曲线/LTC 面积光/天空/分层材质节点接入既有求值器) | 3–5 人日 | 20 节点图实时预览≤1 帧;编译错误定位到节点;与今日 f3b06bca 草稿态衔接 |
| 2 | "管线档×设备×manifest 行"公开绿黄红矩阵(gate 报告产出) | 2–3 人日 | verify 门自动生成矩阵工件;每行带证据链接;进 product-browser 门 |
| 3 | A1 首帧 500ms 攻坚(对标 Unity Fast Build/PSO 预热的"迭代速度"域) | 主线在跑 | 分段探针每刀复测:2251ms→≤500ms;指纹判据防伪 |
| 4 | 对象级锁协同编辑评估(presence→锁→合并最小闭环设计) | 2 人日(评估) | 双端并发编辑冲突自动合并或明确拒绝的设计稿+契约草案 |
| 5 | 神经升尺度可行性评估(自研轻量网络 vs 离线门槛) | 1 人日(评估) | 评估纪要:模型体积/推理时延/WebGPU 推理路径结论;不立项不登记能力行 |

## 4. three.js r186(我仓依赖 0.185.1,落后 1 个 minor)

**当前能力面**(GitHub releases,r186 为最新):SunLight 级联阴影(双渲染器)、compileComputeAsync()、PBR 能量守恒重做(多散射/DFG LUT/sheen)、retroreflectivity(MeshPhysicalMaterial)、非 compute 阶段 storage buffer+原子操作、TRANSIENT_ATTACHMENT、SSGINode/SSSNode(screen-space shadows)/GTAONode 时域、TRAA 新实现、BatchedMesh per-instance opacity/wireframe/indirect、reversed depth buffer、WebXR WebGPU MSAA、MaterialX 导入、HTMLTexture/ProjectorLight 投影纹理、Inspector(Timeline/内存/TSL Graph)、KTX2/BC4/BC5/ASTC。

### 4.1 它有我们没有(逐项)

| # | 能力 | 判定 | 理由 |
|---|---|---|---|
| 1 | reversed depth buffer(逆深度) | **可补(评估先行)** | 我方 C4 已做 camera-relative;逆深度是互补的 z 精度手段,大场景近远同屏 z-fighting 有收益 |
| 2 | SSGI(screen-space GI)/SSS(screen-space shadows) | **可补** | 我方有 SSAO/GTAO 系+contact-shadows,屏空间 GI(半屏射线 SSGDI)在旧计划 B1 内未收 |
| 3 | 投影纹理 ProjectorLight(gobo/HTMLTexture) | **可补** | 工厂投影仪/标线语义真实存在;IES+LTC 面积光已有,投影视锥纹理增量可控 |
| 4 | compute 预编译显式 API(compileComputeAsync) | **可补(小)** | 我方有 shaderCache/prewarm/磁盘缓存;缺显式 compute 管线预热 API;A1 首帧直接受益 |
| 5 | BatchedMesh per-instance opacity/wireframe | **可补(低优)** | 我方实例化走 occlusion-culling/cluster-lod;逐实例透明度/OOTB 线框属作者便利层 |
| 6 | WebXR WebGPU MSAA/深度感知 | **可补(中)** | 我方 WebXR 仅入口门控;XR 生产链为裁剪域,但门控行可补深度能力检测 |
| 7 | MaterialX 导入 | **不宜补高优** | 工业材质交换有价值但优先级低于 sdf-gi/megalights;挂评估 |
| 8 | TSL 单语言多后端(WGSL/GLSL 双发射) | **不宜补** | 我方 J2B1/J2B2 已选 WGSL 单源+CPU 镜像+双端共享 checksum 路线,对拍基建更强;两路线等价,不折返 |
| 9 | three 0.185→0.186 升级 | **应做(小)** | 作者桥基线落后 1 个 minor;升级含 SunLight 级联/能量守恒重做/逆深度上游实现可复用 |

### 4.2 我们有它没有(如实)

three 是渲染库非引擎:render graph、GI 三层、RT 双通道、VSM、虚拟几何/纹理、TSR、物理、确定性 DES、工业格式治理、双端金样、deep2D 全栈、看板——全部不存在或远弱于我方;BVH 拾取同机配对 113×–6685×(0 mismatch);three 作者桥本身消费我方 RenderPacket(自定义渲染由我们持有)。

### 4.3 优先级 Top5 刀位

| # | 刀位 | 工作量 | 验证口径 |
|---|---|---|---|
| 1 | three 0.185.1→r186 升级评估+落地 | 1–2 人日 | 全 verify 门绿;作者桥回归(拾取/材质/动画);bundle 体积门 |
| 2 | compute 管线预热 API(对接 A1 首帧) | 1–2 人日 | 分段探针"管线编译"段下降;首帧指纹不变 |
| 3 | reversed-Z 评估 | 1–2 人日 | 近远同屏 z-fighting 样例 SSIM;与 camera-relative 组合矩阵 |
| 4 | SSGI 半屏射线(消费 C11 深度/法线缓存) | 3–5 人日 | GI-on/off 三区哨兵;帧预算≤3ms@1080p |
| 5 | ProjectorLight 投影纹理 | 3–5 人日 | 工厂投影语义样例;与 IES 对拍零分歧;金样新增行 |

## 5. Babylon.js 9.15(9.0 于 2026-03 发布)

**当前能力面**:Frame Graph 全管线控制、集群光(WebGPU compute+WebGL2 回退,支持方向光)、Node Particle Editor、Node Material Editor(WebGPU 版)、compute shaders(5.0 起)、WebXR 全框架、Havok 物理(wasm)、Babylon Native(C++ 移动运行时)、glTF interactivity(KHR_interactivity)、双 GLSL/WGSL 着色器核、9.15 迁移 TC39 装饰器。

### 5.1 它有我们没有(逐项)

| # | 能力 | 判定 | 理由 |
|---|---|---|---|
| 1 | Node Particle Editor(可视化粒子图编辑器) | **不宜补** | T20 裁剪决策"不建 VFX 图编辑器";粒子运行时(gpuParticleRuntime/流场/曲线 LUT)我方已有 |
| 2 | Node Material Editor 成熟度(实时预览/调试) | **可补** | 与 Unity 向刀 1 合并:Shader Graph 节点族+预览球+诊断定位 |
| 3 | Frame Graph 公开调试面 | **可补(小)** | 我方 renderGraph(TS)+native render_graph 存在;缺可视化泳道——与 UE 向刀 5(Profiler 泳道)是同一刀 |
| 4 | WebGL2 回退集群光 | **可补(低优)** | 我方 web 端 WebGPU 为主、WebGL 走 three 作者桥;native/wasm 已有簇光;web WebGL 回退簇光价值低 |
| 5 | WebXR 完整框架(手部/深度/特性矩阵) | **可补(中)** | 同 three 向:门控行先补深度/手部检测,生产链仍裁剪 |
| 6 | KHR_interactivity(glTF 行为标准) | **可补(评估)** | 我方行为 IR/交互流是自有方案;标准互操作导入可评估(样例往返) |
| 7 | Babylon Native(C++ 移动) | **不宜补** | 移动平台整体裁剪;native=Tauri/Rust 既定 |
| 8 | Playground/文档/社区生态 | **不宜补** | 生态差距如实;以可运行示例+SDK 文档缓解 |

### 5.2 我们有它没有(如实)

ReSTIR 万灯(其集群光是重要性采样前一代方案)、双端确定性对拍、工业 DES/格式治理、native 离线出片(Media Foundation)、deep2D CPU oracle、金样协商表(Babylon 无对外能力协商概念);浏览器本地 WebGPU 工业全链与其等价但成本结构以配对数据为准。

### 5.3 优先级 Top5 刀位

| # | 刀位 | 工作量 | 验证口径 |
|---|---|---|---|
| 1 | Profiler/帧图泳道面板(与 UE 向刀 5 共刀) | 2–3 人日 | 见 §2.3-5 |
| 2 | Shader Graph 预览球+诊断定位(与 Unity 向刀 1 共刀) | 3–5 人日 | 错误定位到节点;20 节点≤1 帧 |
| 3 | WebXR 门控行扩面(深度/手部能力检测) | 1–2 人日 | rendererCapabilities 新增检测行;不承诺生产链 |
| 4 | KHR_interactivity 导入评估 | 2 人日(评估) | 官方样例解析往返演示;结论纪要 |
| 5 | WebGL 回退档位文档化(如实登记 web 端簇光仅 WebGPU) | 0.5 人日 | manifest web 行注记;无代码改动 |

## 6. Bevy 0.19 / 0.20(0.20 在研)

**当前能力面**(官方/官方博客):Solari 实时光线追踪 GI——0.17 引入(ReSTIR DI+GI),0.18 specular GI 0–3 bounce 路径追踪+world cache 提前终止,0.20 持续深化(jms55 2026-09-18 博客);多线程 ECS 调度器/change detection;资产热重载;文本特性族(0.19);0.19.1 补丁。配对基准(我方唯一跨引擎跑分):vs Bevy 0.19.1 同 fixture CPU P50 6.95 vs 6.47ms、GPU 0.129 vs 0.120ms——同量级互有胜负。

### 6.1 它有我们没有(逐项)

| # | 能力 | 判定 | 理由 |
|---|---|---|---|
| 1 | Solari specular GI(硬件 RT 全路径镜面反弹+world cache) | **可补(native)** | 我方 B3 有 RT 阴影/反射 closest-hit+ReSTIR-DI;specular GI 与 UE 向刀 4 同刀,native 硬件 ray-query 已启用 |
| 2 | 通用 ECS 调度器(自动并行/change detection) | **不宜补** | 场景图+命令层+事务是工业主线架构;通用 ECS 收益不成立;如实登记为架构差异 |
| 3 | 资产热重载(材质/纹理改动即时生效) | **可补** | AssetReimportCoordinator 是再导入;运行中热重载(改参数≤1s 生效)是编辑器迭代速度域,Unity 7 亦对标此域 |
| 4 | wgpu 最新特性追踪(我方固定 30.0.1;subgroups/新特性) | **可补(评估)** | 升级评估+subgroups 对 megaLights 排序/前缀和的加速潜力 |
| 5 | 多线程调度透明化(schedule 内建并行) | **不宜补** | 我方 JS 单线程宿主+Worker 沙箱架构;native 侧 rayon 已按需用 |

### 6.2 我们有它没有(如实)

编辑器(全栈)、WebGPU 浏览器产品线(Bevy wasm 为实验)、确定性物理金样(enhanced-determinism+指纹)、工业格式链、deep2D/看板、AI 受控写通道、双端金样协商;vs Bevy 0.19.1 帧时间同量级(如实,无决定性差距)。

### 6.3 优先级 Top5 刀位

| # | 刀位 | 工作量 | 验证口径 |
|---|---|---|---|
| 1 | native RT specular GI(与 UE 向刀 4 共刀) | 8–12 人日 | 镜面 RT-on/off 哨兵+帧预算门;金样新增行 |
| 2 | 材质/纹理运行中热重载 | 3–5 人日 | 改材质参数≤1s 生效;渲染指纹 diff 仅目标对象;撤销可回 |
| 3 | Rapier 版本分轨对齐评估(web 0.19.3 vs native 0.35.3) | 2 人日(评估) | 双端确定性合同草案;跨端金样可行性结论 |
| 4 | wgpu 30→最新升级评估(含 subgroups) | 2–3 人日 | 全门绿;megaLights 帧时 A/B 对比 |
| 5 | Bevy 0.20 发布后复跑配对基准(0.19.1 基线滚动) | 1 人日 | paired-summary 更新;同 fixture 同口径 |

## 7. GPUI / Zed 1.x(Zed 1.0 2026-05,最新稳定 1.20.x)

**当前能力面**:Zed 1.0(五周年)、GPUI 跨平台渲染提交管线稳定(macOS/Linux/Windows,2026-09 文档更新)、GPUI 开始被第三方采用(Zaku 等)、Zed 侧 agentic AI(BYOK/subagent/自动压缩)、"delta"取代 PR 的协作叙事。deep2d 对齐底稿(`deep2d-gpui-parity-plan-20261005.md`)三刀全闭环:视觉三命令/taffy 布局/stencil-then-cover 动态路径;cosmic-text 与 GPUI 同源;CPU oracle 我方更强。

### 7.1 它有我们没有(逐项)

| # | 能力 | 判定 | 理由 |
|---|---|---|---|
| 1 | 合成层 blend modes/backdrop-blur(玻璃拟态) | **可补** | deep2d 视觉三件(渐变/圆角/阴影)已闭环;blend/blur 是看板质感自然下一位;CPU oracle 同式镜像照旧纪律 |
| 2 | 框架级动画原语(spring/easing 元素动画) | **可补(小)** | 我方绘制属性+taffy 布局均为静态求解;补 easing 插值原语(显示列表层),不给框架层 |
| 3 | 滚动把手/z-scroll 虚拟化视口语义(GPUI 滚动缓存) | **可补(小)** | native virtual_list 已有 1 万行档;把手/视口裁剪/惯性语义对齐 |
| 4 | SVG 渲染管线完整度 | **可补(按需)** | adapterN1 SVG 子集 fail-closed;按看板图标需求扩面,不追全量 |
| 5 | Zed 编辑器域(LSP/tree-sitter/多缓冲/远程开发/协作) | **不宜补** | 产品形态不同;Studio 编辑器域按自有路线(9 项补齐)推进 |
| 6 | gpui-fast 零拷贝/缓存分析项 | **已对齐** | painter_cache 五件套+atlas+滑窗动态分路;对位表已消,无新刀 |

### 7.2 我们有它没有(如实)

CPU 权威 oracle 逐像素镜像(raster_reference+golden,GPUI 无对外等价)、stencil-then-cover 动态路径自动分路(滑窗 8 帧≥3 变更,无用户开关)、跨端显示列表合同(web 作者↔native 出片)、工业看板语义(数据绑定/虚拟滚动/双随机门);文本栈与 GPUI 同源(cosmic-text 0.19),text_document 七件套+IME 不弱于其默认。

### 7.3 优先级 Top5 刀位

| # | 刀位 | 工作量 | 验证口径 |
|---|---|---|---|
| 1 | deep2d blend modes + backdrop-blur(视觉三件之后第四件) | 3–5 人日 | CPU/GPU 对拍零分歧(照旧纪律);看板玻璃拟态样例;金样新增行 |
| 2 | 显示列表动画原语(easing 接绘制属性+taffy 布局) | 2–3 人日 | 60fps 采样指纹;与时间线/播放器衔接样例 |
| 3 | 滚动把手/视口语义(virtual_list 增强) | 2–3 人日 | 1 万行档保持;把手拖拽 P95≤7.2ms 输入门不破 |
| 4 | SVG 子集扩面评估 | 1 人日(评估) | 看板图标用例清单+fail-closed 边界结论 |
| 5 | GPUI 上游漂移监控(版本/API 对照) | 0.5 人日/季 | 对齐底稿追加"上游版本"小节;漂移项滚动登记 |

---

## 8. 总刀位清单(跨引擎汇总,按优先级)

**P0 地基(≤3 人日,先做——它们决定一切能力声明的可信度)**

> **执行状态(2026-10-06):三件全部收口**——①F2 RT 登记修正(5f4fff96);
> ②TS↔金样对拍(d4826193+7ea2d62d+5f4fff96 双向行集 diff);③native 视觉三件套
> (2fcb5f7e:vignette 全链启用 / FXAA+auto-exposure 入库为 harness-only,生产接线
> 后继切片;审计文档 ts-rust-parity-audit §8/§9)。三方对拍网 22/22 绿、native lib
> 792 测试绿、FXAA 真机 GPU 门 RTX 4060 通过。

| 刀位 | 工作量 | 验证口径 | 来源引擎向 |
|---|---|---|---|
| F2 RT 登记修正(hardware-ray-query/ray-traced-shadows native 列落后实际面)+ 金样重生成 + rt_probe 补实验特性 | 0.5–1 人日 | 金样重生成;native selfCheck 逐词一致;rt_probe 探测 EXPERIMENTAL_RAY_QUERY | 全部(协商表可信度) |
| TS↔金样对拍测试(金样逐字节相等+自检↔登记表对拍) | 0.5–1 人日 | contracts 两个测试;改表忘更金样即红 | 全部 |
| native 视觉低成本三件套(vignette 启用/FXAA/auto-exposure) | 3–5 人日 | 双端视觉对拍;native 金样三行升 supported | Unity/three(质感追平) |

**P1 质量主线(native 三大件,UE/Bevy 同源)**

| 刀位 | 工作量 | 验证口径 |
|---|---|---|
| native sdf-gi(两切片) | 8–12 人日 | 昼夜 p99≤3/255;封门哨兵双端同口径 |
| native megaLights(灯池+RIS) | 8–15 人日 | 5000 灯 p95≤12ms(native);RMSE≤0.05 |
| native geometry_dag(virtual-geometry 作者侧) | 8–12 人日 | 1 亿三角形 .dgc;页驻留≤64MB/s;档位切换 p99≤2/255 |
| RT specular GI(native,1–2 bounce) | 8–12 人日 | 镜面哨兵+帧预算;金样新增行(J4 先登记) |

**P2 补差与体验**

| 刀位 | 工作量 | 验证口径 |
|---|---|---|
| three r186 升级 | 1–2 人日 | 全门绿+作者桥回归+体积门 |
| SSGI 半屏射线 | 3–5 人日 | GI-on/off 哨兵;≤3ms@1080p |
| Shader Graph 节点族+预览球+诊断定位 | 3–5 人日 | 错误定位到节点;20 节点≤1 帧 |
| deep2d blend modes/backdrop-blur | 3–5 人日 | CPU/GPU 对拍零分歧;金样新增行 |
| 材质/纹理热重载 | 3–5 人日 | ≤1s 生效;指纹 diff 仅目标对象 |
| Profiler 泳道/帧图面板 | 2–3 人日 | 面板开销≤0.5ms;定位最贵 pass |
| 管线档×设备×能力行公开矩阵 | 2–3 人日 | gate 报告工件;每行带证据链接 |
| ProjectorLight 投影纹理 | 3–5 人日 | 工厂投影样例;IES 对拍零分歧 |
| compute 管线预热 API | 1–2 人日 | A1 分段探针编译段下降 |
| DoF/MB/subsurface 双端登记(unavailable fail-closed) | 0.5 人日 | 金样三行(J4 纪律:先登记再谈实现) |

**P3 评估/低优(不立项不占线)**

| 刀位 | 工作量 |
|---|---|
| reversed-Z 评估 | 1–2 人日 |
| Rapier 版本分轨对齐评估 | 2 人日 |
| wgpu 升级+subgroups 评估 | 2–3 人日 |
| WebXR 门控行扩面(深度/手部) | 1–2 人日 |
| KHR_interactivity 导入评估 | 2 人日 |
| 神经升尺度可行性评估 | 1 人日 |
| 对象级锁协同编辑评估 | 2 人日 |
| MaterialX 导入评估 | 1 人日 |
| HLOD 生成/预取策略 | 5–8 人日(中优挂起) |
| Bevy 0.20 复跑配对基准 | 1 人日 |

## 9. 来源

**官方渠道(本轮新核,2026-10-05/06)**
- three.js releases(r186 迁移与特性): https://github.com/mrdoob/three.js/releases ;特性综述: https://www.utsubo.com (What's New in Three.js 2026)
- Babylon 8.0: https://blogs.windows.com/windowsexperience/2025/03/27/announcing-babylon-js-8-0/ ; https://gamefromscratch.com (Babylon 8 发布稿);compute shaders: https://doc.babylonjs.com/features/featuresDeepDive/materials/shaders/computeShader ;9.x(GitHub releases,9.15 装饰器迁移): https://github.com/BabylonJS/Babylon.js/releases
- Bevy 0.18→0.19 迁移指南: https://bevy.org/learn/migration-guides/0_18-0_19/ ;Solari 0.18 博客: https://jms55.github.io/posts/realtime-raytracing-in-bevy-0.18-solari/ ;Solari 0.17: https://lobste.rs (Realtime Raytracing in Bevy 0.17);Solari 走读: https://resources.proceduralpixels.com ;RT 追踪 issue: https://github.com/bevyengine/bevy/issues/639
- UE 5.8 release notes: https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes ;发布公告: https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available ;Lumen Lite/MegaLights 解读: https://tomlooman.com
- Unity Surface Cache GI 预览: https://discussions.unity.com/t/surface-cache-gi-preview/1720494 ;Unity 6: https://unity.com/releases/unity-6 ;Unity 7: https://unity.com/releases/unity-7 ;Unite Seoul 2026: https://unity.com/blog/unite-seoul-keynote-2026-recap
- Zed 最新稳定: https://zed.dev/releases/stable/latest ;Zed 1.0 访谈(PodRocket,2026-05-28): https://podcasts.apple.com ;GPUI 跨平台渲染文档(2026-09): zed.dev/gpui 文档站

**沿用旧底稿已核验来源**
- UE:Lumen https://dev.epicgames.com/documentation/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine ;Datasmith 矩阵 https://dev.epicgames.com/documentation/unreal-engine/datasmith-supported-software-and-file-types ;Pixel Streaming https://dev.epicgames.com/documentation/unreal-engine/pixel-streaming-in-unreal-engine
- Unity:6.6 新功能 https://docs.unity.com/en-us/engine/6000.6/manual/whats-new/unity66 ;HDR Output(URP) https://docs.unity.com/en-us/engine/6000.6/manual/materials-and-shaders/graphics-color/hdr/hdr-in-urp/hdr-output

**仓内证据(对账依据)**
- `docs/reports/deep-engine-vs-unity7-ue6-direct-2026-09-26.md`(122 项)、`docs/reports/unity-ue-parity-evidence-2026-09-27.md`(75 项)、`docs/reports/deep-engine-vs-unity-ue-gap-2026-09-26.md`、`docs/specs/ue-class-leap-plan-20261003.md`、`docs/specs/ue-class-b2-vsm-m2-acceptance-20261004.md`、`docs/specs/ts-rust-parity-audit-20261005.md`、`docs/specs/legacy-debts-closeout-plan-20261006.md`、`docs/specs/deep2d-gpui-parity-plan-20261005.md`
- `packages/contracts/fixtures/renderer-capability-manifest.json`(45 行金样);提交:00871f4c、4988df13、c59319b1、60ba4efe、1c193341、f3b06bca 等(git show 可验)
- `test-output/vsm-20261003/`、`test-output/deep-core/T00/`、`test-output/bevy-019-benchmark/paired-summary.md`

**本文局限**:未运行任何测试/基准;跨引擎能力面来自官方文档而非装机实测;native 金样行数以 2026-10-05 审计为快照,随后续提交按 J4 纪律滚动;工时为估计级未排期。
