# 主流程交接：Deep2D、Deep Engine、工业格式

> 版本：2026-09-17
> 适用目录：D:/Documents/bim/bim-studio
> 用途：下一会话按本文件的顺序、证据和门禁继续任务。
> 口径：历史百分比只作背景；关闭任务必须有代码、测试、证据、台账和独立提交。

## 0. 目标与固定顺序

目标：在轻量化、极致性能、优秀视觉效果和大道至简的架构约束下，形成可复现、可离线、可回退的 Deep2D、Deep Engine、工业模型和客户端交付链。

固定主线顺序：

1. 收拢当前工作树和在途提交，完成 Web 静态包真实闭环。
2. 完成 Deep2D 正式发布链，再做 P1 性能、P2 受限兼容、P3 热同步和后验收。
3. 完成 Deep Engine 的 SceneSnapshot → RenderPacket/runtime package → Web/Native 播放链，再做性能、视觉和客户端工程化。
4. 工业格式按 S0 → S6 推进；S0/S1 是硬前置，JT/3DM 可先形成增量，X_T/RVT/SolidWorks 只按证据开放。
5. 主流程收官后，才由用户决定是否启动 DE26。DE26 不计入当前三条主线完成率。

Web 与 Native 是两条交付链：

- Web：静态资源包、浏览器启动、浏览器全屏、HTTP/静态托管、资源闭包。
- Native：离线包、独立 EXE、Unity 风格标题栏、窗口化/全屏、断网启动、更新与回滚。

原生 ZIP、DMDA 或单次 GPU 探针不等于静态 Web 包，也不等于正式 Native ready。

## 1. 权威入口

接手后按以下顺序读取；冲突按“用户最新指令 > 工作区 AGENTS.md > 权威计划 > 单次报告”处理：

1. AGENTS.md、bim-studio/AGENTS.md。
2. specs/industrial-3d-format-work-plan-2026-09-16.md。
3. 本文。
4. active-task-recovery-ledger.md。
5. specs/deep2d-remaining-tasks-2026-09-16.md。
6. specs/deep-engine-execution-plan-2026-09-15.md、specs/deep-engine-comprehensive-plan-2026-09-16.md。
7. specs/de26-high-value-scope-2026-09-17.md（仅主线结束后）。

旧交接只能作背景，不能覆盖这些入口；不得用百分比代替状态。

## 2. 已确认基线与未关闭项

只计已提交或独立复核证据，未提交的并行工作保持“在途”。

| 区域 | 可信事实 | 未关闭 |
|---|---|---|
| Native 纯二维 | e9d004f：无 Bloom/Fog/探针/三维实例时 ForwardTargets 紧凑为 1×1；ACES 和坐标路径保留；125 项常规、真实窗口切换/零尺寸恢复、GPU 40 组 41,032 像素等价和 6 组非均匀采样通过。 | 不扩大为整体显存、FPS 或完整产品视觉收益；Bloom 仍完整分配。 |
| Native 前向预算 | 2f25804：修正 4× MSAA 深度漏算，44 B/px 改为 56 B/px；输出 shader 读取 HDR 并做 ACES/编码。 | 不能直接删除 output pass，仍需像素等价和视觉证据。 |
| RVT | 44d45f4：Core2024 源记录身份、分区/ElementId/偏移/hash 可追溯，重复文件去重。 | 仍为 inspect/identity；无生产几何、墙宽或完整构件 ready 证据；未知版本阻断。 |
| JT | e0c5e83：源 alpha 乘场景透明度，WeakMap 基线、共享材质不累乘、深度模式可恢复；32 项焦点测试和 Web 类型通过。 | 完整装配、材质覆盖、跨端视觉和生产发布未关闭。 |
| 3DM | 8360e0f：53 条不一致共边已分类，49 条有源 C3 下界；旧派生边界点矛盾已记录，未改源文件。 | 继续局部接缝重建，保持源 UV/身份、拓扑/法线和 0.01 mm 总预算。 |
| 背景/原生 | 3ba4c98、119dd20：真实上传→发布/公开读取→磁盘重开→候选→ZIP/DMDA/无参数 EXE 打开链已有证据；Web/Native 已分开。 | 静态 Web loader、资源闭包、篡改/窄屏/主题/全屏和最终门禁仍待。 |
| Web 静态包 | 在途代理已有 HTML/JS/CSS/Worker/WASM/图片/字体和 web.zip，子目录服务及浏览器全屏入口已验。 | 最后 EOF 到达时取消仍能发布完成包；realpath/junction、窄屏/浅色/篡改、报告和提交未关闭。 |

