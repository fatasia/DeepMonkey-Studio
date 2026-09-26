# Deep Engine 对 Unity 与 Unreal Engine 的能力差距（2026-09-26）

## 现状核查

1. **全仓检索**：检索 `packages/*/src`、`apps/*/src` 的 Unity、Unreal、渲染、动画、物理、发布等关键词，并检查 `git status --short` 的未跟踪项。已有 Unity Bridge 和嵌入组件，它们是互操作能力，不能算 Deep 自身具备 Unity 功能。未跟踪的发布目录及既有 Cocos/Laya 报告保持原样。
2. **合同层**：`packages/contracts/src/scene.ts` 已有场景、动画、物理和发布快照合同；`modelFormatCapability.ts` 有格式 profile 与生产验证规则；`simulationEngine.ts` 有工业仿真端口。已有，不重建。
3. **依赖层**：`apps/web/package.json` 依赖 Three.js、Rapier、ECharts；`packages/deep-engine/package.json` 依赖 Three.js。Native 使用 Rust/wgpu 路线。已有，不因对比增加依赖。
4. **消费方**：`apps/web/src/viewer/`、`delivery/`、`controllers/` 消费场景和发布合同；`packages/deep-engine/src/webgpu/`、`runtimePackage/` 和 `packages/deep-engine-native/src/` 消费 RenderPacket/运行包。`ROADMAP.md` 明确 Three.js WebGL 仍是作者态基线，Deep WebGPU 是可选后端，Native 是独立交付目标。
5. **测试与证据**：Deep/WebGL/WASM 内部配对数据及阶段缺口在 `docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md` 和 `test-output/deep-fair-comparison-*`；渲染、运行包、Native、发布各有测试。未发现同素材、同设备、同质量的 Unity/UE 跨引擎基准。
6. **规格文档**：检查 `docs/specs/`、`docs/handoffs/`、`docs/reports/`、`test-output/`。用户工作区指令提到的工业格式总计划及恢复台账不在当前 checkout 的对应路径；本次只依据现存源码、合同、报告和官方公开资料。

**已有，不重建**：RenderPacket、WebGPU/Native/WASM 桥、PBR、LOD/meshlet、实例/剔除、流送/驻留、探针和后处理、动画/形变、Rapier 物理、2D 看板、工业格式和发布门禁。**真实缺口**：这些能力的统一作者态、跨端产品闭环、生产级广度和跨引擎实测，与 Unity/UE 的完整工具链仍有明显距离。

## 比较基线与证据等级

- **当前版本**：Unity 6.6（Unity 6.7 已有公开 Beta）；UE 5.8。下一代为 Unity 7（计划 2027 年第一季度正式发布）与 UE6（计划 2027 年底 Early Access，正式版再晚 12–18 个月）。UE 5.9 仅保留按需发布可能，不能当作确定版本。
- 本表比较“可由作者编辑、运行、发布并诊断”的产品级能力。源码里存在模块或单元测试，仅表示已有底座，不等于多端生产可用。
- 差距：**大**=缺成体系产品能力或关键交付目标；**中**=已有能力但深度/跨端/证据不足；**小**=工业主任务可用但工具成熟度有差；**待测**=必须做同条件实验，不能凭架构判断。
- 所列为引擎栈的主要能力域，不把 Unity/UE 的所有 API、每个插件和每个实验特性当成独立条目。Beta/Experimental 在下文明确标记。

## 全栈差距清单

### A. 渲染、几何与大场景

