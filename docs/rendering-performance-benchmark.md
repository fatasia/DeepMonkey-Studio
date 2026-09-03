# Industrial Studio 与 Unity 渲染性能基准

## 目标与结论口径

目标不是证明某一方“总是更快”，而是回答三个可复现的问题：

1. 相同浏览器场景下，Industrial Studio WebGPU 相对 WebGL 2 的收益、退化和兼容性是什么。
2. 相同资产、相机、分辨率和画质下，Industrial Studio 本地渲染与 Unity Release Player 的性能差异是什么。
3. 相同 GPU、编码器、码率和网络条件下，Industrial Studio 云渲染与 Unity Render Streaming 的端到端差异是什么。
4. Three WebGPU 是否在保持产品能力和画质的前提下，具备晋级默认后端的充分证据。

不生成单一综合分。每个工作负载分别报告帧时间、资源消耗、延迟和画质，结论必须带硬件、驱动、
浏览器/Unity/代码版本、场景哈希、配置与原始结果。

## 当前基线环境

- Windows 11，Intel Core i9-12900HX，31.8 GB RAM。
- NVIDIA GeForce RTX 4060 Laptop GPU，8188 MiB，驱动 595.79。
- Unity Hub 3.12.1 与 Unity 2021.3.10f1c2、2022.3.62f1、6000.0.52f1 已纳入当前验证范围且用户许可证有效。2022.3.62f1 和 6000.0.52f1 均已产出可重复的 WebGL Bridge 构建并通过平台 ZIP 回灌；2021.3 的旧 Licensing Client 与当前 Hub batch 激活不兼容。6000.3 按当前项目范围不考虑。Unity 公平性能对照仍需统一资产和浏览器采样，不能用 Bridge 烟测代替。
- Industrial Studio 已能在同一场景内切换 WebGPU 实验后端并回退 WebGL 2。
- 云渲染当前已经具备 Chromium Worker、硬件编码探测、WebRTC 媒体协商、输入 DataChannel、发布作用域隔离和
  资源回收链路；但公网 TURN、并发容量、网络矩阵和 Unity 对照数据尚未完成，因此当前仍不得宣称优于 Unity。

2026-08-25 的空场景浏览器烟测在同一会话各读取 5 次编辑器内置 FPS：WebGPU 为
`138 / 136 / 137 / 113 / 136`，WebGL 2 为 `138 / 138 / 140 / 114 / 136`。该结果只证明两种后端都能
初始化、切换和持续渲染；空场景、采样过短且未锁定功耗/刷新率，**不能用于性能排名**。

## 公平性控制

| 变量 | 固定方式 |
|---|---|
| 资产 | 同一 GLB/KTX2/纹理和内容哈希；不让 Unity 使用专有源资产优化 |
| 场景 | 同一对象、三角面、材质、灯光、动画、碰撞体和可见性 |
| 相机 | 同一位置、目标、FOV、near/far 和 120 秒确定性轨迹 |
| 分辨率 | 1920×1080、2560×1440、3840×2160，渲染比例 100% |
| 画质 | 阴影、AA、环境、后处理、纹理过滤、LOD 和遮挡逐项映射并截图核对 |
| 运行形态 | Industrial Studio 生产构建；Unity Windows x64 Release Player，不测 Unity Editor |
| 系统 | 同一机器、同一显示模式、接通电源、固定性能档、关闭覆盖层和无关后台任务 |
| 采样 | 30 秒预热、120 秒采样、每项 5 次；报告中位数及最差一次，不挑最好结果 |

## 固定工作负载

| ID | 内容 | 目的 |
|---|---|---|
| R0 | 空场景与编辑器 UI | 启动、后端切换和框架开销烟测 |
| R1 | 100 万三角面、100 材质、静态园区/通用空间 | 基础提交与材质成本 |
| R2 | 500 万三角面、500 材质、LOD/遮挡/实例 | 中型数字孪生主场景 |
| R3 | 1000 万三角面、1000 材质、楼层分解与透明 | 重型场景和显存压力 |
| R4 | 200 AGV/运动对象、物流路径、实时数据更新 | CPU 更新、动画和数据桥 |
| R5 | 第一人称碰撞、物理、粒子和后处理 | 交互与复杂运行时 |

