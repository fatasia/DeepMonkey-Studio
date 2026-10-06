# 渲染基准程序(2026-10-07 定稿)

> 用户拍板:指标全集按行业标准上表;浏览器组对比 three.js + Babylon.js;Unity 走**原生对原生**
> (我方 Deep Native vs Unity Windows 构建);**不考虑安卓**。
> 本文件是该程序的唯一事实源;README「性能实测」表只收录已按本程序实测入库的数字。

## 1. 指标全集(行业标准口径)

| # | 指标 | 定义 | 行业出处 | 采集状态 |
|---|---|---|---|---|
| M1 | 帧时间 P50/P95/P99/max | 静置(无输入无动画)与动态两 workload,rAF 帧间隔序列分位 | PresentMon 帧间隔 | ✅ 已采集(公平门) |
| M2 | 1% Low / 5% Low FPS | 最慢 1%/5% 帧时间均值的倒数 | CapFrameX/PresentMon 口径 | ✅ 采集已加(gate-deep-fair-comparison),待下轮实跑入库 |
| M3 | 卡顿率 | 帧 >16.7ms、>20ms、>2×中位数 三档占比 | Android Jank% 同型 | ✅ 同上 |
| M4 | 输入延迟 | pointer→submit、pointer→GPU 完成、pointer→present;标准词对齐 **INP**(Event Timing API) | Core Web Vitals / W3C | ✅ 前两项已有;INP 标准采集待接 |
| M5 | 首帧/场景就绪 | 对齐 **LCP** 语义:首次完整场景呈现;Deep 链另留六阶段 mark 分解 | Core Web Vitals | ✅ 已有 |
| M6 | 吞吐 | 60fps 预算下最大物体数(二分扫描,WebGL Aquarium 式) | Aquarium 传统 | ⏳ 新 workload 待建 |
| M7 | CPU/GPU 帧时分解 | WebGPU timestamp-query / EXT_disjoint_timer_query_webgl2 | Babylon SceneInstrumentation 同法 | ✅ three 与 Babylon 已接;three-webgpu 待接 |
| M8 | 一致性 | 同场景同相机位姿逐像素 SSIM/MAE、黑帧数、自确定性 SSIM | 本仓公平门(独有严谨项) | ✅ 已有 |
| M9 | 环境披露 | GPU/CPU/驱动/浏览器/引擎版本/协议参数,随证据落盘 | 基准可信性底线 | ✅ 已有(schema v2 host+dependencies) |

**纪律**:每格数字必须「脚本一键复现 + 证据 JSON/MD 落盘」;测不了的格子写 N/A,禁止录入社区传闻数;输入 P95 已设阈值门(≤1.2× 同轮 WebGL,超限即守卫失败)防止"切换成功即通过"。

## 2. 引擎矩阵

### A 组:浏览器同口径(进同一张表)
| 引擎 | 档位 | 状态 |
|---|---|---|
| three.js WebGL | `three-webgl` | ✅ 默认列,基线参照 |
| three.js WebGPU | `three-webgpu` | ✅ 默认列 |
| Babylon.js WebGPU 9.29.0 | `babylon-webgpu` | ✅ 已接入并通过几何一致性守卫(2026-10-07 三角面零差异) |
| **Deep WebGPU(TS 内核,产品桥投影)** | `deep-webgpu` | ✅ 2026-10-07 接入:`DeepWebGpuBackend` + `ThreeProjectionBridge` 直用,场景构造与 three 档位逐行同源(parity 由构造保证),动态负载走产品同款单在途同步 |

- 复现:`BIM_STUDIO_RENDER_BENCHMARK_ENGINES=three-webgl,three-webgpu,babylon-webgpu,deep-webgpu pnpm --filter @bim-studio/web benchmark:render-engines`
- 默认引擎矩阵在发布门中保持 `three-webgl,three-webgpu` 不变;新列升默认须经评审,防止发布门基线被静默扩大。
- fixture 合约:`apps/web/benchmarks/render-engine/src/fixture.ts`(确定性布局,PBR roughness 0.72/metalness 0.05,48° FOV 同机位,120/1000 物体两档,static/dynamic 两负载)。

