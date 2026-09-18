# Deep Engine：客户端与打包剩余交付清单

日期：2026-09-12。状态：本轮待办持续推进。用户最新决策要求 Deep 路径零 WebGL、最终客户端零 WebView，GUI/图表/3D 全部由原生 `wgpu` 执行；本文据此把浏览器验证器、迁移切换、纯原生客户端和长期竞品目标分开验收。

## 0. 优先级与合流顺序

| 优先级 | 范围 | 执行原则 |
|---|---|---|
| P0 | `WEB-01..08`：RenderPacket、真实模型/纹理、材质、动画、光照、后处理、性能与浏览器交付 | 当前串行阻塞链，优先清零；正式 Three 路径继续冻结保护 |
| P1 | `WEB-09..11/13`：Nanite Lite、Deep Lights、GI Lite、轻量烘焙 | 大场景与高级渲染内核；不能抢占 P0，但可复用已完成基础并行验证 |
| P2 | `SHADER-01..07`、`SWITCH-01..06`、`NATIVE-01..08`、`ASSET-01/02/06/07`、`PACK-01..06` | **战略必做，不是远期可选**；依赖满足即与 P0/P1 并行推进，最终必须通过高频兼容、无感切换、零 WebView Windows 客户端和发布门禁 |
| 排除项 | 非 Windows 平台、重型 RT/路径追踪、UE 全套虚拟几何、逐插件兼容、复杂 Shader Graph、长尾格式新解码器 | 删除出任务范围，不开发、不构建、不测试、不进入完成分母 |

单文件 300 行、runtime purity、真实资产/真实 GPU 证据、公平基准与正式环境隔离属于全程门禁，不按优先级延后。

## 1. 当前可验证基线

| 范围 | 当前证据 | 状态 |
|---|---|---|
| 自研 WebGPU 设备与 surface 生命周期 | 独立实验页已在真实浏览器完成首帧、resize、销毁、设备丢失后重建 | 已完成基础批次 |
| 基础渲染管线 | 自有 WGSL、GGX PBR、HDR、ACES、轻量 Bloom/暗角、环境预计算、阴影和 4x MSAA | 已完成基础批次 |
| 通用静态网格 | RenderPacket、共享几何、实例更新、GLB Box/BoxInterleaved、上传失败回滚 | 已完成基础批次 |
| 作者对象投影 | 同一 Three Object3D 投影、稳定 identity、实例增量；真实 AnimationMixer、GLTFLoader、three-mesh-bvh、SkeletonUtils 语料已跑 | 已完成基础批次，兼容面仍有限 |
| 纹理 | RGBA8/sRGB/线性语义、采样器、mip、UV0、baseColor/MR、KHR_texture_transform、GLB bufferView 与 glTF base64 data URI 已进入同一严格解码和 GPU 资源事务；BoxTextured 已在真实浏览器显示并通过失败回滚与设备重建 | WEB-01 基础闭环完成，代表资产语料继续扩充 |
| 原生客户端 | Rust `winit 0.30.13 + wgpu 30.0.1` 已实跑纹理 PBR、MASK、BLEND、双面、HDR/4×MSAA/ACES、四级 CSM、动态 bounds、IBL、Bloom、跨帧资源复用和 Deep2D path/atlas/矩形 clip 同帧 pass；尚无雾、直接 Text/Image 命令、完整矢量或安装包 | NATIVE-00/01 当前纵向切片通过；NATIVE-02 已到 path/预烘焙 atlas/矩形 clip |
| 正式产品 | 默认 Three.js 未改变；Deep 尚未接入设置页或正式项目 | 明确保持隔离 |

这套基线已经是可运行的图形内核实验，不是完整引擎发行版。固定球体或 Box 的成功不能替代真实项目、发布和竞品矩阵。

## 2. 浏览器 WebGPU 开发版还差什么

浏览器开发版的完成定义是：在隔离客户端中加载代表性真实资产，完成交互、故障恢复、性能诊断和可复现构建，不依赖 Three/Babylon 绘制。

