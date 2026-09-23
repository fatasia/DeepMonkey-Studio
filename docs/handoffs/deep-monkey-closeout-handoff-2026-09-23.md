# Deep Monkey Studio 收口交接（2026-09-23）

> 本文是当前工作区的收口交接，不等同于 V5 正式发布放行。Parasolid/X_T 工业格式 F7 按用户指令排除，不恢复。

> **2026-09-23 用户范围校正**：本轮不做百万构件/点云/3D Tiles/大坐标流式、协作、更多平台或自研 XR；Three WebGL + WebXR 既有路线保留，Bevy XR/WebXR/OpenXR 资料只作为历史调研，不形成实现任务。V5 收口延后到核心接线完成后。每项能力必须有运行时消费者、三维编辑器属性配置和回执/降级原因。

## 一、已完成且有真实消费者/测试或证据

### F 组

- **F1/F2 动态 GI 与 RT**：场景辐射 producer、环境读回、能量/历史约束、RT BLAS/TLAS 驻留、RT fragment 消费、RT/栅格像素对拍 99.883%；设备恢复与无 RT 回退证据已完成。Native lib/bin 多轮全绿。
- **F3 探针 GI**：96B ABI → storage/bind → 最近探针 → 网格头 → 三线性 8-tap → 多层级联（细/次粗两层混合，Web smoothstep 1.5 格语义）→ CPU 对拍 → 真机 GPU 像素证据 → Web 打包器 → 运行包载荷 → Native init → UI 烘焙入口/发布会话态。GPU 烘焙 2×2×2 真机 gate TRUE：8/8 覆盖，GPU/CPU 最差差值 2.33e-4，两次 bake JSON 逐位一致。多层载荷 v2 双形态合同已落地。
- **F4**：逐字段矩阵 6 域 53 行；3 处静默丢失已修复：作者六通道分级随 v9 运行包贯通、spot shadowSoftness 显式 degraded、environmentIntensity 非 1 fail-closed。author-grading 旧 EXE 拒/新 EXE 接受+GPU 逐位证据。
- **F5**：Deep2D select-v1/文本输入/视频/UIA、看板多选、IME 组合输入、触控 Touch 与鼠标统一链、Web 音轨策略、Native Media Foundation + rodio MP4/AAC 音轨首片。编译/校验会先探测 MP4 `soun` 音轨，无音轨的有声意图显式阻断；代码已接入播放/暂停/音量/seek/恢复。正式 Windows EXE 音频证据已通过：默认输出枚举、设备切换后从当前媒体位置重开、30 秒真实输出长稳、最大音画偏差 140.4 ms（门槛 150 ms）。证据：`test-output/native-audio-formal-evidence-2026-09-23.json`；复跑命令见 GLM 交接文档。
- **F6**：`packages/deep-engine/src/host.ts` 五主题 facade + `./host` 发布子入口 + smoke；viewerEngineInteraction 动画控制域拆分且公开 API 不变；仓外 Node/Browser 独立消费示例离线安装链通过；plugin-runtime compatibilityMatrix 公开导出与并发/失败重试/能力缺失 fail-closed 测试 40/40。

### I 组

- I2 能力驱动显隐：发布查看器按快照编译字段隐藏 clipping，未冒用对象级 `degradedCapabilities` 清单；I5 AI 模型目录、失败切换、reasoning effort、上下文预算、checkpoint 恢复闭环；I6 SDK 文档与可运行示例已同步。
- I3 六项全部清零：样条分段、固定 seed、门位、贴地投影、坡度边界、T/十字等宽 junction 盖板、道路 fixed 分段 cuboid 碰撞接入；junction/碰撞边界已明确。
- I4 图层/多选/组织面板与统一选择语义已落地。I1 既有材质/灯光/后处理/GI/烘焙等面板链已接入，F4 矩阵补证。

### V 组