| # | 能力域 | Deep 当前事实与对 Unity/UE 的差距 | 等级 |
| ---: | --- | --- | --- |
| 1 | 多图形后端与统一渲染合同 | WebGL 作者态、Deep WebGPU/WASM/Native 已有；跨后端作者操作、视觉、运行包语义仍未全量一致。Unity 的 URP/HDRP 和 UE 的多平台渲染路径更成熟。 | 中 |
| 2 | PBR、材质模型与 Shader | 有 PBR、材质/Shader IR、图形化作者入口；与 Unity Shader Graph/HDRP、UE Substrate/Material Editor 的节点生态、特殊材质和跨平台变体相比，产品广度不足。 | 中 |
| 3 | 动态全局光照与反射 | 有探针、近似 GI、SSR 等；缺 Lumen 级动态场景覆盖、质量档和已验证的大规模跨端运行。Unity 6.7 的 Surface Cache GI 也会提高基准。 | 大 |
| 4 | 硬件光追与离线路径追踪 | 有射线能力探测、实验路径；不能据此宣称已具备 UE Path Tracer 或 Unity HDRP 的生产级 RT 效果、降噪与编辑闭环。 | 大 |
| 5 | 灯光与阴影 | 有多光源、阴影、IES 和缓存；与 UE 5.8 已生产可用的 MegaLights、虚拟阴影和多灯可视化调试相比，规模、画质和工具仍有距离。 | 大 |
| 6 | 虚拟化几何 | 有 meshlet、LOD、Hi-Z、间接绘制和驻留；不是 Nanite 等价物。任意高模直接导入、自动簇层级、流送、变形/透明边界和稳定帧时间未同级验收。 | 大 |
| 7 | 虚拟纹理与纹理流送 | 有纹理资源、数组打包和预算控制；缺类似 UE Virtual Texturing 的完整作者、打包、页缓存、反馈与跨端诊断流程。 | 中 |
| 8 | 大世界分区 | 有 world partition/chunk、重定位和资源驻留模块；预测预取、快速转身稳定性、世界编辑工具与 UE World Partition/HLOD 的生产经验仍有差。 | 中 |
| 9 | 地形、植被、PCG | 未见类似 Unity Terrain 或 UE Landscape/PCG 的完整地形绘制、植被生态、程序化作者工作流；UE 5.8 Mesh Terrain 与植被编辑器仍是 Experimental。 | 大 |
| 10 | 粒子与视觉特效 | 有 GPU 粒子/后处理底座；与 Unity VFX Graph、UE Niagara 的模块、事件、调试和特效作者生态差距大。 | 大 |
| 11 | 体积效果、云、水和天气 | 有雾/体积雾、天气和环境效果；统一光照、动态水体、复杂云层及大范围质量伸缩未见同级闭环。 | 中 |
| 12 | 时域重建与超分辨率 | 有 SMAA/FXAA 等与部分空间抗锯齿；缺成熟 TAA/TSR、DLSS/FSR/XeSS 及即将出现的神经升尺度统一方案。 | 大 |
| 13 | HDR、色彩管理和电影级输出 | 有 ACES/PBR/后处理配置；相机曝光、HDR 显示输出、色彩管线、离线高质渲染和镜头级一致性仍需系统验收。 | 中 |
| 14 | 帧性能 | 内部基准显示 Deep WebGPU 静置已追平 WebGL，但输入帧 P95、切后端首帧仍落后；没有 Unity/UE 配对数据。GPU/CPU/内存/画质整体优劣均待测。 | 待测 |

### B. 动画、物理、音视频与交互

