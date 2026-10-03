# Drei 对齐方案：复用现有引擎，补作者消费与资源边界

日期：2026-10-01。状态：**方案，尚未实现或按本文验收**。服务现有 SDK、Studio 与应用内 SceneViewport；J/C/I 优先，本方案不改变原 61 项分母或完成数。

目标是吸收 Drei 的组合 API、生命周期与有限更新思路，让已有能力更容易正确使用。保持现有 contracts、runtime package/resource manifest、RenderPacket 和双宿主支持域；不引入 Drei/Fiber 运行依赖，不另建 renderer、loader、资源状态机或产品多视口。

## 1. 来源、目录与判断范围

上游固定为 [pmndrs/drei `bf6f4ad`](https://github.com/pmndrs/drei/tree/bf6f4addf47467d3885de272d94ca5127f6ef68f)，官方文档入口 [pmndrs.github.io/drei](https://pmndrs.github.io/drei)。详细源码对照见 [调研报告](D:/Documents/bim/bim-studio/docs/handoffs/drei-reference-analysis-20261001.md)；报告与原始目录位于本地 ignored 目录，正式方案不将它们当作已入库工件。

目录按固定源的 `src/index.ts → web/index.ts → core/index.ts` 实际 star/named/alias/type 导出解析，使用 TypeScript 5.9.3 checker；159 个源码文件逐 SHA 核验，导出图无 unresolved/重名歧义。默认 Web 379 个公开名称＝218 个运行时＋161 个纯类型；运行时再将 17 个公开支持符号单列，余 201 是组件/hook/factory 名称，不是功能数量。React Native 入口 331＝192＋139，和本仓 Rust/wgpu Native 不同。

完整表：[379 行 API 对照 JSON](D:/Documents/bim/bim-studio/test-output/drei-reference-20261001/capability-coverage.json)、[TSV](D:/Documents/bim/bim-studio/test-output/drei-reference-20261001/capability-coverage.tsv)、[原始导出目录](D:/Documents/bim/bim-studio/test-output/drei-reference-20261001/public-export-inventory.json)。顶层计数不递归计算 `View.Port` / `useGLTF.preload` 等静态属性。

`exactEquivalent` 需要范围、行为与生命周期证据；`partial` 只有已核实的能力重叠；`absent` 是未找到具体生产工作流；`notAudited` 是仅完成目录枚举。本轮未证明任何整套 Drei API 完全等价，不给功能覆盖百分比。

## 2. 现状核查（六步）

| 步骤 | 实际检查 | 已有（不重建） / 真实缺口 |
|---|---|---|
| 1. 全仓与未跟踪源码 | 搜索 packages/apps 的 demand、adaptive、cache、prewarm、viewport、IBL、LOD/BVH、portal、font；读取 git status，包含未跟踪叶 | 独立 WebGPU/Native 与 Three 作者路径已存在；正式源多线工作中，本方案只写本文 |
| 2. 契约与类型 | contracts `scene.ts/application.ts`；runtimePackage `types.ts/resourcePrewarmTypes.ts`；adaptive quality/environment 类型 | `SceneViewportWidgetNode`、资源 id/revision/contentHash、packageHash、prewarm 状态与预算已有；缺的是共同 host 消费边界，不是第二份场景模型 |
| 3. 依赖 | Web/engine package.json、Native Cargo.toml 与上游 package | React/Three/BVH/meshoptimizer、wgpu 已有；Drei/Fiber 未引入，也不作为本方案前提 |
| 4. 真正消费方 | SceneViewportPreview、viewerEngineCore/Loading、resourcePrewarmExecutor/adapter、PbrRenderer、dynamicIblResidency | 每 viewport 当前独立 ViewerEngine；按需渲染、缓存、原子预热、IBL/mip 驻留实际在用；单 canvas 多视图隔离未找到 |
| 5. 测试与证据 | sharedGltfAssets、viewerRenderDemand、SceneViewportPreview、resourcePrewarmLifecycle/Commit、dynamicIblResidency、reflection probes 测试；J/C/I 现有收据 | 复用原测试与真实 renderer；调研目录 CPU 4/4 只证明枚举完整性，本文各运行准入尚未执行 |
| 6. 规格链 | 09-27 核心能力计划、J3 Gate E 生命周期、remaining 表、active recovery ledger、10-01 调研 | 服从现有支持域与验收；用户指向的 09-22 expansion handoff 本轮未找到，不引作已读权威 |

现有 `dashboardCompositionHost.ts` 承担 2D/chart 候选合成，不是完整 3D 多视图实现。SceneViewport 的 IntersectionObserver、semantic revision、renderMode/interactionPolicy 都要保留。

## 3. 15 个能力族导航

| 族 | 本仓判断 | 本方案处置 |
|---|---|---|
| 按需 / 自适应 / 预热 | 已有 demand、CPU/GPU P95 质量策略、prewarm；partial | P0 统一消费与阶段，不换控制器 |
| 实例 / LOD / BVH / 空间采样 | 已有批次、SSE/HLOD、BVH/TLAS；partial，部分 API 未审 | P2 精选 facade；保留差量上传 |
| 相机 / Controls | 已有 Orbit/PointerLock、Deep 输入、framing；其余模式未逐审 | P0 归属；P2 作者便利 |
| Gizmo / Grid / helper | 变换工具与方向立方体有真实消费；partial | 复用现有工具，不另造 HUD |
| 资产 / 纹理 / 媒体加载 | glTF/FBX/KTX2、缓存、video/audio 已有；partial | P0 所有权和 ready 阶段 |
| Text / Text3D / 字体 | 2D glyph/DOM 已有；空间 SDF 与挤出字体未找到 | 新视觉候选，独立验收 |
| Html / DOM / 输入挂载 | 标注布局/命中已有；完整 Drei API 未审 | P2 变化时更新，保留标签优先级 |
| View / Portal / FBO | 产品多视口与内部 targets 已有；交互门户未找到 | P1 共享 host；portal 后继候选 |
| 几何 / 曲线 / 贴花 | 基础 primitive/clone 已有；其它未逐审 | 不按文件名补齐，按作者用途挑选 |
| 动画 / procedural deformation | timeline/骨骼/播放已有；其余未逐审 | 不加入第二动画状态机 |
| 环境 / 布光 / 氛围 | IBL/probes/sky 已有；Lightformer 工作流未找到 | P1 有限更新；形状布光单列 |
| 阴影 / 舞台布局 | CSM/contact/baker/framing 已有；算法不等同 | P1 调度边界，不替换阴影算法 |
| 光学 / 自定义材质 / 效果 | SSR/IBL/Bloom/Fog 已有；焦散/生产平面镜未找到 | 原画质门不变，新视觉独立候选 |
| Splat | 生产 owner/pass 已有；高阶 SH 当前不等同 | 保留 DC 渲染与高阶数据边界 |
| 面捕 / 演示 / 上下文工具 | 面捕未找到，其余未逐审 | 面捕/新输入设备排除；不为导出数量追平 |

## 4. API 与资源原则

采用 api-and-interface-design：先明确输入、输出、所有权和失败行为，再做适配；扩展现有接口，不分叉第二版本。不复制 Drei 的 props 名单或 R3F 全局 store。

输入复用 `SceneViewportWidgetNode`、runtime resource index/manifest、已有 camera/quality/environment；输出复用 prewarm result/diagnostics。仅新增实际消费者需要的可选字段或只读观察口，公共签名前先核验旧行为。资源/场景类型不暴露 WebGLRenderTarget、Three prototype 或 GPU handle。

| 边界 | 保持的合同 |
|---|---|
| 身份 | resource id/revision/contentHash、packageHash、deviceEpoch 与现有 owner；view 用已有 node.id，不生成第二身份体系 |
| 所有权 | host 持有 device/pool；资源 lease/reference 复用已有机制；view 只释放自己拥有的 history/targets/输入订阅，借用资源由 owner 释放 |
| ready | fetch/decode/resource commit/pipeline readiness/first-presented 是观察阶段；保留现有 committed/unchanged/aborted/superseded/failed，不另写发布状态机 |
| 失败 | 边界校验沿 RuntimePackageError、既有 path/message/status；失败候选不得改可见 publication，unsupported 必须保持原支持门 |
| 取消 / 重入 | generation/latest-wins/AbortSignal 与现有 idempotent dispose；迟到任务只清理自身资源，不复活关闭 view |
| 可观测性 | 仅实际到达边界才报告阶段；无法观察则 unavailable/null，不能将 prepare 完成当真实 present，不能将 CPU 计时叫 GPU 时间 |

## 5. 工作包与最小交付

### D-P0：所有权与 ready 阶段（先做）

复用 sharedGltfAssets、RuntimeResourcePrewarmExecutor、runtimePackage WebGPU adapter、DeviceSession 与真实 host 的 present 边界。先选一条真实资产预览链，提供短调用示例和只读阶段观察，不改现有资源/原子发布器。

补共享对象两消费者、一方关闭、加载失败、取消后迟到、同内容复用、SPA/HMR 重入；每个阶段记录当前 package/view/epoch 身份。缓存 clear 和 lease release 分别解释，重复 dispose 不重复释放。

完成条件：CPU 负例、真实预览阶段顺序和生命周期循环通过；pipeline-ready 没有已消费的正式信号时保持未知，不能用 compile Promise 或资源数推定。

### D-P1A：既有两 SceneViewport 共享一个 host

保留原 node/frame/cameraViewId/renderMode/interactionPolicy，先选同包、两相机、相同合法渲染 profile 的两个实际产品 viewport；只把底层接入一个 renderer/canvas 原型。原每 node 独立 host 路径继续可用，原型尚未准入时不改默认。

共同 geometry/texture/pipeline 使用现有身份与资源池；每 view 的 camera、depth/color/normal/motion、TAA/SSR/history、选取/readback、viewport/scissor、输入归属独立。已有 render graph/targets 按真实需求扩展，不只增加 scissor 就称完成。

DOM rect→画布像素转换复用已有布局，覆盖 scroll/resize/DPR/offscreen；点击、拖拽、gizmo 只能消费所属 view。关闭 A 不清空 B，不重置 B 历史或重复解码共享包。

此刀先验证 WebGPU 与现有产品路径；Native 用窗口像素 rect 的适配是单独准入，未验证不宣称双端完成。不新增操作系统/设备平台，不依赖 DOM 作为引擎合同。

### D-P1B：已有环境工作的有限预算与睡眠

复用 dynamicIblResidency、environment/probe owner、FrameScheduler、demand 与既有 bake/prewarm producer。针对真正存在的 stage/upload/bake 工作定义依赖 fingerprint、reset、有限 work budget 和完成后 sleep；不把 prepared IBL 冒充动态场景六面捕获。

指纹只包含实际 producer 消费的 identity/revision/contentHash、参数与 deviceEpoch；相机、光照、几何只有在该 producer 实际消费时才加入。未变化复用，变化取消旧代际，失败保留上一次合法环境。

保持原 keptMips、预算、C15 探针数量和 LUT 所有权；自动预算/LUT 生成共享等既有剩余任务分别推进。本方案不为光照错误减小曝光或删 mip。

没有生产 scene-capture 接线的功能继续单列候选，不为实现 `frames` 字段另造一个 cubemap renderer。

### D-P2：精选作者 facade

P0 已稳定后，从实际痛点选最多三条：实例 typed attributes/嵌套变换、camera fit/controls 所有权、cache preload/阶段观察或少量富标注。输入沿现有合同，薄适配调用已有能力；文档例子必须是实际公开 API 可执行路径。

保留稳定 model/instance ID、选择映射、差量上传、SSE LOD 和作者 override。大场景不转为每对象 React 订阅，每标签不默认逐帧 raycast；静态属性变动范围要有实际上传计数。

### D-V：新视觉候选（不并入前四刀）

按真实用途另立小规格：空间 SDF/Text3D 工业标签、设备屏幕 render-to-texture 门户、平面镜/地面反射。每项先查已有 glyph、屏幕材质、SSR/水面 CPU 参考，明确新增算法与作者入口，再给独立估计。

Lightformer/焦散仅在有实际作品需求时排期；面捕、新输入设备、新平台、Ascii 演示、全部 R3F hooks 复刻不进入当前范围。低优先级不代表“已经有”。

## 6. 顺序、净工时与运行准入

依赖：J/C/I 当前锁定工作及统一收据优先 → P0 → P1A/P1B 可按文件锁并行 → P2；新视觉候选各自开工前复核。GPU/Cargo 串行队列和正式 source freeze 继续有效，方案不插入当前验证队列。

| 工作包 | 净工程工时估计 | 估计边界 |
|---|---:|---|
| P0 所有权 / 阶段 | 8–16 h | 一条既有产品链＋focused CPU＋20 循环真机验收 |
| P1A 两 view 共享 host | 24–40 h | WebGPU 同包两 view、历史/输入隔离；Native 额外 8–16 h 仅在范围确认后 |
| P1B 有限环境工作 | 8–16 h | 既有 producer 调度；不包含新 scene-capture 算法 |
| P2 最多三条 facade | 6–12 h | 仅已有能力薄适配、例子与消费测试 |

现阶段主路径合计 **46–84 净人时**，不是日历承诺；不含 GPU 等待、J/C/I 既有工作和新视觉算法。开工时按最终消费者/源锁更新，不能用并行路数直接除成墙钟工期。

| 实测门 | 准入要求 |
|---|---|
| Zero idle | 固定静态输入、无动画/video/XR/待处理任务，settle 后连续观察 ≥10 s；heavy render/capture/重复 upload 为 0。轻量 RAF/OS compositor 单列，不宣称整进程 CPU 为 0 |
| 20 生命周期循环 | 同一 live host 做打开→共享→关闭 A→B 保留→全部关闭 20 次，含失败/取消/迟到/重入；lease/订阅/owned targets 回到登记基线，无逐轮增长；保留原始记录 |
| 共享资源 | 同身份不重复 decode/upload；跨 epoch 不借旧 GPU handle；B 活跃时 A 关闭不 dispose 共用资源；计 source/upload/resident/driver bytes 各自口径 |
| View 隔离 | 两相机不同遮挡，独立 history/选取/gizmo；scroll/resize/DPR/隐藏恢复/单 view 关闭均实际测试，错 view/旧 epoch/缺对象负控必须失败 |
| 性能 | 同包/相机/profile/尺寸下比较原独立 host 与共同 host 的 CPU、GPU、提交与资源数；登记 P95 和峰值，未改善先定位，不宣称固定加速倍率 |
| 原画质 | 不改变 J5 strict、J3 各域、C8/I 系列材料/显示与合法 profile 门；同输入原 HDR/display/深度/阴影证据照旧，不扩大容差、删困难资产或冻结点 |
| 收据与身份 | 精确 package/源/工具/binary/profile/hash，两个独立 fresh 宿主；旧失败与新结果并列。性能归属与 GPU/CPU 时间分开，驱动缺失数据保持 null |

Web 产品改变需执行既有设计验收与至少两轮截图检查；本轮文档没有创建或改变 UI，未执行这些未来运行门。Native unknown driver fault、驱动残留预算和初始上传 coverage 继续由 J3-E 处理，生命周期 20 循环不代替它们。

## 7. 本轮交付与自审

本轮仅正式方案，未新增运行依赖、API、renderer 或产品行为；61 项完成数不因本文增加。源码调研目录与负例 CPU 4/4 已完成，本文工作包均是待实现/待实测。

自审：六步现状核查有具体锚点；产品多视口已存在的事实保留；准备资源与呈现阶段不混淆；prepared IBL 与实时捕获不混淆；类型/支持符号不当功能计数；15 族未审范围留账；估计与已验证事实分开；原支持域、失败证据与画质门完整保留。
