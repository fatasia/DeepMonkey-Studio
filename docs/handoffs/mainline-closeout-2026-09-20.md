# Deep Monkey Studio 主线交接与收尾清单（2026-09-20）

> 工作区：`D:\Documents\bim\bim-studio`
> 分支：`dev-studio`
> 目标：持续推进性能、效果、轻量交付与工业能力主线；Babylon/跨引擎对比与 480min soak 已按用户指令收口，不再作为主线阻塞。

## 1. 本轮已完成并已提交

| 能力 | 提交 | 交付与证据 |
|---|---|---|
| B05 staging ring | `cdaf2eb` | Native 实例上传 3 槽 ring；容量按需增长不收缩；stage/refresh 两路径接线。`cargo check` 通过；native 单测 431 passed / 0 failed / 1 ignored。 |
| G7 体积雾 GPU 首切片 | `d8feaf5` | 半分辨率 ray-march、Henyey–Greenstein、Beer–Lambert、CPU 镜像、WGSL/Naga 合同。fog 测试 29/29；tsc 通过。尚未接生产 render graph，未做真机 GPU 数值对拍。 |
| P3/P4 运营 UI | `b51651c` | 运营中心新增“现场监控”tab，挂载告警状态与时序回放两个既有面板；路由支持 `operations?task=monitoring`；聚焦测试 17/17。全量 web tsc 当时受并行 dashboard delivery WIP 阻塞，错误不在本切片闭包。 |
| R4 遮挡尾巴 | `4063533` | 空批次 draw skip、逐实例 HiZ mip、culled/drawn/draws metrics；生产挂载经核验已存在，开关关闭保持旧行为。Native CPU/GPU/窗口 smoke 证据由车道报告给出；默认开关仍关闭。 |
| R11 动画首切片 | `49b23ee` | `AnimationStateMachine`、条件过渡、crossFade/预算/失败闭环；线性/折线路径采样；距离约束纯函数。动画聚焦 25/25；deep-engine tsc 通过。真实 GPU/产品挂载另卡。 |
| E04 SSR 首切片 | `d041dcb` | 半分辨率屏幕空间反射步进 + 二分精化 + TAA 前合成；CPU 对拍合同；deep-engine 405 文件 / 3308 passed / 41 skipped。默认 feature off。 |
| R2 DCIR v1 扩展 | `54b5af1` | read-write storage buffer、buffer-store、静态 loop-range、PCG hash-rng；GLSL/WebGL2 对 v1 能力整体 fail-closed。shaderCompute 23/23；deep-engine tsc 通过。尚未接真实消费管线/native GPU 对拍。 |
| R6-3 并行调度 | `7718fe0` | `executeParallelGroups`：组间有序、组内 bounded concurrency、失败短路/可继续、结果顺序确定；测试 5/5；tsc 通过。尚未替换实际 RenderGraph GPU encoder loop。 |
| R12 帧捕获首切片 | `0be6b70` | CPU 侧 frame/pass record、timeline range、source-map 反查、预算与 fail-closed；测试 16/16（同一组测试被镜像路径执行两次）；tsc 通过。诚实边界：未接真实 GPU render loop，未捕获实际颜色/深度/binding。 |
| A01-X / Babylon 收口 | `485bade` | Babylon 从对比矩阵正式排除；相关 runner 仅保留参考并标记 excluded；A01-X 不再阻塞主线。 |
| 路线图同步 | `71cf655` | 权威路线图已标记已完成切片；删除 480min soak 与跨引擎对比的收口依赖。 |

## 2. 已明确取消/不再做

1. **Babylon mesh 出图修复**：用户已明确“踢出去”，不再修复、不再启动 Babylon runner。
2. **A01-X Unity/Babylon/跨引擎继续对比**：用户明确“对比的问题直接收口，不继续做了”。已有 Three 配对结果仅作为历史结论。
3. **480min production soak 静默窗口重跑**：用户明确删除该任务；保留历史启动脚本和旧证据，不再启动、不再巡检。
4. **RVT 2026 深水逆向**：相关车道已停止；现有 2024 decode 对 2026 分区记录无法形成可用记录，后续除非重新排期，不阻塞主线。

## 3. 当前正在收口

### 2026-09-20 R12 续跑检查点