### B 组:原生对原生(独立"参考表",永不与浏览器表混排)
| 项 | 我方 | Unity |
|---|---|---|
| 运行时 | **Deep Native**(`packages/deep-engine-native`,Rust/wgpu,入口 `pnpm run:scene-native`) | **Unity 2022.3.62f1**(本机 `D:\Soft\Unity\2022.3.62f1\Editor\Unity.exe`) |
| 场景 | 同一 fixture 合约移植(确定性布局、同机位、两物体档、static/dynamic) | C# 脚本生成同一布局,Built-in RP,构建 Windows x64(本机 IL2CPP 模块未装,如实采用 Mono 后端——非开发版变体;升级 IL2CPP 后重测) |
| 测量 | 帧间隔采样(原生侧同函数语义) | PresentMon(或 Unity `FrameTimingManager`)外部测量,不采自报数 |
| 标注 | **表头必须注明"原生运行时,与浏览器表不可直接对比,仅供参考"** | 同左 |

- 排除项:**安卓端不进任何基准表**(用户拍板 2026-10-07);用户同日拍板 B 组必须含 **deep-native 与 unity-native** 两列。
- Unity 许可为商业软件:场景工程与构建在本机完成,不进仓库;只入库 C# fixture 脚本与测量证据。
- **Unity 性能数字不用公开数据**(用户问询 2026-10-07,答复:不可):公开跑分场景/硬件/口径全部不可比,且违反"零基准禁定量"红线。Unity 的定性定位进能力对照表(下),性能列只来自 P3 自跑。

### 能力对照表(定性,只用公开事实,与性能表分离)

| 维度 | DeepMonkey Studio | three.js | Babylon.js | Unity(原生) |
|---|---|---|---|---|
| 运行形态 | 浏览器 WebGPU + WASM + Windows/Android 原生 | 浏览器 | 浏览器 | 原生为主,web 导出 |
| 引擎内核 | 自研(TS WebGPU 内核 + Rust/wgpu 执行器) | 社区开源(MIT) | 微软开源(Apache-2.0) | Unity 商业内核 |
| 完整编辑器 | ✅ 2D/3D/脚本/拓扑/数据内置 | ✗(官方仅示例编辑器) | ✗(Playground) | ✅ Unity Editor |
| 工业格式内置离线解析 | ✅ IFC/STEP/IGES/JT/X_T/DWG/OpenUSD/URDF 等 | ✗(loaders 生态) | 有限(glTF 系) | ✗ 需第三方(如 Pixyz) |
| 数据连接/语义层 | ✅ 32 类连接 + 语义本体 + 溯源账本 | ✗ | ✗ | 附加产品线 |
| AI 受控执行 | ✅ MCP 工具 + 差异确认 + 审计 | ✗ | ✗ | Muse(对话辅助,非受控执行) |
| 多端交付合同 | ✅ Web/Viewer/Windows/WASM 同一发布合同 | ✗ | ✗ | ✅(平台构建) |

