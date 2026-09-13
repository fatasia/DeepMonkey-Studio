# Deep Engine 零旧包袱原生客户端架构

日期：2026-09-12。状态：用户最新决策，覆盖旧版“长期保留 WebView Studio”和“混合 Studio”路线。

## 1. 不可退让的边界

0. **第一原则：以最终目标和可验证事实纠正方案。** 不机械执行局部设想；每个决策先检查性能、兼容、跨平台、维护成本和正式环境风险。发现目标互斥、证据不足或存在更优结构时，直接指出并更新权威方案与门禁。
1. Deep Engine 只实现 WebGPU 语义：浏览器验证器使用浏览器 WebGPU，最终客户端使用原生 `wgpu`。Deep 路径不实现 WebGL、WebGL2 或自动回退到 WebGL。
2. 最终 Deep Studio/Viewer 直接使用 Rust、`winit` 和 `wgpu`，不嵌入 WebView、Chromium、Electron、Tauri 前端或浏览器 JS 运行时。
3. GUI、文字、图表、HUD、节点画布和 3D 视口全部经同一个 `wgpu::Device` 与帧图输出；跨平台只替换窗口、输入法、字体发现、文件和无障碍适配。
4. Three.js、Babylon.js、React、ECharts、zrender 和 Monaco 不进入原生客户端运行时依赖，也不进入渲染帧循环。
5. 旧项目正式环境继续保持当前 Three/Web/Tauri 行为；Deep 包与原生客户端保持独立，达到迁移门禁前不修改默认引擎、项目数据、脚本、账号或存储。
6. 开源项目只用于学习算法、合同和测试方法。正式核心、资源生命周期、渲染图、2D、图表、UI 和插件 ABI 均由 Deep 自己控制。
7. 必要的平台库必须按最小 feature、固定版本、许可证、二进制体积和性能预算单独准入，不能以跨平台为由引入整套 GUI/浏览器运行时。

这组约束同时意味着：最终原生客户端不内置 Three 后端。旧 Studio 的设置页可以在迁移期切换 Three WebGL 与 Deep WebGPU，以验证同一项目；纯原生客户端只运行 Deep。把 Three/WebGL 放回同一原生安装包，会直接破坏零旧运行时目标。

## 2. 三种产物，严格隔离

| 产物 | 用途 | 允许的运行时 | 禁止进入 |
|---|---|---|---|
| 现有正式 Studio | 保护已上线项目；迁移期 A/B 与一键切换 | 当前 React/Three/Tauri；Deep WebGPU adapter 通过门禁后可选 | Deep 原生包不得反向依赖它 |
| Browser WebGPU Lab | WebGPU 功能、画质、故障和跨实现 fixture 验证 | TypeScript + 浏览器 WebGPU，仅开发/测试 | 正式原生安装包、产品状态权威 |
| Deep Native Viewer/Client | 最终客户端的查看、交互、运行、打包与离线部署；编辑工作继续由现有 Studio 承担 | Rust + `winit` + `wgpu` + 经门禁的平台适配 | WebView、DOM、WebGL、Three/Babylon、React/ECharts 运行时 |

浏览器 Lab 不是未来客户端外壳。它只用于快速验证 WebGPU 规范、WGSL 和浏览器平台兼容性；原生产品不复制它的 UI、网络或生命周期。

## 3. 原生运行结构

```text
Deep Native Process
├─ deep-platform       窗口、输入、IME、DPI、剪贴板、文件、无障碍、系统事件
├─ deep-host           网络、实时数据、缓存、任务、媒体、凭据、更新、诊断
├─ deep-document       项目文档、命令、撤销、选择、会话和唯一状态权威
├─ deep-assets         glTF/BIM/纹理/字体/流式、内容寻址与生命周期
├─ deep-render         RenderPacket、渲染图、资源注册、PBR、光照、后处理
├─ deep-2d             path/text/image/clip/hit region 的批量显示列表与 wgpu painter
├─ deep-ui             retained UI 树、布局、焦点、停靠、输入与语义树
├─ deep-chart          ChartIR、坐标系、layout、交互、增量数据与 GPU 批次
├─ deep-plugin         版本化能力清单、稳定 ABI、预算、隔离和诊断
└─ deep-pack           项目烘焙、shader/asset cache、签名、安装和回滚
```