- 最新：无 SpatialAA 的实际 present 管线已记录 exact WGSL SHA-256/入口行来源，拒绝外部来源注入；`test-output/r12-frame-capture-1789882931950/evidence.json` 四场景真 GPU 与查询通过。不是 ShaderGraph 作者节点映射，其他内置 pass、资源快照与完整调试 UI 仍待。FINAL-GATE 结果见 [首轮预检](../reports/mainline-final-gate-2026-09-20.md)。

- R10 F04/F05 已由 `8dc7b14` 提交并推送，后续不重复实现这两个夹具。
- R12 工作树已接入 render-loop 捕获事务；新增 Shader Package 显式 pass binding 配置和 source-map 查询测试。捕获开启被拒绝时，已修复误取消其他调用者活动帧的问题。
- 本次聚焦验证：R12 与 capture 共 3 文件 / 20 项通过；后续集成共 7 文件 / 49 项通过，deep-engine tsc 通过。排除了 test-output 镜像路径，不重复计算测试数。SSR 单独开启需要 MRT；Hi-Z 实际读取硬件深度，不为它额外分配 MRT。
- 已接实际 feature switches 编译计划并在捕获前校验资源描述；覆盖 64 种开关组合。真实 GPU 四组（direct、SSR-only、默认效果、透明）各两帧通过，证据 `test-output/r12-frame-capture-1789882232544/evidence.json`。首轮发现 SSR composite 引入未绑定法线函数，移至 trace 后原路径复验通过；SSR 聚焦 15 项通过。
- 独立 ShaderPackageExecutor 的 shadow/forward 真实 draw、像素/深度读回及完成回执 source-map 查询已通过，最终证据 `test-output/r12-frame-capture-1789882287963/evidence.json`；lab tsc 通过。
- 仍待：作者级 ShaderGraph/source-map UI、通用资源快照与调试 UI、FINAL-GATE 完整签核。实际内置 output pipeline 已消费并绑定执行中的 WGSL provenance；独立 package 完成回执不等于作者级映射，也不证明视觉质量；Hi-Z 等 unmapped pass 不计入精确捕获。
- 用户最新顺序：当前任务先收尾，P0、P1 性能/效果/能力与 R10 剩余项按独立文件边界并行；重复全量测试后置，提交前保留必要验证。允许自主普通 push，禁止强推。

### R10 Rapier F04/F05

F07 增量：固定 Multibody 三段重力摆链 native/WASM 241 帧逐位一致，逐帧锚点约束与移除关节/重力负对照通过；Rust 聚焦 13 项通过，F04–F06 金标不变。证据 `test-output/r10-f07-multibody-20260920-r1/evidence.json`。下方 Multibody 待办现收敛为动态拓扑/控制、混合求解器及产品宿主；不支持的 multibody motor/limits 组合明确拒绝。

最新增量：F06 固定 position motor（acceleration/force）与双向限位已完成双端 241 帧逐位对拍，WASM 重跑和移除控制负对照通过；Rust 定向 10 项通过，F04/F05 金标保持不变。证据 `test-output/r10-f06-motor-limits-20260920-r1/evidence.json`，spec SHA-256 `26988f7c813fc28158511182ef3d983b4df335d92679d75018732270224ad4bc`。仍待 MultibodyJoint、速度模式/扭矩预算、运行时控制更新与产品 PhysicsWorld 宿主。

现有 `packages/deep-engine-native/physics-validate/` 已具备：

- `physics-frame-v1` canonical frame 合同；
- Rust Rapier 固定步长 drop 场景；
- WASM `@dimforge/rapier3d-compat` 对拍脚本；
- frame/body 位级摘要与首分歧定位器。

本轮已在工作树扩展 `contract.rs`，并完成 F04/F05 最小双端闭环：

- `JointState`；
- joint canonical 字段：id/kind/body1/body2/anchor1/anchor2/frame1/frame2；
- `joint_bits_sha256`；
- joint 首分歧定位；
- 旧无关节场景保持旧 canonical 字节格式。

`runner.rs`、WASM runner 已按同一 spec 构造 revolute `ImpulseJoint`；新增 F04 单关节与 F05 三段链场景，native cargo 7/7，F04/F05 对拍均 `bitwiseIdentical=true`。F06 增量与剩余范围见本节最新记录。