| 编号 | 剩余任务 | 完成门禁 |
|---|---|---|
| WEB-01 | 扩充嵌入 PNG/JPEG 的 glTF/GLB 纹理语料 | bufferView 与严格 base64 data URI、MIME/signature/预算/取消、UV0/UV1、baseColor sRGB、metallic-roughness 线性采样和 KHR_texture_transform 已通过；继续补 MR/transform/UV1 官方实际模型 |
| WEB-02 | 扩充通用材质与特效材质 | 基础材质纵向切片已实机通过；direct BRDF 已对齐 separate diffuse、优化 Schlick 与 correlated Smith，冻结基准 SSIM 0.949514 通过；继续补 clearcoat/anisotropy/transmission/SSS 与代表资产矩阵 |
| WEB-03 | 补齐场景光照与环境 | 方向光、四级 CSM 和内建 IBL 已实机通过；继续补点光、聚光、真实 HDRI、反射探针和动态 shadow fitting，并在代表场景冻结画质基线 |
| WEB-04 | 扩充后处理 | GTAO、TAA、HDR Bloom、曝光、ACES 和一次显示编码已有 GPU 探针；继续补接触阴影、分层 Bloom 品质、色阶/调色、运动稳定性，并验证 UI 颜色不被 HDR 链污染 |
| WEB-05 | 动画与特效 | 节点、骨骼、morph、融合 GPU 路径和 glTF 运行协调器已通过；支持多 clip、loop/once、TRS+morph cross-fade、失败重试和 revision 去重；继续补嵌套过渡策略、粒子、告警呼吸/扩散环、飞线与切换时间连续 |
| WEB-06 | 大场景管线 | loose octree/working set、GPU LOD、Hi-Z、实例与 Meshlet 剔除、间接绘制、KTX2/Basis 压缩纹理和分块 visible/prefetch 驻留已有独立实现及 NVIDIA 证据；下一门禁是开放/遮挡/动态三类真实大负载的组合策略、帧时、峰值和回落 |
| WEB-07 | 诊断与缓存 | 已有默认关闭、固定窗口的 frame encode/queue submit/GPU/present-acquire P50/P95/P99 与迟到 GPU 样本合并；继续接冷启动/解析/提取、shader/pipeline/资源命中、显存预算与驱逐，并冻结真实场景基线 |
| WEB-08 | 开发客户端交付 | 可复现构建、版本/资产 hash、错误面板、设备能力页、离线静态资源、至少两轮实际浏览器视觉验收 |
| WEB-09 | Nanite Lite 几何路径 | 离线 meshlet 分块、层级屏幕误差、GPU frustum/Hi-Z cull、indirect draw 与驻留预算；开放/遮挡/动态三类负载均无明显 popping，失败回退现有 LOD |
| WEB-10 | Deep Lights 直接光 | Forward+ 点/聚光重要性预算与共享 depth32float shadow-atlas 计划/原子 GPU 生命周期已落地；下一段接 renderer/shader 的局部光阴影采样、固定采样预算和时域稳定，大量动态光源继续自动降级且不依赖硬件 RT |
| WEB-11 | Deep GI Lite | irradiance probe clipmap、probe occlusion、屏幕空间补偿和分帧更新；相机运动/动态物体/设备降级有稳定时序与资源上限 |
| WEB-13 | 轻量离线烘焙 | **现在做资产预处理**：meshlet/层级误差/包围体、LOD、顶点量化、KTX2 压缩、材质变体、shader/pipeline 预热清单和资产 hash；静态间接光只先做 probe/可见性混合烘焙，动态灯光与可编辑场景保留运行时路径 |

每个新增切片先核对当前依赖版本、标准能力和仓库已有实现；能复用或接线就不重写，只为可验证缺口新增代码。当前最近的阻塞链是 `WEB-02 → WEB-08`，同时继续扩充 `WEB-01` 模型语料。完成它可以交付可审查的 WebGPU 开发客户端；它不会自动完成动画、大场景或产品切换。

## 3. 正式应用一键切换还差什么

