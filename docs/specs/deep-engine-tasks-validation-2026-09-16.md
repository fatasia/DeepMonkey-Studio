# Deep Engine 验证手册、项目验收与范围差距

2026-09-16。[总方案](deep-engine-comprehensive-plan-2026-09-16.md)｜[基础任务](deep-engine-tasks-foundation-2026-09-16.md)｜[产品任务](deep-engine-tasks-product-2026-09-16.md)｜[机器清单](deep-engine-execution-tasks-2026-09-16.json)。

## 1. 每张任务卡如何执行

1. **领取**：复核当前HEAD、dirty文件、总账、原任务和本卡依赖。已有能力先找正式调用者，再查对应失败测试与实际样本。代码路径是导航入口，不是整目录修改授权。
2. **冻结**：写清输入/输出、版本、稳定ID、资源所有权、失败旧状态、取消边界和兼容策略。性能/画质/精度阈值在第一次比赛前冻结。
3. **实现**：先一个端到端切片。涉及公共ABI必须有旧版本和双语言golden；大卡拆合同、执行、集成三次PR，每次保持可运行。
4. **验证**：新反例＋全量参考对照＋相关现有回归。UI要真实操作和两轮截图；GPU要实际提交/读回/设备日志，不能用mock替代。
5. **关闭**：目标用户任务通过，证据绑定source/compile/artifact/设备身份。独立复核后标“已完成”；仅模块存在或单元绿不关闭整卡。

任务状态只使用已完成、本轮待办、明确排除、项目级后验收。CPU/GPU/窗口/OS输入/浏览器/离线是不同证据种类。运行日志留在忽略目录；仓库只存可复现规格、必要指标和证据索引。

<a id="commands"></a>
## 2. 验证代号与现有命令

命令工作目录：仓库根 `<repository-root>`。以下是执行任务时的入口清单，**不代表本轮已全部运行**。先针对改动文件执行专项，整卡集成后运行对应包完整门禁；不要每个小PR重复跑无关全仓。

### T：TypeScript引擎

```powershell
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine lab:build
```

新增专项按实际测试文件运行 `pnpm --filter @bim-studio/deep-engine exec vitest run <实际测试文件>`；尖括号是执行人替换的参数，不是已有文件。完整test包含purity/source-size等后置检查，Vitest通过不能替代命令整体成功。

### W / A：Web与API

```powershell
pnpm --filter @bim-studio/web typecheck
pnpm --filter @bim-studio/web test
pnpm --filter @bim-studio/web build
pnpm --filter @bim-studio/api typecheck
pnpm --filter @bim-studio/api test
pnpm --filter @bim-studio/api build
```

当前可复跑的本轮专项：

```powershell
pnpm --filter @bim-studio/deep-engine exec vitest run src/runtimePackage/dashboard.test.ts src/runtimePackage/chart.test.ts src/threeBridge/ThreeProjectionBridge.test.ts src/renderGraph.test.ts src/benchmarkContract.test.ts
pnpm --filter @bim-studio/web exec vitest run src/delivery/compileDashboardContent.test.ts src/delivery/compileDashboardRasterContent.test.ts src/delivery/lowerDashboardChart.test.ts src/delivery/compileSceneRuntimePackage.test.ts src/viewer/StudioDeepWebGpuBridge.test.ts
pnpm --filter @bim-studio/api exec vitest run src/dashboardPublicationAuthorityAdapter.test.ts src/dashboardPublicationFreeze.test.ts src/dashboardPublicationCapability.test.ts
pnpm --filter @bim-studio/api exec vitest run src/dashboardNativeCandidateService.test.ts src/dashboardRuntimeArtifactCompiler.test.ts src/dashboardOfflineArchive.test.ts
```

### N：Native CPU与静态检查

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --all --check
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

Native不是pnpm包，不使用不存在的pnpm native脚本。ignored测试包括GPU和性能等不同类别，应报告skip数量及原因。

### GPU：真实设备流程