## 3. 阶段路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | three 双列进 README 表 | ✅ 2026-10-06 |
| P1 | 指标升级:原始帧序列持久化 + M2/M3 采集(本变更);README 术语标准化 | ✅ 2026-10-07,待下轮实跑回填数字 |
| P2 | Babylon 首轮证据 → README 加列 | 🔶 采集进行中(2026-10-07 夜) |
| P3 | Unity 原生参考表:fixture 脚本 → 构建 → PresentMon 采集 → 独立表 | ⏳ 环境已确认,拆三步:P3.1 Deep Native 侧 fixture 移植(2026-10-07 核查完毕:①`PrimitiveKind` 合同原生支持全部 fixture 图元 box/sphere/cylinder/cone/torus/plane/capsule,SceneSnapshot 直构零资产可编译;②release 版 deep-engine-native.exe 在位,CLI `--package`;③原生侧缺帧时输出——需小改 Rust:present 环帧间隔记录、退出写 JSON;④包编译走发布链 SceneSnapshot→compileSceneRenderPacket→runtime-package,补无头 CLI 驱动。余量:Rust 帧时小改 + 无头编译脚本,约 1-1.5 天);P3.2 Unity 侧(Hub CLI 建 2022.3.62f1 工程 → C# fixture 脚本读同一布局 → IL2CPP Windows 构建 → PresentMon 采集);P3.3 原生参考表落 README 独立小节(注明"原生运行时,与浏览器表不可直接对比")。估 2-3 天 |
| P4 | M6 吞吐扫描 workload + M4 INP 标准采集 | ⏳ |

## 4. 变更清单(本次落盘)

- `apps/web/scripts/gate-deep-fair-comparison.mjs`:静置采样持久化 `framesMs` 并新增 `low1Fps/low5Fps/jankOver16_7/jankOver20/jankOver2xMedian`(增量字段,旧消费方不受影响)。
- `apps/web/benchmarks/render-engine/src/babylonWebgpuRuntime.ts`(新增)、`babylonAdapter.ts`(由 fail-closed 占位转真实现,依赖缺失/WebGPU 缺席仍如实抛错)。
- `apps/web/scripts/gate-render-engine-comparison.mjs`:引擎清单支持 `BIM_STUDIO_RENDER_BENCHMARK_ENGINES` opt-in,默认矩阵不变;报告标题改引擎中立。
- `apps/web/package.json`:`@babylonjs/core@9.29.0` 精确锁版(第三方许可审计走 `pnpm audit:licenses` 门,已过)。
- `contracts.test.ts`:Babylon 可用性断言随事实更新。

### 首轮实跑抓到的真缺陷(2026-10-07 夜,三引擎同轮首跑被门禁正确拦截)

1. **三角面 parity 违约**:Babylon 适配器首版三角面 149,082 vs three 73,842(+102%),几何一致性守卫按 1% 容差拒绝——门禁起效实证。修复:球/环手写 VertexData 对齐 three 拓扑(1216/1728),锥改 16 段(64)、胶囊锁 tess=8/cap=16(544),逐 kind 复核后总面数 73,842 **零差异**。
2. **重建成本失真**:MeshBuilder 每次重建新建几何导致 1000 物体重建 470ms(three 共享几何仅 3-4ms)。修复:模板 + clone 共享几何,与 three 的共享 BufferGeometry 同语义。
3. **GPU 帧时恒 0**:Babylon 默认不请求任何 WebGPU feature,timestamp-query 未启用。修复:`enableAllFeatures: true`(与适配器支持集取交集)+ 计数器改在 `engine.onEndFrameObservable` 读取。
4. **GPU 帧时单位错**:二轮实跑 GPU 列 246,784"ms"——Babylon 时间戳为**纳秒**且不做换算(webgpuTimestampQuery.js `addCount(duration)` 直通),已在我方采样侧除以 1e6 对齐 FrameMetrics 毫秒口径(three 侧 GPU timer 本为 ms)。
5. **three 灯对象混入投影根**:Deep 适配器首版把 HemisphereLight/DirectionalLight 放进投影根,门禁按"投影不支持的对象类型"拒绝。修复:投影根只含网格(renderRoot),灯光经 `projectThreeWorldLights` 转换走 `view.lights`——与产品语义一致。同批修复:`scene.background` 不被投影支持,背景只经 `RenderView.background` 传入。
6. **通用灯转换器不收 HemisphereLight**:`projectThreeWorldLights` 不支持半球光且直射光 shadow 需 authored 配置。修复:fixture 灯固定,按 `WorldClusteredLights` 接口手工构造(逐字段对应 three 语义),比硬凑通用转换器更诚实。
7. **GPU 计时通道用错**:`resolveTimestampsAsync` 是 three WebGPU 后端(lab/threeWebGpuBenchmarkBackend)的通道,Deep PbrRenderer 没有——静默无样本被门禁拦。正解:Deep 的 F1 opt-in `gpuPassTiming: true`,帧回执 `gpuPassTimings.milliseconds`(GPU 全帧跨度,滞后 1-2 帧)入样。