## 3. 硬门槛

### 工业格式

- Parasolid 用户可见名称只能写 X_T，扩展名只能写 .x_t，禁止写 XT。
- 生产链必须自研或固定版本的开源实现，默认断网；禁止商业 SDK、商业转换器、源 CAD/BIM 软件、云转换、在线授权或许可证服务器作为依赖、回退、验收依据或 blocker。
- X_T 的 Python/OCP 组合只能做 S0 验证；生产桥必须由无 Python 机器上的原生 Worker 完成同等验证。
- 未可靠解析只能是 inspect/preview/blocked；bbox、诊断代理或默认值不能冒充工程几何。
- 每个样本记录来源、SHA-256、授权边界、版本、预期几何和验证命令；私有模型不提交仓库。
- 缺资源先查 D:/Download、仓内/本机缓存、官方仓库/发布页、开放数据源和等价开源实现；全部实际尝试失败后才记 blocker。

### 架构

- R3F/TresJS 只参考声明式场景、生命周期、资源复用和脚本边界；不建设兼容层，不新增其运行依赖。
- 不新建第二套 loader、资源身份或发布状态机；复用 runtime package、prewarm、candidate/LKG、SourceBundle、ScenePublication。
- 体积优化后置；先测冷启动、首次可交互、峰值 RSS、GPU 目标和资源闭包。

## 4. 执行顺序

### 阶段 0：接手盘点

1. 读取本文、台账和当前 lane 计划。
2. 执行 git status --short、git log -8 --oneline，确认在途文件和 GPU/浏览器/构建进程。
3. 按文件确认 ownership；不得代提交他人未验证整组文件，不得 git add .。
4. 为本片写目标、输入/输出、依赖、证据、提交文件和 blocker；先聚焦测试，合流时全量。

### 阶段 1：Web 静态包

1. 修复 dashboardWebPackageLoader 最后 EOF 取消竞态；取消、截断、超大资源、重定向、恶意路径、malformed UTF-8 必须 fail-closed。
2. 完成 realpath/junction/目录穿越和资源闭包校验；manifest 的 HTML、JS、CSS、Worker、WASM、图片、字体必须存在、hash 匹配且在包根。
3. 实际运行根目录/子目录服务、冷启动、刷新、浏览器全屏、标准/窄屏、深色/浅色、缺资源/坏 hash/取消恢复。
4. 完成两轮真实浏览器截图闭环；静态截图不代替性能证据。
5. 跑 Web typecheck、聚焦测试、生产构建、包内容检查和 pnpm gate:repository，写报告并独立提交。

### 阶段 2：Deep2D（P0 → P1 → P2 → P3 → V）

#### P0 正式发布

按依赖执行：

- P0-01：Dashboard 完整 lowering——文字、图片、KPI、表格、图表、筛选、阴影、页面外观、publicationReady。
- P0-03：DashboardDocument、作者组件、绑定、字体/图片闭包、稳定身份和三端 loading；编辑→保存→刷新→发布→下载→离线打开同一版本。
- P0-04：正式 manifest、目标产物、平台证据和逐对象 supported/degraded/blocked/webview-only；无 fixture、设备、字体范围不得 supported。
- P0-05：统一 validate→dependency closure→prewarm→frame→present→LKG；覆盖取消、迟到、连续换包、坏资源和旧版本回退。
- P0-06：动态 Dashboard 真实发布与离线启动；不能借用三维或纯 demo 报告。
- P0-07：完整布局、内容、文本、交互同源三端 golden，比较 producer、对象/资源身份、命中和状态轨迹。
- P0-08：Browser/Native 像素与输入矩阵，双主题、标准/980px、DPI、真实 OS 输入和差异原因分开记录。

#### P1 动态核心与性能

- P1-23 N1 版本化适配器：Rust 切片已有版本化信封和 fail-closed 三态；TS 端到端消费、正式绘制和 fixture 范围仍需复核。
- P1-03 数据分块接入真实数据窗口。
- P1-09 按 56 B/px 修正口径做真实目标裁剪和像素等价。
- P1-13 接受控 HTTP/订阅/异步握手。
- P1-16 接 OS 屏幕阅读器桥。
- 换包、失败恢复、GPU 窗口和取消轨迹只接一套状态机。