| 编号 | 剩余任务 | 完成门禁 |
|---|---|---|
| SWITCH-01 | 项目高频 Three 使用面与代表语料 | 标准对象/材质、loader、控件、BVH、动画和项目实际 P0 插件逐项归类；raw WebGL、任意 GLSL 与 renderer 私有 hook 只报告 unsupported，不逐插件追平 |
| SWITCH-02 | 唯一作者状态和稳定 facade | 同一对象 identity、脚本闭包、相机、选择、撤销、草稿、动画和仿真只运行一份；旧 renderer 引用不悬空 |
| SWITCH-03 | 双后端资源准备 | 后台预热资源/pipeline，新后端追平最新 revision；失败、取消、超时和迟到结果全部释放 |
| SWITCH-04 | 帧边界原子交接 | 20 次 Deep/Three 往返，无黑帧、跳帧、状态丢失、重复脚本或显存持续增长；逐帧录像与资源记录通过 |
| SWITCH-05 | 设置与回滚策略 | 仅成功后持久化偏好；当前引擎和期望引擎分开；启动失败自动回到可用后端 |
| SWITCH-06 | 灰度发布 | 默认继续 Three；按设备/项目 profile 小流量启用，崩溃、性能和画质门禁通过后才能晋级默认 |

`BackendSwitchCoordinator` 已覆盖准备、超时、取消和帧边界合同，但还没有接真实产品 surface、输入路由、GPU fence 和设置 UI，因此不能声称已实现无感切换。

## 4. 原生 Viewer 与全 GPU Studio 还差什么

原生 Viewer 不带 WebView/Chromium。Rust host 与浏览器 executor 消费同一版本化 RenderPacket/资源合同，并用跨实现 fixture 验证一致性。

| 编号 | 剩余任务 | 完成门禁 |
|---|---|---|
| NATIVE-00 | 已成立的最小窗口与静态 packet GPU executor | Windows 已实跑 `winit + wgpu` surface present、adapter/device、全几何/材质/实例、稳定合批、非均匀缩放逆转置法线、镜像双绕序、空场景、resize/redraw、关闭、device lost 重建与 RenderPacket v1 golden |
| NATIVE-01 | 与浏览器管线对齐 | 五类纹理、基础 PBR、MASK/BLEND/double-sided、HDR/4×MSAA/ACES、四级动态 bounds CSM、IBL、Shader Package、Bloom 和动态 packet 资源复用/回滚/device epoch 已实跑；继续补公开更新入口、雾、native BRDF 新公式与跨实现像素容差 |
| NATIVE-02 | Deep2D GPU painter | 曲线/凹 path、开放 stroke、预烘焙 glyph/image atlas、z-order 交错与矩形 scissor clip 已与 3D 共用 device/surface/encoder 真实 present/readback；继续补直接命令编译、路径 clip、完整 stroke、命中、跨帧复用、DPI 和回滚 |
| NATIVE-03 | Deep retained UI 与输入 | flex/grid/dock/virtual list、焦点、键鼠、触控、中文 IME、剪贴板、多窗口和无障碍；UI 全由 wgpu 绘制 |
| NATIVE-04 | DeepChart | ChartIR、坐标系/layout/action、折柱散饼热力仪表、百万点增量和 ECharts option 兼容报告；不加载 ECharts/zrender |
| NATIVE-05 | 文件与资源 | 文件选择、拖放、异步 IO、资产流式、压缩纹理、字体、磁盘/GPU 缓存、断点和离线资源包 |
| NATIVE-06 | 宿主能力 | 音视频、HTTP/WebSocket、任务、定时器、脚本、日志、崩溃恢复；保持单一状态和网络权威 |
| NATIVE-07 | Viewer 产品闭环 | 项目打开、导航、选择、剖切、测量、标注、告警和大场景连续运行；短时稳定与资源回落通过 |
| NATIVE-08 | 现有 Studio 接入 | 复用现有编辑器的项目状态、属性、2D/3D/数据/脚本、撤销保存恢复、插件和发布工作流；接入 Deep 引擎与原生 Viewer 产物，不另建原生编辑器 |

