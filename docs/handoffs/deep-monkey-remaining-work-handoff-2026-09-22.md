# Deep Monkey Studio 剩余任务交接

日期：2026-09-22  
范围：`bim-studio` 当前工作树与本轮用户目标  
排序原则：先做引擎/功能实现，再做编辑器与发布接入，最后做跨端一致性、正式打包和全量验收。本文不安排空间清理，也不替代 `docs/active-task-recovery-ledger.md` 的证据记录。

## 1. 接手规则

1. 开始任何任务前，依次读取本文件、`docs/active-task-recovery-ledger.md`、相关 `docs/specs/`、最近提交、工作树状态和现有测试入口。
2. 先定位现有实现和消费者，再决定是补实现、补接线还是只补证据。已有合同、渲染器、控制器、发布审计和测试必须复用，不得另建平行实现。
3. 每个任务写清：现有入口、缺失条件、修改边界、测试证据和下一层依赖。只有代码进入真实消费者后才能从“功能开发”移动到“上层接入”。
4. 失败、取消、设备丢失、旧包恢复、未知字段和不支持能力必须保持显式诊断；不能用 fallback、合成三角形、仅生成 EXE 或单点微基准宣称完成。
5. 代码新增模块原则上小于 300 行，复杂控制器小于 400 行；500 行触发拆分评估，800 行直接阻断。拆分必须做行为、视觉和性能回归。
6. 最终测试集中执行；实现阶段只跑与当前切片直接相关的类型检查、单元测试和必要的 GPU/编译门禁。

## 2. 已完成，禁止重复建设

下列事项已有代码和聚焦证据，后续只做接入复核或最终验收：

| 领域 | 已有事实与入口 | 接手动作 |
|---|---|---|
| 2D/3D 图层 | 图层统一模型、排序/可见/锁定/多选、拖拽审计及 3D 默认间隙修正已在现有编辑器链路 | 只做最终页面和响应式验收，不重写图层模型 |
| AI 助手 | `AssistantModelControls`、模型/思考强度选项、请求传递与会话快照已有；相关 Web 聚焦测试通过 | 只补真实供应商回执、刷新恢复和正式页面验收 |
| 缓存与健康 | `/api/admin/cache/three-scene-viewer` 已注册；缓存 UI、健康探针品牌兼容已接入 | 旧 API 进程需重启复验，不能另建路由 |
| 仅发布文案 | `ScenePublicationDialog` 首项已改为“仅发布”，Three WebView/Deep Native 独立显示 | 只做发布页面实点与产物复验 |
| 围栏/道路 | `prefab + placementPath` 已进入 RenderPacket，发布投影字段已补 `prefab`；道路误报回归已通过 | 继续补完整编辑器入口和正式 Native/Three 运行证据 |
| Native 发布降级 | `degradedCapabilities` 已写入 manifest；可选缺失能力可降级，资源/hash/未知字段仍阻断 | 只补真实 EXE 行为与按钮可见性 |
| Native 导航基础 | orbit 碰撞、WASD/QE/Shift/Space 状态和相机合同已有；first/third person 仍有明确边界 | 按“功能开发”缺口继续实现，不能把基础 orbit 证据扩大成完整导航 |
| Native Hi-Z | 上一帧 Hi-Z、相机变化后一帧保守旁路、compact 消费链已接；当前 auto 默认启用，可显式关闭 | 补收益阈值遥测与同设备基准，不重复建裁剪链 |
| Native RT 基础 | wgpu 30.0.1 的真实 BLAS/TLAS、Ray Query 命中探针、生产 40-byte buffer 校验已通过 | 继续正式 Renderer 像素消费，不能宣称场景级光追完成 |
| 材质源恢复 | glTF 源参数、颜色意图、UV/采样恢复和材质槽编辑已有 | 只补 Native/发布消费和最终画面对拍 |
| SDK/文档中心 | SDK 入口、借鉴设计理念、性能基准入口已进入现有文档中心；仓外 SDK 门禁已有 | 补统一宿主生命周期、输入合同和最终文档收口 |

