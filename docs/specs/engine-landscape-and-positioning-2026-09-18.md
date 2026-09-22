# 引擎版图盘点与系统定位(现实编译器)— 2026-09-18

> 状态:战略研究稿,定位结论待用户拍板后转正式口径。
> 范围:Unity 6 系列 / UE5 系列 / Three.js / Babylon.js 的版本盘点与路线图、对我方的高价值新项提炼、
> 对标可行性分层结论、系统定位建议。
> 可信度分层:版本事实与功能清单来自官方发布页/文档/官方博客(可信);发布时间窗与"最后大版本"类
> 判断含社区转述成分(按信号处理);我方现状引自 2026-09-15 源码取证(见附录),与竞品水位分开标注,
> 不得混作验收依据。

---

## 1. 四家版本盘点(截至 2026-09-18)

### 1.1 Unity 6 系列:已进入 6.4/6.5 交替期,Unity 7 在地平线上

| 版本 | 时间 | 关键内容 |
|---|---|---|
| Unity 6.0 (6000.0) | 2024-10 | GPU Resident Drawer、GPU Occlusion Culling、STP 时域后处理、Adaptive Probe Volumes,Web 导出运行时 |
| Unity 6.1 | 2025-04 | 稳定性与工作流打磨版 |
| Unity 6.2 | 2025-08 | **Unity AI 套件**(生成式代码/美术),Muse 与 Sentis 被合流取代 |
| Unity 6.3 LTS | 2025-12 | Face Tracking、Object Trackables、自动动态分辨率、"3D as 2D" 工作流 |
| **Unity 6.4** | **2026-03** | **ECS 转为核心包**、Project Auditor 默认内置、独立工具 Unity Studio 发布、Grid/Snap 重做、地形着色与 Mesh LOD 工作流、Matchmaker 升级 |
| Unity 6.5 | 开发中(破坏性变更清单 2026-03-27 更新) | 编辑器 UI/导航栏/状态栏 API 新体系 |
| Unity 6.7 / 6.7 LTS | ~2026 Q4 / 年底 | Built-in 管线最后堡垒,保留至 6.7 LTS |
| **Unity 7** | **2026-12 early beta,2027 初正式** | 主打更快迭代、连通性、工具现代化;承诺不破坏现有工程 |

### 1.2 UE5 系列:5.7/5.8 双发后进入 UE6 静默期

| 版本 | 时间 | 关键内容 |
|---|---|---|
| 5.5 / 5.6 | 2024-11 / 2025 年中 | MegaLights、硬件光追 Lumen 增强 |
| **UE 5.7** | 2025 年末(5.7.1 热修已发) | **PCG 程序化内容生成生产就绪、Nanite Foliage、Substrate 次世代材质体系正式、MegaLights 扩容、MetaHuman 深度集成** |
| **UE 5.8** | 2026-05/06(State of Unreal 2026) | **Mesh Terrain、Procedural Vegetation Editor、Control Rig Physics、MetaHuman Crowds、Lumen Lite、Unreal MCP 插件、着色器编译提速** |
| **UE6** | **2027 年底 Early Access,全量 2028–2029** | 平台愿景:live-service 开发流线化;桥接期用 Unreal MCP、Generative AI Node Graph 过渡 |

社区判断(信号,非官方承诺):**5.8 可能是未来 16–18 个月最后一个大功能版本**,Epic 主力已转向 UE6。

### 1.3 Three.js:节奏放缓为季度版,r186 为当前版

发布轨迹:r183(2026-02-20)→ r184(2026-04-16)→ r185(2026-07-01)→ **r186(2026-09-08)**。

- **r183**:BezierInterpolant、Object3D `pivot`/`static` 属性、反向 Z 基础支持、per-attachment MRT 混合
- **r184**:**HTMLTexture**(HTML 直接入 3D)、WebGLRenderer 的 **NodeMaterial 兼容层**(新旧渲染器合流开始)、compileAsync 真非阻塞、**TSL 编译性能提升 3 倍**
- **r185**:**WebGPU 上的 WebXR**、ExternalTexture、纹理数组渲染、foveateBoundTexture
- **r186**:**SunLight + 级联阴影(CSM)**、MeshPhysicalMaterial 逆反射、WebGPU WebXR MSAA、DirectRenderPipeline、`compileComputeAsync()`

大方向:TSL 节点材质成为唯一着色语言;WebGLRenderer 正在通过兼容层被 node 体系吸收——
**新旧渲染器合并是既定路线**。