工业综合案例完成后冻结为 `R-industrial-v1`；另保留不含行业语义的通用层级场景，防止基准只适用于工厂。

## WebGPU 独立对比矩阵

WebGPU 是一级验收项，不与“浏览器渲染总体可用”合并。每个 R1–R5 工作负载产生三组独立结果：Three WebGL 2、Three WebGPU 和 Unity Windows Release Player。Unity 使用独立构建与采样流程，不进入 Web 主编辑器运行时：

- 相同 GLB、纹理、相机、灯光、阴影、AA、后处理和 100% 渲染比例；画质不等价时先记录能力差异，不比较 FPS。
- 隔离夹具必须证明几何负载等价：同一负载、对象数和重复轮次下，两个 Three 后端的最终三角面差异不得超过 1%，报告必须公开三角面数；超过门槛直接判基准无效。
- 裸引擎基准和完整产品查看器都会截取同一场景的 WebGL/WebGPU 画布，输出全局 SSIM、归一化 MAE、PSNR、变化像素比例、严重变化像素比例和放大差异热图；SSIM 低于 0.7 直接判为严重画质回归，低于 0.9 或局部严重变化偏高则进入人工复核。自动指标通过后仍需人工检查阴影、透明、PBR、标签、后处理与细线闪烁。
- 对比报告必须同时具备 WebGPU 适配器与关键 limits、设备支持时的 GPU timestamp、每次重建前后的完整堆样本、Long Tasks API 统计，以及 Three WebGL/WebGPU 画质对照；任一证据缺失直接判基准无效，不能用空字段或“不支持”伪装通过。
- 冷启动与热启动首帧、管线编译、P50/P95/P99/最大帧、GPU/CPU 时间、Long Task、峰值显存和 20 次场景切换残留。
- 复杂 PBR、透明/裁剪、实例化、蒙皮动画、粒子、拾取、标签、灯光/阴影、后处理、物理和设备丢失恢复。
- 同一 Scene Port 命令与业务脚本语义；若迁移要求复制编辑器状态、脚本 API 或运行时模型，则其维护成本计入结论。
- 只有 Three WebGPU 在 R1–R5 至少四项 P95 改善 15%、其余不退化超过 5%，且画质、功能与恢复矩阵全部通过时，才允许晋级自动默认后端。

隔离夹具同时运行 `static` 与 `dynamic`：静态组用于确定性画质截图、PBR/灯光/阴影和提交成本；动态组每帧更新最多 200 个对象的位置与旋转，用于暴露实时数据、动画矩阵上传和主线程提交差异。两组均报告平均、P50/P95/P99/最大帧以及覆盖冷加载、初始化、编译和 20 次重建全过程的 Long Task 数量/总时长/最大时长。Rapier 物理在产品 R5 中单独采样，不与渲染后端性能混为一谈。

该矩阵防止把 WebGPU 理论优势、单个 Demo 或引擎营销资料当作产品结论。当前固定门禁中 Three WebGPU 的 P99 和最大帧仍明显差于 WebGL，因此生产默认继续是 WebGL，WebGPU 保持显式实验状态。

隔离报告的 JSON 现固定输出 `promotionDecision=blocked-incomplete-release-coverage`，并分别记录性能、画质、动画、物理和渲染管线的覆盖状态。只要 R1–R5、产品适配层或 Unity Release Player 对照未完成，任何自动汇总都不得把该报告解释为引擎晋级批准。

### 2026-08-30 引擎现状校准

WebGPU 必须同时作为“产品发布能力”和“引擎技术路线”两条证据线评估，不能因底层 API 先进就自动成为默认后端：

| 路线 | 官方当前状态 | 对本项目的实际含义 |
|---|---|---|
| Three WebGPU | `WebGPURenderer` 仍由 Three 官方标为实验，但已具备 WebGL 2 自动回退、TSL、Compute、MRT、RenderPipeline 与新后处理栈 | 与现有 Three 场景、拾取、脚本和编辑器模型迁移成本最低；产品已接入核心 TSL 后处理和对象轮廓，下一步是逐场景画质签署与短时稳定性、恢复验证，而不是更换引擎 |
| Unity WebGPU | Unity 于 2026-08-24 宣布从 6000.6 起移除 WebGPU 的实验标签，并加入设备过滤与 WebGL2 回退；截至 2026-08-30，6000.6 仍在 Beta 序列 | Unity WebGPU 已成为必须对标项；本机 6000.0.52f1 不能代表该路线，公平对照需冻结具体 6000.6 Beta/正式版本并如实记录成熟度 |

