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

- R10 F04/F05 已由 `8dc7b14` 提交并推送，后续不重复实现这两个夹具。
- R12 工作树已接入 render-loop 捕获事务；新增 Shader Package 显式 pass binding 配置和 source-map 查询测试。捕获开启被拒绝时，已修复误取消其他调用者活动帧的问题。
- 本次聚焦验证：R12 与 capture 共 3 文件 / 20 项通过；后续集成共 7 文件 / 49 项通过，deep-engine tsc 通过。排除了 test-output 镜像路径，不重复计算测试数。SSR 单独开启需要 MRT；Hi-Z 实际读取硬件深度，不为它额外分配 MRT。
- 已接实际 feature switches 编译计划并在捕获前校验资源描述；覆盖 64 种开关组合。真实 GPU 四组（direct、SSR-only、默认效果、透明）各两帧通过，证据 `test-output/r12-frame-capture-1789882232544/evidence.json`。首轮发现 SSR composite 引入未绑定法线函数，移至 trace 后原路径复验通过；SSR 聚焦 15 项通过。
- 独立 ShaderPackageExecutor 的 shadow/forward 真实 draw、像素/深度读回及完成回执 source-map 查询已通过，最终证据 `test-output/r12-frame-capture-1789882287963/evidence.json`；lab tsc 通过。
- 仍待：内置 PBR 的实际 Shader Package/source-map 消费接线、通用资源快照与调试 UI、FINAL-GATE。独立 package 完成回执不等于内置 PBR source-map 集成，也不证明视觉质量；Hi-Z 等 unmapped pass 不计入精确捕获。
- 用户最新顺序：当前任务先收尾，P0、P1 性能/效果/能力与 R10 剩余项按独立文件边界并行；重复全量测试后置，提交前保留必要验证。允许自主普通 push，禁止强推。

### R10 Rapier F04/F05

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

## 4. 仍未完成的主线任务（按优先级）

### P0：本轮先收口

1. R10 F04/F05/F06：固定 revolute、joint chain、position motor 与双向限位双端门禁已完成；MultibodyJoint、速度模式/扭矩预算、运行时控制更新与产品宿主接线仍待。
2. R12 生产 render-loop 捕获已交付；内置 PBR source-map 消费、资源快照和调试 UI 仍待。
3. FINAL-GATE 第一轮：性能、确定性、渲染回归、核心 UI/功能回归；不包含 Babylon/Unity/A01-X/480min soak。

### P1：性能轴

1. C3 材质 uniform / texture revision / LOD / shadow flag / Deep2D 增量剩余收口。
2. R2 DCIR v1 真实消费：先迁移一个 probe/HiZ 之外的真实 buffer 消费点，跑 WebGPU + Native 对拍；loop-range 后续接 G7 GPU march。
3. R4 万灯/meshlet/indirect 二期；当前遮挡尾巴已完成但默认开关仍关闭。
4. R6-3 把 bounded scheduler 接到真实 RenderGraph encode/worker/encoder 路径；当前只是 host-neutral 首切片。
5. R9 virtual geometry：基于 Bevy visibility-buffer 蓝本的原型，尚未实施。
6. G3 compile-time HLOD/impostor chain，尚未实施。
7. PSO 磁盘缓存、按设备预算自适应质量、后台资产准备，仍在总路线图中。

### P1：效果轴

1. R1 DDGI / Surface Cache 动态更新，尚未完成。
2. G7 体积雾 GPU pass 已有，但未接生产 render graph、未做真实 GPU 对拍。
3. E04 SSR 二阶段：temporal accumulation、roughness mip/反射稳定性。
4. E05 多灯阴影、PCSS、接触阴影、面积光；E02 IES native 消费尚未完成。
5. C04/C05 材质与后处理效果账本，继续跟随渲染链实测。

### P1：能力轴

1. P5 空间校验：核心 OBB/SAT/broadphase 已有；产品 UI 导出入口/限高规则收口仍待。
2. P7 QTO：体积/表面积/分类聚合核心已有；产品 UI 导出入口仍待。
3. R11：动画状态机首切片已交付；路径/约束写回 SceneTransformGraph、编辑器/运行时挂载仍待。
4. R12：真实 render loop 接线、source-map UI 调试面仍待。
5. P2/P3/P4：核心与运营 UI 首切片已有；生产数据持续摄取/真实数据链路/权限与错误态深测仍待。
6. R5 AI compile chain/H09、G06/G08、D24-D28、V04/V05，仍在总路线图中。

### P2：工业格式与后排

- RVT 2026 记录形态：当前停止，需新样本/新证据再排期；
- C3 Deep2D/资产与 dashboard delivery 并行 WIP：必须先按其独立交接收口；
- P6 FMU/FMI、P8 IFC 深水、G4 地理坐标、G9 多人协同、G10 XR、V12 Splat/扫描方向：按路线图标注后排/用户未批准，不得偷删，也不得冒充完成。

## 5. 已知验证边界与阻塞

- 工作树有大量其他会话未提交改动，集中在 apps/api、apps/web delivery、RVT/资产脚本等；主线提交只圈定相关文件，禁止 reset/clean/checkout 覆盖。
- web 全量 tsc 曾被并行 dashboard delivery 文件阻塞；P3/P4 自身聚焦测试通过。
- deep-engine tsc 在 R12 修复后已通过；DCIR v1 23/23、R6-3 5/5、R11 25/25、R12 16/16（重复镜像执行）、G7 29/29 均有证据。
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