## 3. 第一阶段：开发与功能实现

这一阶段只实现可复用的引擎能力和稳定合同，不先做页面按钮或打包脚本。

### F1. 动态 GI 与探针真实辐射

- 现有入口：`packages/deep-engine/src/webgpu/probeClipmapRuntime.ts`、`webgpuProbeCaptureAdapter.ts`、`ProbeClipmapCaptureExecutor`、`PbrRenderer`。
- 状态（2026-09-22 切片1 完成）：Web 一跳场景辐射 GPU 生产者已落地并有真机证据——`rayTracing/probeRadianceKernel.ts` + `probeSceneRadianceProducer.ts` 实现 `encodeSourceRadiance`（静态 opaque + 主直射光 + 环境项，TLAS→BLAS 软件遍历复用 RayBackend），`PbrRenderer.createProbeClipmapController` 使产品宿主 `radianceSource=scene` 真实成立；真机 GPU 读回对拍 gate TRUE（台账 2026-09-22 F1 切片1 条）。
- 剩余缺口：环境均值读回（当前 ambient 宿主零值）、动态脏区/设备恢复在真实 Studio 场景的收敛证据、2–4 次受限历史反馈、能量钳制、泄漏与收敛诊断。
- 实现顺序：先做 Web 一跳场景辐射（已完成切片1），再做动态脏区/设备恢复；随后以同一记录格式增加 2–4 次受限历史反馈、能量钳制、泄漏和收敛诊断。
- 边界：没有真实辐射源时保持 IBL，禁止用 fallback 或黑色体积发布为 GI（生产者已强制：零能量输入拒绝捕获）。
- 完成证据：GPU 读回一跳能量（已达成切片1）、遮挡/泄漏、动态对象更新、相机切换、设备丢失恢复；`radianceSource=scene` 由正式宿主产生（已达成）。

## 用户范围变更（2026-09-22）

- **F7 工业格式高价值 profile 整项排除**（用户指令，本轮不做）：X_T/RVT/E57/LAS/COPC/3D Tiles/3DM/JT/SLDPRT/SLDASM 全部不排期；已完成的研究证据保持现状，不做生产接线。

## 第一阶段：开发与功能实现

### F2. 正式硬件 RT 阴影路径

- 现有入口：`packages/deep-engine-native/src/hardware_ray_query.rs`、`gpu_scene.rs`、`renderer/frame.rs`、`renderer/scene_update_stage.rs`、`mesh_pass.rs`、`pipeline.rs`。
- 缺口：Renderer 没有 RT residency、TLAS、RT bind group 或像素查询；当前只是独立探针，主通路仍是栅格 CSM。
- 最小生产切片：选定 adapter/device 支持时，为唯一静态 opaque geometry 建 BLAS；按当前 resident instance/transform 建 TLAS；在 stock PBR directional shadow fragment 中执行 Ray Query；能力不满足、MASK、BLEND、LOD/变形几何回退现有栅格路径。
- 后续：加入静态反射，再评估 RT 探针遮挡/GI；动态 skin/morph 在没有 Native AS 顶点更新链前保持回退。
- 完成证据：同一场景 RT/栅格阴影像素对拍、TLAS transform-only 更新、设备不支持回退、MASK/BLEND 回退、设备恢复和 PlayerDiagnostics 状态。

### F3. Native GI/探针 ABI

- 现有入口：Native `frame.rs`、`gpu_ibl.rs`、`native_mesh_v1.wgsl`、发布 lighting contract。
- 缺口：Native 没有探针体积、采样绑定、真实辐射捕获与 PBR GI 混合链。
- 实现：复用 Web 的探针记录布局和质量预设，设计 Native 离线/实时两种 producer；先接静态 baked/scene capture，再接动态更新；能力、预算、设备丢失和降级原因进入统一 manifest。
- 完成证据：Native PBR 画面实际采样探针，旧包兼容，空场景零分配，设备恢复不读悬挂资源。

### F4. 材质、光照、烘焙、色彩和后处理完整消费