WebGPU 对比必须同时回答“跑得是否更快”和“是否承载完整产品”，当前证据与待测项如下；任何一行未完成都不能仅凭 FPS 推荐换引擎：

| 维度 | Three WebGPU | Unity WebGPU / Release Player | 本项目可否决门槛 |
|---|---|---|---|
| CPU/GPU 性能 | 已有产品查看器和隔离夹具，可取 RAF、Long Task 与 timestamp | 6000.6 Beta 尚未安装，暂无公平结果 | R1–R5 固定设备各 5 次，P50/P95/P99、GPU 时间、首帧和显存齐全 |
| PBR 与显示效果 | 基础 PBR、ACES、阴影夹具已接入；复杂纹理、透明和真实工业资产待测 | 必须冻结相同 GLB、曝光、阴影和输出分辨率 | 画质不等价先修正或记录能力差异，不直接比较 FPS |
| 渲染管线与后处理 | 产品已接入 TSL RenderPipeline，覆盖 AO、对象轮廓、Bloom、景深、暗角、胶片颗粒、残影和 SMAA/FXAA；画质按发布场景签署 | 以 Unity 6000.6 WebGPU 实际支持的 URP/Shader Graph 子集为准 | 轮廓、AO/辉光、色调、抗锯齿、透明和裁剪逐项截图；核心接入不能代替同画质、短时资源回落、设备丢失与恢复证据 |
| 动画与实时数据 | Scene Port、脚本和时间线共用；当前夹具只覆盖 200 对象逐帧变换 | Animator/Timeline 作为功能深度基线 | R4 增加骨骼、关键帧、脚本驱动和数据更新四类压力，行为哈希必须一致 |
| 物理与虚拟调试 | 产品统一使用 Rapier，渲染后端不改变确定性调度 | Unity 物理和 Player 作为体验/性能对照 | R5 单独采样 Rapier 与渲染耦合成本；调度、故障注入和断言结果不得随引擎改变 |
| 工业交互 | 已有拾取、标签、剖切、XRay、脚本和对象身份主链 | 对照相机、灯光、模型、UGUI 和脚本控制深度 | 标签、剖切、测量、选择、灯光、动画、隐藏和设备信号映射必须逐项通过 |
| 稳定与恢复 | 产品已验证真实 `GPUDevice.destroy()` 后无损回退 WebGL，并持续执行短时资源与画面健康门禁 | 需验证浏览器失焦、设备丢失和图形 API 回退 | 同画质截图、20 次场景重建、状态/画面恢复和资源回落缺一不可 |
| 维护成本 | 延续现有 Three 编辑器、脚本和资源模型，不引入第二套 Web 运行时 | 作为独立 Unity 资源/Player 集成，不替代 Web 主编辑器 | 普通用户不能承担渲染器选择；任何优化不得破坏模型质量 |

Web 主编辑器采用 Three 单引擎路线，不向普通用户暴露渲染引擎选择。WebGL 2 与 WebGPU 共用同一场景、脚本和资源语义；后端切换只由自动能力判断和专家诊断承担。

发布态的 `WebGPU 优先` 采用画质等价守卫：安全上下文与 GPU API 可用只是必要条件。WebGPU TSL 已覆盖核心后处理和对象轮廓，但画质仍按发布场景签署，因此只要场景启用了受守卫的作者效果，自动发布仍保留 WebGL；这表示逐场景画质证据尚未关闭，不表示 WebGPU 运行时不支持。发布态自动决策与用户编辑器偏好相互隔离，不写坏本地选择，离开发布页后自动恢复。云渲染控制面在 Worker 打开页面前读取权威发布快照，通过 contracts 中的共享策略直接选择安全首帧后端；前端与 API 不再各写一套规则，也不会先初始化错误后端再回切。专家仍可在诊断面板显式切换以做验证，场景配置不会被删除。

### 当前 Three WebGL / WebGPU 产品能力矩阵

