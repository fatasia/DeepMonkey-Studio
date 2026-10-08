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

- **参照列缓存(2026-10-07 落地)**:引擎按单元缓存(three 双档=一个视觉对单元;Babylon、Deep 各一单元)。指纹 = 引擎版本 + 主机(CPU/GPU/内存) + 协议参数 + 相关源码哈希(benchmark src、gate、evidence 模块;Deep 单元另含 threeBridge 源码树)。指纹一致 → 复用上轮该单元全部证据与截图,只重测变更单元;命中与来源轮次在报告/markdown 首部披露,混合轮次表头不得声称"同轮"。`BIM_STUDIO_RENDER_BENCHMARK_NO_CACHE=1` 强制全重测。缓存写入发生在有效性守卫全绿之后,失败轮不留缓存(fail-closed)。
- 复现:`BIM_STUDIO_RENDER_BENCHMARK_ENGINES=three-webgl,three-webgpu,babylon-webgpu,deep-webgpu pnpm --filter @bim-studio/web benchmark:render-engines`
- 完整 23 列报告：`test-output/render-engine-comparison/report.md`；Unity 原始采样与摘要：`test-output/unity-native-bench/summary.json`。Unity 首帧包含播放器启动；Mono 播放器 GPU 帧时不可用，Draw Calls 无逐帧公开计数，README 对应格保留“—”。
- 默认引擎矩阵在发布门中保持 `three-webgl,three-webgpu` 不变;新列升默认须经评审,防止发布门基线被静默扩大。
- fixture 合约:`apps/web/benchmarks/render-engine/src/fixture.ts`(确定性布局,PBR roughness 0.72/metalness 0.05,48° FOV 同机位,120/1000 物体两档,static/dynamic 两负载)。

### B 组:原生档(2026-10-07 用户拍板:合并进主表,列头星注原生口径;原"独立成表"方案废止)
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
| P3 | 原生 fixture → 构建 → 采集 → README 主表原生列 | ✅ Deep Native 主表九行均已实测，静置两档、动态与重建共 12 轮证据落盘；Unity Mono 列保留现有口径，GPU/Draw Calls 空格原因见 §2。原生输入延迟、吞吐与长稳不属于本次主表采集。 |
| P4 | M6 吞吐扫描 workload + M4 INP 标准采集 | ⏳ |

### P3.1 Deep Native 首次静置实测（2026-10-07，历史轮次）

现状核查：已有 `SceneSnapshot` / `PrimitiveState` 合同、`fixtureObjects`、场景绘制/相机/环境编译器、runtime-package builder、Player telemetry 及测试，不重建。真实缺口是基准 fixture CLI、采集和摘要校验。原生帧间隔原始序列已经由 `metrics.benchmark_sample_window.channels[frame-interval]` 输出；旧版“缺原生帧时输出”的判断作废。

首次静置版本不含观察器；当前复现命令见 P3.2。脚本入口（仓库根目录，安装现有 workspace 依赖后）：

```powershell
cargo build --release --locked --features native-bench --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native
pnpm --filter @bim-studio/web benchmark:deep-native --test
pnpm --filter @bim-studio/web benchmark:deep-native --probe
pnpm --filter @bim-studio/web benchmark:deep-native
pnpm --filter @bim-studio/web benchmark:deep-native --check
```

- fixture 直接复用布局，经过 `compileSceneRenderPacket` → `buildDeepRuntimePackage`，零外部资产。120/1000 设备分别加一个地面；逻辑三角面数 **73,842 / 614,294**，7 种共享几何、7 个共享材质。Player 启动打印的 3,694 三角面是唯一几何资源合计，不是实例展开后的逻辑面数。
- `compileSceneCamera` 之后固定为基准的 48° / near 0.1 / far 5000；方向光 2.2、半球光 0.35、exposure 1.05。Native 使用 AutoVsync、frame latency 2、4×MSAA、4 级 2048×2048 CSM。几何与位姿校验不表示跨引擎逐像素一致，阴影与输出管线差异保留披露。
- 每档 3 轮，每轮预热 **120** 帧后重置遥测，再采 **512** 个呈现帧 / **511** 个间隔，窗口约 **3.56s**。使用原始 ms 序列，按浏览器 `FrameSampler` 相同 nearest-rank 算 P50/P95/P99/max，再取三轮统计中位；max 列是三轮各自最大值的中位。
- 时钟为 `web_time::Instant`，测量成功呈现帧的主机间隔；`surface.present` 没有合成器完成时间戳，禁止标成 PresentMon 或屏幕完成延迟。CPU/GPU 遥测开启，报告只在窗口结束读回。
- 主机 i9-12900HX / RTX 4060 Laptop / Windows 10.0.22621；Vulkan / NVIDIA 595.79，Rust/wgpu 30.0.1 release。EXE SHA-256 `a6bcb9547a8983805ccc72b621e0e23149953f246dc4bd1c70a323fc243c2da9`；未内嵌源码 commit，完整 Native 源码哈希清单与二进制身份随证据保存。