- 现有入口：Web `pbrShader.ts`/后处理链、Inspector 材质槽和作者合同；Native 当前真实消费主要是 ACES、雾、Bloom/既有光照，作者非零色彩分级仍会被精确降级。
- 实现：先统一材质字段校验、默认值、继承/覆盖/预设；再补 Native 可消费的色调、曝光、温度、色调、饱和度、亮度、对比度、AO、反射和烘焙结果；不能消费的字段保留明确 `degraded` 并隐藏对应发布入口。
- 完成证据：属性面板→快照→运行包→Web/Native 渲染的逐字段对拍，旧包兼容，失败不静默丢字段。

### F5. Deep 2D 基础元素与 GUI parity

- 现有入口：Deep2D runtime/compositor、`control_render.rs`、Native 输入/IME/atlas、Web Dashboard lowering。
- 剩余：输入框完整 IME/剪贴板/焦点链、多选/级联 select、表格编辑与分页联动、视频音频边界、图表 tooltip/legend/动态增量，以及正式窗口中的滚动、DPI、触控和键鼠一致性。
- 实现顺序：先统一控件语义和焦点/事件合同，再补元素消费；每个元素同时输出 capability/diagnostic，不能只做静态绘制。
- 完成证据：键鼠、触控、IME、剪贴板、焦点、滚动、空态/错误态、980px 窄窗和双主题真实窗口回归。

### F6. 引擎 API/SDK 分层与大文件拆分

- 现有入口：Deep Engine 导出、PbrRenderer、SDK 文档与仓外 consumer gate。
- 剩余：统一宿主入口、模块生命周期、插件启停/兼容矩阵、公开 GUI/输入合同和第三方独立使用示例。
- 结构治理：优先按稳定边界拆分 `apps/web/src/viewer/viewerEngineInteraction.ts` 的动画控制域，再评估 annotation/设备消息域；保持既有公开 API 兼容，拆分前后做行为和性能回归。
- 完成证据：仓外空工作区离线安装、Node/Browser/Native API 示例、插件隔离、文档中心可运行样例。

### F7. 工业格式高价值 profile

按 `industrial-3d-format-work-plan-2026-09-16.md` 分层推进，不把文件头或包围盒当成生产支持：

- X_T：扩展当前 V24.1 旋转件子集到已验证平面/圆柱/圆锥/球/圆环/修剪面/多实体，再做 NURBS/交线；未知 Schema 保持 inspect/preview。
- RVT：自研/开源 Reader 的版本、构件身份、几何、楼层、链接、机电和未知字段证据；现有 Revit Worker 只能作历史对照。
- E57/LAS/LAZ/COPC：本地 Reader、CRS/量化/姿态/分类/空间索引、Web/Native 点云驻留和裁剪。
- 3D Tiles：本地依赖闭包、mesh/glTF 后补 b3dm/i3dm/pnts、implicit tiling 和 metadata；禁用在线 provider。
- 3DM：保存网格、Brep/Extrusion、块实例、图层、UUID、法线/UV/材质；无缓存 NURBS 与插件对象保持明确预览边界。
- JT/SLDPRT/SLDASM：按真实样本矩阵和许可证审计推进；没有几何/拓扑/版本证据就不开放 ready。

## 4. 第二阶段：上层接入

只有第一阶段的合同和最小运行证据成立后，才进行页面、编辑器和发布消费接入。

### I1. 编辑器属性面板

将已有材质、光照、后处理、GI、烘焙、阴影、反射、相机、碰撞、导航、围栏、道路、视频和数据绑定字段按统一分组接入 Inspector。每个字段必须有默认值、继承/覆盖状态、单位、重置、撤销、锁定态和 capability 显示；同一字段只保留一个写入口。

### I2. 能力与设置入口

性能设置放在设置页作为全局 auto/显式覆盖/预设；场景质量、光照、GI、阴影和调试开关在编辑器场景设置中显示，并由统一配置合同合并。Native 不支持的按钮按 manifest `degradedCapabilities` 隐藏，不能把设置页和编辑器各做一套开关。

### I3. 围栏/道路与导航