### 1.4 Babylon.js:9.0(2026-03)是 WebGPU compute 的一座里程碑

8.0(2025)完成全部核心着色器 GLSL+WGSL 双端口,WebGPU out of the box;9.0 在此之上:

- **Clustered Lighting**:分簇光照,WebGPU 与 WebGL2 上支持成百上千盏灯
- **Frame Graph v1**:DAG 渲染管线 + Node Render Graph Editor,官方称部分场景 GPU 显存省 40%+
- **Node Particle Editor**、Particle Flow Maps、体积光(WebGPU compute,WebGL2 回退)
- Textured Area Lights(带贴图的区域光)
- 动画重定向 + 无代码重定向工具
- **高级 Gaussian Splatting**(.PLY/.splat/.SPZ/.SOG、三角 splat、投影、多 splat 全局排序,Adobe 参与贡献)
- **Geospatial Camera**(球面行星相机,原点即地心)——明确瞄准地理空间场景
- Part 3 覆盖 **OpenPBR** 材质标准

---

## 2. 跨四家高价值新项提炼(按对我方 BIM/数字孪生场景的价值排序)

1. **多灯规模化**(UE MegaLights / Babylon Clustered Lighting)——楼宇夜间照明、厂房灯阵是数字孪生刚需,Web 端至今没有便宜方案。
2. **GPU 驱动渲染与渲染图**(Unity GPU Resident Drawer / Babylon Frame Graph)——Babylon 的 Frame Graph + 显存账本模式,与 Deep Engine 已有但未合流的 GPU LOD/meshlet/Hi-Z/indirect 零件是同族工程,直接可对标。
3. **材质语义标准化**(UE Substrate / Babylon OpenPBR / Three TSL 全面化)——工业 PBR 材质描述正在收敛到统一标准;我方 glTF 扩展只认 `KHR_materials_emissive_strength` 的现状会被甩开。
4. **AI 原生编辑器**(Unity AI 套件 / Unreal MCP + Generative AI Node Graph)——两大引擎都把 MCP 接口和生成式图编辑当下一代编辑器骨架。**引擎正在变成 agent 可操作的引擎**,这是全表最值得注意的信号。
5. **程序化大世界**(UE PCG + Nanite Foliage + Mesh Terrain)——园区级外部环境(地形/绿化)生成,对 BIM 场景是外围能力,中等优先。
6. **级联阴影**(Three r186 SunLight CSM)——建筑日照分析、大园区场景阴影质量的直接答案,恰是我方 3×3 PCF 的痛点同族。
7. **地理空间相机与 floating origin**(Babylon Geospatial Camera)——地球级数字孪生前置件;我方 native 端拒绝绝对坐标 >1e6、floating origin 未实现的缺口正好在此。
8. **Splat 纳入引擎标准件**(Babylon 9)——业界已把它当普通资产类型。用户已决策不引入,仅作水位参照。
9. **HTML-in-3D**(Three HTMLTexture)——BIM 构件信息牌、富文本标注的官方新路径。

---

## 3. 对标可行性:分层结论

**口径声明(沿 2026-09-15 既定口径):Deep Engine 是挂在 Three 场景图下的渲染后端,不是独立引擎。
比"引擎层"是苹果比橘子;公平的引擎层对标对象是 Three `WebGPURenderer` 与 Babylon WebGPU 后端。
任何能力盘点/性能基准/画质验收,先声明按哪一层比。**

### 3.1 引擎层:不可能,也不应该

Unity 与 UE 各自是二三十年、每年数亿美元研发的积累。把 Deep Engine 拿去比 Unity 7 的编辑器或
UE 5.8 的世界构建,结论只有自取其辱。架构事实是:场景图/相机/输入/拾取/物理全部归 Three + Rapier,
Deep 只负责"画"这一步——它本来就是渲染后端。

### 3.2 渲染后端层:可以,是唯一公平的对标层

公平对手:Three `WebGPURenderer`、Babylon WebGPU 后端。我方真实位置(2026-09-15 源码取证,详见附录):

- **真材实料**:TAA 是教科书级实现(全分辨率 HDR 历史、运动重投影、深度拒绝、YCoCg 钳制);
  GTAO + Bloom + ACES + Vignette 齐备;WGSL compute 有基础设施。
- **覆盖面差距**:后期栈 6 项对 Babylon/Unity 的 20+ 项;体积雾/SSR/体积光/区域光全缺;
  阴影滤波仅 3×3 PCF——对照 Three r186 刚上的 CSM 与 Babylon 分簇光照,差距在被拉大。