3D 与 2D 共用 surface、上传队列、资源预算和帧图。UI 改变时只重算受影响的 retained subtree；静止界面不持续重建全部顶点，也不强制整窗口每帧重绘。文本、图表和视口 pass 由同一帧调度器排序，避免多套 swapchain、跨进程纹理和 DOM 合成成本。

现有 `packages/deep-engine-native` 已证明窗口、surface 和完整静态 RenderPacket 可以直接 present；`Deep2dDisplayList` 已在 TypeScript/Rust 两侧形成严格批量协议，原生端也已在同一 encoder 的 3D pass 后真实提交基础 path fill/stroke 透明 pass。下一步扩充曲线/凹面/stroke、image、clip、glyph atlas 与缓存，再接 retained UI，不先引入完整 GUI 框架。

## 4. 全 WebGPU GUI 路线

Deep UI 采用自己的 retained tree：

- stable node id、style snapshot、layout result、paint cache、hit-test index 和 accessibility node 分开存储；
- flex/grid/dock/absolute/virtual list 作为可测试的纯布局模块；
- 事件按 capture/target/bubble 传播，命令进入统一 document/session reducer；
- 输入法使用原生 composition/caret 矩形，候选窗由操作系统呈现；正文、选择和光标由 Deep GPU painter 绘制；
- 控件输出 `Deep2dDisplayList`，painter 只消费批量资源和命令，不知道业务状态；
- 颜色、字号、间距、圆角、阴影、运动曲线和语义色来自版本化设计令牌快照，不读取 CSS；
- 语义树与绘制树共享 stable id，UI Automation/辅助技术动作回到同一事件系统；
- 2D path、glyph、image、clip、shadow 和 chart primitive 全部走 `wgpu` render/compute pass，不保留 Canvas/SVG/系统控件绘制回退。

候选基础库只做有界 spike：

| 候选 | 吸收价值 | 决策 |
|---|---|---|
| Vello | compute-centric 2D、可直接输出到 `wgpu::Texture` | alpha 状态且上游明确列出 blur、内存分配、glyph cache 缺口；作为算法/压力测试对照，不直接成为核心依赖 |
| cosmic-text | Windows/macOS/Linux 的 shaping、双向文字、fallback、彩色 emoji | 只负责 CPU shaping/layout 候选；glyph atlas 与绘制仍由 Deep WebGPU 管线完成 |
| AccessKit | 自绘 UI 到 Windows UIA/macOS/Unix accessibility 的语义树适配 | 只接平台 adapter，不接 GUI 框架或系统控件绘制 |
| egui/iced/RNW 等 | 控件行为、输入和集成基准 | 只作 benchmark/reference；不作为 Deep Studio 产品 UI 运行时 |