| # | 能力域 | Deep 当前事实与差距 | 等级 |
| ---: | --- | --- | --- |
| 15 | 基础动画与时间线 | 有模型 Clip、对象/相机关键帧、插值、状态机和形变；与 Unity Timeline/Animation Rigging、UE Sequencer/Control Rig 在剪辑、混合、曲线、层、调试方面仍有差。 | 中 |
| 16 | 骨骼、重定向与程序化动画 | 有 glTF skin/morph 和 GPU 形变底座；未见成熟 IK Rig、重定向、motion matching、实时程序化角色控制整链。 | 大 |
| 17 | 数字人与动作捕捉 | 未见 MetaHuman/Unity 角色生态同级的人体、面部、布料、实时 mocap、群体角色生产流程。 | 大 |
| 18 | 刚体与碰撞 | Web 作者路径已有 Rapier；Native 物理与发布消费有模块，但跨后端稳定等价、复杂约束和真实窗口证据仍不足。UE Chaos 及 Unity 物理工具更完整。 | 中 |
| 19 | 布料、毛发、软体、流体、破碎 | 未见 UE Chaos Cloth/Destruction/Fluid/Hair 或同级可编辑、可缓存、可运行的综合物理体系；UE 5.8 Cloth 已 Production Ready。 | 大 |
| 20 | 角色控制与导航 | 有漫游、碰撞、地面跟随和导航模块；Native 的三角碰撞、坡度、步高、重力、跳跃、第一/第三人称尚缺真实场景闭环；复杂 NavMesh、群体寻路也不足。 | 大 |
| 21 | 输入系统 | 鼠标、触屏及场景交互已有；统一动作映射、手柄、设备热插拔、重绑定、跨平台调试与 UE Enhanced Input/Unity Input System 差距明显。 | 中 |
| 22 | 空间音频、混音与视频 | 有 Web 音视频及 Native 解码/合成路径；Native 音频输出、seek、同步和完整播放控件尚缺。与 UE MetaSounds、Unity Audio Mixer/Video 的作者与调试流程有差。 | 大 |
| 23 | XR | WebGL 路径有 WebXR 入口；与 Unity/UE 的 OpenXR、Quest、Android XR、visionOS、控制器/手势和设备性能工具链不在同一成熟度。 | 大 |
| 24 | 电影叙事与虚拟制片 | 有相机/对象时间线；缺 UE Sequencer、Movie Render Graph、Live Link、nDisplay、虚拟摄像机和镜头协作的系统。 | 大 |

### C. 作者工具、内容管线与开发效率

| # | 能力域 | Deep 当前事实与差距 | 等级 |
| ---: | --- | --- | --- |
| 25 | 场景编辑器 | 对象树、gizmo、材质、测量、剖切等已具备；Deep 纯编辑输入/拾取/撤销/保存/重开尚需贯通，Three 仍是基线。 | 大 |
| 26 | 预制体与可重用组件 | 有工业预制体与参数；与 Unity Prefab Variants、UE Blueprint 类体系的嵌套继承、覆盖传播、冲突解决和内容库成熟度有差。 | 中 |
| 27 | 可视化逻辑 | 有交互流、脚本、受控命令；与 UE Blueprint、StateTree 及 Unity Visual Scripting 在节点广度、调试、热更新、可复用图资产方面有差。 | 中 |
| 28 | 脚本运行时/API | 有 `studio.*`、Worker 沙箱及插件合同；与 Unity C#/.NET/Burst/Jobs/ECS、UE C++/Blueprint/Verse 生态相比，运行时、工具与第三方库广度不足。 | 大 |
| 29 | 资源导入和再导入 | 有模型转换、来源/哈希和 LOD 处理；与成熟 DCC、材质、骨骼、贴图、多格式资产再导入及增量 cook 管线相比，覆盖和可靠性有差。 | 中 |
| 30 | 资产烘焙、构建与包体 | 有本地减面、贴图压缩、光照烘焙、发布包；跨 Web/WASM/Native 的烘焙结果消费和内容分阶段加载未完全闭环。Unity 6.6 已增加内容目录与 Web 渐进资产加载。 | 中 |
| 31 | 编辑迭代速度 | 有缓存/增量编译与浏览器热更新；没有 Unity 7 计划中的 CoreCLR、细粒度代码重载、近即时 Play Mode、Shader 快速构建等同级统一作者体验。 | 大 |
| 32 | 性能分析与调试 | 有遥测、帧捕获、性能门禁；与 Unity Profiler/Frame Debugger、UE Unreal Insights/RenderDoc 集成在 CPU/GPU/流送/内存/网络的关联诊断方面有差。 | 中 |
| 33 | 自动化、回归与崩溃诊断 | 仓内单测、浏览器/Native 门禁丰富；缺多硬件、多系统、大量真实用户内容的兼容矩阵及成熟崩溃符号、回放、错误聚合。 | 中 |
| 34 | 协作与版本控制 | 有项目权限、版本、AI 编辑会话；不等于 UE OFPA/多用户协作或 Unity Studio 实时多人同场编辑与资产管线。 | 大 |
| 35 | 内容生态 | 有模型和模板库；与 Unity Asset Store、Epic Fab、官方样例、第三方插件/开发者规模相比差距大。 | 大 |
| 36 | 2D 游戏与通用 UI | 有专业看板和保留式 UI；缺 Sprite/Tilemap/2D 动画/2D 物理、通用游戏 HUD、布局/输入/本地化完整框架。工业看板是不同优势，不等于游戏 UI 全覆盖。 | 大 |
| 37 | 可访问性与本地化 | 有中英文、部分 Native UIA；跨端屏幕阅读器、键盘/手柄导航、字幕、颜色辅助、文本排版等仍缺系统级覆盖证据。 | 中 |