#### P2 受限实验

- P2-01：独立受限进程、IPC、超时、崩溃/终止隔离和回执；不运行任意 JS，不将实验 lane 变成 N0。
- P2-02：只认证冻结的 ZRender 6.1.0 动态 bar rect 子集；formatter、图片、tooltip、动画、非 rect 继续 blocked。
- P2-03：真实 Windows IME、异常/超时轨迹、bidi/fallback/换行像素证据；离线 composition/commit 不等于系统 IME。
- P2-04 报告已冻结准入/淘汰规则，但不关闭 P2-01～03。

#### P3 与后验收

- P3-01 内容寻址 delta、资源闭包、校验、预热、迟到/丢包/不兼容回退。
- P3-02 同一作者 revision 的 Web/Three/Native 预览，取消陈旧编译，失败不污染当前预览。
- P3-03 签名扩展与 HostCapabilities，扩展独立分发。
- P3-04 Windows 设备/驱动、字体/DPI/显存、设备丢失恢复矩阵。
- P3-05 正式升级与回滚，覆盖离线旧版、坏 hash/schema、资源缺失、取消和检查点恢复。
- 最后完成 V-01～V-05：完整用户流、Kimi-95 视觉闭环、三证/资源证、稳定性/失败注入、全量门禁。这里的 V 是 Deep2D 项目后验收，不是 DE26 已删除的 V。

### 阶段 3：Deep Engine

1. 合同与发布：冻结 SceneSnapshot、RenderPacket、runtime package、manifest、版本、对象/资源身份、依赖闭包、相机/坐标/单位和质量等级；发布失败不能出现“成功但没有包”。
2. Native 消费：正式接 geometry/material/texture/camera/clip/animation/Deep2D；标题栏、窗口化/全屏、F11/恢复、无参数 EXE、离线启动均从正式包验证。
3. Web 消费：复用同一版本合同和资源闭包；Three WebView 入口保留但不作为 Deep Native 证据。
4. 资源与数据：坐标重基、资源寻址、动态更新、凭据脱敏、取消/超时、device lost、LKG 和回滚。
5. 性能/视觉：固定资产、分辨率、DPR、画质、轨迹和设备；分别测 CPU prepare、GPU timestamp、present、输入、上传、峰值 RSS/显存；PBR、IBL、CSM、Bloom、ACES、透明/剖切和 Deep2D 做跨端阈值。
6. 客户端工程化：Web 发布包与 Native EXE/ZIP/安装包分别做 hash、资源闭包、更新/回滚、断网和损坏恢复；体积优化后置。
7. RT 保持隔离，不阻塞 P0～P3；只有真实收益和稳定性证据齐全才进入默认管线。

### 阶段 4：工业模型（S0 → S6）

1. S0：七方向都有真实输入、来源/hash/license、失败分类、离线构建、体积/RSS/冷启动记录。
2. S1：统一 SourceBundle、质量合同、取消/恢复/复转、attempt 目录、哈希审计、旧版本保留、原子活动指针和并发/重启测试。
3. S2：JT 装配/材质/身份/透明度；3DM 保存网格、局部接缝、源映射、法线/拓扑。当前 3DM 仍是部分预览。
4. S3：E57/LAS/LAZ/COPC 与本地 3D Tiles，分块调度、坐标/配准、回收和大场景证据。
5. S4：X_T 常见实体、单位、曲面/拓扑/孔洞、源映射、误差报告和原生离散桥；圆柱边界、交线、未解析面保持 unknown/blocked。
6. S5：RVT 开源 reader 的容器/schema/稳定身份和有限构件几何；SolidWorks 可行性/零件装配试点。Revit Worker、诊断 bbox、商业结果不能计 builtin-only ready。
7. S6：版本矩阵、Native/Web、发布、断网、回滚、混合场景和质量报告全通过后才扩大 profile。

S2/S3 在 S0/S1 通过后可以并行；S4/S5 服从样本和解析证据，不以工期倒逼升级。

### 阶段 5：DE26（最后、可选）

只在主流程结束且用户明确启动时做。对标只保留 Three.js、Babylon.js、Unity；A05–A07、V01–V05 已删除，不能以别名或隐含依赖回流。