`NATIVE-00` 已证明原生静态 packet 渲染通道成立。本机 RTX 4060 Laptop/Vulkan 已实际提交五纹理 PBR、MASK、两个独立稳定排序 BLEND、双面材质、HDR/4×MSAA/ACES、四级动态 bounds CSM、Deep2D、rgba16float IBL 和 HDR Bloom；动态 packet 的 geometry/texture/sampler/material/instance 复用、revision 级联、失败回滚、device epoch 与无僵尸复用均有真实 GPU 断言。runtime purity 解析 194 个 Windows packages，零 WebView/Chromium/browser/GL fallback。Deep2D 矩形 clip 已真实 readback；预烘焙 glyph/image atlas 已按 z-order 与 path 交错。它仍没有跨实现像素级竞品对照、雾、公开 reload 入口、直接 Text/Image 命令编译、路径 clip 或安装包；透明仍是对象级 AABB 中心排序和单 pass 双面。缺少后续 `NATIVE-01..08` 时仍不是可交付客户端。

## 5. 零 WebView 客户端、全 GPU GUI 与网络边界

最终 Deep Native Viewer/Client 是一条独立原生产品线。现有 Studio 继续承担编辑、项目状态和发布工作流，并在迁移期做项目对照；它不是新客户端的外壳，也不会随 Deep Native 安装包发布。本轮不另建原生编辑器。

```text
现有正式 Studio（冻结保护）
└─ 当前 React / Three / Tauri；迁移期可用 Deep WebGPU adapter 做项目 A/B

Browser WebGPU Lab（开发验证）
└─ 自有 WGSL / WebGPU executor / 真实样本 / 跨实现 fixture；不作为客户端外壳

Deep Native Viewer / Client（最终原生产品）
├─ winit：窗口、输入、DPI 与平台事件
├─ wgpu：同一 device/surface 执行 3D、GUI、文字、图表、HUD 与节点画布
├─ Deep retained UI + Deep2dDisplayList + DeepChart IR
├─ Rust HostCapabilities：文件、HTTP、WebSocket、任务、脚本、媒体、凭据和诊断
└─ Deep document/session：唯一项目状态、命令、撤销、选择和网络权威
```

2D 不使用 DOM、Canvas、SVG 或系统控件绘制回退。跨平台只替换窗口、输入法、字体发现、文件和无障碍 adapter；布局、命中、glyph atlas、path/image、图表 primitive 与合成都进入 Deep 自有 `wgpu` 管线。静止 UI 由 invalidation 驱动，不持续全树 layout/paint/upload。

ECharts option 作为旧项目输入，经 `EChartsOptionCompat -> ChartIR -> DeepChart -> Deep2dDisplayList` 编译；原生客户端不加载 ECharts/zrender。React 组件拆出 view-model、`UiState/UiIntent` 和设计令牌，以 golden fixture 迁移为 Deep 原生控件；React 本身不进入客户端。

网络、脚本、媒体和插件全部通过版本化 `HostCapabilities`。renderer、UI、chart 和 plugin 不得直接创建连接或读取凭据；每个 workspace 只有一个状态权威、一个网络权威和一个 realtime registry。工业协议仍优先由服务端/边缘网关归一化，离线直连则实现窄 native connector。

Three 高频兼容不得污染原生运行时：loader/CPU 处理优先复用成熟工具并放在隔离迁移边界；控件和状态机映射到 Deep facade；raw WebGL、任意 GLSL、ShaderMaterial 与 renderer 私有 hook 明确报告不兼容，不再建设逐插件替代层。完整边界见 [零旧包袱原生客户端架构](deep-engine-native-gui-migration-2026-09-12.md)。

## 6. 安装包与发布还差什么

| 编号 | 剩余任务 | 完成门禁 |
|---|---|---|
| PACK-01 | 可复现构建 | 锁定 Rust/Node/工具链、生成 SBOM/许可证、资产与 shader hash；干净环境重复构建产物一致 |
| PACK-02 | Windows 包 | MSI/MSIX 或明确安装器、代码签名、静默安装/卸载、用户数据迁移、GPU 先决条件检查 |
| PACK-03 | 更新与回滚 | 分通道更新、增量下载、签名验证、失败自动回滚、版本/场景/缓存迁移 |
| PACK-04 | 诊断与恢复 | 崩溃转储、GPU/驱动信息、隐私受控日志、损坏缓存重建、device loss 与启动失败安全恢复 |
| PACK-05 | Windows 设备矩阵 | NVIDIA/AMD/Intel GPU 与目标 Windows/驱动组合分别运行画质、输入、稳定性、恢复和安装门禁 |
| PACK-06 | 发布流水线 | CI 构建、测试、签名、制品留存、渠道晋级、回滚演练和版本说明全部自动化 |