### R12

生产 render-loop 捕获、compiled plan/actual pass 映射、独立 shader package source-map 适配已由 `726d8fd` 提交推送。下一步是内置 PBR source-map 消费、通用资源快照与调试 UI；具体证据和边界见本页续跑检查点。

### 2026-09-20 晚间并行收口检查点（未提交、未推送）

- **R10 产品宿主**：新增宿主中立 `PhysicsWorldHost`，真实接入 Viewer Rapier World，统一固定 `1/60s` 步进、`0.2s` 追帧上限、暂停恢复、重力与生命周期；修复异步初始化期间 Viewer 已销毁仍创建 World 的竞态。仍待产品关节编辑/运行时控制、速度模式与扭矩预算、动态 Multibody 拓扑。
- **R6-3 生产执行器**：PBR 的 `deform + cluster-lights` 已按编译并行组使用独立真实 `GPUCommandEncoder` 编码，并与主帧保持单次 `queue.submit` 和失败不部分提交。当前仍是同一 JS 线程多 encoder；Worker encoder farm 未完成。
- **R2 真实 buffer 消费**：DCIR 支持 buffer-only kernel、显式 binding metadata、`f32` uniform 与 atomic u32 load；buffer store 已移到 guard 之后。粒子系统 `drawIndirect.instanceCount` 已从手写 WGSL 迁移为 DCIR 生成内核并复用原 bind group。Native wgpu 第三端执行与更多复杂 kernel 迁移仍待。
- **G7 生产接线**：体积雾已接通 `march → 全分辨率 HDR Beer-Lambert 合成 → SSR → TAA → Bloom`，同步 frame graph、actual-pass 与 R12 capture 合同；默认关闭，不改变现有画面。最终浏览器视觉对拍按总体验门禁后置。
- **R11 产品挂载**：导演台新增可持久化的片段状态机入口，状态切换真实驱动 Three `AnimationMixer.crossFadeTo`；失效片段、跨对象与停用状态失败关闭。仍待条件参数编辑、路径/距离约束 UI 与 runtime package 消费。
- **P5/P7 产品入口**：`查看与分析 → 工程分析与导出` 已复用现有空间校验与 QTO 核心，支持空间 JSON/CSV、工程量 CSV，并覆盖空态、错误态、加载态与 CSV 公式注入防护。
- **本批组合门禁**：Deep focused `14 files / 83 passed / 1 skipped`，Web focused `8 files / 42 passed`；Contracts、Web、Deep+Lab typecheck 全部通过；runtime purity 为 `664 browser/core + 574 native` sources passed；定向 `git diff --check` 无错误。source-size 仍有仓内既有超限项，本批无新增超限文件。
- **R10 第二切片**：产品物理面板与 Viewer 已形成 world revolute 的保存/恢复/运行闭环，支持轴、双向角限位、velocity motor、目标速度和求解强度；模型删除或改为非 dynamic 会清理悬空关节。Rapier 0.19 无可证明的最大扭矩接口，未把 solver strength 冒充 torque cap。仍待动态 Multibody、两刚体 authoring、Native 产品宿主与视觉终验。
- **R11 第二切片**：状态机条件参数和显式边可持久化；导演台可编辑布尔参数并用 Deep 状态机严格求值单条过渡，命中后驱动 Three cross-fade。runtime package 消费仍待。
- **C3 Deep2D 增量**：相邻 draw 的顶点上传按 `min(device.maxBufferSize, 4 MiB)` 合批；固定三 draw 的 buffer 分配和 `writeBuffer` 均由 `3 → 1`，保持 atlas、pipeline、draw 顺序与字节不变，小设备按 draw 边界确定性拆批。
- **第二批门禁**：Web focused `6 files / 19 passed`，Deep focused `2 files / 14 passed`；Contracts、Web、Deep+Lab typecheck 再次全部通过。R10 UI 因当前 CUA 无可用浏览器，尚未完成两轮真实截图，不计视觉终验。
- **C3 材质/纹理 revision**：sampler-only revision 复用原 GPU texture/view，只发布新 sampler 与 binding identity；固定单 mip 用例的增量 `createTexture`/`writeTexture` 均由 `1 → 0`。像素变化仍重新上传并安全退休旧纹理，同 revision 静默修改继续拒绝。相关 `4 files / 70 tests`、Deep 双 typecheck、runtime purity 通过。
- **R12 作者 Source Map UI**：Studio 仅在显式打开渲染诊断并启用 Deep 时创建真实 `FrameCaptureSession`，保留 24 帧有界记录；关闭后 no-op，普通编辑零采集。现有诊断面板可按 frame/pass/module/node/stage/generated line 查询。focused `4 files / 36 tests`、Web typecheck 通过；真实浏览器视觉截图仍后置。
- **R11 runtime package**：dynamic-runtime 升级 v2 animation-controller ABI，保留 v1 解析；新增保存态→ABI 纯编译、Web Player 条件/切换消费与 Native 确定性 transition command。未知版本、重复/悬空/跨模型引用、未声明参数和宿主拒绝均 fail-closed。Web `3/3`、Deep ABI `6/6`、Native `7/7`，三套 typecheck 通过。未改发布门禁。
- **FINAL-GATE 第一轮**：仓库治理、项目 800 行源体量、公开品牌、Web 类型检查全部通过；Web `651 files / 3867 tests`、API `217 files / 1407 tests`、Studio Core `14 files / 106 tests`、Deep Engine `418 files / 3411 tests` 均为 0 失败。R10 F04–F07 native/WASM 位级一致证据位于 `test-output/final-gate-r10-determinism-20260920/`；R12 四场景真 WebGPU 证据位于 `test-output/r12-frame-capture-1789907707541/evidence.json`。主线索引为 `5 passed / 3 partial / 0 blocked / 0 unverified`，3 项 partial 仍是项目后验收、工业 S1–S6 与资产 readiness。严格 Deep Engine 300 行审计仍有 71 个既有超限文件，未降低阈值。完整报告见 [FINAL-GATE 第一轮](../reports/mainline-final-gate-2026-09-20.md)。
- **R10 双刚体作者闭环**：revolute 可选择固定世界或另一动态物理刚体；保存的世界枢轴会按第二刚体平移与旋转转换为 Rapier 局部 anchor。自连接拒绝，删除或停用任一端会清理悬空关节。focused `4 files / 23 tests`、Contracts 与 Web typecheck 通过。仍待 Native 产品宿主、动态 Multibody 控制与真实 torque cap。
- **R1 Surface Cache 动态更新**：对象新增、移动、几何/材质 revision 与删除已进入 probe clipmap 脏域；动态对象逐帧刷新。更新只有在真实 GPU publication 与 PBR target 都接受后提交，失败保留重试；64-box 硬预算内确定性压缩。focused `2 files / 11 tests`、Deep Web+Lab typecheck 通过。
- **R9 virtual geometry 生产切片**：复用现有 Nanite Lite meshlet build→GPU cull→stable compact→indirect draw 链，将已提交的上一帧 Hi-Z 真实传入 meshlet culler；首帧、camera cut、场景/视口变化继续保守回退 frustum-only。隐藏 meshlet 在 indirect 命令生成前剔除且无 CPU readback。focused `46 passed / 2 existing skipped`、双 tsc、runtime purity 与真 WebGPU 四场景通过。仍是有界 author-selected meshlet 路径，不冒充完整 Nanite/visibility-buffer。
- **R10 Multibody 产品切片**：物理面板支持 ImpulseJoint / MultibodyJoint 切换，Viewer 使用真实 Rapier multibody 创建与删除；自连接、重复 parent、拓扑环以及 multibody+motor/limits 均 fail-closed。focused `4 files / 25 tests`、Contracts typecheck 通过。Native 播放器尚无 physics runtime payload，不能先造无数据 World 宿主。
- **R1 RenderPacket 消费**：Surface Cache 已从手工 upsert 深化为 authoritative RenderPacket 编译，base+LOD 几何和实例变换形成 world-space 覆盖域，并进入真实 Probe Clipmap capture→PBR binding 发布链。focused `3 files / 14 tests`、Deep 双 tsc 通过。
- **G3 编译期 HLOD 切片**：可选生成确定性 12-triangle AABB far proxy，并进入现有 meshlet bake→residency→GPU LOD table；默认门槛下远景三角形至少下降 95.3%。focused `2 files / 10 tests`、双 tsc、runtime purity 通过。当前只降远景绘制量，主/代理仍同时驻留，不冒充分区 HLOD/impostor 完整链。
- **PBR PSO 缓存**：真实 PBR bootstrap 现按 GPUDevice、Forward+ layout、surface/MRT、direct-display、阴影级联与 deformation ABI 隔离缓存；并发/暖启动共享 Promise，失败自动逐出，device loss 可显式清理。默认重复 bootstrap 避免底层 28 个 Render PSO 重编译，重复提交下降 100%。focused `2 files / 16 tests`、双 tsc、runtime purity 通过。
- **C04/C05 材质效果账本**：作者 material/instance identity 已对账到真实 GPU `batchKey + instanceRecord`，覆盖 PBR 数值、纹理 identity、透明/双面/预乘/阴影 pipeline 状态；漂移和重复/缺失 identity fail-closed。账本只随 PacketBuffers 成功上传事务发布。focused `4 files / 58 tests`、Deep typecheck 通过。
- **C3 Author Grid revision**：等价场景快照按纹理 `id + revision` 复用 GPU texture，避免重复 allocation、全 mip 上传和 bind-group 重建；revision 增长仍上传，倒退 fail-closed，失败替换保留旧纹理可重试。focused `12 passed / 1 environment skip`、Lab tsc 与 purity 通过。
- **R10 Native Physics ABI**：dynamic-runtime v3 新增 physics-runtime v1，真实编译刚体、render-bounds 碰撞体、Impulse/受限 Multibody revolute；Native 严格解析并输出 Configure→Body→Joint 确定性命令。v1/v2 保持兼容，不支持的引用、数值和拓扑 fail-closed。Deep `7/7`、Web `19/19`、Native `8/8`，双端 typecheck 与 5388 文件 source-size 通过。仍待 Native 播放器消费命令并同步渲染 transform。
- **E04 SSR roughness 稳定性**：view-normal alpha 携带真实 perceptual roughness，SSR trace 在原 pass 内执行 `roughness²` 驱动的 5-tap cone filter；roughness=0 精确保持旧 sharp 路径，不增加 pass/RT/binding，SSR→TAA 顺序不变。focused `38 passed / 2 Naga environment skips`、Deep typecheck 通过。
- **E05 局部灯 PCSS**：最多 4 盏 Spot 阴影新增 opt-in `shadow.softness`；0 保持原 4-tap PCF，启用后在同一 atlas shader 内执行 4-tap blocker search + 12-tap PCSS，半影 1–4 texel 且限定 tile 防串影。复用既有 uniform/atlas，无新增绑定或显存。focused `50 passed / 3 Naga environment skips`、Deep typecheck 通过。
- **R4 万灯 clustered compute**：每 cluster 从单线程串扫全部灯改为 64 线程协作、分批 bounds 与确定性前缀压缩；10,000 灯的昂贵扫描关键路径由 10,000 次串行降为 157 个 64-lane 批次，ABI 灯序与 overflow 语义不变。focused `2 files / 16 tests`、Naga、双 tsc、purity 通过。
- **E05 多灯阴影稳定性**：PCSS 增加 slope-aware receiver bias，并按稳定 atlas tile 生成确定性采样旋转；同灯跨帧和数组重排稳定，不同灯图案去相关。默认 softness=0 不进入新分支，无新增资源或 pass。focused `28 passed / 3 Naga environment skips`、Deep typecheck 通过。
- **C3 LOD uniform revision**：LOD compute 继续真实执行，但 64-byte uniform 内容未变化时跳过 `queue.writeBuffer`；热稳态 revision 更新由每次 1 次上传降为 0。倒退在写入前拒绝，写失败不推进 identity/history。focused `13/13`、双 tsc、purity 通过。
- **设备预算自适应阴影**：CSM 在分配前读取 DeviceSession 实时剩余显存，扣除固定 uniform 后与显式 depth budget 取严格较小值，自动选择最高可容纳 tier；exact profile 仍 fail-closed。focused `3 files / 31 tests`、双 tsc、purity 通过。
- **R1 DDGI 动态 irradiance**：动态探针真实进入 GPU update record，现有 filter pass 读取上一帧 committed volume 并按默认 0.85 hysteresis 混合；initial/resize/device epoch 禁用历史，无新增纹理或 pass，失败沿双缓冲事务回滚重试。focused `28 passed`，Naga `8/8`、Deep typecheck 通过。
- **R10 Native PhysicsWorld 产品宿主**：主 Native 客户端接入 Rapier 0.35.3，事务式消费 Configure/Body/Joint；固定步进后把 body pose 同步至真实 RenderPacket 更新通道，Impulse/Multibody 关节均运行，旧无 physics 包兼容，动画/物理 transform 冲突 fail-closed。physics-validate `19/19`、Native focused `11/11`、Web focused `26/26`、typecheck 与 5392 文件 source-size 通过。真实 RTX 4060/Vulkan 窗口 smoke 已确认窗口、PBR/Deep2D、物理同步、GPU submit 与干净退出，证据 `test-output/native-physics-window-smoke-20260920/evidence.json`；像素对拍和性能终验仍后置。
- **G3 分区 HLOD**：bounds far proxy 支持 opt-in `spatialPartitions`（默认 1，最大 64），按最长轴和三角形质心确定性分区，各分区生成保守 AABB 后合并为真实 far LOD geometry，继续进入 meshlet bake、residency catalog 与 GPU LOD。focused `7/7`、双 tsc、purity 通过。仍是静态 bounds HLOD，不是材质 impostor 或跨实例合批终验。
- **E02 IES Native 消费**：Native renderer 真实上传并持续绑定 IES GPU 光度资源，Spot shader 按 θ/φ、旋转、对称与 scaleFactor 采样，与 WebGPU 使用一致的 0.5°/361 列语义；无 IES 恒等，非 Spot 携带 IES、坏引用和超预算 fail-closed。Naga、focused、Native lib/bin cargo check 与 diff-check 通过。