- 先枚举 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked -- --list`，选与任务对应的GPU test名。
- 串行运行选定case，设置 `--test-threads=1`；确认adapter/API/EXE/fixture hash和实际present/readback。不要无差别执行所有ignored基准。
- 现有Dashboard入口示例：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native dashboard -- --ignored --nocapture --test-threads=1`。运行前核对该过滤器当前匹配的测试，新增名后更新证据清单。
- Browser复用Lab/现有WebGPU门禁，保留真实navigator.gpu adapter与GPU scopes；fallback到软件或其他后端必须分开报告。
- 独占GPU与构建产物，避免别的任务更换EXE或占满GPU。无匹配硬件的项保持未验证，不等待虚构结果。

### WEB：视觉与实际交互

现有命令：`pnpm gate:product-browser`、`pnpm gate:webgpu`；按变更补相应场景。

必须真实点击/拖拽/输入/切页/刷新，不只断言DOM存在；覆盖双主题、相关1920/1280/980/800/480档、DPI、空/错/禁用/权限态。两轮截图按design-taste-digitaltwin十维评分，每维≥9才通过。Native额外区分合成handler事件与真实OS鼠标/IME事件。

### BENCH / SDK / INTEGRATION / REPORT / RESEARCH

| 代号 | 执行与产物 |
| --- | --- |
| BENCH | Web现有入口：`pnpm --filter @bim-studio/web benchmark:render-engines`。新 Unity/Bevy runner 按对应研究卡新增，当前不能给它们伪造已存在命令；完成后登记完整命令、安装前置与原始样本。Unity 复用本机安装；Bevy 固定版本与 SHA 后安装到工作区外隔离缓存，不写项目依赖、系统 PATH 或产品包。Bevy 挑战轨固定正式发布的 0.19，并保留完整 Cargo.lock、feature 集、wgpu 后端和构建 profile。UE、Godot 不进入测试基准。 |
| SDK | `pnpm gate:sdk-consumer`，另增加H01独立consumer工程真实build/run；Unity桥现有 `pnpm test:unity-bridge` 只验证桥，不能替代Unity渲染性能。 |
| INTEGRATION | 受控测试项目走保存→刷新→发布→下载落盘→校验→同包启动→交互→恢复；测试PG/MinIO与离线机器各自留证。不得修改固定账号或生产数据。 |
| REPORT | 检查矩阵分母、hash、版本、样本、置信区间、失败与未测项；至少另一名复核人或独立环境复跑。缺资源/硬件明确记录。 |
| RESEARCH | 实际官方API/依赖验证、小型实验、预算/风险/淘汰条件、RFC。研究报告通过不等于功能已实现。 |

全局合并门禁：`pnpm gate:repository`、`pnpm quality:source-size`，以及改动对应类型、测试、构建、视觉/GPU门禁。不可降低门禁阈值让当前改动通过。

## 3. 性能与胜出规则

- Deep、Three、Babylon、Unity、Bevy 的版本和各渲染器独立锁定。Three 本地 0.185.1、Babylon 隔离 9.26.1 可作为固定历史基线；增加当前稳定版挑战轨，不能只挑旧版本。Bevy 使用 0.19 正式版，不再以 0.17 的历史结果代表当前对手。UE、Godot 仅作架构参考，不参与实测排名或能力分母。
- Web对Web，Native对Native；产品任务对功能等价实现。允许正常优化，给对手同等调优时间。
- 工厂实例、异构BIM、远原点园区、动态工作单元、混合看板、外观展示六类负载；至少三个真实项目。
- 同画质主要case目标P95降低≥20%，所有关键case回退≤5%；显存降低≥25%、可交互加载/任务耗时降低≥30%是分别验证的目标，不能由帧时推导。
- Bevy 对比必须覆盖静态与动态实体、GPU driven 批处理/MDI、材质异构、多灯阴影、GUI/文本输入和大场景流送；同时报告 ECS/Extract/Prepare/Queue/Render 与 Deep 编译包/增量投影/编码/提交的 CPU 分段。只赢空 ECS、纯立方体或单一 GPU pass 不算引擎性能胜出。
- 5组成对交替是最低轮次；每轮稳定采足逐帧样本，P99需足够样本量。使用分组置信区间，不能把自相关帧当独立样本制造显著性。
- GPU时间戳不可用时报告缺失；CPU计时、GPU计时、RAF/呈现间隔和输入到反馈分别报告。
- 显存写明逻辑载荷/分配预算/驱动可见用量；浏览器限制导致无法取真实驱动用量时不编造数字。估算只与同口径估算比较。
- 材质/灯光/GI/透明/AA/分辨率冻结；运动画质用视频、细线/文字可读性和遮挡显露反例，单SSIM不够。
- 静态、1%状态更新、全量更新、快速转身、流式加载、选择剖切同时存在的case分别报告。
- 可靠性/兼容/精度为硬门；均值优势不能抵消关键失败。