保留最小高价值集：A01–A04/A08；D01、D04–D06；F01、F04、F05；H02–H04、H07（含材质调试）；I04、I05、I07（含双骨 IK）；B/C/E/G 只保留已有能力之外的高价值工作；X01–X05 仅作研究背景。

## 5. 单卡完成规范

同时满足以下条件才关闭：

1. 合同：输入、输出、版本、身份、单位/坐标、预算、取消/超时、失败语义和兼容范围。
2. 正式实现：走生产入口，复用已有状态机/loader/资源身份；demo、探针、旁路脚本不算。
3. 测试：成功、空/坏输入、边界、取消、超时、并发/重启、迟到和失败回退；跨语言合同有 golden。
4. 真实证据：设备/驱动/后端、资产/样本来源、版本、运行次数、hash、像素/结构阈值和限制。
5. UI/3D 证据：使用 base.css 令牌，真实浏览器/窗口至少两轮截图；深浅主题、标准/窄窗、全屏/恢复按范围验证。
6. 门禁：相关 typecheck/test/build、git diff --check、pnpm gate:repository；Rust 按下列命令。
7. 记录：更新 spec/report、活动台账和必要 CHANGELOG，写明已验证/未验证/阻断/下一步。
8. 提交：只提交本片文件；不提交 secrets、模型缓存、临时日志、未验证并行改动，不 push。

## 6. 性能与视觉口径

固定资产、格式、版本、分辨率、DPR、质量、相机/输入轨迹、设备和驱动。CPU prepare、GPU timestamp、present、输入延迟、上传字节、峰值 RSS、显存估算和包字节分开记录。合成夹具只证明算法边界，正式结论优先真实 BIM/工业样本和真实窗口；没有跨端/回归证据就保持实验开关。

视觉闭环必须有 base.css 令牌、标准与 980px、深浅主题、空/错/加载/取消态；Native 标题栏/全屏/恢复与 Web 浏览器全屏分别截图。两轮截图后按层级、对比、密度、对齐、字体、状态、动效、空间氛围、主题一致性、窄屏/全屏适配十维评分；低于 9/10 继续修。

## 7. 固定门禁命令

~~~powershell
pnpm --filter @bim-studio/web typecheck
pnpm --filter @bim-studio/web test -- --run
pnpm --filter @bim-studio/api typecheck
pnpm --filter @bim-studio/api test
pnpm --filter @bim-studio/deep-engine typecheck

cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml -- --check
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native

pnpm gate:repository
~~~

真实 GPU、浏览器、静态包服务和工业样本命令写入各自报告，包含后端、驱动、资产 hash 和运行次数。公共 Web 修改或合流时补生产构建和浏览器门禁。

## 8. 下一会话最短清单

1. 读本文、active-task-recovery-ledger.md 和当前 lane 计划。
2. 查看 git status --short、git log -8 --oneline，确认并行代理和 GPU/浏览器/构建进程。
3. 先修 Web static package loader 最后 EOF 取消红测试和路径安全，独立提交。
4. 再收拢 Deep2D P0-01/P0-03/P0-04/P0-05/P0-06/P0-07/P0-08；已有 P1/P2 单元切片不能直接标整项完成。
5. Deep Engine 先冻结 SceneSnapshot/RenderPacket/runtime package 的实际消费者，再接 Native/Web；标题栏、全屏、离线 EXE 走真实包。
6. 工业线复核 S0/S1 样本和许可证，S2/S3 可并行；JT/3DM、X_T、RVT 未知项按证据推进，禁止代理几何填空。
7. 每片更新报告、台账和独立提交；主线完成后再报告是否启动 DE26。

## 9. 交接红线

- 不写 XT；只写 X_T 和 .x_t。
- 不把商业 SDK、Revit/NX/SolidWorks/Rhino、云转换或许可证服务器写成依赖、回退或 blocker。
- 不把 bbox、截图、CPU 模拟、单次探针、静态 ZIP 或测试数量扩大成生产能力。
- 不因工作树脏就整批提交；不使用 git add .，不 push。
- 不删 unknown/blocked、不降低误差预算、不放宽 hash/版本检查、不跳过取消/恢复。
- 不把 DE26 混入 Deep2D、Deep Engine、工业模型当前完成率。