## 4. 仍未完成的主线任务（按优先级）

用户最新调度：**接入、消费、编辑器挂载、无缝切换统一放到功能任务末尾，最终验收之前**；先收尾当前在手切片，再完成底层优化和高价值核心能力。下列旧 P0/P1 与推荐顺序如涉及提前接入，以此为准；既有接线不回退。

2026-09-20 用户新增要求已纳入：[高收益优化、能力接入与竞品精华执行表](../specs/mainline-high-value-integration-2026-09-20.md)。OPT-01–07 / CAP-01–08 均挂回下列既有卡，不另建平行系统；按最新提交扣除已完成部分。当前 R10/R12 切片先收尾，FINAL-GATE 第一轮保留；跨引擎资料借鉴不恢复已取消的对比跑分。

### P0：本轮先收口

1. R10 F04–F07、Web PhysicsWorld、双刚体作者入口与 Multibody 产品创建已完成；当前优先补 physics runtime payload，再接 Native 产品宿主。真实 torque cap 受当前 Rapier JS API 限制，保持明确不支持。
2. R12 生产 render-loop、内置 PBR source-map 与调试 UI 已交付；通用 GPU 资源快照/读回仍待。
3. FINAL-GATE 第一轮已通过功能、确定性和渲染回归；项目最终视觉/交互/性能签核按用户要求放在全部核心功能之后。

