# Deep Engine：方案复审、调整与执行基线

日期：2026-09-12。状态：本轮待办持续推进；基础合同与独立 WebGPU 材质首帧已实现，完整项目平替尚未验收。

2026-09-13 范围更新：当前集中交付保留极致性能、Browser WebGPU 与 Windows 原生 `wgpu` 主线；macOS、Linux、Android 与 iOS 全部删除出范围。现有编辑器继续作为作者工具，不新建一套原生编辑器。Unity 包/Web 构建迁移兼容、长尾格式新解码器、重型光追、UE 全套虚拟几何、Three 插件逐个兼容和复杂 Shader Graph 产品均删除出默认路线。

优先级更新：P0 为 RenderPacket、真实模型/纹理、完整基础画质、性能和 Browser 交付；P1 为 Nanite Lite、Deep Lights、GI Lite 与轻量烘焙；P2 统一包含轻量 Shader 工具链、Three 高频兼容、无感切换、Windows 原生客户端、Deep2D/GUI/图表/Host、统一资产包和 Windows 发布。这些 P2 项是战略必做项，依赖满足后并行推进。

用户后续决策覆盖原 Orillusion 引入方案：开源引擎用于研究和吸取实现经验，Deep 自主实现核心；实验期间不得影响现有项目正式环境。Deep 路径只实现 WebGPU/wgpu，不提供 WebGL 回退。最终客户端完全原生，GUI、图表、文字、HUD 和 3D 都由同一 `wgpu` 设备执行，不携带 WebView、Three/Babylon、React/ECharts 运行时。旧作者对象与脚本只在隔离迁移桥中读取，不能成为原生内核的数据模型。

本文接续“规划自研 WebGPU 引擎方案”任务，优先于旧路线中关于实施顺序、兼容实现、性能判定的建议。
来源是用户在两个任务中的明确决策，以及当前源码、测试和上游固定版本审计。没有改变现有产品默认渲染路径。

第一原则：以最终目标和可验证事实纠正局部方案。新增能力前必须先核对当前依赖版本、标准/官方能力、仓库已有实现和真实证据；能复用、配置或接线就不重写，只为被证明的缺口新增代码。发现用户设想、旧计划或当前实现之间存在目标互斥、性能包袱、兼容风险或更优路线时，必须直接指出并修改方案，不能机械照做；正式环境保护仍是不可突破的约束。

## 1. 不变的目标

- 自研核心，参考 Orillusion 等多家实现，最终性能与能力超过 Three.js、Babylon.js。
- 对 Unity、UE5、Godot 只对标本项目保留的高价值能力矩阵并争取 ≥90%；因已删除重型 RT、UE 全套虚拟几何、复杂 Graph 与跨平台矩阵，不再宣称三款完整引擎总体能力 90%。
- 用户补充：默认视觉效果和性能原生以 Unity/UE5 为对照，从渲染管线和默认配置实现，不依赖单个示例手调。质量、功能和性能分别验收，不能用缺少 GI/反射等工作负载换取领先数字。
- 性能、轻量、完整度同时约束。Three 语法兼容面是项目实际使用、文档承诺及真实脚本，不复制未使用的全部 Three API。
- 现有正式 Studio 在迁移期提供“自研引擎 / Three.js”一键切换，以同一作者状态验证项目兼容；相机、选择、草稿、脚本闭包、动画与仿真连续。最终纯原生客户端只包含 Deep，不能为了切回 Three 把 WebGL/WebView/JS 运行时重新打包进去。
- Three 兼容门槛只覆盖本项目高频标准对象/材质、loader、控件、BVH、动画和明确使用的 P0 插件；逐插件生态扩张、raw WebGL、任意 GLSL 与 renderer 私有 hook 删除，只保留结构化 unsupported report。详见 [高频兼容门槛](deep-engine-three-plugin-compatibility-2026-09-12.md)。
- 原生客户端不携带 WebView/Chromium/Electron/Tauri 前端；Rust + `winit + wgpu` 是基础设施边界，不宣称图形 API 或操作系统也完全自研。
- GUI、图表、文字、节点画布和 HUD 全部进入 Deep 自有 WebGPU/wgpu 管线；外部 GUI/图表项目仅作算法和测试参考。
- 新引擎只把 glTF/GLB 做成原生纵向切片；旧 Studio 的既有格式入口保持原状，高频 IFC/CAD/机器人输入仅复用现成 converter/provider，不为长尾扩展名新建 decoder。
- 当前采用独立实验包。正式切换门禁通过前保护已有项目、数据、账号与脚本；用户已授权 Codex 在门禁通过后自主管理 commit/push，禁止强推。