- **最痛的不是缺算法,是零件未合流**:GPU LOD/meshlet/Hi-Z/indirect/octree/chunk 流式都有代码
  但未进正式场景。对照 Babylon Frame Graph 的发布方式——他们把同类零件用一张 DAG + 显存账本
  串成产品特性发布了,我方还在零件库阶段。

**结论:渲染后端层 95% 水位可达,次序是"先合流、再补氛围层最小集、后补灯光规模化",
不逐项追平清单。**

### 3.3 战略窗口

Unity 7 要 2027 年初、UE6 要 2027 年底才 Early Access——**2026H2 到 2028 是两大引擎的世代交替
静默期**(老用户迁移痛苦、新能力真空),而 WebGPU 在 Chrome/Edge/Firefox 已全绿。
**这 18 个月是 Web 端渲染栈拉近身位的最好窗口。**

---

## 4. 系统定位:两个选项都不要,占第三个空位

### 4.1 对两个候选名的判断

**"数字孪生平台"——委屈了我们,且是红海。** 山海鲸、优锘、帆软、51WORLD 已把"园区大屏+四级钻取"
做成同质化品类;叫这个名等于把自己归入大屏工具,而我方实际在做的(工业格式解析、WebGPU 渲染后端、
素材生产管线)比"平台"这个词深得多。

**"世界模型底座"——伪定位,兑现不了。** 世界模型是 Genie 3/Seedance/World Labs 那批人的战场,
拼训练算力与数据飞轮,我方没有也不打算进(高斯泼溅已决策不引入,Spark 仅保留工程模式阅读借鉴)。
称"底座"会被客户/投资人用 Genie 3 的标准拷问,且承诺兑现不了。

### 4.2 第三个空位:编译端

"世界模型"讨论自己给出的分水岭——**能看的世界 vs 能改的世界**——藏着答案:

- 世界模型是"**看起来对的世界**":统计采样,不保证任何一根梁的坐标是对的;
- 游戏引擎是"**做得出来的世界**":多边形很漂亮,但不认识什么是梁;
- BIM 是人类唯一大规模存在的、**说得清的世界**:毫米级几何 + 构件语义 + 规则 + 数据绑定,
  可验收、可追溯、可改。

三个端:世界的**运行端**(引擎,Unity/UE 在做)、世界的**生成端**(世界模型,Genie 在做)、
世界的**编译端**(把工程行业的"源代码"——RVT/IFC/X_T/STEP/DWG——编译成人能用、agent 也能用的
运行时世界)。**编译端天然没人占。**

**一句话定位:Unity 编译游戏,我们编译现实。Reality Compiler(现实编译器)。**

Deep Monkey Studio = 把真实工程文件编译成可运行、可编辑、可连接数据的活世界的
那层"编译器 + 运行时"。

### 4.3 这个角度刁钻在哪

1. **门槛是两个稀缺能力的交集,所以没人抢。** 做编译器要求同时懂 Parasolid/IFC 几何内核和
   WebGPU 渲染——搞 CAD 的不懂渲染管线,搞渲染的不懂 BRep。我方恰好两样都在自研,且已经在按
   编译器结构干活:industrial-3d-format 战役的格式解析器 = 词法/语义分析 pass;Deep Engine =
   代码生成 pass;three-mesh-bvh 场景图 = 目标机。**Deep Monkey Studio 其实已经是一个编译器,
   只差承认它。**
2. **世界模型越成功,编译器越值钱。** 生成的世界"好看但不准";AI agent 要操控物理世界
   (检修、巡检、应急推演)时,唯一可靠的 grounding 是语义精确的 BIM 世界。我们不和 Genie 竞争,
   站在它下面:世界模型负责想象,我们负责现实那一份的可验证副本。对应引擎厂商正把 MCP 塞进
   编辑器的动向——**下一代 3D 世界不光给人用,也给 agent 用;agent 需要的是"可读可写可验证"
   的世界接口,这是编译器的输出物,是数字孪生大屏(只读、给人看)给不了的。**
3. **本地离线恰好是对像素流路线的成本对冲。** 云渲染按每用户每秒算力烧钱,我方编译产物是
   本地离线运行的"可执行文件",企业部署成本结构性占优——现成商业论据,不需要编。

### 4.4 执行边界(纪律)

- 本定位先作**内部战略口径与产品语言**("把工程文件编译成可运行的世界");**不主动塞进
  README/对外门面**(2026-09-18 README 叙事撤回的教训);对外叙事载体待用户拍板后再定。