### P1：性能轴

1. C3 材质 uniform / texture revision / LOD / shadow flag / Deep2D 增量剩余收口。
2. R2 DCIR v1 已迁移 GPU particle indirect 的真实 buffer 消费；Native wgpu 第三端执行与更多复杂 kernel 迁移仍待。
3. R4 万灯/meshlet/indirect 二期；当前遮挡尾巴已完成但默认开关仍关闭。
4. R6-3 已接真实 PBR 多 encoder 与单次事务提交；浏览器仍是主线程顺序 encode，下一真实增量是 Native 持久线程 executor 或 worker-owned GPU 架构。
5. R9 已让 meshlet indirect culler 消费上一帧真实 Hi-Z；仍待完整 visibility-buffer/virtual geometry 分页与大型场景收益证据。
6. G3 已接确定性 bounds far proxy；仍待分区 HLOD、impostor 生成和驻留显存下降。
7. PSO 磁盘缓存、按设备预算自适应质量、后台资产准备，仍在总路线图中。

### P1：效果轴

1. R1 Surface Cache 已消费真实 RenderPacket 并驱动 probe clipmap 动态脏域；仍待完整 DDGI 动态更新与真 GPU 数值/视觉验收。
2. G7 体积雾已接生产 render graph 并通过四场景真 GPU；最终画质和跨端对拍后置。
3. E04 SSR 二阶段：temporal accumulation、roughness mip/反射稳定性。
4. E05 多灯阴影、PCSS、接触阴影、面积光；E02 IES native 消费尚未完成。
5. C04/C05 材质与后处理效果账本，继续跟随渲染链实测。