原生客户端仍要补齐 Viewer 所需的布局、HUD、图表、拖放、快捷键、输入、脚本宿主和无障碍；现有 Studio 通过版本化项目/运行包合同接入这些产物。本轮不复制已有编辑器，也不能通过把网页塞进壳里满足“无 Chromium”。

## 6A. Unity 级 Deep Shader 系统

Shader 路线采用 Unity 级资产/Pass/变体/编辑器模型、自研 typed Shader IR 和 WGSL 唯一运行目标。Three TSL 只作为节点组合参考；Three、TSL、Unity Player 和 HLSL 编译器不进入 native runtime。完整架构与迁移分级见 [Deep Shader 执行规格](deep-engine-shader-system-2026-09-12.md)。

| 编号 | 剩余任务 | 完成门禁 |
|---|---|---|
| SHADER-00 | **首批完成**：typed asset/Pass/graph IR、Standard Surface PBR lowering 与 WGSL 编译链 | Naga、类型、完整 Deep Engine 测试、构建、11 个 ESM 入口和 runtime purity 已通过 |
| SHADER-01 | PBR 模板与 ABI 对齐 | Standard 已由 IR 生成方向光/阴影/IBL/AO/emission HDR WGSL；固定无纹理/非双面 adapter、Native IBL 与同一 package Browser/Native GPU 执行已通过，纹理/MASK/双面扩展继续推进 |
| SHADER-02 | 多 Pass 与材质属性块 | forward/depth/shadow/object-id 的 alpha、双面、位移、skin/morph 语义一致 |
| SHADER-03 | 变体与 pipeline cache | v2 完整 pipeline package、Browser/Native executor、失败 cache 隔离、device epoch 失效、Browser pass LRU 与 native 磁盘 CAS 已完成；内容层仍需实际使用 allowlist 与发布预热 |
| SHADER-04 | 现有 Studio 的轻量 Shader 创作 | Standard/Unlit 模板、Inspector、DeepSL/WGSL 文本、预览、撤销、热重载和错误定位闭环；删除复杂 Shader Graph 产品建设 |
| SHADER-05 | Three 高频迁移；Unity 暂缓 | Three 标准/物理材质与少量已使用 TSL 按冻结语料分级，未知 GLSL 不静默降级；不追逐第三方插件私有 shader |
| SHADER-06 | 高级能力 | compute、粒子、后处理、自定义 render feature、coat/anisotropy/transmission/SSS 等逐项验收 |
| SHADER-07 | 当前目标发布矩阵 | Browser WebGPU 与 Windows 原生、多厂商 GPU 的编译、缓存、画质、P95/P99、故障恢复和包体通过 |

支撑层已继续前进：`shader-presets` 的 Standard Surface 真实降低为 PBR WGSL；`shader-authoring` 已有受预算 DeepSL、行列诊断、source map、revision/undo/redo/last-known-good/stale 回滚；`shader-package` v2 已冻结完整 pipeline 布局，并由 Browser/Native executor 在真实 NVIDIA/Vulkan 上创建 forward/shadow pipeline。`shader-cache` 已覆盖内容/设备 epoch/pipeline LRU，native `ShaderDiskCache` 已具备实例锁、generation 回退、Windows 原子 no-clobber 发布和有界 LRU；`shader-abi` 已冻结 208/160/144B 记录、顶点流、绑定、附件、resolve 与六类 Pass variant，Native IBL 绑定 3–6 已真实读回。Standard 与 Unlit adapter 均已覆盖纹理、MASK/BLEND 和单面/双面固定 ABI 变体；Unlit 不适用的 PBR 字段会机器可读拒绝。现有 Studio 轻量 Shader 工具接入、CAS 实际预热、通用多 Pass/compute 和高价值高级材质仍属于 `SHADER-03/04/06`。