| 物体数 | 轮次 | P50 ms | P95 ms | P99 ms | max ms | 窗口 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 120 | 1 | 6.9392 | 7.3948 | 7.6417 | 7.8292 | 3557.0040 |
| 120 | 2 | 6.9305 | 7.5286 | 8.1489 | 12.1002 | 3557.7719 |
| 120 | 3 | 6.9475 | 7.3844 | 7.5823 | 8.5525 | 3556.7831 |
| 120 | 中位 | **6.9392** | **7.3948** | **7.6417** | **8.5525** | **3557.0040** |
| 1000 | 1 | 6.9383 | 7.3749 | 7.7148 | 8.7357 | 3556.2647 |
| 1000 | 2 | 6.9532 | 7.4521 | 7.6500 | 8.0750 | 3557.2274 |
| 1000 | 3 | 6.9277 | 7.4575 | 7.6936 | 8.0733 | 3557.8547 |
| 1000 | 中位 | **6.9383** | **7.4521** | **7.6936** | **8.0750** | **3557.2274** |

证据根目录 `test-output/deep-native-bench/`；历史轮次 `runs/2026-10-07T05-43-35-601Z/` 含两档冻结 runtime-package、manifest、6 个 `static-<count>-r<round>.telemetry.json`（stdout JSON 原样提取）、原始 stdout/stderr 和 Native 源码哈希。该目录的 `summary.json` 保留首次静置结果；根目录摘要随最新完整成功轮次更新。`--probe` 使用独立摘要，不覆盖正式结果。

一次正式启动在 `runs/2026-10-07T05-43-20-659Z/` 发生 `Surface::configure: Invalid surface`，没有进入采样；日志保留。重跑后完整六轮成功，未在结果中筛除任何成功轮次。小窗口试跑证据为 `runs/2026-10-07T05-41-05-827Z-probe/`，不入 README 数字。

首次静置版本的六个空格由 P3.2 补采；原 GPU 环仅保留末 64 帧，首次证据中的时间戳不能作为新版本 512 帧窗口的结果。本窗口约 3.56s，不能替代长时稳定性或吞吐压力测试。

验证：fixture 与浏览器六种几何的顶点/法线/索引、逐实例矩阵、颜色、PBR、相机及阴影角色的测试；包哈希确定性；证据解析拒绝缺报、错误包、非 release、失败/截断窗口和非法间隔。只使用现有 three/tsx/wgpu/serde 依赖，无新增运行依赖。

### P3.2 Deep Native 全表采集（2026-10-07）

现状核查：已有 GPU 全帧时间戳、`replace_render_packet` 场景更新事务和真实 draw 编码入口，不重建。补齐基准固定负载和观察器；没有新增发布合同或运行依赖。

使用上节的 `cargo build --features native-bench` 后运行 `pnpm --filter @bim-studio/web benchmark:deep-native`。专用构建开启 Rust 分配器观察和 draw 指令计数，将 GPU 环扩为 512 槽；正常构建默认关闭该 feature。四个 case 各跑三轮：静置 120、静置 1000、动态 1000、重建 1000。前三组每轮预热 120 帧、采 512 帧，重建组预热 120 帧后逐次重建并呈现 20 帧。每轮独立进程，继承的 `DEEP_ENGINE_*` 选项清空。

| README 行 | 原生采样口径 |
| --- | --- |
| 静置 P50/P95/max、动态 P95 | `frame-interval` 的完整 511 个间隔，nearest-rank 分位；三轮各统计的中位。max 取各轮 max 的中位，逐轮 max 仍保留。 |
| 动态负载 | 索引 0–199 的设备每帧转动 `0.004 + index % 5 × 0.0004`，Y 位移 `sin(timeMs × 0.0015 + index) × 0.08`；通过现有场景事务提交，包含 packet 复制、内容哈希和 GPU 更新成本。 |
| 首帧 | 父进程单调时钟从 spawn 前至首次 `surface.present` 返回后的 stdout 标记到达，包含进程、包解析、设备/管线启动和 IPC；未采合成器完成时刻。取静置 1000 三轮中位。 |
| GPU P50 | 完整 512 帧的 `gpu-timestamp`，范围为渲染 command buffer 的 frame 起止，含可见性、阴影、opaque、HiZ 和输出；不含主机启动、等待垂直同步或合成器呈现。三轮 P50 的中位。 |
| 20 轮重建 | 重建全部 1000 设备实例、更换实例 ID、按 cycle 换共享材质并转动；几何/材质资源保留，地面不重建。记录构造、哈希及 GPU 发布事务的 20 个耗时；上表取第 20 次耗时的三轮中位，与浏览器 `lastRebuildMs` 行一致。 |
| Draw Calls | 逐帧实际编码的 render draw 指令，包括并行阴影线程、HiZ 和输出；indirect 指令即便全部实例被剔除也计一次，compute dispatch 不计。上表取静置 1000 末帧的三轮中位。 |
| 重建堆增最差 | Rust `GlobalAlloc` 活跃分配字节：预热后基线加 20 次呈现后端点。每轮取末值减基线，上表取三轮净增的最大值；GPU/驱动与非 Rust 系统分配不在其中，与浏览器 GC 后 JS heap 的范围不同。 |