### P1：能力轴

1. P5 空间校验产品 UI 与 JSON/CSV 导出已接入；限高规则和更深生产数据验证仍待。
2. P7 QTO 产品 UI 与 CSV 导出已接入；分类口径和真实项目深测仍待。
3. R11 状态机编辑、条件参数、Three cross-fade、dynamic-runtime v2 与 Native transition command 已完成；路径/距离约束写回 SceneTransformGraph 仍待。
4. R12 render loop 与作者 source-map UI 已交付并有四场景真 GPU 证据；通用资源快照仍待。
5. P2/P3/P4：核心与运营 UI 首切片已有；生产数据持续摄取/真实数据链路/权限与错误态深测仍待。
6. R5 AI compile chain/H09、G06/G08、D24-D28、V04/V05，仍在总路线图中。

### P2：工业格式与后排

- RVT 2026 记录形态：当前停止，需新样本/新证据再排期；
- C3 Deep2D/资产与 dashboard delivery 并行 WIP：必须先按其独立交接收口；
- P6 FMU/FMI、P8 IFC 深水、G4 地理坐标、G9 多人协同、G10 XR、V12 Splat/扫描方向：按路线图标注后排/用户未批准，不得偷删，也不得冒充完成。

## 5. 已知验证边界与阻塞

- 工作树有大量其他会话未提交改动，集中在 apps/api、apps/web delivery、RVT/资产脚本等；主线提交只圈定相关文件，禁止 reset/clean/checkout 覆盖。
- web 全量 tsc 曾被并行 dashboard delivery 文件阻塞；P3/P4 自身聚焦测试通过。
- deep-engine tsc、runtime-purity 与 R12/capture focused 18/18 已通过；DCIR v1 23/23、R6-3 5/5、R11 25/25、G7 29/29 均有证据。严格 deep-engine >300 行 source-size 仍有历史/并行文件超限，未改阈值或豁免。
- native 主 crate B05/R4 已分别有 cargo check 与测试证据；R10 独立 physics-validate crate 需单独 cargo test，不要混入主 crate 的 wgpu 门禁。
- 禁止修改 wgpu/vendor 底层；R6-0 已测得 wgpu 底层约占 3% 帧预算，底层 fork/hotspot/whitebox 方案封存。