## 2. 原方案有哪些问题

| 问题 | 核验依据 | 调整 |
|---|---|---|
| 骨架尚未通过基础检查 | 接手时 8 个 TS 诊断、17 测试中 2 项失败；追加 10 个行为用例全部复现缺陷 | 先修正确性，再接 GPU；不能把“写了文件”当阶段完成 |
| 独立 facade 重造成本过高 | 脚本注入完整 THREE、engine；studio.raw 暴露 live scene/camera/renderer | 迁移期 Web adapter 可读取固定版本 Three 作者状态；原生运行时使用 Deep 文档/场景合同，按 golden 行为迁移，不链接 Three |
| 只数类名无法证明平替 | 动态属性、别名、raw 逃逸、实例方法、闭包、第三方 loader 均跨过静态类名边界 | AST 来源清单与运行时语料、合同用例分别建账；未核验统一标记 unverified |
| 快照恢复无法保证无感切换 | 闭包保留 Object3D/Material/renderer 引用，重新反序列化会换 identity、重置事件与动画 | 同一份作者状态、同一脚本宿主，交接渲染后端；快照仅用于灾难恢复 |
| Orillusion 的已有能力被低估 | 固定提交已有多实例 Context3D、dirty compile、生命周期分析和资源池 | 研究其合同与实现；后续用户决策为自主实现核心，不整体引入 |
| 自研 RenderGraph 被误当执行管线 | 当前只是字符串资源 DAG；没有 GPU usage、尺寸、format、subresource、load/store 合同 | 保留为 headless 调度合同；实验 GPU 管线显式编码 pass，后续统一到可执行图，避免两套竞争调度 |
| 每帧 compile 与 GPU-first 被当默认 | 旧 §5.1 写每帧 compile；旧 §7 对简单场景也排 PreDepth/HiZ/Cluster | 结构变化时 compile；普通帧只更新 buffer/uniform；昂贵 pass 按收益启用 |
| 后处理顺序前后不一致 | 旧 §7 将 Bloom、AO、tone mapping、vignette 混排，与视觉规范冲突 | AO 在光照/合成相应阶段，HDR Bloom → Vignette → 色阶 → 一次 tone mapping/输出转换；UI 按显示色语义独立合成 |
| 双引擎同时常驻污染性能比较 | 同时跑旧/新渲染会争抢 GPU、CPU、显存 | 功能影子比对可双开；正式性能 A/B 串行，同条件交替多轮 |
| 原生路线低估脚本宿主 | JS 引擎不自带 DOM、Canvas、媒体、字体、Worker、事件循环 | 建 browser-dependent 能力清单；首发原生 Viewer，再补编辑器，不假设 TS 自动变 Rust |
| 原生竞品事实不准确 | Babylon 有官方 Babylon Native，同 JS 跨平台，当前 public preview | 纳入原生对照，删除“Babylon 无原生方案”的暗示 |
| 预算/胜出判定不充分 | 120/250KB 尚未实测；draw call 减半不能重复领取已有实例化收益；OR 条件可能掩盖劣化 | 拆分内核/兼容/loader/WASM/总加载字节，冻结版本和测试集，以非退化+独立收益判定 |
| “90%”没有可测分母 | 三个引擎能力和平台不同，FPS、画质、工具链不能混成一分 | 三份对照矩阵、三类门禁；缺证据不得得分，缺失能力不可移出分母美化结果 |