## 4. V · 项目级后验收

<a id="v01"></a>
### V01 · Web引擎逐对手胜出验收

- **排程**：P0｜项目级后验收｜责任角色：独立性能QA｜初估 4–7 工程人日。
- **已有基础**：A04提供runner，当前没有综合胜出结论。
- **代码入口**：[.github/workflows/deep-engine.yml](../../.github/workflows/deep-engine.yml)；[scripts](../../scripts)；[docs/specs](../../docs/specs)；[packages/deep-engine/lab](../../packages/deep-engine/lab)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：冻结所有关键case并复跑Deep对Three、Babylon，检查质量与置信区间，保留失败项。
- **通过标准**：各对手分别至少两类主要负载P95改善≥20%；所有关键case回退≤5%，必选质量与正确性全过。
- **边界/失败验证**：统计不足/无timestamp不能拿缺失项算赢；禁止只挑最好case。
- **依赖**：[A04](deep-engine-tasks-foundation-2026-09-16.md#a04)、[A08](deep-engine-tasks-foundation-2026-09-16.md#a08)、[B04](deep-engine-tasks-foundation-2026-09-16.md#b04)、[B08](deep-engine-tasks-foundation-2026-09-16.md#b08)、[D06](deep-engine-tasks-foundation-2026-09-16.md#d06)、[E06](deep-engine-tasks-product-2026-09-16.md#e06)。
- **验证**：BENCH+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D24/D25。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="v02"></a>
### V02 · Native逐对手与画质验收

- **排程**：P1｜项目级后验收｜责任角色：独立性能/视觉QA｜初估 6–10 工程人日。
- **已有基础**：Unity/Godot/UE需分别测试。
- **代码入口**：[.github/workflows/deep-engine.yml](../../.github/workflows/deep-engine.yml)；[scripts](../../scripts)；[docs/specs](../../docs/specs)；[packages/deep-engine/lab](../../packages/deep-engine/lab)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：用A05–A07跑Native成对比赛，覆盖等质量与最佳质量；动画/透明/数据联动保持同功能。
- **通过标准**：三份独立结果；质量稳定性视频/资源/输入/帧时均有结论；落后项公开。
- **边界/失败验证**：跨硬件、编辑器对发布版、省特效、忽略加载尾延迟均无效。
- **依赖**：[A05](deep-engine-tasks-foundation-2026-09-16.md#a05)、[A06](deep-engine-tasks-foundation-2026-09-16.md#a06)、[A07](deep-engine-tasks-foundation-2026-09-16.md#a07)、[A08](deep-engine-tasks-foundation-2026-09-16.md#a08)、[E08](deep-engine-tasks-product-2026-09-16.md#e08)、[F02](deep-engine-tasks-product-2026-09-16.md#f02)、[I08](deep-engine-tasks-product-2026-09-16.md#i08)。
- **验证**：N+GPU+BENCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D24/D25。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="v03"></a>
### V03 · 故障与正式交付矩阵

- **排程**：P0｜项目级后验收｜责任角色：发布/QA｜初估 5–8 工程人日。
- **已有基础**：已有局部恢复/包校验证据。
- **代码入口**：[.github/workflows/deep-engine.yml](../../.github/workflows/deep-engine.yml)；[scripts](../../scripts)；[docs/specs](../../docs/specs)；[packages/deep-engine/lab](../../packages/deep-engine/lab)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：覆盖真实PG/MinIO发布、落盘、干净Windows离线、更新回滚、设备丢失、20次重建和短时压力。
- **通过标准**：0数据错版/不可恢复坏包；资源回落无持续增长；失败路径都有可操作反馈。
- **边界/失败验证**：401/5xx/超时/取消/磁盘满/网络断开/坏hash/旧版本逐项验证。
- **依赖**：[G05](deep-engine-tasks-product-2026-09-16.md#g05)、[G06](deep-engine-tasks-product-2026-09-16.md#g06)、[H07](deep-engine-tasks-product-2026-09-16.md#h07)、[I07](deep-engine-tasks-product-2026-09-16.md#i07)。
- **验证**：N+A+W+INTEGRATION+GPU（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D26/D27；V-01/V-05。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="v04"></a>
### V04 · 统一产品视觉与开发者任务

- **排程**：P0｜项目级后验收｜责任角色：产品/视觉QA｜初估 5–8 工程人日。
- **已有基础**：未完成完整双轮视觉与外部独立SDK任务证据。
- **代码入口**：[.github/workflows/deep-engine.yml](../../.github/workflows/deep-engine.yml)；[scripts](../../scripts)；[docs/specs](../../docs/specs)；[packages/deep-engine/lab](../../packages/deep-engine/lab)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：真实操作浏览器/Native双主题1920/1280/980等相关档、两轮截图；独立人员做导入编辑脚本发布五任务。
- **通过标准**：design-taste-digitaltwin十维逐项≥9且有截图；输入/可达/空错态全过；任务耗时可与对手比较。
- **边界/失败验证**：截图不能代替真实点击/IME；小窗口/字体缺字/无权限不能省略。
- **依赖**：[G07](deep-engine-tasks-product-2026-09-16.md#g07)、[H01](deep-engine-tasks-product-2026-09-16.md#h01)、[H04](deep-engine-tasks-product-2026-09-16.md#h04)、[D07](deep-engine-tasks-foundation-2026-09-16.md#d07)、[I01](deep-engine-tasks-product-2026-09-16.md#i01)。
- **验证**：WEB+N+SDK（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：D28；Deep2D V-02/03/04。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="v05"></a>
### V05 · 综合领先审查与发布结论

- **排程**：P0｜项目级后验收｜责任角色：架构/独立评审｜初估 2–4 工程人日。
- **已有基础**：旧90%覆盖不等于本次超越。
- **代码入口**：[.github/workflows/deep-engine.yml](../../.github/workflows/deep-engine.yml)；[scripts](../../scripts)；[docs/specs](../../docs/specs)；[packages/deep-engine/lab](../../packages/deep-engine/lab)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：汇总全部域状态与四对手矩阵；关键能力全通过、主要指标领先、非领先项显式呈现；独立复跑。
- **通过标准**：分别发布局部/领域/综合结论；X域未解除或未过验收时不得称全平台全能力超过。
- **边界/失败验证**：删分母/权重掩盖短板/生态与平台缺项隐去均拒绝综合领先。
- **依赖**：[V01](deep-engine-tasks-validation-2026-09-16.md#v01)、[V02](deep-engine-tasks-validation-2026-09-16.md#v02)、[V03](deep-engine-tasks-validation-2026-09-16.md#v03)、[V04](deep-engine-tasks-validation-2026-09-16.md#v04)、[I02](deep-engine-tasks-product-2026-09-16.md#i02)、[I03](deep-engine-tasks-product-2026-09-16.md#i03)、[I04](deep-engine-tasks-product-2026-09-16.md#i04)、[I05](deep-engine-tasks-product-2026-09-16.md#i05)、[I06](deep-engine-tasks-product-2026-09-16.md#i06)、[B07](deep-engine-tasks-foundation-2026-09-16.md#b07)、[C05](deep-engine-tasks-foundation-2026-09-16.md#c05)、[E03](deep-engine-tasks-product-2026-09-16.md#e03)、[E07](deep-engine-tasks-product-2026-09-16.md#e07)、[F05](deep-engine-tasks-product-2026-09-16.md#f05)、[F06](deep-engine-tasks-product-2026-09-16.md#f06)、[F07](deep-engine-tasks-product-2026-09-16.md#f07)、[G08](deep-engine-tasks-product-2026-09-16.md#g08)、[H08](deep-engine-tasks-product-2026-09-16.md#h08)。这些依赖的传递闭包必须覆盖全部72张建设卡；遗漏的关键域会阻止综合结论。
- **验证**：REPORT（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：旧benchmark v1升级。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

## 5. X · 综合超越尚需单独处理的范围差距

这些领域在现有交付线仍为“明确排除”，本次分析完整列出，避免从综合对标分母消失。用户本次提出综合超越，本文为其规划长期路线；不自动撤销既有Windows/轻量Shader等实施约束。X卡给出具体研究输入与退出条件，尚不是实现授权或实现已完成。开始长期研发时先明确覆盖范围并把选中的RFC继续拆为实现卡；在此之前只能声明已验证领域领先。

<a id="x01"></a>
### X01 · 高端RT/路径追踪专项决策

- **排程**：P3｜明确排除｜责任角色：图形研究｜初估 3–5 工程人日。
- **已有基础**：P4当前只有探测合同；重型RT/路径追踪属现交付线明确排除。
- **代码入口**：[docs/specs](../../docs/specs)；[packages/deep-engine/src](../../packages/deep-engine/src)；[packages/deep-engine-native/src](../../packages/deep-engine-native/src)；[apps/web/src](../../apps/web/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：调研当前WebGPU/wgpu/原生后端真实接口，设计一项硬件ray-query或离线参考实验，测质量/预算后形成实现RFC。
- **通过标准**：RFC给真实支持平台/版本、CPU/GPU证据、fallback与失败淘汰条件；若立项再拆实现卡。
- **边界/失败验证**：仅有feature字段不能判已支持；实验失败不能影响光栅主路径。
- **依赖**：[A01](deep-engine-tasks-foundation-2026-09-16.md#a01)、[E03](deep-engine-tasks-product-2026-09-16.md#e03)、[E04](deep-engine-tasks-product-2026-09-16.md#e04)。
- **验证**：RESEARCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：明确排除：重型RT/PT。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="x02"></a>
### X02 · 完整虚拟几何与高级阴影专项

- **排程**：P3｜明确排除｜责任角色：几何研究｜初估 3–5 工程人日。
- **已有基础**：Nanite Lite保留；UE全套虚拟几何属现范围明确排除。
- **代码入口**：[docs/specs](../../docs/specs)；[packages/deep-engine/src](../../packages/deep-engine/src)；[packages/deep-engine-native/src](../../packages/deep-engine-native/src)；[apps/web/src](../../apps/web/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：比较I08与目标Nanite/VSM在层级压缩/流式/变形/阴影上的残差，形成可复用研究切片与成本。
- **通过标准**：真实数据证明何种负载仍落后；独立RFC决定扩展，不用meshlet名称替代系统能力。
- **边界/失败验证**：不以LOD截图或总面数证明Nanite等价。
- **依赖**：[I08](deep-engine-tasks-product-2026-09-16.md#i08)、[V02](deep-engine-tasks-validation-2026-09-16.md#v02)。
- **验证**：RESEARCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：明确排除：UE全套虚拟几何。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="x03"></a>
### X03 · 复杂节点创作工具专项

- **排程**：P3｜明确排除｜责任角色：工具/产品研究｜初估 3–5 工程人日。
- **已有基础**：轻量DeepSL保留；复杂Shader Graph现范围明确排除。
- **代码入口**：[docs/specs](../../docs/specs)；[packages/deep-engine/src](../../packages/deep-engine/src)；[packages/deep-engine-native/src](../../packages/deep-engine-native/src)；[apps/web/src](../../apps/web/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：以三种外部开发者材质/VFX任务比较轻量方案与节点工具，形成必要节点集、诊断/迁移/版本RFC。
- **通过标准**：可用性实验与维护成本支持立项；需求拆为真实用户任务，非仅节点数量。
- **边界/失败验证**：只会连线不能编译/保存/发布的原型不得算完成。
- **依赖**：[H04](deep-engine-tasks-product-2026-09-16.md#h04)、[F07](deep-engine-tasks-product-2026-09-16.md#f07)、[V04](deep-engine-tasks-validation-2026-09-16.md#v04)。
- **验证**：RESEARCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：明确排除：复杂Shader Graph。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="x04"></a>
### X04 · 非Windows平台与设备覆盖专项

- **排程**：P3｜明确排除｜责任角色：平台/QA研究｜初估 3–5 工程人日。
- **已有基础**：Rust crate特性/CI并不等于平台产品支持；非Windows适配现范围排除。
- **代码入口**：[docs/specs](../../docs/specs)；[packages/deep-engine/src](../../packages/deep-engine/src)；[packages/deep-engine-native/src](../../packages/deep-engine-native/src)；[apps/web/src](../../apps/web/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：按Linux/macOS/移动/Web低端设备逐一盘点接口、字体、打包、GPU限制和成本；形成平台独立试验计划。
- **通过标准**：平台矩阵保留未支持项；每平台有最小可跑样本、负责人需求和退出标准。
- **边界/失败验证**：不能因wgpu支持后端或CI编译通过就宣称正式平台支持。
- **依赖**：[H06](deep-engine-tasks-product-2026-09-16.md#h06)、[V03](deep-engine-tasks-validation-2026-09-16.md#v03)。
- **验证**：RESEARCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：明确排除：非Windows实现。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。

<a id="x05"></a>
### X05 · 生态兼容与通用引擎覆盖专项

- **排程**：P3｜明确排除｜责任角色：生态/产品研究｜初估 3–5 工程人日。
- **已有基础**：全Three插件逐个兼容被排除；缺完整第三方生态不能被工业能力分数掩盖。
- **代码入口**：[docs/specs](../../docs/specs)；[packages/deep-engine/src](../../packages/deep-engine/src)；[packages/deep-engine-native/src](../../packages/deep-engine-native/src)；[apps/web/src](../../apps/web/src)。入口用于查找职责，禁止整目录机械改写。
- **实施与产物**：调查高频插件/API/素材与游戏通用工作流，优先适配公开协议；记录联网/多人运行/地形/布料流体等未验证域。
- **通过标准**：给出有频次证据的Top兼容列表和通用域差距；未来实现有独立用户任务与验收。
- **边界/失败验证**：不承诺任意插件/脚本/素材自动可运行；现项目source-available称谓与许可证不变。
- **依赖**：[H01](deep-engine-tasks-product-2026-09-16.md#h01)、[H05](deep-engine-tasks-product-2026-09-16.md#h05)、[V04](deep-engine-tasks-validation-2026-09-16.md#v04)。
- **验证**：RESEARCH（命令与硬件流程见[验证手册](deep-engine-tasks-validation-2026-09-16.md#commands)）；先增加本卡反例与参考路径对照，再运行相关现有回归。
- **对应原任务**：明确排除：全Three插件矩阵。复用已有产物；本卡只负责上述剩余切片。
- **收尾证据**：记录任务ID、源码/产物hash、设备/工具版本、完整命令、原始日志位置、通过/失败/未测项及限制；执行人签署，独立复核后更新JSON状态。