## 6. 下一会话推荐执行顺序

1. 读取本交接文档与 `docs/specs/de26-master-execution-roadmap-2026-09-19.md`。
2. 沿 R10 F06 已验证实现推进产品宿主与剩余关节控制，不重写 F04/F05/F06。
3. 沿 R12 已提交真实捕获推进内置 PBR source-map 与资源快照，不重复独立 package 探针。
4. 接 G7 pass 到 PBR post-process chain（先 feature off，再聚焦 GPU contract）。
5. 接 R6-3 scheduler 到实际 RenderGraph executor，不改 plan hash 合同。
6. 补 P5/P7 UI 导出入口并做浏览器真实交互闭环；再做 FINAL-GATE 第一轮。
7. 最终报告只写主线性能/效果/能力结论；不要重新开启已取消的 Babylon、Unity/A01-X 对比或 480min soak。

## 7. 提交与交接纪律

- 用户已授权自主普通 push；禁止强推。
- 每一车道独立 commit，提交信息说明能力、测试数字和未验证边界。
- 发现一个机制缺陷要做同族排查，不做表面补丁。
- 未接真实 GPU、未做真实浏览器、未做双端对拍的部分必须标记 partial/unverified。
- 本文是交接记录，不替代代码/测试证据；状态以 commit、测试日志和证据目录为准。
