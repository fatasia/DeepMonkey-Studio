# Deep Engine(WebGPU)对标主流平台差距分析(2026-09-15)

> 结论来源:对 `packages/deep-engine`(Web/WebGPU 侧)与 `packages/deep-engine-native`(Rust wgpu 侧)的全量源码盘点,并与三份自审文档交叉验证:`docs/specs/deep-engine-consolidated-audit-2026-09-14.md`、`docs/specs/deep-engine-webgpu-remaining-plan-2026-09-14.md`、`docs/specs/deep2d-support-matrix-2026-09-14.md`,以及 `packages/deep-engine-native/README.md`"尚未完成"清单。
>
> 诚实条款:本文为静态代码盘点结论,未做浏览器/真机渲染画面实测对比。所有"缺失"均以 src 与文档双向确认为准;凡属"内核已存在未合流"的一律单独标注,不把 roadmap 计划当作现状。竞品能力(Unity/Babylon.js/Three.js 生态、山海鲸/ThingJS 类数字孪生平台)只用于确定水位,未验证的竞品功能不写成事实。

## 当前交叉核对补充（2026-09-15）

本文作为 GLM 静态盘点输入，需结合当前实现核验：Studio bridge 已显式创建
`authorChunks`、`deformation`、`meshlets` profile，但正式三项目 GPU 证据仍缺；现有
`DeepBenchmarkBackend` 只覆盖合成 sphere fixture，不能替代 BIM 基准。GLM C05 的
`gpu=27ms` 是 `Instant` 包围的主机耗时，不是 timestamp-query GPU 时间。

已追加的兼容切片：Browser/Native 的 `BLEND + alphaCutoff` flags 已统一为 `6`，
并通过 Browser 26/26、Native 5/5 相关测试；`flatShading`、`vertexColors` 仍因几何
流和 ABI 未冻结而保持结构化不支持。Native Deep2D/chart/IME 模块仍需接入真实
`PlayerContent`/renderer frame chain，不能以库级探针作为 Studio 产品完成证据。

## 一、结论先行

**渲染核的起点已经相当高——自研 WGSL 管线 + MRT + TAA + Hi-Z + Forward+ 聚类灯光,这一层不输 Babylon.js 的 WebGPU 路线;但 deep 目前是"能渲一帧的渲染核",不是"能用的平台引擎"。** 差距主要不在画质上限,而在三整层的缺失(交互层、高级效果层、物理/VFX 层),以及大模型能力"有零件无整车"的合流缺口。

按 `docs/render-engine-selection-2026-08-30.md`,产品生产默认仍是 Three.js,deep 是可切换实验轨道;`deep-engine-consolidated-audit-2026-09-14.md` 也明确"已可运行,但不是正式默认引擎切换,也不是完整 Three/编辑器替代品"。本文评估的就是这条轨道要追平主流平台还差什么。

## 二、已具备能力(对标基准面)

以下能力均有源码实证,对标时不需要自卑:

| 能力 | 现状 | 证据 |
|---|---|---|
| Web 渲染管线 | MRT(HDR 色+线性深度+视图法线+motion)→ GTAO → Hi-Z → TAA → 加权 OIT 透明 → Bloom → vignette/色阶,ACES(deep-aces / three-aces-r185 双实现);抗锯齿 TAA+FXAA | `src/webgpu/renderTargets.ts`、`pbrFrameGraph.ts`、`pbrPostProcessChain.ts`、`postprocess/temporalAa.ts` |
| Forward+ 聚类灯光 | 聚类网格+打包+compute 灯光,带视角重要性预算;点/聚光局部阴影 | `src/lighting/clusterGrid/`、`clusterLightingPbrWgsl`、`importanceBudget.ts`、`webgpu/localSpotShadowRuntime.ts` |
| IBL | GPU 生成摄影棚环境 + GGX 预过滤 mip + 辐照度 + DFG LUT;.HDR 解码、KTX2/Basis 转码、全景背景 | `src/webgpu/environmentShader.ts`、`studioEnvironment.ts`、`textures/radianceHdr.ts`、`textures/ktx2Transcode.ts` |
| PBR 材质 | metallic-roughness 完整(GGX/Smith/Schlick),shaderAbi v1–v3 冻结 | `shaderPresets/`、`shaderAbi/`、native `src/renderer/pbr_brdf.rs` |
| GI 内核 | DDGI 式 irradiance probe clipmap(compute 采集+更新调度+采样)——内核存在,未产品闭环 | `src/lighting/probeClipmap*`、`webgpu/probeClipmapRuntime.ts` |
| 阴影 | CSM 2–4 级(默认 4)、texel snapping、级联混合、阴影缓存 | native `src/renderer/cascaded_shadow.rs`、`shadow_cache.rs`;web `cascadedShadowPlanner` |
| 动画 | glTF TRS+morph 解码与融合、SceneAnimationMixer(多层/blend/fade)、GPU 蒙皮、GPU morph、变形历史 | `src/gltf/decodeAnimated*`、`animation/SceneAnimationMixer.ts`、`webgpu/gpuSkinning.ts`、`gpuMorphDeformation.ts` |
| 大模型内核组件 | GPU LOD 选择、meshlet 构建/剔除/间接执行、GPU frustum culling、Hi-Z 金字塔+遮挡剔除+实例压实、loose octree、chunk 流式+驻留预算 | `webgpu/gpuLodSelector.ts`、`geometry/meshlet*`、`gpuFrustumCulling.ts`、`hiZPyramid/`、`spatial/looseOctree.ts`、`streaming/residencyController.ts`;native `gpu_culling.rs`、`gpu_lod.rs` |
| 粒子 | GPU compute 粒子(上限 1,048,576、indirect draw)、3 个数字孪生预设:告警脉冲/扩散环/流线 | `webgpu/gpuParticleRuntime.ts`、`gpuParticleEmitters.ts` |
| native 管线 | 4x MSAA 前向 HDR + CSM + ACES + 单剖切平面(含阴影参与)+ Deep2d 后置 pass | native `src/renderer/frame.rs`、`mesh_abi.rs`、`assets/shaders/native_mesh_v1.wgsl` |
| 工程纪律 | shader ABI 冻结、磁盘缓存、时间戳遥测(web 异步读回/native 六段)、golden 像素对照 | `webgpu/gpuTimer.ts`、native `telemetry_gpu.rs`、`shader_disk_cache/` |

## 三、五档不足(按对"可用性"的伤害排序)

### 第一档:交互与 BIM 功能层整体缺失 —— 最大短板

与 ThingJS/山海鲸/Unity 编辑器拉开体感差距的地方。Three.js 产品侧已有的,deep 全都没有:

| 能力 | deep 现状 | 对标水位 |
|---|---|---|
| 相机控制器 | 引擎层零(仅 `cameraMath.ts` lookAt 数学与 jitter 历史);native 仅固定焦距 yaw 轨道(`player_state.rs`) | Unity/ThingJS 轨道+第一人称+碰撞漫游为标配 |
| 拾取 | deep 无 BVH、无 GPU picking;native 仅 CPU 三角拾取(`player_picking.rs`) | three-mesh-bvh 在产品侧已落地(RAY-03),deep 未接 |
| 选择/高亮/轮廓 | 无 | ThingJS 选中描边+呼吸灯 |
| 测量标注 | native 仅点到点距离(`player_measurement.rs`);无区域测量、无 3D 公告牌文字、无 SDF | 西门子 PS 级多类测量+标签 |
| 剖切 | Web 侧无 clip plane;native 单平面、键盘驱动(C 开关/X-Y-Z 选轴/PageUp-Down 移动) | 山海鲸/ThingJS 楼层剖切、剖切盒、爆炸图 |

**结论:数字孪生平台的日常主干(选、量、剖、标、走)在 deep 上一个都做不了。这是"渲染核"与"引擎"的本质区别,也是最痛的一档。**

### 第二档:高级渲染效果整层缺失

- 无 SSR、DOF、Motion Blur(TAA 已有 motion 向量,离 Motion Blur 只差一步但未做);无胶片颗粒、色差。
- 体积类全空:体积雾、体积光(god rays)、大气散射、程序化天空/日夜循环,volumetric/god ray/atmospheric 在两包 src 零命中;仅解析式雾(web 线性/exp2,native 指数雾)。对标山海鲸"空气感"(雾/渐变背景/辉光),场景氛围能力不足。
- 天气与水体全无:产品 Three 侧已有晴/雨/雪与晴空/黄昏/夜空天空盒(`docs/capabilities.md`),deep 未追平;water/fluid/ocean 零命中。
- GI 未闭环:probe clipmap 是内核不是产品——probe occlusion、屏幕空间补偿、分帧 dirty 更新均在 roadmap P2-04("Deep GI Lite / Lumen Lite")待办;native 无 GI。
- 阴影偏弱:软阴影仅 3×3 comparison PCF,无 VSM/PCSS;无区域光(RectArea)。Unity HDRP/Babylon 已标配 PCSS 级。
- native 侧后处理极简:仅 Bloom+ACES+雾,无 SSAO/TAA/OIT/native README 自认的"多级 Bloom 金字塔、OIT 尚未完成",与 Web 侧画面对齐是明确欠账。