- 不引入 Gaussian Splatting/Spark 依赖(用户 2026-09-18 已决策);引擎对标遵守
  `deep-engine-competitive-baseline` 口径(五家、能力/性能/视觉效果维度、分层声明)。
- 工业格式路线维持自研/开源、内置、本地离线硬门槛(见 `industrial-3d-format-work-plan-2026-09-16.md`)。

---

## 附录 A:我方现状取证摘要(2026-09-15,与竞品水位分开读)

来源:`docs/deep-engine-gap-analysis-2026-09-15.md` + 会话源码核实,细目见记忆
`deep-engine-architecture-positioning`。

- 定位真相:渲染后端而非引擎。Three 画布保留(opacity=0)承接输入,Deep 另建画布叠加;
  场景来源是 Three 的 `projectionRoot()`。
- 产品里 "WebGPU" 有两义:`ViewerEngine.create()` 的 `webgpu` 分支是 **Three WebGPURenderer**;
  Deep Engine 是独立旁路。生产默认仍是 Three WebGL。
- 交互层整层为零(相机控制器/raycast/拾取归 Three + Rapier,属架构分工而非缺失);
  后期栈仅 GTAO + Bloom + TAA + FXAA + ACES + vignette;阴影滤波 3×3 PCF(有 4 档质量分级);
  glTF 扩展只认 emissive_strength;无物理;粒子仅 3 个预设。
- TAA 为教科书级正确实现;引擎的问题不是"做得糙",是**覆盖面窄**。
- 大模型能力"有零件无整车":GPU LOD/meshlet/Hi-Z/indirect/octree/chunk 流式/驻留预算都有代码
  但未合流进正式场景,瓶颈在合流不在算法。
- native 显式拒绝绝对坐标 >1e6,floating origin 未实现——BIM 大地坐标场景进不来,与
  Babylon Geospatial Camera 方向形成正面对照。

## 附录 B:来源

**Unity**
- [Unity 6.4 What's New(官方文档)](https://docs.unity3d.com/6000.5/Documentation/Manual/WhatsNewUnity64.html)
- [Unity 6.4 发布讨论](https://discussions.unity.com/t/unity-6-4-is-now-available/1713245)
- [CGChannel:Unity 6.4 与 Unity Studio](https://www.cgchannel.com/2026/03/unity-releases-unity-6-4-and-unity-studio/)
- [Unity 产品路线图](https://unity.com/roadmap)
- [Unity 6.5 计划中的破坏性变更](https://discussions.unity.com/t/planned-breaking-changes-in-unity-6-5-updated-2026-03-27/1694205)
- [Unity 6 支持策略(含 6.7 LTS/Built-in 管线)](https://unity.com/releases/unity-6/support)
- [Unity 6.2 What's New(Unity AI 取代 Muse/Sentis)](https://docs.unity3d.com/6000.5/Documentation/Manual/WhatsNewUnity62.html)
- [CGChannel:Unity AI in 6.2](https://www.cgchannel.com/2025/08/unity-rolls-out-unity-ai-in-unity-6-2/)
- [Unity 6.3 Beta 公告](https://discussions.unity.com/t/unity-6-3-beta-is-now-available/1680610)

**Unreal**
- [UE 5.7 发布](https://www.unrealengine.com/news/unreal-engine-5-7-is-now-available)
- [UE 5.8 发布](https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available)
- [UE 5.8 Release Notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)
- [The Road to UE6](https://www.unrealengine.com/news/the-road-to-ue-6)
- [State of Unreal 2026 要闻](https://www.unrealengine.com/news/state-of-unreal-2026-top-news-from-the-show)
- [Tom Looman:UE 5.7 性能](https://tomlooman.com/unreal-engine-5-7-performance-highlights/)

**Three.js / Babylon.js**
- [three.js Releases(GitHub,最新 r186)](https://github.com/mrdoob/three.js/releases)
- [Three.js 2026 变化综述](https://www.utsubo.com/blog/threejs-2026-what-changed)
- [Babylon.js 9.0 发布(Windows Developer Blog)](https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/)
- [Babylon.js 9.0(Medium 官方)](https://babylonjs.medium.com/welcome-to-babylon-js-9-0-c3edc9ee6428)
- [Babylon.js 官网](https://www.babylonjs.com/)
- [Babylon 8.0 发布](https://forum.babylonjs.com/t/babylon-js-8-0-is-officially-here/57452)