把已有道路/围栏 RenderPacket 消费接入创建、编辑、撤销、保存、预览和发布；补贴地、样条、道路连接、碰撞、坡度/跳跃边界和固定 seed。Native 未实现的导航参数继续显示精确降级原因，避免把 orbit 回退包装成 first/third person 完成。

### I4. 2D/3D 统一层与 GUI

复用统一对象 identity、可见/锁定/选中/父子层级、排序和命令历史；2D 以画布坐标，3D 以场景节点表达，但共享选择、过滤、撤销、快捷键和权限语义。补齐图层面板无多选间隙、空态、拖放反馈和双主题。

### I5. AI 助手上层闭环

接入真实模型目录、供应商回执、思考强度实际生效、失败切换、上下文预算、普通问答与工业 Agent 恢复；刷新/重开会话后恢复可解释性快照，但不把历史快照当成重新执行结果。模型不可用时给出可操作错误和回退状态。

### I6. 文档中心与 SDK

在现有文档中心继续收口：SDK API、插件生命周期、Deep 2D/3D 元素合同、Native 能力矩阵、性能配置、借鉴 Unity/Babylon/Bevy/Godot 的设计理念，以及最终基准报告。文档引用真实命令和产物路径，区分已完成、待接入和明确阻断。

## 5. 第三阶段：跨端一致性、打包和最终验收

该阶段只在功能和上层接入完成后执行，避免在未稳定的接口上反复截图和打包。

### V1. 三端同内容对拍

同一冻结场景、同一资源 hash、同一相机/输入轨迹，分别运行 Web、Three WebView、Deep Native；比较元素可见性、材质/光照/后处理、文字/图片/输入框/视频、图层/选择和键鼠行为。所有差异写入 capability matrix，不能用降画质掩盖差异。

### V2. Native 正式发布

真实启动 Deep Native EXE，检查窗口、工具栏/快捷键、相机、测量、剖切、选择、属性、输入、离线资源、设备丢失和旧版本恢复。Three WebView 走真实下载和启动链；“仅发布”只验证网页产物，不当作客户端包。

### V3. Unity WebGL 插件验证

验证本项目插件导出的 Unity WebGL 包在 Deep Web 中的加载、材质、输入、资源和发布行为；Native 不支持 Unity，保持明确排除，不把该限制转成伪兼容入口。

### V4. 正式性能基准

只运行 Three、Babylon、Unity、本地隔离的 Bevy 0.19 四个正式对手；UE/Godot 保留架构研究，不下载、不安装、不参与排名。使用同设备、同内容、同画质口径，采集 CPU/GPU P50/P95/P99、加载到可交互、输入延迟、峰值内存、30 分钟稳定性和画质相似度。不能用局部微基准或降画质宣称超过 Unity/Bevy。

### V5. 全量门禁

最后统一执行 Web/API/Deep Native typecheck、单元/集成/E2E、视觉回归、双主题/多分辨率、故障注入、可访问性、正式构建、离线启动、发布回滚、source-size 和仓库门禁。发现缺陷时先排查同机制族，再修复和重跑对应证据。

## 6. 依赖关系与交付状态

```text
功能开发 F1–F7
        ↓
上层接入 I1–I6
        ↓
跨端/发布/性能/全量验收 V1–V5
```

当前不要把以下事项提前标为完成：动态 GI、Native 探针 GI、正式硬件 RT 画面路径、完整 Native 后处理色彩、完整 Deep2D 元素、first/third person 导航、工业格式 ready、正式 EXE 画面对拍、同设备胜出基准。

当前明确排除：Native 支持 Unity、UE/Godot 正式性能排名、完整商业 CAD/源软件依赖、完整 Shader Graph 产品、重型路径追踪、移动端适配、完整 OLP/PLM、认证级人体工效，以及本交接文档范围内的清理任务。

每完成一个切片，必须同步更新本文件对应状态、`docs/active-task-recovery-ledger.md` 的证据、相关 spec 和测试命令。没有新增实现、消费者或证据的重复运行不计进度。