### 第三档:物理与 VFX 空白

- 无物理引擎:刚体、碰撞、布料、流体、IK 全部为零(Babylon 有 Havok 插件、Unity 有 PhysX);Three 侧 IK 也只是 planned(ANI-06)。
- 粒子是"演示件"不是"工具链":无发射器编辑、无流场/curl noise、无拖尾、无粒子碰撞、无序列帧。对比 Unity VFX Graph/Babylon GPU 粒子是工具链级差距;不过告警脉冲/扩散环/流线三个预设恰好覆盖数字孪生基础动效(对标 ThingJS 的告警呼吸灯+扩散环+飞线),该场景够用、通用 VFX 不够用。
- native 完全没有蒙皮/morph/动画播放(P1-02"原生 3D 对齐动画"列为剩余任务)。

### 第四档:大模型能力"有零件无整车"(自审文档明示)

- LOD/meshlet/Hi-Z 遮挡剔除/indirect draw/octree/chunk streaming/驻留预算**全部存在但未合流接入正式场景**——`deep-engine-webgpu-remaining-plan-2026-09-14.md` P0-10/P0-11 自认。
- native 显式拒绝绝对坐标 >1e6 的场景,floating origin 未实现(native README),BIM 级大坐标场景进不来。
- deep 无 BIM 构件语义/属性面,IFC 属性树全在 Three 侧与转换器层(`docs/converter-plugin-and-format-support.md`)。
- audit 未开始清单还包括:动态 LOD residency、Hi-Z history、indirect 扩容、自动质量档位、独立 perf gate JSON。
- **结论:"百万面/千级构件"目前是组件级证据,不是产品级能力。瓶颈不在算法,在合流。**

### 第五档:独立客户端外壳与资产覆盖

- native viewer 只吃版本化 RenderPacket/Runtime Package:不接受裸 GLB,无纹理解码、压缩纹理、自动 mip、流式(native README"尚未完成"清单)。
- 文字系统薄弱:无 SDF(src 零命中),文字依赖 host 预烘焙 glyph atlas;动态 shaping/中文 fallback/bidi 明确未实现(D05,cosmic-text 候选未获准入);中文 IME 文件已出现但未验收。
- retainedUi 只有 TS 合同 v1 与 native reader/validator,layout/paint/event 未长出;deep2d 是 2D 底座不是 3D 内文字;D03/D04/D09(deep2d 支持矩阵)明确未实现。
- 材质覆盖窄:glTF 扩展只认 `KHR_materials_emissive_strength`(`gltf/materialExtensions.ts` 显式拒绝其它),clearcoat 仅 authoring 层有、glTF KHR clearcoat 不解析,sheen/transmission/iridescence 无——Babylon/Three 已全量支持。
- 无安装器/签名/自动更新/离线资源包;完整 Native Viewer 按 roadmap 在 P1 之后(2026 末),原生编辑器在 2027——与 Unity/Babylon/商用数字孪生平台的"开箱即用"差距是阶段性的。

## 四、追赶优先级建议

1. **先合流、后增能**:P0-10/11(LOD/剔除/流式合流进正式场景)杠杆最大——把已有内核变成真实大模型能力,直接决定"能不能承载 BIM 级场景"。
2. **交互层最小集**:轨道相机+GPU/BVH 拾取+选择高亮+Web 剖切平面,是 deep 从"渲染核"变"引擎"的入场券;量级不大,缺了什么都演示不了。
3. **氛围层补齐性价比最高**:体积雾/程序化天空/日夜循环均为 shader 层工作,与既有 Bloom/ACES 栈衔接顺畅,对标山海鲸"空气感"见效最快。
4. **顺势项**:SSR 与 Motion Blur(TAA motion 向量已在)、软阴影升级 PCSS、GI 走完 P2-04 闭环。
5. **最后**:物理与通用粒子编辑器——数字孪生场景当前依赖度低,可先用外部库过渡,不阻塞前四项。

## 五、与产品现有计划的关系

- 本文只评估引擎层差距,不重复 `docs/platform-gap-analysis-2026-09-09.md` 的产品平台层结论(云渲染入口、一键启动、脚本工作区等),两份文档互补。
- 排期上不新开需求:第一档与第四档已被 P0-10/P0-11 与后续 P1/P2 覆盖,本文的作用是给这些项一个"对标水位"参照,防止合流后只达"能跑"不达"可用"。
- 若需要,后续可为每一档补"验收口径"(如:剖切至少支持单平面交互式拖动+阴影参与、拾取在 50 万面场景 P95 < 50ms 等),另立文档。