事实来源：[脚本宿主](../../apps/web/src/studio/trustedApplicationScript.ts)、[Studio API](../../apps/web/src/studio/studioApi.ts)、
[当前 Three renderer 类型](../../apps/web/src/viewer/viewerRendererTypes.ts)。
上游审计固定在 Orillusion `908fd3d65c8d4b6b4fc11117e3323bee047faa76`，package.json 为 0.9.2；包版本号不能替代 commit。
[Engine3D](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/Engine3D.ts)、
[RenderGraph](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/gfx/renderJob/graph/RenderGraph.ts)、
[Babylon Native](https://github.com/BabylonJS/BabylonNative)。以上是事实；路线优劣是据此作出的工程判断，不是性能实测结论。

## 3. 推荐架构：原生 Deep 主线与旧项目迁移桥隔离

```text
旧 Studio/Three 作者状态 ----> 隔离迁移桥 ----> Deep 文档/资源/行为 fixture
                                                ↓
Deep Native document/session/UI/chart/scene/host
                                                ↓
Deep RenderPacket / Deep2dDisplayList / ChartIR
                                                ↓
同一 wgpu device、资源池、帧图与 surface

Browser WebGPU Lab ----> 共用 WGSL/fixture/合同对照；不进入原生产品包
```

资产输入不直接进入 renderer。`.unitypackage`、UPM、Unity 工程/Scene/Prefab、AssetBundle/Addressables、glTF、BIM/CAD 与机器人格式先经过受限 importer，统一输出内容寻址、可重导入的 Deep Asset Package；随后才编译为运行时 RenderPacket、动画/行为和 metadata sidecar。每种格式分别记录 geometry、hierarchy、material、texture、animation、skin、morph、camera/light、collider/navmesh、metadata/PMI、behavior/audio 的 `verified / partial / unsupported / unverified` 证据。扩展名可选不等于 native-ready。

### 3.1 状态所有权

- 迁移期 Web adapter 以现有作者对象图为唯一权威；渲染数组是可丢弃投影。纯原生产品打开迁移后的 Deep 文档，由 Deep document/session 唯一持有状态。
- `DeepSceneState` 当前用于 headless 状态与失败语义验证，不直接塞进产品形成双向同步的第二套作者树。
- `threeBridge` 只属于开发/迁移工具，必须使用同一模块实例和固定版本；不能让 instanceof、数学类、loader 产物因重复安装漂移。它不得成为 native crate 的依赖。
- 兼容工具实际加载大小单独报告，但不计入纯原生产品包；正式包的依赖门禁必须证明 Three/WebGL/JS GUI 不存在。
- `raw`、Vector/Quaternion/Euler 直接写入、TypedArray 与 needsUpdate 必须遵守原 Three 更新时机。不能靠深层 Proxy 假设捕获所有写操作。
- 提取层先保正确，再优化变化范围；存在无法追踪的 raw 修改时采用保守同步并量测开销，不能漏帧。
- 暂时无法转换的 shader / onBeforeCompile / 原生 GPU handle 不得静默变材质。试验阶段保留旧后端，最终项目 profile 未清零前不认定完全平替。

### 3.2 开源参考与自主实现纪律

参考源码按固定 commit 记证据；若以后迁入代码，保留许可证、原路径和修改说明。当前没有复制上游引擎实现。
自主控制设备生命周期、帧调度、场景提取、GPU 资源、批处理与提交；PBR 使用公开的标准模型，自有 WGSL 实现。
不是把全部成熟能力无差别重写。按功能缺口和 profile 排序，构建可替换的模块；避免先建十几个空包。

Orillusion 审计发现：GPUCullPass 明确输出可见性与间接命令，但 ColorPass 的主要绘制路径仍遍历 CPU 列表，间接绘制接入列为后续；Engine3D 存在共享初始化/帧时钟，初始化预建 reflection GBuffer；Context3D 要求数项可选设备 feature。这些是设计审查证据，不是已经测得的性能差值。

当前 `packages/deep-engine/src/webgpu` 是独立的自研真实 GPU 验证管线：球体实例化、阴影、GGX 材质、线性 HDR 与输出。它尚不是通用模型渲染器，不能用于替换正式项目。`lab:isolation` 检查运行时构建输入与正式 apps 引用，验证页只监听 127.0.0.1:5291，不调用产品 API，不读写项目数据。

### 3.2A Deep Shader 主线

Shader 能力按 Unity 级生产体系建设，而不是停留在若干固定 WGSL：Shader 资产、属性、Technique/Pass、显式渲染状态、typed graph/DSL、关键字和变体裁剪、反射布局、确定性缓存、热重载、调试/Profiler 与离线迁移都是同一主线。Three TSL 的组合方式可作为设计参考，但不进入原生运行时；Deep 只生成 WGSL，不保留 GLSL/WebGL 输出包袱。

创作体验保持“高能力、低样板”：普通材质只暴露 Standard/Unlit 模板和少量属性，高级能力再展开 DeepSL、Technique/Pass、变体和生成 WGSL。现有 Studio 接入轻量参数/文本编写、实时预览、撤销、诊断、热重载、成本与必要 Profiler；不建设复杂 Graph IDE。原生运行包只保留实际使用的 WGSL、反射、Pass 和变体，不携带编辑器、编译器、迁移器或未使用模板。

Unity Standard/URP/HDRP 材质、Shader Graph 和手写 ShaderLab/HLSL 分级迁移。常用语义可自动映射；自定义宏、Unity 内部 include、平台 intrinsic 和未知 graph 节点未验证时必须失败关闭或显式烘焙，不能静默退化。完整合同、批次和八类验收矩阵见 [Deep Shader 执行规格](deep-engine-shader-system-2026-09-12.md)。

### 3.3 原生复用范围

可以共用版本化场景/资源/材质合同、WGSL 资产、fixture 和录制命令；TS 与 Rust executor 是不同实现，必须用同一测试集对照。
窗口输入、IME、剪贴板、字体 shaping、音视频、无障碍、脚本定时器/Promise/调试与超时是显式宿主能力。
QuickJS-ng/V8 仍要用项目真实脚本基准选型，纯 JS 语言兼容不能代表完整浏览器 API 兼容。

### 3.4 WebGPU 验证器与纯原生客户端拆分

浏览器 WebGPU Lab、迁移期旧 Studio adapter、原生 Viewer 和完整原生 Studio 是四个隔离产物。

1. Browser WebGPU Lab：验证真实纹理 glTF、WGSL、资源事务、设备恢复和跨实现 fixture；它只属于开发/测试，不是客户端外壳。
2. 迁移期旧 Studio adapter：在不改变正式默认行为的前提下完成 Three/Deep 一键切换和项目兼容报告；它仍在旧产品包，不进入 Deep Native。
3. Deep Native Viewer：Rust `winit + wgpu` 消费版本化 RenderPacket/资源合同，完成 PBR、资源、输入、文件、网络、诊断和发布查看闭环。
4. 现有编辑器集成：保留已经存在的作者工具，以稳定合同输出 Deep 文档、资源和 shader 包；当前不另造原生编辑器。原生客户端中的运行态 GUI、文字和图表仍与 3D 共用同一 wgpu device/surface。
5. 发布工程：可复现资产烘焙与 shader/pipeline cache、离线资源包、版本迁移、崩溃报告、自动更新/回滚、代码签名，以及 Windows 独立门禁。

React 与 ECharts 只保留为迁移输入：React 组件拆成 `UiState/UiIntent` 与行为 fixture；ECharts option 编译成 `ChartIR`，再由 DeepChart/Deep2D 的 wgpu pass 执行。网络、文件、任务、脚本和媒体统一进入 Rust `HostCapabilities`。详细边界见 [零旧包袱原生客户端架构](deep-engine-native-gui-migration-2026-09-12.md)；资产主线只深做 glTF/GLB，既有高频工业格式复用现成 converter/provider。

原生脚本宿主选型前先运行现有项目脚本语料，分别核验语言、Promise/计时器、Worker、DOM/Canvas、网络、字体和调试协议；不支持的浏览器 API 必须由 native host 实现或进入明确 profile，不能在打包后才发现脚本失效。

## 4. 迁移期旧 Studio 的设置一键切换合同

这份合同用于旧 Studio 的兼容迁移和正式项目保护。Deep Native 客户端不提供 Three 选项，也不包含 WebGL fallback。

1. 点击立即显示准备状态，旧后端继续绘制、脚本与仿真继续执行。
2. 新后端检查项目 profile、设备能力及双后端暂存资源预算；预热纹理、shader、pipeline 和必要资源。
3. 使用同一作者状态准备新首帧。期间记录 revision；交接前跟上最新相机、视口、选择与动态对象，过期帧不能发表。
4. 帧边界原子交接呈现权与输入路由，一次只由一个后端负责提交产品画面。不能复制运行两份脚本或物理世界。
5. GPU 完成已提交工作后退役旧资源。切回反向重复以上过程，状态引用保持不变。
6. 准备/编译失败、超时、设备丢失、取消与连续点击均保留或恢复可用后端；迟到初始化结果必须释放。
7. 只有成功交接后持久化用户偏好；“期望引擎”与“当前可用引擎”分开记录。重启时不恢复不可用实例。

关键细节：WebGL 与 WebGPU 不能假设复用同一个已建立 context 的 canvas。宿主需要暂存 surface 与稳定输入层，待首帧就绪再原子替换呈现。
`studioApi.ts` 当前缓存 raw camera/renderer；未来接入前必须从启动时提供稳定 facade，不能只改一个 getter 让旧闭包继续持有被销毁 renderer。
直接暴露后端私有 WebGL/GPU handle 的用法必须在兼容语料中识别，修完对应兼容路径才允许该项目通过无感门禁。

本轮 `BackendSwitchCoordinator` 已实现准备、帧边界回调、引用保持、取消、超时、最新请求优先、清理与诊断合同。
真实 backend 的首帧、revision 追平、GPU fence、canvas 呈现、设置 UI 与偏好持久化仍待接入；mock 测试不能证明没有黑帧。

切换验收：连续往返 20 次；运行脚本保留闭包和对象引用；动画时间、仿真 tick、选择、撤销栈、草稿及相机不丢；注入编译失败、设备丢失、超时；逐帧录像检查空白/跳变；资源回落。

## 5. 性能路线与保留条件

| 顺序 | 先优化什么 | 验证与退出条件 |
|---|---|---|
| P0 | 冷加载/解析/编译/提取/encode/GPU/present 分段计时 | 能定位 P95/P99，而不是只报平均 FPS |
| P1 | 结构不变时不编译图、按需绘制、dirty range、上传合并、资源共享 | 比现有优化后的 Three 基线更快；没有丢更新或隐藏成本 |
| P2 | 管线缓存、draw list、重复几何实例化、材质合批 | 控制透明顺序、剖切、动画及 ID 语义；兼容例外单独走正确路径 |
| P3 | GPU frustum cull/compact/indirect 已落地，继续做空间索引、HiZ 与 LOD | 当前六平面 sphere culling 已在 PbrRenderer 不透明/阴影批次执行；后续同时测简单、开放、遮挡密集场景，禁止同步 readback 驱动下一帧 |
| P4 | 纹理压缩、异步 IO/解码、流式分块与逐级质量 | 首次可交互、峰值显存与完整质量到达时间都记录 |
| P5 | GUI、文字、标注、告警和图表全 GPU 化 | retained invalidation、glyph/path/image/chart 批次与 3D 共用 device；保留轴/图例/tooltip/IME/无障碍语义 |
| P6 | 经 profile 证实的热点下沉 WASM/Rust | 计入跨语言调用、复制和调度成本，收益不足则保留 TS |

渲染质量链统一：显式 PBR、环境/主光/补光、受控阴影、HDR Bloom、暗角、色阶、单次 tone mapping 和输出色彩转换。
GUI 若在 tone mapping 前合成会改变语义色，应按颜色空间合同选择显示阶段合成；不机械地把所有 UI 塞入 HDR 后处理。
HiZ 使用当前深度时要计入 prepass 成本；用历史深度时需在相机跳转、动态遮挡、resize 后保守失效。f16/subgroup/timestamp 等可选能力必须探测并提供正确路径。

## 6. 阶段顺序与完成门禁

| 阶段 | 范围 | 完成条件 | 当前状态 |
|---|---|---|---|
| S0 | 方案纠错、基础正确性、来源清单、切换合同 | 类型/单测/构建、原始清单、状态回填 | 本轮已执行的基础批次；完整运行时语料仍待办 |
| S1 | 自研 WebGPU executor、真实资源与 PBR 验证场景 | 首帧、resize、销毁、设备丢失；两轮视觉闭环 | 本轮待办：固定材质夹具已跑通，完整渲染画质尚待验收 |
| S2 | 渲染提取与项目高频 Three profile | 标准对象/材质、loader、控件、BVH、动画、代表脚本及项目实际 P0 插件通过；其余机器可读报告 unsupported | 本轮待办 |
| S3 | 完整画质、负载优化与 Three/Babylon 对照 | 同质量串行 A/B、多设备、短稳、故障与资源回落 | 本轮待办 |
| S4 | 设置真实一键切换、双向恢复、发布策略 | 第 4 节全链路门禁，默认引擎晋级有证据 | 本轮待办 |
| S5 | 原生 Viewer、全 wgpu GUI/图表与宿主 | 原生客户端无 WebView/WebGL/React/ECharts 运行时；脚本/字体/输入/媒体/发布真实端到端；复用现有编辑器产物 | 本轮待办，与 3D 主线并行；不新建原生编辑器 |
| S5A | Deep Asset Package 与高频资产接入 | glTF/GLB 原生纵向切片、既有高频 converter 接入、重导入和原生发布门禁通过；Unity 与长尾格式扩张删除 | 本轮待办 |
| S5B | 轻量 Deep Shader 系统 | typed IR/DSL、多 Pass、变体裁剪、反射缓存、调试热重载；Browser/Native 共用 WGSL 产物，不建设复杂 Shader Graph | Standard PBR lowering、DeepSL、Package v2、Browser executor、固定 ABI adapter、Native package executor 与 Native IBL 已落地；持久化 CAS、热重载、compute 和高价值高级能力继续推进 |
| S6 | 超越 Three/Babylon、保留能力对标三大引擎 | 第 7 节冻结的高价值矩阵达标，不把已删除范围纳入宣传 | 项目级后验收 |

没有把 S0 或固定 GPU 夹具称为引擎完成。通用资源/模型、运行时兼容、完整画质与真实一键切换仍未完成。
继续保留用户取消的 8 小时 soak 为明确排除；短时稳定性、资源、设备丢失与恢复仍是门禁。

## 7. 如何判定“超过”和“90%”

### 7.1 对 Three.js / Babylon.js

先冻结准确版本、补丁、目标设备/驱动、物理像素、资源 hashes、相机路线、灯光/材质/后处理和统计窗口。
测试矩阵覆盖冷启动、静态大场景、重复设备、稀疏开放场景、密集遮挡、透明剖切、动画、标注、图表、脚本、切换恢复。
WebGL/WebGPU 与 native 分组比较；不把浏览器宿主差异当自研 GPU 算法收益。

- 每个项目 P0 能力与脚本合同必须 100% 通过；能力超过还要包含可用工具链与新增能力的端到端证据。
- 目标测试集 CPU 与 GPU 分别记录 P50/P95/P99、首帧、输入延迟、峰值/稳态资源；至少五轮交替串行测试。
- 所有关键测试不得显著退化超过 5%；胜出负载要求瓶颈帧耗时改善至少 15%，且统计区间支持收益。噪声大则增加样本，不能强行通过。
- 120/1000 对象已有 Three 优化必须保留；新引擎不能对比未优化旧版本领取虚假收益。
- 单独报告未胜出测试，不能仅挑冠军场景称“全面超越”。

### 7.2 对 Unity / UE5 / Godot

建立三份独立矩阵，分别固定版本、渲染器、平台和画质配置。同一功能在不同引擎的测试与成熟度要求可能不同。
以下是计划使用的领域权重；具体功能项及子权重必须在对比开始前冻结，不能测完后删掉未实现项。

| 能力领域 | 权重 | 证据要求 |
|---|---:|---|
| 渲染、光照、阴影、反射、GI、后处理 | 20 | 真实资产、静态与运动画质、帧时和显存 |
| 大场景、资源流式、LOD、几何组织 | 15 | 大负载、加载/卸载、连续导航、峰值与回落 |
| 材质、shader、特效与粒子 | 10 | 创作、调试、组合、性能与发布 |
| 动画、骨骼、时间线 | 10 | 导入、编辑、播放、混合与状态连续 |
| 物理、交互、导航、音视频、XR | 10 | 端到端行为、目标设备与异常路径 |
| 编辑器、资产导入/重导入、场景工作流 | 10 | 作者任务完成率、撤销、保存恢复与协作 |
| GUI、图表、文本、输入与无障碍 | 10 | 中文 IME、复杂布局、数据更新、输入与可访问性 |
| 脚本、插件、扩展与 API | 5 | 真语料、调试、稳定合同、生命周期 |
| 原生平台与发布 | 5 | 安装升级、离线、平台矩阵、崩溃与恢复 |
| Profiler、诊断、自动化与稳定性 | 5 | 性能归因、故障定位、资源和回归门禁 |

能力项只按实际通过比例计分；未实现、未验证计 0。总分 ≥90/100 且每领域 ≥80/100，关键可靠性与用户项目兼容必须 100%。
若特殊平台/生态规模另列，必须在报告中标明，不能把有限功能测试包装成“整个引擎 90%”。目前未完成细项分母冻结，不发布任何当前 90% 分数。

性能另设门禁：同质量吞吐至少参考引擎的 90%（相应帧耗时不超过约 1.111 倍），关键交互/启动/内存同时设预算，不能用降画质换 FPS。
画质另做参考画面与运动时序评审；SSIM/感知差异仅为辅助，透明、阴影、闪烁、拖影必须人工及视频复核。

### 7.3 时间估计

2026-09-12 用户新增要求：并行推进，希望在四天内（9 月 16 日）看到引擎完成。将该日期设为集中交付检查节点，完整目标和验收分母不变；尚无证据支持在四天内完成三大引擎各自 90%，不能把期限当成能力已具备。

当前按四条工作线并行，文件所有权分开：实例与几何更新性能；纹理/材质资源；同一 Three 作者对象投影；根任务负责真实 GPU 集成、回归与交付证据。目标次序为真实资产→材质贴图→作者状态连续→双后端切换→同质量性能与故障验证。每天应留下可运行增量、构建身份、实测结果和明确缺口；依赖完成即可集成，不等全部子任务结束。

四天安排是执行优先级，不是替代完整验收：第 1 天打通模型/动态资源/纹理，第 2 天完善材质与 Three 投影，第 3 天验证同作者状态的双后端切换，第 4 天完成集成修复和对照报告。任何未通过项目语料的能力继续标记本轮待办；正式 apps 的启用仍以原有门禁为准。

小型资深图形团队持续投入的粗估：真实 WebGPU 最小闭环 2–4 周；项目完整平替及一键切换 3–6 个月；
明确测试集超过 Three/Babylon 并补原生/GUI/图表 6–12 个月；全部目标接近三大引擎各自 90% 为 18–36 个月以上。
这是规划量级而非交付承诺，不等同当前会话的日历排期。S1 与真实脚本语料完成后重新估算。

## 8. 高价值高级渲染能力取舍

这些能力只进入可复现的质量档位，不增加用户必须理解的底层开关。默认由设备探测、场景规模和帧预算选择 `auto`，用户只看到性能、平衡、质量三个档位；每个档位仍有固定合同和回退路径。

| 能力 | 是否现在做 | 采用的轻量实现 | 暂不采用的部分与原因 |
|---|---|---|---|
| Nanite 几何体 | **现在做 Lite 版** | 离线 meshlet（约 64–128 三角形）+ 层级误差/包围体 + GPU frustum/HiZ cull + indirect draw；沿用现有 LOD、驻留和流式资源预算 | 不复制 UE 的软件光栅化、全局虚拟阴影和编辑器烘焙系统；先解决大 BIM/重复实例的可见性、内存和细节稳定性 |
| MegaLights | **现在做 Deep Lights** | 已有 Forward+ 集群，已落稳定的亮度/范围/距离/锥角重要性预算；下一段接共享 shadow atlas、固定采样预算和时域去噪；无 RT 时用 CSM/VSM/屏幕空间遮挡 | 不做依赖硬件 RT 的完整随机路径；先保证大量动态点/面光源可控、无噪声爆炸，并让灯光自动降级 |
| Lumen Lite | **现在做 Deep GI Lite** | 辐照度 probe clipmap + probe occlusion + 屏幕空间补偿，按相机/场景 dirty 区域分帧更新；与 HDRI/IBL 共用环境资源 | 不复刻 Lumen Surface Cache、硬件 RT 和复杂跨平台调参；先覆盖工业场景的漫反射间接光与稳定运动画面 |

实施顺序固定为：先完成 meshlet/HiZ/indirect 的大场景收益，再完成 clustered lights/shadow atlas，最后接 probe GI。重型硬件 RT 和 UE 全套虚拟几何不进入路线。验收至少包含静态、相机运动、动态物体、透明/剖切、设备丢失和资源回落，不能用单张截图替代时序质量检查。

烘焙策略单独遵循“预处理优先、光照混合”的原则。必须烘焙的是运行时不会改变的结构性数据：meshlet 分块与层级、屏幕误差、包围体、LOD/驻留清单、顶点量化与纹理压缩、材质变体和 shader/pipeline 预热清单；这些数据能减少解析、上传、编译和每帧调度成本，也能让 Nanite Lite 与大场景流式驻留真正落地。静态间接光先采用 probe/可见性缓存与运行时补偿的混合模式，动态物体、动态灯光、剖切和编辑状态继续走实时路径。完整 UV lightmap、方向光照图、全局光照重烘焙和类似 Enlighten 的编辑器工作流暂缓，除非真实项目证明 probe 混合无法达到稳定画质；否则它会增加资产体积、烘焙等待和跨平台一致性成本。

这套取舍吸收 Unity GPU Resident Drawer/ GPU Occlusion、UE Nanite/MegaLights/Lumen Medium、Godot 的清晰质量分档以及 Three/Babylon 的显式 WebGPU/Frame Graph 组织方式；保留 Deep 的单一资源生命周期和少配置入口。它是后续任务的优先级约束，不代表当前已经完成上述能力。

## 9. 本轮执行证据和限制

- 基线：typecheck 失败，17 个既有测试仅 15 通过；10 个新增回归在修复前全部失败。
- 已修复：类型导出、可选字段、场景换父/根索引、失败原子性、ID 冲突、删除 dirty 确认、后代失效、非有限变换、迭代遍历、调度传递失败与 predicate 异常、无生产者资源与同 pass 反馈、无效图禁执行、描述符所有权。
- 图生产者索引改为一次构建，去掉输入逐次扫所有 pass；图结构未变化时复用不可变编译结果；同步调度阶段不再无条件 await。尚未据此宣称整机性能收益。
- 已新增 `BackendSwitchCoordinator`，覆盖 live state、帧边界、连续请求、取消、超时、失败、迟到结果、销毁和清理错误。
- 已新增 AST 源码清单工具，区分 import 别名、静态属性、类型和值使用、局部遮蔽；动态入口和嵌入脚本显式列 unresolved。
- 首次清单：2157 文件、165 个 module/symbol 项、2266 次静态引用、409 项待进一步解析的证据。不是 165 项能力已实现，也不是项目兼容覆盖率。
- 清单见 [原始 JSON](deep-engine-three-source-inventory-2026-09-12.json)，包含逐行位置、文件 SHA-256 和整个语料哈希。源码变化后重新生成。
- 运行时核心没有外部运行时依赖；扫描器使用已有 TypeScript 开发依赖；未接入现有应用入口。
- 最新检查：typecheck（核心+实验页）、build、12 个 Node ESM 构建入口和隔离门禁通过；Vitest 55 文件 / 627 项、Node 合同与扫描器 26 项通过，runtime purity 覆盖 131 个 Browser/core 源文件、60 个 Native 源文件与 194 个 Windows resolved packages。
- 全仓 `pnpm quality:source-size` 检查 2470 源文件通过；新包源文件均低于 300 行。`lab:isolation` 通过：构建输入仅自有 src/lab，正式 apps 未引用实验包，无引擎运行时依赖。
- 开发工具增加固定 esbuild 0.28.1 和 @webgpu/types 0.1.72；锁文件只增加实验包与类型依赖，不升级产品 Three 依赖。
- 真实 WebGPU 固定场景首帧、实例数改变和设备丢失后重建已浏览器验证。更完整证据与视觉缺口见 [S1 验证记录](deep-engine-webgpu-verification-2026-09-12.md)。
- 已追加默认摄影棚 cubemap/GGX 预过滤/漫反射辐照度/DFG LUT、静态阴影缓存及可选 GPU timestamp-query。普通缓存帧 3 draw，诊断保留实际 GPU 样本覆盖；外部 HDRI、级联和完整画质仍待开发。
- Shader 主线已把 Standard Surface 降低到 GGX/方向光/PCF 阴影/IBL/AO/emission HDR WGSL；Package v2、DeepSL Standard adapter 和 Browser executor 在真实 NVIDIA WebGPU 上创建 4×MSAA forward 与 depth32float shadow pipeline；Native package executor 也已在 Vulkan 实机创建同一 forward/shadow pass 并完成读回。
- Native ABI-3 已在 RTX 4060/Vulkan 上执行真实 2048² depth32float shadow、light VP、3×3 PCF 与 9 个 OPAQUE/MASK/raster shadow pipeline；新增 rgba16float IBL cubemap/DFG/LUT 资源并用 IBL 开关读回 `changed_pixels=915`、on luminance `255.374535` > off `184.904717`。Browser Lab 另以同一设备执行六平面 GPU sphere culling、144B 行压缩与间接实例数读回（4→2，indexCount=3）。
- 产品 UI、项目兼容、竞品性能领先、完整画质、原生与设置切换未验收；本轮不运行与隔离包无关的正式站点 E2E，不继承旧全量结果。
- 本轮已增加 `bakeRenderPacket` 确定性资产预处理合同：从 RenderPacket 生成 Meshlet、一次性展开的间接索引、材质变体/纹理清单与内容缓存键；并为 Forward+ 增加可选 `maxLocalLights` 重要性预算，按亮度、范围、距离和聚光锥角稳定筛选本地光源。两者均未接入正式 Three 路径，后续由浏览器/native executor 消费。

本轮已有 GPU 夹具图像；两轮截图与十维评分在专项记录中，不能把验证页评分扩大成最终产品或完整引擎评分。
S1/S4 的完整视觉仍须满足 design-taste-digitaltwin 的两轮截图、双主题/尺寸与十维逐项 ≥9 标准。

## 10. 参考与下一执行入口

上游依据：[Orillusion](https://github.com/Orillusion/orillusion)、[wgpu](https://github.com/gfx-rs/wgpu)、
[Babylon Native](https://github.com/BabylonJS/BabylonNative)、[Bevy](https://github.com/bevyengine/bevy)、
[Godot 渲染器说明](https://docs.godotengine.org/en/stable/tutorials/rendering/renderers.html)。
Unity/UE5 的版本和完整 feature-level 清单尚需 S6 固定；此处没有声称已经完成对三者的实测。

下一步按顺序：通用 RenderPacket/mesh/material 资源 → 完整环境与材质画质 → 运行时/项目脚本语料与 Three 数据提取/raw 语义 → 全量能力及性能 → 设置真实切换。Orillusion 继续用于独立对照研究。
浏览器语义闭环完成后复用合同推进 native；未来阶段不能以新增空类或开关代替功能完成。