冻结包、源码哈希、二进制 SHA-256、原样 telemetry JSON、stdout/stderr、首帧观察 `.launch.json` 都保存在同一个轮次目录。`summary.json` schema v2 引用每份 telemetry/launch 文件及 SHA-256；`--check` 复算所有结果并核对中英文 README 九行。任一帧 skip/recovery/failure、更新数量不符、GPU 丢样、draw 为零、重建或堆样本不全均拒绝入表。原生 AutoVsync / 4×MSAA / 4 级 2048 CSM 继续保留，原生列仍为独立口径参考。

正式证据：`test-output/deep-native-bench/runs/2026-10-07T06-19-20-693Z/`，当前摘要 `test-output/deep-native-bench/summary.json`。EXE SHA-256 `16cf67cb17c97db9072d8601248dbea551c409b33d14e01b172ee1cbbba9016b`。12 轮均成功，GPU 无丢样，包/设备/源码/二进制身份一致；没有筛除成功轮次。静置窗口约 3.56s，动态约 5.71–5.76s，20 次重建约 0.21s；完整间隔、GPU 序列、20 个重建耗时和 21 个堆端点均保留。

| 负载/物体 | 轮次 | P50 ms | P95 ms | max ms | GPU P50 ms | 首帧 ms | 第20次重建 ms | 堆净增 MiB | Draw Calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| static/120 | 1 | 6.9446 | 7.5512 | 9.3959 | 0.369664 | 1342.7553 | — | — | 9 |
| static/120 | 2 | 6.9443 | 7.8016 | 10.5428 | 1.042432 | 1795.2725 | — | — | 9 |
| static/120 | 3 | 6.9445 | 7.5305 | 9.9041 | 0.927744 | 1380.6928 | — | — | 9 |
| static/1000 | 1 | 6.9468 | 7.3969 | 9.7403 | 0.514048 | 1532.7997 | — | — | 9 |
| static/1000 | 2 | 6.9362 | 7.3957 | 15.4483 | 0.512000 | 1459.8428 | — | — | 9 |
| static/1000 | 3 | 6.9400 | 7.4077 | 7.8420 | 0.514048 | 1431.3342 | — | — | 9 |
| dynamic/1000 | 1 | 11.2343 | 13.1096 | 17.2190 | 1.846272 | 1439.4533 | — | — | 33 |
| dynamic/1000 | 2 | 11.3345 | 12.7695 | 15.1873 | 1.691648 | 1415.0305 | — | — | 33 |
| dynamic/1000 | 3 | 11.2350 | 12.8171 | 15.7389 | 1.863680 | 1393.3298 | — | — | 33 |
| rebuild/1000 | 1 | 10.2225 | 11.0542 | 11.0542 | 0.684032 | 1715.3049 | 8.1727 | 0.337749 | 21 |
| rebuild/1000 | 2 | 10.6317 | 12.2268 | 12.2268 | 0.684032 | 1665.1187 | 10.0230 | 0.337749 | 21 |
| rebuild/1000 | 3 | 10.2830 | 11.3982 | 11.3982 | 0.685056 | 1394.3057 | 8.2742 | 0.327861 | 21 |

README 新增六格：动态 P95 **12.82ms**、首帧 **1459.8ms**、GPU P50 **0.51ms**、重建 **8.27ms**、Draw Calls **9**、重建堆净增最差 **0.34MiB**。静置 P95 更新为 **7.55 / 7.40ms**，120 物体 max 中位为 **9.90ms**；该组全体最大值 **10.5428ms**，1000 物体全体最大值 **15.4483ms**，不以中位代替原始尾部。

本次负载试跑暴露 `ShadowCasterSet::prepare` 的重复资源哈希：每个实例都重新格式化共享几何的完整顶点/索引。已改为每次 prepare 内按资源与 MASK UV 范围复用摘要，纹理内容同样复用；下一次 packet 仍重算，revision 未变的内容变更也会失效。修复前试跑 `preflight-dynamic.stdout.log` 的场景准备 P50 为 154.8069ms；正式三轮为 **2.2467 / 2.2514 / 2.2504ms**。前者是开发期间试跑，未作为独立受控性能对照入表。

验证通过：6 项 Node fixture/统计/拒绝无效证据测试，2 项分配器/跨线程 draw 测试，2 项负载纯逻辑测试，5 项阴影缓存/失效测试（另有 1 项独立 CPU benchmark 默认忽略），1 项真实 GPU LOD 颜色/级联深度 readback；默认构建 `cargo check`、带观察器 release 构建、专项 TypeScript、12 轮哈希与中英文九行证据校验、diff 空白检查。原生 bin 单测目标被已有 `renderer/megalights_gpu_probe_tests.rs` 的 `rand_chain` 缺 `mut`、`rand_config` 移动后复用两处编译错误阻断；本次负载测试已通过独立 lib 目标，阴影测试通过现有 `gpu_lod_draw_readback` 集成目标。

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