上游依据：[Vello](https://github.com/linebender/vello)、[cosmic-text](https://github.com/pop-os/cosmic-text)、[AccessKit](https://github.com/AccessKit/accesskit)、[egui](https://github.com/emilk/egui)。

## 5. React 迁移：保留语义，不执行 React

React 组件不能在无 JS/DOM/WebView 的客户端中直接运行。迁移采用三层拆分：

1. 从现有组件提取纯 view-model：字段、状态机、验证、命令、权限、加载/空白/错误语义。
2. 将可复用部分固化为版本化 `UiState`、`UiIntent`、设计令牌和 golden fixture。
3. Deep UI 用原生控件实现同一 fixture；旧 React adapter 只留在现有 Studio 中作行为对照。

禁止把 JSX、React hooks、DOM node、CSSOM、浏览器事件或 JS 闭包序列化进项目合同。可开发静态扫描和 codemod 帮助抽取属性表、工具栏和列表，但它们是构建工具，不随原生客户端发布。

当前可复现源码盘点覆盖 1,724 个文件：React 549、DOM/CSS/浏览器 API 470、ECharts 15、Monaco 6、Worker 14、直接网络 9、Three/raw graphics 152。它证明这是一条协议与产品 UI 重建路线，不能按“替换一个 renderer 包”估算。机器可读结果见 [原生 UI 源码盘点](deep-engine-native-ui-source-inventory-2026-09-12.md)。

## 6. ECharts 迁移：编译 option，不带 ECharts

ECharts 官方渲染器以 Canvas/SVG 为主；它没有可直接放入 Rust/wgpu 客户端的官方 renderer。`@wuba/react-native-echarts` 证明 option/model 与 painter 可以分离，ChartGPU 证明密集数据可由纯 WebGPU 加速，但二者都不满足最终 Windows 原生零 WebView 运行时。

Deep 保留两类输入：

```text
现有项目 ECharts option
        -> EChartsOptionCompat parser
        -> normalized ChartIR + diagnostics
        -> DeepChart layout/action/dataflow
        -> Deep2dDisplayList / GPU compute buffers
        -> native wgpu painter

第一方新组件 ChartSpec
        -> ChartIR
        -> 同一 DeepChart 执行路径
```

`EChartsOptionCompat` 自己解析已支持的 option 子集，不加载 ECharts JS。每个 series、axis、visualMap、dataset/transform、tooltip、legend、dataZoom 和 action 都有 `supported/degraded/unsupported` 结果；未知字段不能静默忽略。ChartIR 只含数据、标度、布局、交互和语义，不含 DOM/Canvas 对象。所有 chart primitive 最终进入 Deep WebGPU pass。

已有研究依据：[Apache ECharts Canvas/SVG](https://echarts.apache.org/handbook/en/best-practices/canvas-vs-svg/)、[@wuba/react-native-echarts](https://github.com/wuba/react-native-echarts)、[ChartGPU](https://github.com/ChartGPU/ChartGPU)、[Lumen Charts](https://github.com/jagtesh/lumen-charts)。它们只提供迁移证据和测试语料，不写入 Deep Native 正式依赖。

## 7. Three 插件兼容边界

“零 Three 运行时”与“任意 Three 插件原样运行”不能同时成立。兼容按机制分级：

| 插件类型 | 迁移方式 | 目标 |
|---|---|---|
| loader、资产处理、CPU 几何、数据格式 | 独立构建工具执行后输出 Deep 资源/RenderPacket | 高兼容；工具不随原生运行时发布 |
| 控件、相机、选择、动画状态机 | 适配到 Deep input/scene/animation facade，以 golden 行为验证 | 保持项目语义，不保持 JS 对象实现 |
| ShaderMaterial、WebGLRenderer hook、raw GL、postprocess pass | WGSL/渲染图端口或人工重写 | 明确报告 incompatible，不能伪装兼容 |
| 依赖 DOM/React/ECharts/浏览器网络的插件 | 拆为 UiIntent/HostCapabilities/ChartIR adapter | 原生实现替代；旧插件只在旧 Studio 运行 |

原有 `threeBridge` 保持独立开发/迁移包；它只读取 Three 作者对象并生成 Deep packet，不被 `deep-engine-native` 链接。最终项目格式、对象 identity、命令和行为协议属于 Deep，不属于 Three。

Unity Web Build、Unity 源工程/资源包和现有 25 种模型扩展名同样通过隔离边界处理；具体输入分类、Deep Asset Package 路线和保真门禁见 [资产与 Unity 迁移兼容方案](deep-engine-asset-compatibility-migration-2026-09-12.md)。

## 8. 网络、脚本和其他原生能力

原生客户端中的 renderer、UI、chart 和 plugin 均不能直接创建 HTTP/WebSocket 或读取凭据。它们只调用 `HostCapabilities`：

- `HttpTransport`：请求、流、上传、取消、超时、重试、幂等键和结构化错误；
- `RealtimeTransport`：订阅复用、重连、背压、恢复游标、离线队列和关闭确认；
- `AssetIo`：文件、拖放、hash、MIME、流式、缓存和离线包；
- `TaskRuntime`：有预算的线程/进程任务、取消、进度、崩溃隔离；
- `ScriptRuntime`：版本化脚本 ABI、时间/内存/能力预算；不把 DOM 或 Three 注入脚本；
- `Media`、`TextIme`、`Accessibility`、`Clipboard`、`Window`、`Diagnostics`：分别由平台 adapter 实现。

每个 workspace 只有一个 document authority、一个网络 authority 和一个 realtime connection registry。状态切换通过带 `sessionId/epoch/revision` 的命令与事件完成，避免两套撤销栈、WebSocket 和离线队列。

## 9. 打包边界

原生包只包含 Deep 可执行文件、固定版本原生依赖、WGSL/管线缓存、字体/图标许可资产、项目资源包、平台安装/更新组件和 SBOM。构建门禁必须扫描：

- 依赖树不存在 WebView2、Chromium、Electron、Tauri 前端、WebGL、Three/Babylon、React/ECharts；
- 二进制与资源逐项 hash、许可证和来源可追溯；
- feature flag 不得把 OpenGL/GLES fallback 带回 Deep 正式构建；
- browser Lab、threeBridge、迁移 CLI 与 native runtime 分包，禁止反向依赖；
- release 在干净环境可复现，安装、升级、失败回滚和数据保留有真实证据。

| 平台 | GPU/window 路径 | 当前证据 |
|---|---|---|
| Windows | DX12 或 Vulkan + winit | RTX 4060 Laptop/Vulkan 已 present；全量 Rust/依赖纯净门禁已跑 |
| macOS | Metal + winit | 当前明确排除，不开发、不构建、不进入完成分母 |
| Linux | Vulkan + Wayland/X11 | 当前明确排除，不开发、不构建、不进入完成分母 |
| Android/iOS | Vulkan/Metal | 当前明确排除，不开发、不构建、不进入完成分母 |

跨平台共享的是文档、UI/Chart IR、Deep2D、RenderPacket、WGSL、资源和行为合同；操作系统 surface、输入法、字体发现、无障碍、文件和安装器由窄平台 adapter 承担。

## 10. 性能完成门禁

“轻”用测量定义，而不是用依赖数量猜测：

- 静止 UI 采用 invalidation-driven 调度；无动画、无网络变化时不持续全量 layout/paint/upload；
- UI、chart、3D 共享 device、资源池和帧图，禁止每控件一个 surface 或每图表一个线程/运行时；
- retained layout、命中、文本 shaping、图表 layout 和 GPU encode 分段记录 P50/P95/P99；
- 10 万控件虚拟列表、百万点增量图表、复杂中文编辑、4K 多面板和大 3D 场景分别建冻结基准；
- 与 Three/Babylon/Unity/UE/Godot 的比较使用同资源、同相机、同质量、同交互和同机器，报告 CPU、GPU、显存、加载、包体和长尾；
- 每个新增第三方 crate 必须记录启用 feature、传递依赖、release 体积增量、CPU/GPU 影响和替换边界。

## 11. 当前并行执行矩阵

| 并行线 | 当前批次 | 下一合流门禁 |
|---|---|---|
| A：3D 渲染主线 | glTF AO、双面材质、官方 NormalTangentTest；随后透明、灯光、后处理、动画和大场景 | 相同 fixture 在 Browser WebGPU 与 native wgpu 的合同、像素和资源事务一致 |
| B：原生 GPU 执行器 | 静态 RenderPacket 已 present；继续纹理/PBR 与 2D 同 surface | 3D + 2D 同 device 首帧、resize、device loss、资源回滚 |
| C：Deep2D / GUI | TS 严格显示列表；Rust 合同、path/image/glyph painter、retained tree、layout、hit-test、IME | 中文输入、虚拟列表、多面板在 4K/高 DPI 实跑 |
| D：DeepChart | `ChartSpec/ChartIR`、ECharts option 无依赖编译器、折柱散饼热力仪表 | 全部 primitive 进入 Deep2D/compute pass，百万点与交互基准 |
| E：宿主与项目状态 | HostCapabilities、document/session、文件/网络/实时/任务/脚本 | 单一状态与网络权威、保存恢复和故障注入 golden |
| F：兼容迁移 | Three/React/ECharts/Monaco/Worker/network 静态语料与行为 fixture | P0 项目逐项 supported/degraded/unsupported，无静默降级 |
| G：构建发布 | runtime-purity、跨平台 target、SBOM、shader/asset hash、安装/更新/回滚 | 正式包中零 WebGL/WebView/Three/React/ECharts 依赖 |

各线同时工作，只有共享合同版本、GPU surface 合流和最终产品验收存在顺序依赖。任何一线失败都不能让其他主线停工；失败项保留结构化阻塞证据并由该线继续修复。

四天检查点应交付纯净门禁、双语言 2D 合同、原生 2D 首帧和可审查的 native 3D/2D 同 surface 样机；这不是完整编辑器或竞品 90% 完成声明。