### D. 运行、平台、网络与工业交付

| # | 能力域 | Deep 当前事实与差距 | 等级 |
| ---: | --- | --- | --- |
| 38 | 平台覆盖 | Web/Windows/Android 等交付路径已有；iOS、macOS/Linux 原生、主机平台、嵌入式与 XR 设备矩阵明显不足。 | 大 |
| 39 | 多人运行时与实时复制 | 有 WebSocket、设备数据和编辑 presence；未见 Unity Netcode/Services 或 UE Iris/Replication 同级的多人状态复制、预测、回滚、专用服务器和运维。UE 5.8 Iris 已面向 licensees 生产可用。 | 大 |
| 40 | 热更新与长期在线运营 | 有发布版本、回退和资源哈希；缺游戏级内容补丁、用户分群、会话迁移、在线世界持久化及跨区域运行维护体系。 | 中 |
| 41 | 云渲染/浏览器触达 | 有 Web 本地渲染与可选云渲染；UE Pixel Streaming 2 有成熟 WebRTC 交互及平台支持。两者成本与场景不同，必须按并发、延迟和总成本配对测。 | 待测 |
| 42 | CAD/BIM 格式 | 有自研/开源、本地离线工业格式路线及 profile 验证；UE Datasmith 官方已列 STEP、IFC、JT、X_T、多个 CAD/BIM 源的直接/插件导入，且标注支持等级。不能笼统说我们格式更全。 | 中 |
| 43 | 工业数据与语义 | 稳定构件 ID、设备信号、数据集、看板、仿真和发布合同是已有产品优势；Unity Industry/Studio 与 UE Datasmith/行业方案也在该市场。优势必须以端到端交付成本、离线约束和审计证据证明。 | 待测 |
| 44 | AI 作者工具 | 工业对象上下文、受控写事务、MCP 和审计已有；Unity 7 规划 CLI/MCP/API，UE 5.8 已有 Experimental MCP，UE6 计划扩展。AI 接口本身不再是独占壁垒。 | 中 |
| 45 | 许可与可分发性 | 本项目当前为 source-available DMCSL-1.0，README 的 MIT/开源措辞与 LICENSE 冲突；这不是画质差距，却会影响 SDK 采用、商业采购及生态增长。 | 中 |

## 下一版本：已公开事项如何改变差距