| 能力 | WebGL 2 | WebGPU | 当前结论与验收方式 |
|---|---|---|---|
| 几何、PBR 材质、透明、拾取、标签 | 生产 | 实验可用 | 同场景截图、对象数、三角面与交互回归；透明/PBR 仍需补 R1–R5 真实资产 |
| 相机、动画、脚本、Rapier 物理 | 生产 | 共用上层语义 | 两后端共用 Scene Port 和状态推进，不等于 GPU 性能已相同；R4/R5 分别采样 |
| 轴/盒/面剖切 | WebGL clipping planes | WebGPU ClippingGroup | 功能实现不同，需复杂模型截图与拾取验证 |
| 灯光与阴影 | 生产，静态阴影显式缓存 | 可用，后端管理更新 | 同画质截图、动态对象压力与短时稳定性分别验收 |
| 后处理与真实轮廓 | EffectComposer 全量接入 | TSL RenderPipeline 已覆盖 AO、对象轮廓、Bloom、景深、暗角、胶片颗粒、残影和 SMAA/FXAA | 自动发布暂保留 WebGL；当前缺口是逐场景画质签署，不是核心效果未接入 |
| WebXR | 产品已接入 | Three r184 已提供 WebXR 能力，但产品矩阵未实机验收 | Quest/Android 实机通过前不宣称等价 |
| 设备丢失 | WebGL context 路径 | 已触发真实 `GPUDevice.destroy()` 并无损恢复 WebGL | 严格 GPU 门禁持续验证对象与状态恢复 |
| TSL、MRT、Compute | 不作为 WebGL 主路径 | WebGPU 原生增量价值 | 仅在能转化为神经算子、粒子、后处理或大规模实例收益时轻量接入 |