## 6B. 高价值资产兼容；Unity 与长尾格式扩张删除

多模型现状审计见 [资产与 Unity 迁移兼容方案](deep-engine-asset-compatibility-migration-2026-09-12.md)。其中 Unity 分析保留为边界记录，按最新范围决定暂不实施，不计入当前四天主线。

现有产品仍有多种格式入口，它们的真实能力并不相同。当前新引擎只把 glTF/GLB 做成原生纵向切片；已有 IFC/CAD/机器人能力继续通过现成 converter/provider 保持，不新写长尾 decoder，也不把扩展名白名单当作兼容完成。

| 编号 | 剩余任务 | 完成门禁 |
|---|---|---|
| ASSET-01 | Deep Asset Package v1 | 内容寻址 chunk、单位/坐标/色彩、稳定源 GUID、场景/资源 DAG、版本/来源/许可证、unsupported report 和预算均有跨语言 golden |
| ASSET-02 | glTF 原生纵向切片 | GLB/glTF→Deep Asset Package→native RenderPacket，纹理、法线、AO、emissive、透明、动画/skin/morph 按真实样本逐项晋级 |
| ASSET-03 | 既有高频转换接入 | 只复用已经存在且有真实需求的 IFC/CAD/机器人 converter/provider，转换产物进入同一 Package；不扩张格式清单 |
| ASSET-04/05 | **删除**：Unity 与 legacy Web Build 兼容 | 不进入当前或后续默认排期；若用户重新立项再单独评估 |
| ASSET-06 | 重导入和差异 | 相同源/版本/配置可复现；源 GUID 保持对象身份，变更只更新受影响资源，用户覆盖/撤销/回滚可追踪 |
| ASSET-07 | 原生发布纯净门禁 | native 包只含 Deep 运行资产，不含 Unity Player/Editor、Web loader/framework、JS/WASM 或 WebView；legacy compatibility pack 单独发布和计量 |

现有 Unity 导入实际上接收 Web Build ZIP，并由浏览器 iframe 运行 Unity Player。Unity WebGL/WebGPU 都可作为旧 Studio 的 legacy Web 资源；它们不能直接成为零 WebView 原生资产。Deep Native 的首选兼容路径是源工程或包经 exporter 转换，保留明确的不兼容项，而不是逆向执行编译后的 Unity Web/AssetBundle 运行时。

## 7. 交付层级与现实工期

| 交付层级 | 能看到什么 | 粗估 |
|---|---|---:|
| 四天检查点 | 隔离 WebGPU 客户端、真实纹理 GLB、基础 PBR/阴影/后处理、Three 作者投影与故障证据；原生最小 Viewer 若 Windows 构建门禁通过则附带 | 2026-09-16 检查，不等于完整引擎 |
| WebGPU 最小闭环 | `WEB-01..08` 的核心子集、代表资产和可复现验证 | 小型资深图形团队约 2–4 周 |
| 正式项目平替与一键切换 | `SWITCH-01..06`，项目 P0 语料 100% | 约 3–6 个月 |
| 原生 Viewer 与发布 | `NATIVE-00..07`、`PACK-01..06` 的目标平台门禁 | 与引擎并行后仍需数月；以脚本/输入/媒体范围重估 |
| 全 `wgpu` 客户端 GUI/图表与 Studio 接入 | Deep retained UI、Deep2D、DeepChart、IME/a11y/Viewer 闭环及现有编辑器产物接入；原生客户端无 WebView/React/ECharts 运行时 | 约 9–18 个月，和 3D/宿主并行推进 |
| 超过 Three/Babylon | 同质量冻结矩阵胜出且无关键退化 | 约 6–12 个月 |
| 接近 Unity/UE5/Godot 各自 90% | 三份独立能力矩阵总分 ≥90、每领域 ≥80、关键可靠性/兼容 100% | 约 18–36 个月以上 |

这些是工程量级，不是用截止日期替代证据。每一层都必须交付可运行产物、构建身份、测试结果、画面和明确缺口。