| 路线 | 官方公开进度与能力 | 对我们的影响 |
| --- | --- | --- |
| Unity 6.7 LTS | 2026-09-17 已公开 Beta；官方演示 URP Surface Cache GI、SSR/GTAO，计划广泛进入 6.7 LTS；Fast Build Profile、PSO 预热和 Unity Neural 开始推进。仍须按最终发布逐项核实。 | 动态光照、WebGPU、构建和迭代速度的对标水位上升；不能再把“WebGPU + GI”当差异化。 |
| Unity 7 | 官方目标 2026 年 12 月早期测试、2027 年第一季度正式版。计划 CoreCLR/.NET 10/C# 14、近即时 Play、局部代码重载、CLI/MCP/公开 API、神经升尺度与跨设备高质量渲染；具体功能和时间可变。 | 作者效率、AI 代理接入和画质继续拉开通用引擎差距；工业平台也可能受 Unity Studio/资产管线推动。 |
| UE 5.8 | 当前已发布；MegaLights、Chaos Cloth、Movie Render Graph、Live Link Hub 等宣布 Production Ready；Lumen Lite 为 Beta，Mesh Terrain、MCP、Sandboxes 等为 Experimental。 | 现在的 UE 已在高质量渲染、角色、虚拟制片、大世界和工业导入方面显著领先；不能把实验项算成熟交付。 |
| UE6 | 官方目标 2027 年底 Early Access，正式版约再晚 12–18 个月；计划 UE5/UEFN 合一、Verse + Scene Graph、持久大规模世界、跨游戏/引擎互操作、glTF/USD 一等支持、MCP；分布式事务内存仍属研发目标。UE 5.9 只是可能发布。 | AI、协作、持久世界和开放资产标准的竞争压力会增加；目前不能按已交付能力计分。 |

## 优先级判断

**P0：必须做成产品闭环**

1. Deep WebGPU 纯编辑：选择、gizmo、材质、动画、撤销、保存、重开、发布；消除 Three 作者路径残余的重复遍历。
2. 真实工业样本的导入与语义保留：每个格式只宣传已验证 profile，记录层级/属性/PMI/几何损失、哈希与转换性能。
3. Web/WASM/Native 对同一运行包的视觉、数据、动画、物理和失败语义一致；补 Native 导航、媒体、烘焙消费。
4. 固定 3 类场景与输入轨迹，和 Unity/UE 做同设备、同画质、同功能的首帧、P95/P99、内存、包体、交付人时比较。

**P1：形成针对工业的可验证优势**

5. 告警→定位→历史回放→分析/仿真→处置→发布的实际闭环，并验证断网、自托管、权限与审计。
6. 大 BIM/工厂的资源预取、LOD/驻留和跨端测量/拾取；持续追踪输入延迟与视觉一致性。
7. 稳定的插件 SDK、示例工程、文档和版本迁移，降低第三方交付成本。

**P2：明确有客户需求再扩张**

8. 高级角色动画、布料/流体、数字人、地形植被、完整游戏多人栈、主机平台、虚拟制片等。复制 Unity/UE 全量能力的投入无法由当前工业主流程证明。

## 来源与验证范围

- 本仓：`ROADMAP.md`；`README.md`；`LICENSE`；`packages/contracts/src/scene.ts`、`modelFormatCapability.ts`；`packages/deep-engine/src/`；`packages/deep-engine-native/src/`；`docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md`；内部配对测试输出。此次为只读源码审计和文档分析，未运行构建或跨引擎性能测试。
- Unity 官方：[6.6 新功能](https://docs.unity.com/en-us/engine/6000.6/manual/whats-new/unity66)、[6.7 Beta 公告](https://discussions.unity.com/t/unity-6-7-beta-is-now-available/1736830)、[Unity 7 计划](https://unity.com/releases/unity-7)、[Unite Seoul 2026 技术说明](https://unity.com/blog/unite-seoul-keynote-2026-recap)。
- Epic 官方：[UE 5.8 发布](https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available)、[UE 5.8 详细说明](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)、[UE6 路线](https://www.unrealengine.com/news/the-road-to-ue-6)、[Datasmith 格式与支持等级](https://dev.epicgames.com/documentation/unreal-engine/datasmith-supported-software-and-file-types)、[Pixel Streaming](https://dev.epicgames.com/documentation/unreal-engine/pixel-streaming-in-unreal-engine)。