Three r184 的官方 `WebGPURenderer` 文档已经包含 WebXR/multiview，并提供专用 `RenderPipeline`、MRT 和 TSL 后处理体系。产品现已按高价值范围接入核心节点，但“链路可用”不等于“画质与稳定已签署”；仍需逐项画质基线、短时资源回落、设备丢失和恢复验证，不能因接入完成就宣称默认后端成熟。依据：[WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html)、[WebGPU 后处理指南](https://threejs.org/manual/en/webgpu-postprocessing.html)、[RenderPipeline](https://threejs.org/docs/pages/RenderPipeline.html)。

当前固定版本 Three r184 还存在一个已公开的 WebGPU `BatchedMesh` 异构索引偏移问题。平台现阶段继续采用共享基础几何/普通对象路径，不为了降低 Draw Call 贸然切换到可能损坏几何的批处理；升级到包含修复的版本后，必须先加入 Uint16 多几何批处理画质夹具再启用。依据：[Three.js #34211](https://github.com/mrdoob/three.js/issues/34211)。

## 本地渲染指标

- 首次可交互时间、场景切换 P50/P95、着色器/管线预热时间。
- 平均 FPS；P1 与 P0.1 FPS；平均、P50、P95、P99 和最大帧时间。
- CPU 主线程、渲染线程、GPU 帧时间；Draw Call、三角面、管线/材质切换。
- 进程内存、JS/托管堆、GPU 专用显存、峰值与 20 次层级切换后的残留。
- 输入到下一帧呈现延迟；第一人称碰撞扫描耗时与卡顿帧数量。
- 固定相机截图的 SSIM/像素差和人工画质评审。画质不等价的结果不直接比较 FPS。

浏览器端使用 `requestAnimationFrame` 帧序列、Long Task、User Timing、Chrome trace，以及 Three WebGPU timestamp query 和 WebGL2 `EXT_disjoint_timer_query_webgl2` 的真实 GPU 计时；适配器/扩展宣称可用却没有取得样本时，隔离基准直接判为无效。Unity 使用 `FrameTimingManager`/ProfilerRecorder 的 CPU/GPU 帧时间，并用外部 ETW/NVIDIA
工具交叉验证。Unity 官方说明 FrameTimingManager 自身会产生观测开销，因此正式排名以无 Profiler 的外部采样
为主，内置数据用于定位瓶颈。

### 当前平台内诊断基线（2026-08-28）

查看器已在“渲染能力诊断”中提供最近 600 个可见帧的 FPS、P50/P95/P99/最大帧时间、超过 33.3ms 与 50ms 的帧占比，并同步展示 draw call、三角面、几何、纹理、物理像素、像素比、活动高耗特性和浏览器可用时的 JS heap。支持 Long Tasks API 的浏览器还会展示最近十秒长任务数量、总阻塞时间和最大任务耗时，用于区分 GPU/填充压力与脚本、UI 或数据处理造成的主线程阻塞。WebGPU 初始化仅申请设备支持时的 timestamp 能力，默认立即关闭；用户打开诊断面板后才每 30 帧异步解析一次 GPU 时间并展示 GPU P95，关闭面板立即停采且丢弃在途结果，避免普通运行持续承担观测开销。面板同时公开自动质量守卫当前是否保持 100% 画质、临时填充率、触发证据与恢复条件。标签页进入后台或系统休眠造成的 1 秒以上采样空洞会被排除并单独计数，不能混入场景掉帧率。

模型、材质、环境或灯光连续变化时，运行时会合并重复请求，并在浏览器空闲窗口调用当前后端的异步管线编译；状态、完成次数、耗时和失败原因进入性能快照。产品浏览器门禁和短时稳定性门禁要求至少完成一次预热且不得失败，用于降低首次显示材质/灯光组合时的着色器编译卡顿，不改变模型或画面配置。

WebGL 静态阴影已采用显式失效缓存：模型、层级、材质、灯光或可信脚本变化后刷新一次，动画、物理和时间线运行时逐帧更新，停止后固化最终帧。Three.js 0.184 的通用 WebGPU Renderer 没有公开 WebGL `autoUpdate/needsUpdate` 等价契约，因此 WebGPU 必须如实报告 `backend-managed`，不得显示为已缓存；这也是当前 WebGPU 保持实验后端的已知差距。

稳定性门禁可通过 `BIM_STUDIO_SOAK_RENDERER=webgl|webgpu` 对同一确定性阴影场景分别短时采样；报告必须保存后端和真实阴影模式，并分析真实画布亮度、方差和有效像素比例，阻断“对象统计正常但 GPU 画面黑屏/纯色”的假通过。默认发布门禁继续使用 WebGL，WebGPU 作为独立实验矩阵，不能用 WebGL 结果替代。

带 GPU 的验收机必须运行 `pnpm gate:webgpu`。该入口要求浏览器提供安全上下文、WebGPU API 和真实适配器，并把适配器存在时的初始化失败判为产品回归；普通 `pnpm gate:product-browser` 只允许在确实没有 WebGPU 环境时标记阻断，不能再把代码初始化错误伪装成环境跳过。

GPU 发布候选使用单一入口 `pnpm verify:gpu-release`：类型/单测/构建/生产产物、严格 WebGPU 产品门禁、在线主流程和 Three WebGL/WebGPU 静态+动态隔离对比分别执行。短时资源回落、同画质截图、设备丢失与自动恢复是当前发布证据；已取消的 8 小时 WebGPU soak 不再作为本轮签署条件。

诊断面板根据可观测证据提示帧预算、绘制批次、几何、纹理、填充率和 heap 压力，但这些提示只是缩小排查范围，不宣称完成因果归因。正式性能结论仍必须保存 Chrome Performance/GPU profile、机器与浏览器信息、场景哈希、画质、分辨率、功耗状态和重复运行原始数据。

当前阈值是用于发现明显异常的初始工程阈值，不是市场宣传指标：P95 超过 33.3ms、draw call 超过 1,000、三角面超过 5M、纹理超过 800 或 heap 超过上限 75% 时提示。完成 R1 至 R6 参考资产采样后，按设备等级和工作负载校准预算，严禁为了“全绿”放宽阈值。

### 确定性浏览器三维门禁（2026-08-28）

`pnpm gate:product-browser` 现已在显式验收构建中直接创建真实 `ViewerEngine`，用 120 个固定几何对象、73,840 个场景三角面、固定相机和相同 1440×900 视口分别验证 WebGL 2 与 WebGPU；画面夹具包含真实工业标签、对象轮廓/边缘光和 XRay 半透明对象，避免仅验证不透明基础几何。门禁还执行 1440→1024→1440 连续 Resize，以及同一引擎内 20 次场景清空/重建。两种后端必须完成渲染、尺寸恢复和资源统计，且没有 console/pageerror 或请求失败。

2026-08-30 最近一次包含 20 次切换的单次证据中，120 个可独立编辑和拾取的确定性对象仍为 73,840 三角面、WebGL/WebGPU 每帧约 122/123 draw calls；查看器级基础几何复用把 WebGL GPU 几何资源从历史基线 122 降至 8，WebGPU 为 3。该次 WebGL/WebGPU P95 约为 10.1/13.1ms，自动管线预热各完成 21 次，切换、Resize 与 WebGPU 设备丢失恢复均无 console、page 或 request error。帧时间是单次固定夹具证据，不能把与历史运行差值直接归因为几何缓存，也不能替代复杂场景重复采样；几何资源绝对门槛已写入门禁，后续回退到 10 以上会阻断构建。

该门禁用于阻断黑屏、Resize 错误、明显帧预算退化、切换后资源持续增长和无统计渲染；它不是 R1–R5 的正式性能排名，也不替代固定硬件的性能基准。正式结论仍需固定 GPU/驱动/功耗、30 秒预热、120 秒采样、每项 5 次、统一资产与画质，并用 Chrome trace/GPU 工具核对 WebGPU `renderer.info` 与 WebGL 统计口径。

## 云渲染对照

Industrial Studio 和 Unity 都必须在相同 RTX 4060/同级云 GPU、同一场景与相机轨迹下运行，并固定：

- H.264 硬件编码器、1080p60 / 1440p60 / 4K30、相同码率、GOP 和色彩格式。
- 相同浏览器、同一台客户端、同一 LAN；再分别注入 20/50/100 ms RTT、0/1/3% 丢包和带宽限制。
- 同一 STUN/TURN 路径；分别记录直连与 TURN 中继，禁止一方直连、另一方中继。

指标分解为 `input → server receive → simulation → render → encode → network → decode → present`，至少记录：

- 输入到显示 P50/P95/P99；首帧和重连时间。
- 服务端渲染、编码时间；客户端抖动缓冲和解码时间。
- 实际码率、丢包、重传、冻结帧、分辨率降级、PSNR/SSIM/VMAF。
- 每 GPU 并发会话、显存/编码器占用、单会话成本和故障回收时间。

Unity Render Streaming 官方资料说明分辨率、码率、网络状态和硬件/软件编码器会显著影响结果，因此这些变量
必须固定；只有完整 GPU Worker 与 WebRTC 链路通过故障隔离后，Industrial Studio 才能进入这组对比。

## 判定门槛

- WebGPU 成为默认：R1–R5 中至少 4 项的 P95 帧时间比 WebGL 2 改善 15% 以上，剩余项不得退化超过 5%，
  画质门槛通过且浏览器/GPU 发布矩阵满足要求；否则继续保持实验并自动回退 WebGL 2。
- “本地性能超过 Unity”只能限定到具体工作负载、画质和硬件；要求 P95 帧时间、峰值显存和首帧至少两项更优，
  另一项不差于 5%，并公开不占优的场景。
- “云渲染超过 Unity”要求同网络矩阵下输入到显示 P95 至少改善 10%，冻结帧率和画质不差，且每 GPU 并发/成本
  至少一项更优；任何一项只在降低画质或码率后获胜，不算超过。

## 依据

- Unity FrameTimingManager：https://docs.unity3d.com/cn/6000.0/ScriptReference/FrameTimingManager.html
- Unity FrameTiming：https://docs.unity3d.com/cn/6000.0/ScriptReference/FrameTiming.html
- Unity Render Streaming：https://docs.unity3d.com/ja/Packages/com.unity.renderstreaming%403.1/manual/index.html
- Unity 视频流参数：https://github.com/Unity-Technologies/UnityRenderStreaming/blob/main/com.unity.renderstreaming/Documentation~/video-streaming.md
- WebGPU Candidate Recommendation Draft：https://www.w3.org/TR/2026/CRD-webgpu-20260109/
- Three WebGPURenderer：https://threejs.org/manual/en/webgpurenderer
- Three TSL 与 RenderPipeline：https://threejs.org/docs/TSL.html
- Unity 6000.6 WebGPU 路线声明与 Beta 发布说明：https://discussions.unity.com/t/webgpu-out-of-experimental-in-unity-6-6/1734694 、https://unity.com/releases/editor/beta