- **V1**：三端冻结 box runner 首轮 3/3 端真实加载/8 帧/包 hash/GPU clean；逐像素 SSIM 与输入轨迹基线已建立。Web vs WebView SSIM 0.9944/0.9986；Web vs Native 原始 0.4037/0.4091，线性校准后 0.4854/0.4838；只建立基线，不判画质胜负。
- **Native 能力回执**：`native-player-report` 已增加 clustered lighting、dynamic GI、volumetric fog、统一质量档和 Frame Graph receipt 的显式状态及稳定原因码；选择轻量 `kind:volumetric` 时会报告 bounded screen-space steps，探针 GI/作者指数雾等已有局部消费仍按真实配置单独报告。另已接入显式 `DEEP_ENGINE_QUALITY_PROFILE` 的 Native Bloom 预算子集；这不等于跨端统一质量档。
- **V2**：Native release EXE 三路真实窗口验证、portable 包、GPU clean、dashboard 错入口 fail-closed；dashboard 空场景 occlusion 挂起已修为快速拒绝，正式 `.dmda` 链可用。
- **V3**：Unity 6000.0.52f1 WebGL 真实 batchmode 构建，加载/材质/输入/资源/发布 5/5 PASS；SwiftShader 口径，Unity 控制台上传链未覆盖。
- **V4**：a01x Babylon 既有配对轨道已复用；适配层与聚合器完成，短跑内存/长稳出数：peak-host 1033.2MB、mean-host 953.8MB、Deep P99 4.90ms、Babylon P99 4.70ms。Babylon visual similarity 中位 0.8376 < 0.92，结果 invalid/withheld，不宣称领先。

## 二、最近聚焦门禁

- plugin-runtime：vitest 40/40，tsc 0。
- Web dashboardMedia/docs：23/23，tsc 0。
- deep-engine host/runtime/lighting/bake：本轮 227/0（5 skipped），tsc 0。
- Native 最近稳定基线：全量 lib 551 passed / 0 failed / 1 ignored；bin 全量 289 passed / 0 failed / 78 ignored；Web 全量 4340 passed / 3 skipped；API 1539 passed / 12 skipped；Contracts 342 passed；资产与材质浏览器、数据中心流程、初始化/启动矩阵（13/13）均通过。媒体集成定向测试仍需目标设备证据。并行 Native 工作树有未提交改动，不能把当前树直接当最终发布树。
- V5 预检：11 PASS / 5 PARTIAL / 2 SKIP / 0 FAIL；按 PARTIAL 折算的当前发布准备度约 75%，正式最终门禁尚未宣称完成。

## 三、剩余任务（按用户最新优先级）

1. **P0 渲染质量消费回执**：复用 Web 现有高质量路径；Deep WebGPU 体积雾与一跳场景辐射 producer 已进入真实消费；Native 探针 GI storage/采样、直射光 irradiance seed、作者指数/Exp2 雾 output pass、受限 1–64 步体积雾 profile、Native-only 质量档预算子集和 clustered-lighting shader tile lookup 已接，继续补 ray-query 动态辐射更新/多反弹 GI、完整体积光照、跨端统一质量档和真实跨 GPU 对拍证据。
2. **P0 轻量 Profiler / Frame Graph**：实时 plan receipt 已进入 `FrameMetrics`/`StudioDeepPerformance`，诊断面板摘要与导出证据已接入；无 timestamp 时逐 pass 明确保持 `unavailable`。后续只补 Native/跨端回执对拍，不另建重型 profiler。
3. **P1 工业编辑闭环**：逐项复验 BIM 属性、材质槽、灯光、后处理、剖切、测量、动画、物理、导航、粒子和空间音频的“面板→运行时→保存/发布”链路。
4. **P1 资源增量**：v7 `dynamicRuntime` delta 白名单和入口依赖闭包已补；继续跑故障恢复、LKG 和等价包证据。
5. **P1 音视频证据**：在目标 Windows 设备取得默认输出、暂停/恢复、seek、设备切换、长稳和音画误差证据；Web codec 矩阵仍待真实浏览器。
6. **最后 V5 正式终验**：上述接线完成后再冻结工作树，统一跑全量构建/测试、性能与 30 分钟长稳、双主题/多分辨率视觉、a11y、完整交互轨迹、跨端连贯性、媒体音画同步、故障注入、离线启动和回滚；任一类别缺证据都不放行。

明确不排队：百万构件、点云、3D Tiles、大坐标流式、协作、更多平台和自研 XR 实现。现有 Three WebGL + WebXR 保留，V5 只做其回归检查；Deep WebGPU/Native XR 不进入任务分母。F3 后续烘焙增强与 V4 正式基准按独立门禁处理，不阻塞本轮核心接线。

## 四、并行工作区纪律

- 当前工作区存在 Native/V5/F4 等并行未提交改动及 `.tmp-*`、`scripts/benchmarks/babylon-web/` 留置文件；接手者不得 reset/clean/checkout，也不得把这些文件整批加入提交。
- 任何新切片必须先查本文、`deep-monkey-remaining-work-handoff-2026-09-22.md`、`engine-capability-expansion-plan-2026-09-22.md` 和最新台账，发现已有真实消费者立即复用。
- 正式终验前先按文件归属分批收口并复跑门禁；未验证项继续以未验证呈现，不把预检当终验。
