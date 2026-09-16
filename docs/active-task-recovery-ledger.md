### 2026-09-16 全量目标启动与最大并行（Codex）

- 已完成：C1 非入口页更新修复。带 expectedSource 的 Tick/图表更新省略 pageId 时默认使用来源页，保留旧代次与显式跨页拒绝；新增四项回归，原逻辑两项失败，修复后 Runtime Package 244 项与核心类型检查通过。见 [非入口页输入记录](specs/dashboard-non-entry-input-2026-09-16.md)；本次纯请求层验证不代表真实浏览器 GPU 输入矩阵已完成。

- 已完成：下载路由在附件序列化后、发送前复核候选 TTL/撤销状态，修复异步清单读取期间候选已失效仍返回 200 的问题。两项新增回归先复现，再与 registry/runtime 合跑 15 项通过；API 类型及仓库门禁通过。

- 已完成：C3 提交复核新增末尾 authority 与候选完整性检查。两项行为回归先复现资源读取期间保存草稿、已检查数据被修改仍通过，再验证修复。冻结、能力、authority、编译、候选与运行时组合 60 项测试及 API 类型、仓库门禁通过。此检查不替代未来发布存储的原子 revision 比较。

- 已完成：C4 能力报告三项回归先复现错误支持/遗漏/伪造对象，再修复：有 deferredFields 的已呈现对象仅 degraded；冻结文档中漏编译对象补为 blocked、缺口 `$`；不在冻结文档的编译对象拒绝。运行时与部署集成断言同步确认漏编译对象不会在报告中消失。正式发布、窗口逐对象覆盖仍待办。

- 已完成：C2 修正后 producer 包经既有通用 Native 窗口验证器实际 present 3 帧，1200×800、RTX 4060/Vulkan、GPU clean；报告与包/EXE hash 见 [离线进程入口](specs/dashboard-offline-process-launcher-2026-09-16.md)。纠正“Scene verifier 整体不能复用”的旧结论：通用窗口启动及回执校验可复用，Dashboard 逐对象/字体覆盖仍缺失。补 `--conditions=development` 避免 CLI 加载旧 dist。正式发布到离线链、交互与视觉验收保持待办。

- 已完成：增加 [Dashboard 离线进程入口](specs/dashboard-offline-process-launcher-2026-09-16.md)，校验 DMDA 后以固定 `--package` 参数启动本地播放器，关闭后清理，取消终止子进程；CLI `--help` 可实际执行。生命周期测试不替代真实窗口证据，独立 ZIP 与正式发布下载仍待办。

- 已完成：修复 Dashboard 私有资源读取取消挂起。打开对象期间取消、EOF 后等待 transport completion 时取消，两项新增回归均先复现超时；读取改为同时等待流与 transport，并与取消竞争，失败或退出销毁流。另覆盖 transport 失败且流仍空闲的资源清理。真实生产 closure/compiler/verifier 接入仍待办。

- 已完成：C5 候选所有权回归复现返回字节与内部已验证产物共享引用；prepare 返回值及 candidate getter 改为独立副本，调用方修改不再污染服务状态。增加编译中取消保留旧候选检查。服务、登记、路由组合与下载 34 项测试、API 类型检查通过。此修复不代表真实发布及离线窗口验收完成。

- 已完成：修复 C5 候选请求预取消检查遗漏；已经取消的请求在修改 generation 或中止旧候选前拒绝，原在途候选保持可完成。服务与路由组合回归 5 项、API 类型检查、仓库治理门禁通过。
- 本轮待办：C1～C5 整项均以交付切片原验收为准，C3/C4 的纯合同与注入式测试不代表正式发布链完成。此前口头 31%/33% 为未逐项核算的粗估，不作为验收进度。DMDA 字节封装与 launch plan 仍不能替代原要求的 ZIP、真实 EXE 离线正常窗口及恢复验证。

- 已完成：C5 前置、候选、归档、路由、下载、launcher 与可信运行时组合提交至 `e2dbda4`。服务端只从 published Application 权威读取 Dashboard freeze 输入，浏览器提供 document/data/resource/hash 会被拒绝；冻结候选会复核能力凭据、编译严格校验的 v5 artifact，并在写入前二次确认权威状态。候选登记仅存服务端对象，读取绑定候选、项目、应用并在到期删除；路由签发的 candidateId 可供受限下载使用。DMDA v1 离线字节包与本地启动计划完整验证冻结 manifest、资源闭包、能力凭据和三项 hash，拒绝篡改或错误目标。组合模块仅在部署层注入真实可信闭包、权威编译器身份和原生窗口验证器时注册候选与下载入口，当前 `index.ts` 尚无这三项部署适配，故完整端到端仍待接线。83 项 C3～C5 聚焦回归和 API 类型检查通过。
- 已完成：C4 Dashboard 权威能力报告提交 `912fde1`。source/compile/target 三 hash 分别绑定冻结 authority+manifest、服务器编译器身份+配置、实际产物 bytes；窗口证据复核 revision、设备、fixture 与字体闭包，浏览器自报不能放行对象。冻结、能力和 Application 回归共 39 项通过；正式 candidate/route/download 接线仍待 C5。
- 已完成：WebGPU Dashboard 组合宿主提交 `18689fa`。真实 C2 包在浏览器 WebGPU 候选中成功 committed，tick generation 1→2，diagnostics 与 console warning/error 均为空；截图闭环发现并修复 clip 输出共享顶点被重复投影导致的巨大三角，修复后 KPI、表格与 7/9 双柱正确显示。
- 已完成：六类图表 Web/Native 几何对照提交 `ae22419`，36 个 Native reference cases、42 项 Web 测试和严格类型通过。真实 Native GPU 复跑为 206400 个着色像素；7/9 两柱共享零基线，高度比与 7/9 误差小于一个栅格行。
- 已完成：C3 纯发布冻结合同提交 `654d4e7`，冻结作者、绑定、字体和图片身份，并在候选准备前后与提交前复核 stale/cancel；专项加 Application 回归 33 项、API 类型通过。正式 store/routes/下载接线仍待办，当前顺序进入 C4 三种 hash 与权威证据。

- 已完成：[C2 表格有序绘制子片](specs/dashboard-ordered-table-paint-2026-09-16.md) 支持实测背景/文字交错、冻结首列层级和现有 1px 阴影；独立 59 项及类型通过，真实浏览器完成横滚与捕获验证。生产页面自动绑定仍待办。
- 已完成：[C2 冻结数据内容子片](specs/dashboard-frozen-data-content-2026-09-16.md) 独立导出严格类型、149 项测试通过；真实 KPI/表格/图表包通过字体 producer 与 Native GPU 读回。修复小数文字贴图压缩。GPU 目检发现柱图自动零基线缺陷，正同步修复 Native/Web；冻结首列及正式发布仍待办。
- 已完成：[C1 页面候选事务子片](specs/dashboard-candidate-transaction-2026-09-16.md) 独立导出 302 项、主树 305 项测试及核心/Lab 类型通过；资源屏障、旧事件拒绝、失败保持与跨页游标恢复已实现。真实 WebGPU 组合绘制宿主仍为本轮待办。
- 已完成：真实 GPU 对抗验证发现 GLM 作者颜色转换缺失，蓝色 `[54,139,214]` 输出为 `[127,195,236]`；[生产端颜色修复](specs/dashboard-css-color-correction-2026-09-16.md) 后三色 sRGB 像素断言通过，Native 内容 golden 两项、TS 69 项与严格 Clippy 通过。C1 资源基础已提交 `59c5fea`。
- 已完成：C2 文字/图片子片已提交并推送 `56c500d`。[C1 通用资源准备基础](specs/dashboard-resource-prewarm-2026-09-16.md) 独立 224 测试、兼容 302 测试及双类型通过；复核补三项 commit 重入回归并修复资源生命周期问题。浏览器组合绘制/present 仍待实现。
- 已完成：C2 字体 producer 已提交 `22a6b03`；[文字/图片内容编译](specs/dashboard-frozen-raster-content-2026-09-16.md) 的最小独立闭包通过严格 TS、62 项 Vitest、28 项 Node 测试，真实 producer 包通过 Native GPU 读回。仍为 C2 子片，数据组件、完整外观、交互及正式发布待办。
- 已完成：A/B 与 C1 core/Native 分片已推送至 `dev-studio` 的 `3a88b5c`。C2 [冻结字体 producer](specs/dashboard-frozen-text-producer-2026-09-16.md)、CLI 与 Node adapter 已实现；中间全量 Native 1000 通过/63 忽略，最终修复后定向 15、Node 23、严格 Clippy 和独立 HEAD 加 24 文件的 all-targets 检查通过。文字/图片 producer 包真实 GPU 读回通过，中文 PNG 已目检。
- 本轮待办：当前顺序为 C2 文字/图片编译及真实 GPU 读回→冻结数据内容→绑定/报告/正式离线交付；C1 Web prewarm 缺口保留。完整 84 个上层编号和原验收条件不变，浏览器视觉 V-02 仍未完成。下列条目保留此前各阶段证据，以本节最新状态为准。
- 已完成：C1 core/Native 子片通过 Native 987 测试/63 忽略、严格 Clippy、格式检查及 3 项真实 GPU 测试；TS 独立闭包 259 测试和双类型通过，见 [组合运行时记录](specs/dashboard-composition-runtime-2026-09-16.md)。修复整页缓存清理、Recover 与计时退避。C1 Web prewarm 仍待接通；C2 文字/图片编译在隔离目录推进，尚未合入。
- 已完成：TS Runtime Package 基础切片独立导出 219 测试、核心/Lab 类型检查通过，补齐 v3/v4 与图表数据合同，见 [基础合同记录](specs/runtime-package-foundation-2026-09-16.md)。C1 v5 组合包仍在真实 GPU 与窗口验证中。
- 本轮待办：基础修复分片已提交 `de2f3dc`、`7167bd3`、`8e431b2`，进入 C1。TS v5 组合合同与真实双图表 golden 已通过 257 项运行包测试及类型检查；Rust 包解析、多组件组合层、窗口整帧事务与 GPU 回归正在合并。C1 尚未验收，未提交本批产品改动。
- 已完成：解码器切片提交 `7167bd3`；[共享场景脚本协议](specs/shared-scene-script-protocol-2026-09-16.md) 最小六文件独立导出通过 Contracts 构建、SDK 类型与 88 测试。未将发布大闭包混入基础切片。
- 已完成：Native 切片提交 `de2f3dc`；浏览器解码器核心/Lab 最小切片经 HEAD 独立导出 9 测试、双类型检查通过，见 [解码边界](specs/browser-image-decoder-boundary-2026-09-16.md)。原混合工作树的其他功能仍分别审查提交闭包。
- 已完成：A/B 已修复文本字素/IME 历史与原 helper 边界，以及 invocation ID 复用风险；四种终态共享有界 FIFO 身份窗口，窗口外宿主仍不得复用 ID。Native 独立导出全量 952 通过/60 忽略，5 项专项 GPU 通过，严格 Clippy 通过。提交闭包含真实 ChartSpec 拒绝夹具，584 个 Native 文件与导出逐一一致，见 [A/B 执行记录](specs/codex-native-correctness-and-gates-2026-09-16.md)。
- 已完成：Deep Engine 全包 2827 测试通过/41 跳过及 Node 26 通过；Web 3323 通过/2 跳过、API 954 通过/1 跳过，Web/API 生产构建和生产 import smoke 通过。浏览器适配器与共享协议依赖方向已修复，TS 未提交闭包仍在分片核对。
- 本轮待办：先完成 A/B 的独立导出验证与分片提交，再执行 [Dashboard C1～C5](specs/codex-dashboard-delivery-slices-2026-09-16.md)。真实浏览器视觉验证尚未完成，现有 GPU 读回不代表 V-02。
- 本轮待办：用户明确要求将完整剩余计划设为任务目标，已创建 active goal，覆盖原有 84 个上层编号与原验收条件。用户随后强调严格按既定顺序、最快速度和最大并行；不另插演示版本分支，不以今晚可测取代正式验收。
- 本轮待办：当前执行 A 正确性与 B 门禁恢复；主线程负责文本事务与合并验证，三条独立子任务处理运行时边界/模块拆分/应用与合同门禁。GPU/全量 Rust 编译统一单车道，避免竞争；后续状态与证据继续回填本节。

### 2026-09-16 五平台超越重新分析与任务分解（Codex）

- 已完成：按用户要求重新分析Deep Engine对Three.js、Babylon.js、Unity、UE、Godot的差距，交付[全面方案](specs/deep-engine-comprehensive-plan-2026-09-16.md)和[82张机器可读任务卡](specs/deep-engine-execution-tasks-2026-09-16.json)。源码复核窗口截至 `678d2715`；后续C5并行进展以本账最新执行记录与源码为准。
- 已完成：Deep Engine核心/Lab类型检查、16文件170项专项测试、仓库治理通过；任务代码入口、本地链接、ID、状态、工量与无环依赖已校验。本轮产出为分析文档，没有实施任务卡，也未新跑Native全量、GPU视觉或五平台性能比赛。
- 本轮待办：`DE26`命名空间的72张建设卡是超越路线建议，领取前与旧84项、Deep2D及格式计划去重；不替代当前执行总表，不打断C5正式交付。5张V卡保留项目级后验收。
- 明确排除：5张X卡记录当前交付线排除领域的综合差距和后续研究入口，不改变既有实施范围；这些领域未解决时不宣称全平台全能力超过。账号、存储、数据和许可证约束保持。

### 2026-09-16 GLM 接手复核与剩余计划（Codex）

- 已完成：读取 GLM 交接、原任务表、近期提交和混合工作树；新增 [复核与执行计划](specs/codex-takeover-audit-and-plan-2026-09-16.md)，回填两份交接入口。接手 HEAD 为 d6a7ae5，初始状态记录 1034 条，未整批暂存、提交或 push。
- 已完成：本次 Native 原测试 922 通过/0 失败/60 忽略；Deep Engine Vitest 2821 通过/41 跳过、Node 26 通过、typecheck 通过；仓库治理与全仓 800 行门禁通过。日志均为 test-output/codex-takeover-*，不提交原始日志。
- 本轮待办：Deep Engine 完整 test 被 OffscreenCanvas 纯净性检查阻断；包级体量门禁有 27 个阻断，Rust fmt 失败。三项新增对抗测试确认退格 redo 无效、组合附加符导致样式越界与 IME caret 越界，产品代码尚未修复。复现源码/日志留在 test-output，未把失败临时测试留在默认测试目录。
- 本轮待办：顺序调整为正确性修复→门禁/依赖闭包与分片提交→Deep2D 正式发布/跨端/宿主/扩展→主线三维→工业格式；不采用旧“完成17”汇总，不因纯模块测试通过关闭整项。
- 项目级后验收：Web/API 全量、GPU/视觉、构建/clippy、独立提交态本次未重跑；V-01～05 与 D24～28 保留。明确排除项、账号、存储、数据和许可证约束不变。

### 2026-09-15 Deep2D 终局方案任务目标（Codex）

- 本轮待办：用户明确授权按 `docs/specs/Deep2D-跨时代发布终局方案-2026-09-15.md` 研发，并已建立 active 任务目标。该授权覆盖历史“Deep2D 发布替代方案移出当前实施路径”的记录；以本方案的认证能力范围、兼容层隔离和淘汰条件执行。
- 本轮待办：先 P0 真实 Runtime Package、Web validate/prewarm/atomic commit、版本化语义合同与跨端基线，再 P1 epoch/增量依赖、动态图表、文本/IME 与行为回放。P2 为有淘汰条件的兼容实验，P3 为热同步、签名扩展和平台验证；不预先承诺任意 JS/ECharts 原生支持。
- 已完成：任务目标登记与首次代码盘点。`apps/web/src/delivery/sceneClientPackage.ts` 仍写 `conversionRequired: true`；现有 `packages/deep-engine/src/webgpu/runtimePackagePrewarmAdapter.ts` 应优先复用。旧总账引用的 `packages/deep-engine/src/sceneSnapshotRenderPacket.ts` 当前不存在，其历史类型错误不可直接当作当前缺陷。上述仅为只读核实，未新增实现或测试通过证据。
- 项目级后验收：相关类型、单元、构建、仓库门禁及真实发布/Native/GPU/浏览器验证；视觉切片执行 design-taste-digitaltwin 的两轮截图与逐维验收。未验证能力不标记完成。
- 明确排除：不覆盖并行工作区改动，不改固定账户、存储拓扑、既有数据，不将本轮目标解读为恢复已排除的完整 Three 插件兼容、重型光追或非 Windows 平台适配。

2026-09-15 Windows portable 实包收口：x86_64-pc-windows-msvc 43 payload/43 ZIP entries，PE+static CRT+purity 通过，26 smoke checks 通过，GPU submission clean，Deep2D 64x64，archive SHA-256 7580eadc05c204eb4f16ef64613e2355ebcb08929e8f6e42f6fa9625278a29fb。

2026-09-15 P3/P4 GLM 第二批交付收口(未提交、未 push):按 deep-engine-p3-p4-glm-handoff-2026-09-15 完成。P3:U04 控件→Deep2D 显示列表(control_render.rs 五控件×状态,focus 环/disabled 0.4 透明度几何差异,contract 6/6);U09 样机帧构建器(prototype.rs 顶栏+对象树+检查器+图表带自适应网格,GPU 真机 painted=40344/64000);C05 百万点 GPU 基准(1,048,576 点 decode 5.96ms/decimate 16.1ms/render 37.0ms/gpu 27ms,全记账;过程中发现并修复 render.rs 稠密线缺口:min-max 包络填充+stroke 按 160 点分片,CPU 描边对噪声折线必自交是 painter fail-closed 正确行为);C06 选区联动+屏读摘要(linking.rs 单一 identity 映射+中文摘要/趋势短语);D05 glyph atlas 增量(shelf 装包/同像素零重传/有界淘汰/pending rect 上报)+shape_run 接缝(真字形光栅化待字体库准入,如实);D09 CPU 参考光栅化器(raster_reference.rs 同 letterbox 映射+compare 阈值报告,GPU 对照 interior_agreement=0.9812 过 0.98 线);Windows IME 适配(ime_winit.rs:preedit 不碰文档/commit 单编辑路径/空 Preedit no-op);DPI 四档 painter 矩阵(100/125/150/200% 探针方块 400/625/900/1600px 精确命中;真窗口交互属 app 禁改域如实记录)。P4-A:host_capabilities/rt_probe.rs 厂商矩阵+四类降级原因+flag 决策(wgpu 30 无 RT API 是硬事实,Unsupported/BackendLacksRtApi 全记录,默认关+fallback 现有光栅,3/3);P4-B:RT 实验设计文档(RT 阴影首选+benchmark 规格通过线,不宣称生产)。终态门禁:fmt clean、clippy --lib --tests 0、lib 98/0、集成 68/0、CPU 全量 507/0/37、真 GPU 全套 17/0、恢复矩阵全 PASS、TS tsc+vitest PASS。回报文档 docs/specs/deep-engine-p3-p4-glm-report-2026-09-15.md(含诚实未完成:Browser 侧对照因 deep-engine/src 禁改未接、真窗口证据受限、字体库依赖待批)。文件域严格在允许清单内,共享文件仅 lib.rs 模块注册(本文登记)。约束遵守:零新依赖、零 P0/P1/P2 域触碰、账号/.env/冻结包未动。

2026-09-15 P3 GLM 夜班交付(未提交、未 push):按用户指令"到 08:00 做完全部任务+GPT 交接"执行。D 线补课全清:D07 命中索引接 clip 约束(clipPathIds 环+clipRect,与 painter 同语义失败关闭,5/5)、D02 组合矩阵(负缩放/非均匀/45°/DPI 1.0-2.0 单调/奇数 dash+负 offset+round,4/4)、D03 三层嵌套 clip+旋转镜像矩阵(2/2)、D04 atlas revision/坏 payload fail-closed(3/3)。U 线新模块:layout.rs(flex/stack/absolute 逐行镜像 TS layout.ts,NaN fail-closed)、events.rs(z 序命中+capture/target/bubble)、controls.rs(五控件状态机)、virtual_list.rs(10 万条目有界)、design_tokens.rs+scripts/export-design-tokens.mjs(base.css 唯一来源→JSON 快照,color-mix/transparent 解析,双主题+reduced-motion 校验)、accessibility.rs(语义树+UIA 动作→同一事件系统)。C 线新模块:scales.rs(linear/log/category/time+nice ticks,19 测)、layout.rs(画布分区)、render.rs(六类图表→Deep2D 显示列表自校验,13 测,566 行超预算已披露)、interaction.rs(tooltip/legend/zoom 状态机)、data_window.rs(列式分块+1M 预算+等距抽样+记账)。U05 纯逻辑:platform_text/layout.rs(字素簇/断行/定宽)、text_edit.rs(cluster 光标/选区/撤销)、ime.rs(composition 外挂状态机)。跨语言 golden:fixtures/deep2d_validator_golden_v1.json 13 case TS+Rust 双端一致(过程抓到 Rust validator strokeWidth 缺口,核对确认 TS 权威允许,以 TS 对齐回滚)。性能守卫 tests/performance_guards.rs 5/5:万节点布局/2k 命中+5k 查询/5 万点渲染/百万点分块管线/渲染确定性(JSON 字节一致)。终态门禁(05:00):cargo test 485/0/31(夜班起点 300,净增 +185)、clippy --lib --tests 0、fmt 0、GPU debug+release deep2d 4/4、恢复矩阵 7/7、TS 2697/0、headless/smoke/interleaved PASS。证据 test-output/deep-engine/p3/night-final-gate-2026-09-15.txt;GPT 交接 docs/specs/deep-engine-p3-gpt-handoff-2026-09-15.md(含 §4 诚实未做清单、§6 文件域、§8 对标差距、§9 接手建议)。仍未做(不许冒充):D05 真 shaping(cosmic-text 未批准)、D09 Browser 像素对照、U04 控件 GPU 绘制、U09 样机、C03 GPU 接线、C05 百万点真 GPU 基准、真窗口 DPI 矩阵、两轮视觉闭环。冲突:双子代理(U/C 线)按白名单并行零事故;23:07 并行会话 runtime_package 车道错误仍在途未动。

2026-09-14 P3 GLM 第一批交付（未提交、未 push）：按 deep-engine-p3-glm-handoff-2026-09-14 §9 第一批执行。D02 round cap/join+闭合 stroke（stroke_caps 凸扇形展开，公差驱动 3..64 顶点，由拒绝变支持）；D06 frame uniform/bind group 进 Deep2dGpuAssetCache（按 logical size 键控，真机 creates=1/hits=2 指针同一）；D08 WGSL PainterFrame.reserved→physical_size，logical→物理统一为等比 letterbox+居中（chunk_scissor 与 shader 同映射，resize 零重建）；D07 命中索引 deep2d/hit_index.rs（fill even-odd/stroke 半宽带/quad 逆变换，(z,index) 逆序最顶层）；U01/C01 合同层 src/native_ui/retained_ui.rs 与 src/chart/chart_ir.rs（serde deny_unknown_fields+结构校验+色环 DFS，测试拆集成 tests/，均 ≤431 行）。门禁：cargo test CPU 372/0（基线 300 净增 72）、Deep2D 真 GPU 4/4（RTX 4060/Vulkan）、clippy 本车道 0、fmt 过、headless/smoke/interleaved 三 surface 真 PASS、恢复矩阵 7/7、TS deep-engine typecheck/2645 tests/build 过。支持矩阵冻结 docs/specs/deep2d-support-matrix-2026-09-14.md；证据 test-output/deep-engine/p3/d-line-evidence-2026-09-14.txt；交接回填 docs/specs/deep-engine-p3-glm-progress-2026-09-14.md。冲突记录：23:07-23:11 并行会话写入 runtime_package/{prefiltered_ibl.rs,package_drop_probe_tests.rs}（触发 clippy duplicate_mod，已在 deep2d/mod.rs 加 allow 化解；其自身 2 个 clippy 错误与 1 个 GPU 测试失败属其车道未动）；source-size 仅 apps/web 两文件超限（并行在途，本轮未触碰 apps/web）。剩余：D03-D05 复核/D05 等字体准入、D09 Browser 对照、U02-U09、C02-C06、真窗口交互 DPI 实机。

2026-09-13 21:20 Codex 根目录专项整理（未提交、未 push）：核对外层备份仓各目录用途与主工程引用；删除空的根级 `test-output/`、未被当前 pnpm 使用的旧 `.pnpm-store/`（当前实际 store 为 `D:\.pnpm-store\v11`，删除前确认其中 junction 仅指向并未删除 `bim-studio/`）以及 `bim-studio-docs/.chrome-capture/` 的 819 个 Chrome 用户目录/缓存文件，合计约 114.5 MiB，并新增外层 `.gitignore` 防止三类产物回流。保留主工程 `bim-studio/`、MinIO 二进制与权威数据、Oracle Instant Client、安装包及宣介最终成品；未删除任何可能被运行时使用的目录。

2026-09-13 21:15 Codex 文档与过程证据整理（未提交、未 push）：按用户“可能在用的保留、过程文件/文档可清理”补充执行。删除 9 月 10 日前且无在途修改的旧 verification/handoff/checkpoint/review/report、14 批旧素材目检 JSON、已被现行 Deep Engine/平台计划替代的旧路线研究，以及对应 9 月 9 日及更早截图、诊断脚本和日志；`docs` 顶层由 138 文件收敛至 37 文件，新增 `docs/README.md` 作为权威计划、当前验收、稳定参考的统一索引。修复删除后 7 个历史 Markdown 引用，递归文档链接检查为 0 断链，仓库治理门禁继续通过。保留当前 9/12–9/13 规格/报告/视觉证据、`AGENTS.md` 指定三份权威计划、稳定产品/部署文档、运行数据、外部素材、真实模型和活跃任务新生成的约 0.96 GiB 构建产物；最终核验时内层工作区约 11.62 GiB，较初始 32.41 GiB 减少约 20.79 GiB，连同外层 Git 压缩净释放约 24.7 GiB。

2026-09-13 21:05 Codex 全仓清理（未提交、未 push）：在外层/内层双仓结构和大量并行未提交改动下，仅删除可证明可再生内容；清理 Rust/Tauri/Cargo target（含漏网的 `target-native-packet-cache`）、各 workspace dist、浏览器/Unity/.NET/Revit 缓存、运行日志、复制型 WASM/Draco/Basis 产物及已删除 Node-RED 工作区残留包，并对外层 Git 执行 `git gc --prune=now`。内层目录核验由 32.41 GiB 降至 12.55 GiB，外层 `.git` 由约 4.66 GiB 降至 0.71 GiB，净释放约 23.8 GiB；保留 8.17 GiB 权威运行数据、2.37 GiB 文档引用测试证据、338.8 MiB 真实测试模型、环境/证书、外部素材和全部未提交源码。新增默认只预览、显式 `--apply` 的 `scripts/clean-generated.mjs` 与 pnpm 入口，补忽略规则；修复治理门禁读取 Git 索引中已删除 package manifest 的缺陷，回归 4/4 且 `pnpm gate:repository` 通过。依赖审计：22 个 workspace 锁文件离线冻结校验一致，运行依赖未发现零引用项，17 个内部包均有入站引用；不基于静态猜测删除声明依赖。全量类型检查被并行 Deep Engine 在途代码 4 个既有错误阻断（`competitiveBenchmarkRunner.test.ts` 缺 `setGpuInstrumentation`，`threeWebGpuBenchmarkBackend.ts` 后端断言不兼容），与清理改动无关。

2026-09-13 07:00 GLM 收口完成（未提交、未 push）：CC0 缺口模型下载交付——20 个 CC-BY-4.0 真实设备模型入库（相机 4/传感器 6/车辆 5/人员 5,全部 author/originUrl/attribution 完整署名,拒绝 15 个超限候选）,匹配表 53→73,预制体缩略图渲染器修 2 处 SkinnedMesh bounds 失真,prefabs 36/36 测试,20/20 特写目检过。剩余 ~43 种类无达标 CC0 如实申报继续程序化兜底。全仓终验收口：apps/web tsc 0 错误、web 套件 483 文件 481 过（2 失败=并行 deep-engine lab 3 探针+parametric workbench 裸 HTTP,均为他会在途文件已记录移交）;根目录 scripts/lib+tools node:test 12 文件单独跑全过（unity-package-archive 1 失败为 Git Bash tar 盘符路径解析的环境问题,与本轮改动无关）;api plantLiteStudy 3 失败属并行会话 plantLite 在途改动。素材终态：2D 预设 520/看板模板 317（32 域）/预制体 120（73 真模型+47 程序化兜底）/风格库 18 套/真实图表类型 4 新增/示例数据 32 域行业节律。待用户复核：终版对照板（apps/web/test-output/visual-compare/final-state/ + cover-quality/final/ + prefab-real-models/compare-thingjs.png）。未 commit、未 push、admin/.env 未动。

2026-09-13 00:30 GLM 数量波次 B/C 交付 + 全仓终验（未提交、未 push）：波次 B 看板模板 277→317（32 域=32×10−3，3 个为质量裁删不回退；4 新域电力交易/化工安全/冷链物流/会展活动各 10 真实指标；9 大类归并与 18 套套件同步；40/40 目检通过 0 删除；components 1193/1193）。波次 C 预制体 98→120（感知+6/视觉+4/车辆+5/仓储+4/移动+3；4 轮目检修 8 处几何构图问题，22/22 通过 0 删除；相机 7 型拆独立文件）。全仓终验：pnpm -r typecheck 通过；全量 Web 483 文件仅 2 失败=并行会话在途文件架构违规（deep-engine/lab 3 探针 + parametric/ParametricModelWorkbench 裸 HTTP），非本轮产物已记录移交。终态实机：资源页概览统计二维 420/模板 317/预制体 120 上墙，氛围背景/头部/分类 chips 终态可见（apps/web/test-output/visual-compare/final-state/）。剩余待办：真实渲染封面全量性能取证、echarts-wordcloud bundle 预算生产构建验证、S3 余 109 处 z-index 全局审计、波次 B/C 报告第 15/16 节已写入 docs/delivery-report-2026-09-12.md。

2026-09-12 23:25 GLM 第三波交付（未提交、未 push）：素材数量波次 A 完成——2D 预设 250→420+（7 族：行业 KPI 60/仪表阈值 16/区域地图 16/报表形态 14/控件 12/装饰造型 24/分析增强 28），170 个新预设逐卡双主题特写 340 张+30 张 contact-sheet 已产出，根会话抽检 5/30 覆盖 7 族五项全过；聚合断言 ≥420+聚类门禁（同形簇=0）+components 全量 1153/1153 通过。视觉风格库 7→18 套（28 域恰一覆盖，283 测试）。素材中心分类体系（2D 七大类/模板 9 大类+行业包标准分层/预制体 14 类 chips）+页面级审美升级（页面头部/概览统计/全页氛围背景命名空间隔离零泄漏量化证据/216px 栅格/空态设计；用户授权全页背景与排版可改，唯一标准不突兀）交付。真实渲染封面+示例数据管线接线验证成功：模板库 SVG 先行→真渲染截帧渐进替换（实机 6 卡）；模板插入即带示例数据实证（生产运行监控·示例 10 组件数据在线）。真实图表类型交付（词云 echarts-wordcloud@2.1 兼容 ECharts6 像素级验证/箱线/瀑布/极坐标，1149+248 测试，拖入画布 0 错误）。剩余待办：波次 B 模板 277→320（4 新域）与波次 C 预制体 98→120——规格在 docs/asset-quantity-wave-spec-2026-09-12.md，启动时写入逐个目检硬门槛（每预设双主题特写五项全过，数量让位质量）；两代理因 quota/captcha 中断（封面管线代码已接线完成仅剩验证取证；波次 A 已由根会话接续完成）。真实渲染封面全量性能取证与 check-bundle-budget 生产构建验证待做。诚实边界：词云/箱线/瀑布/极坐标已真实化，封面数字为确定性装饰，KPI 装饰数字绑定真实数据集后替换；S3 余 109 处 z-index 待审计。

2026-09-12 13:00 GLM 第二波交付（未提交、未 push）：用户指定八项 bug 全部实施并验证——S1 标签底板（真因=画布固定 640×160，D2a 修复+354 测试）、S1-A OutlinePass 幽灵板（postProcessingRuntime 包装 OutlinePass.render 内部隐藏 Sprite，首版误伤主通道被截图抓到已纠正，终态远景/近景标签正常零幽灵板）、S2 tabular-nums（8 文件 35 选择器）、S3 z-index（新增 --layer-canvas-* 3 令牌收敛病理值，109 处低风险记录）、S5 断连横幅（src/appStatus/ 监控+Banner，api.ts 在线出口接线，6/6 单测+Playwright 503 拦截实测）、S6 409 指引（应用保存链路复用 workspaceSaveFailureGuidance，实测 toast 可见）、S7 标尺（实渲染 12px+隔刻度）、S8 编辑场景记忆落点（src/studio/lastWorkspacePreference.ts，实测三维记忆直达）。素材扩量对标帆软/山海鲸/ThingJS：2D 预设 157→250（+93，332 测试，442 截图 5 轮闭环）、看板模板 120→300（30 行业域×10 指标，300 个 FVS 式封面 dashboardTemplateCoverArt.tsx，9 大类分组+类型筛选+推荐最新双分区+7 套主题套件鎏金/绛霄/翠涛/青冥/沧澜/紫电/霞光，1160 测试，4 轮闭环）、预制体 78→98（C1-C8 造型细节全实施，26/26 测试）。全部原创零竞品素材/名称。集成复验：全仓 pnpm -r typecheck 通过、全量 Web 2223/2225 通过 0 失败（上轮 deep-engine 架构失败已被并行会话修复）。诚实边界：词云/箱线/瀑布/极坐标为最接近类型诚实命名（真实新类型需 contracts+渲染器施工，词云需 echarts-wordcloud 新依赖待用户批准）；封面数字为装饰；推荐排序不造假热度；S3 余 109 处待全局审计；后端 502 属服务端。详情 docs/delivery-report-2026-09-12.md §8。

# Deep Monkey Studio 当前任务恢复总账

2026-09-15 00:29 用户最新指令：全力推进，7小时完成P0/P1/P2，窗口00:29–07:29，覆盖旧4小时与P2延后安排。P0 14项/P1 5项/P2 4项不删减，P3仍GLM，P4后续。三路重试已发出，bounds确认恢复；主线负责P2 Lights/GI和集成验证。根接管额度中断处，确认resident validationReady门闩已落，补部分scope完成时publish保旧帧、拒绝后旧owner仍存的交错回归；23项与core/lab类型通过，Studio实机尚待重验。

2026-09-14 23:30 根修补IBL提交失败事务：旧环境延迟到帧成功才释放，失败恢复旧绑定并释放候选；状态/上传25项、core/lab类型通过，真GPU注入submit同步抛错后HDR误差0、七帧资源40恒定归零。新Windows prefiltered-ibl-drop candidate独立26/26，根复算ZIP哈希fdf77c6c…cba5c6一致；后续Native跨包源域修补不属于该冻结包。Studio流式/Meshlet仍在途，P0/P1未全项验收。

2026-09-14 23:25 补验：显式Naga全量323文件2689测试通过、零跳过；治理门禁通过。作者视锥独立GPU读回通过，camera/shadow实例及previous配对正确、资源0。IBL追加预取消、上传后device loss、可重入调用方变更快照回归，32专项通过。Native renderer体量已按环境职责抽取，P1代理开始独立prefiltered-ibl-drop候选，前后sourcefingerprint门禁不变。Studio流式与Meshlet代理仍在执行，P0/P1未全项完成。

2026-09-14 23:22 根复核：共享预过滤 IBL Browser 真 GPU 变化3100像素、取消/坏包/切回/最后候选误差0，资源40恒定后归零；Native对应标准PBR/ShaderMaterial实测通过。Spot第一次GPU发现352/384-byte ABI不匹配、chunk第一次GPU发现重复mapped-range，两者修复后原断言全部通过；spot四选层独立tile正确，chunk同帧[2,3]/预取零上传/资源归零。Deep全量2646通过41条件跳过、Node26/纯度通过，体量门禁5个P3+renderer301仍失败；Naga显式验证待。两P0线继续正式Studio流式与Meshlet，P1线新候选包，不覆盖旧ZIP；P0/P1全项未完成。详见Studio23:22检查点和共享IBL合同。

2026-09-14 22:55 目录双击两根因已修：工具条固定占位且无选择时inert；第二click不取消选择，双击显式选目标后聚焦。根1280深色两轮实际复验行y224不变、立方体/模型身份正确、Ctrl多选2，控制台空、未保存发布。公共样式后Web2685通过2跳过、类型/构建/预算通过；作者LOD真实GPU复跑四模式通过。视觉完整矩阵仍待。DPR线继续逐level GPU视锥裁剪，P1线继续同设备目录拖放，原candidate不覆盖新改动；详见Studio22:55检查点。

2026-09-14 22:50 作者 LOD 已合流 Runtime/烘焙/Three/Browser/Native 并在 Studio 启用，共享桥默认仍关闭。根真实 GPU 四种选择读回匹配、metadata 更新零几何/实例上传；Web2675通过2跳过、构建/类型/预算通过，Deep2635含Naga与Node26/纯度通过，整命令仍被GLM P3五个超长文件阻断。Windows新candidate独立解压24/24，旧包保留。完整Studio重新打开及Deep→WebGL→Deep成功、控制台空、未保存发布；发现首次双击因选择工具条插入而误选，bounds代理修目录布局/双击语义，Native代理推进目录拖放。author GPU预算/frustum/Hi-Z、正式meshlet/流式与全视觉矩阵仍待；P0/P1未完成。详见Studio检查点22:50节。

2026-09-14 22:26 在途所有权：下一片作者 LOD 采用统一 `author-selected` 判别策略，保留真实全部 level 和显式选择，不把 Three 欧氏距离/zoom/逐层迟滞转换为屏幕像素阈值。bounds 代理负责 TS 合同、Three/Web 作者帧及桥；dpr 代理负责 GPU 主影同选与 residency 快照；根负责 Runtime parser、烘焙兼容和 Native/golden。新增能力默认关闭，消费者全合流前不启用。根 Runtime parser 白名单先接分支，旧 Runtime LOD/materialization 44 项通过；新分支及跨语言仍在途，不能沿用 22:22 全量结果。Native 代理正在收口目录资产包 LKG，与 LOD 文件分离。

2026-09-14 22:22 Codex P0/P1 继续（未提交）：修复作者网格真实 GPU 探针揭示的 AO 关闭/OIT HDR 读写别名，正式覆盖像素精确匹配，GPU 诊断空、受管资源归零；AO 开启的三类变形组合也通过，静态共享源稳定资源 88/89/94。Deep 2574 测试、Node26、纯度通过，整命令仍被 GLM P3 五个超长文件阻断；Web 2667 通过/2 跳过、类型/构建/预算通过。完整 Studio 20 次往返逐次确认后端成功，控制台空，最后两个画布；未覆盖逐帧黑帧、脚本重复与显存曲线。1280×720 网格/辅助/聚焦可见，视觉仍未过完整矩阵。LOD 作者输入、正式 meshlet、多 chunk 同帧及 CPU/磁盘流式预算仍缺，P0/P1 全项未完成。详见 Studio 22:22 检查点；Native Asset Directory 初版已接真实 Player，目录 LKG 正在实施。

2026-09-14 21:59 Codex P0/P1 继续（未提交）：空间 AA 与编辑辅助 pass 已进入 Studio，实际 GPU 六类质量夹具和 720p/1080p 时间戳成本通过；1080p 固定斜边 AA median 0.081920 ms，新增纹理 8,294,400 bytes，仅合成热缓存每 pass 证据。Studio 实测移动轴 Y 1→1.137→撤销为 1、旋转环和灯光代理显示；发现并修复基础元素聚焦按钮空操作，真实聚焦和 9 项测试通过。Deep Naga 全量 2538 测试、26 Node、纯度通过，整命令仍被 GLM P3 五个超长源文件阻断；Web 类型及 2656 测试通过、2 跳过（早于聚焦小修）。地面网格、真实窄窗/双主题/双轮、三项目/20 次切换、完整资产和 Native 对齐仍待办，未缩减 P0 14/P1 5 范围。Native 独立复核发现普通打开未自动恢复 LKG、恢复矩阵未注入 device loss，前者已交原生代理实施，后者不作为已验依据。详细证据见 Studio/Native 检查点。

2026-09-14 21:38 P0 回归补记：根独立切线 GPU 入口三姿态通过，最大误差 5.960464477539063e-8、history false/true/true、受管资源零残留。Web 首轮发现 XR 旧夹具缺少新增 DPR 依赖，修复并新增换显示器恢复断言；根全量复跑 522 文件/2647 测试通过、2 跳过，Web 类型通过。AA 几何反例证明 TAA 16 帧无法积累前景/背景轮廓覆盖率，防拖影深度拒绝保持；两条 P0 线正分别实施空间 AA 和同 device 编辑辅助 pass，Native 线继续标注/便携包。证据见 Studio 检查点 21:38 节，未将施工前全量基线用于声称后续改动通过。

2026-09-14 21:35 P0 正式变形路径合流：PacketBuffers/PbrRenderer 与 Studio 显式启用作者 skin/morph，skin-only 真切线保持可选 32/48 字节输出。根真实 NVIDIA GPU 三类变形+纹理/MASK/OIT/TAA/AO/Hi-Z 五帧探针通过，提交失败重试成功、受管资源释放归零；严格后处理计数断言复跑通过。根 Deep 300 文件/2457 测试通过、39 跳过，Node26/purity通过，整个命令仍被六处 source-size 超限阻断。完整 Studio 1280/980 尺寸 Deep 激活与 WebGL 回切实测，控制台无 warning/error；斜边锯齿、网格/灯光辅助层缺失仍在，视觉未通过。未保存或发布，恢复副本保留。证据边界与源码身份见 `docs/specs/deep-engine-studio-frame-checkpoint-2026-09-14.md` 21:35 节。三路并行正常；P0/P1 全项仍为本轮待办，截止目标 00:52 不变。

2026-09-14 21:04 三路代理重试已恢复并实际开展工作。根新增 packet staging 的显式 deformation executor 能力入口和候选资源回滚：变形、几何、实例同属候选，后续上传失败或取消一起释放，借用旧几何不释放；7 项新测试、合计 3 文件 59 项通过，Deep core/lab 类型通过。正式 PacketBuffers/PbrRenderer 尚未启用该入口。根 Native 全目标编译通过，Native test/fmt 门禁阶段通过，clippy 被 GLM P3 chart_ir.rs:277 collapsible_if 阻断。DPR 代理完成 21 项专项，视觉待根验证；代理已转入作者动画投影接入。P0/P1 仍为本轮待办。

2026-09-14 20:53 用户将 P0/P1 截止目标改为从最新指令起 4 小时，执行窗口 20:52 至次日 00:52，完整 19 项范围不变。三路新代理均认证失败，未开展开发，主线继续本地工作。另复读代码确认 18:43 关于 deformationBounds 保守上界的结论不成立：剪切、偏心镜像、归一化权重与 morph-skin 组合仍有低估风险；须以反例修复后重新验证。

2026-09-14 18:43 动态 bounds envelope 修正为中心偏移 + 最大线性尺度 + 平移 + preserve 权重和的保守上界；3 项测试、类型检查通过。正式 renderer/真实动画顶点验证仍待。

2026-09-14 18:41 修复 dynamic culling 缓存遗漏：姿态 bounds 单独变化此前不会重新上传，新增失败复现后修复按四元数值更新；相同值复用、恢复静态、非法边界清除旧可见性及重试均覆盖。根 20 专项、类型通过。deformationBounds 仍待偏心/剪切/原始权重/组合数学验证，不能据既有简单用例认定任意姿态保守；renderer/bridge 未接完，P0/P1 未完成。

2026-09-14 18:12 Deep 全量测试 293 文件/2387 项通过，runtime purity 通过；source-size 仅剩 GLM P3 `deep2d_gpu_cache.rs` 318 行。PacketBuffers 动态 culling 接线后曾 302 行，已整理回 300 行。P0/P1 仍未完成。

2026-09-14 18:09 动态包围体已接入 PacketCullingResources/PacketBuffers 可选输入，动态边界优先、静态路径兼容；类型检查与相关 12 项测试通过。正式 renderer 尚未提供 envelope map，Studio 动画 culling 仍待接线。

2026-09-14 17:51 新增 deformationBounds 保守动态包围体计算（morph/skin、非法输入拒绝），13 项测试与类型检查通过；尚未接入 PacketBuffers culling，动画裁剪仍是 P0 待办。

2026-09-14 17:47 根接管中断代理：Studio 模块解析恢复并实际打开服务器场景，本地副本保留未保存未发布；浏览器会话随后重置。抗锯齿 WebGL FXAA/Three WebGPU SMAA 色彩顺序修正，17 测试过但两轮视觉未完成。正式 GPU deformation wrapper 三类与双 pose 隔离实际通过；后续静止 compute 优化根 82 项测试过，优化后 GPU 结果尚缺。动态 packetDraw 接线与失败保护根 25 项测试、类型通过；完整 renderer/bridge/动态 bounds/LOD 合流待办。三路代理额度/认证错误已停止，不能视为后台继续运行。详见帧检查点 17:47；P0/P1 未完成。

2026-09-14 17:27 GPU动画：根真机已验证skin/morph/fused三类compute→history→plain/unlit HDR、solid shadow、motion，三组各130主影像素且位移/运动向量匹配；独立history五项读回误差0，NVIDIA Lovelace，无GPU诊断、受管资源归零。PacketDeformationResources、动态热验和材质/pose绑定缓存已落，根99专项含Naga、双类型通过。RenderPacket合同正在合流，静态staging/update/resident已加显式guard避免未接消费者时静默静态绘制。下一继续正式wrapper探针、PacketBuffers/PbrRenderer和作者bridge、动态bounds/LOD/Meshlet。详见帧调度检查点17:27节；P0/P1未完成。

2026-09-14 17:17 真GPU变形管线：根CUA实际运行新probe，NVIDIA Lovelace非fallback，18主/18阴影管线和48-byte双姿态binding通过，缺少motion路径拒绝，diagnostics空、释放后受管资源0；不是draw/readback证明。GpuDeformationHistory首片20项含Naga通过，真实GPU历史读回探针仍在补充。继续完成资源可靠性修复、RenderPacket消费者、实际绘制/阴影/motion和空间合流。

2026-09-14 17:15 GPU动画首片：新增deformation严格合同/快照、作者绝对/相对morph与remap适配，以及PBR当前/上一GPU姿态vertex pulling；createPipelines新增显式变形候选，主18/含作者阴影18管线，group1bindings11/12保留静态ABI，不支持无geometry-buffer的direct快路。根60专项、核心/lab类型通过，新shader完整Naga通过。真实GPU创建探针与GpuDeformationHistory正在并行验证；三类变形器setSource发布后退役失败误毁新资源的同族问题已交修。尚未接RenderPacket/Studio消费者，P0-05未完成。

2026-09-14 17:09 根全量复验：Deep src/lab 280文件2272项全部通过，显式启用Naga无跳过。作者骨骼只读快照首片已落盘且根审查公式/所有权；不依赖boneMatrices缓存，不推进动画，仍未接Studio消费者。后续按 `docs/specs/deep-engine-studio-gpu-animation-integration-2026-09-14.md` 推进三线完整GPU合同/绘制/空间合流。

2026-09-14 17:08 补记：根已通过浏览器实际执行Author Bloom GPU读回，NVIDIA Lovelace非fallback，6项固定输入零超差，容差0.003+0.004×参考绝对值，最大相对误差0.3653%，GPU诊断空且释放后受管资源零；临时probe服务停止，可由仓库脚本重现。清理异常聚合和新cache保留已补修。新增GPU蒙皮weightMode保留作者原始正总权重，旧调用仍默认归一化；fused输入同步，16项含Naga及核心类型通过，Studio消费者尚未启用。Web生产构建通过。动画实施方案新增独立文档；骨骼快照适配继续开发。全P0/P1尚未完成，锯齿反馈与真实Studio画质待继续复核。

2026-09-14 17:04 Deep P0 合流（未提交、未 push）：作者 Bloom 已接入原始 strength/threshold 与独立五级 Gaussian，保留 legacy；核心相关 74 项含 Naga、类型/build/purity 通过，根独立复跑 Studio 参数和桥 30 项、Web 类型通过。GPU 像素参考探针正在补充，尚未实跑。当前测试标签缓存过旧动态导入失败，源模块现请求 HTTP 200，但再次切换仍失败且保留 WebGL；不得计为成功切换。用户锯齿反馈继续排查：正式 Deep 默认 TAA 开启、主通道单采样、静止补16帧；所见 WebGL 画布 DPR1.25/100%质量，无已证实的全局降分辨率。动画只读核验确认需逐姿态GPU输出、当前/上一姿态及主画面/阴影统一绑定，不依赖隐藏WebGL的skeleton缓存，不以CPU快照替代GPU动画交付。详见帧调度检查点17:04节；P0/P1范围与18小时目标不变。

2026-09-14 16:52 最终补记：输出职责抽取后 Deep 双类型、构建和 runtime purity 均通过，未修改 allowlist；源码体量只余既有 P3 318 行阻断。全量与实机证据范围沿用下条，不将抽取前截图扩成抽取后完整画质验收。

2026-09-14 16:52 补验：显式启用 Naga 后 Deep 274 文件/2213 项全部通过，覆盖上一条跳过项；输出资源/绘制职责已归并，PbrRenderer 从313回到300行，后补36项输出专项通过。新增性能计时移位造成 purity 错误后，改为从既有 renderer 注入时钟，未扩大 allowlist。source-size 检查现仅剩既有 P3 cache318行；最终 purity/build 结果见同一检查点后续补记。实机画面证据来自职责抽取前，未扩大验收结论。

2026-09-14 16:47 Codex P0/P1 增量（未提交、未 push）：正式 Studio 逐帧接入作者暗角与 Hue/Saturation/Brightness/Contrast，独立输出 uniform 不改 frame ABI；AO/Bloom 开关跟随实际 Composer，算法参数仍待等价对齐。实机开启两效果、修改数值、关闭恢复均保持 Deep，最终恢复 WebGL，未保存/发布。Web 全量 2632 通过/2 跳过，类型/生产构建与仓库治理通过。Native cast/receive/unlit 已进入合同、批次、culling/LOD、draw/dirty；46 CPU+3 Vulkan GPU 通过，完整 Cargo 仍受 P3 两错阻断。Deep 全套 2177 通过/36 shader 项因未设 Naga 环境跳过，Node26与purity通过；本轮新增 pbrRenderer 313 行门禁正在修复，既有 P3 cache318行仍在。检查点 `docs/specs/deep-engine-studio-frame-checkpoint-2026-09-14.md`，P0/P1 未完成，18 小时窗口不变。

2026-09-14 16:34 Codex P0 接线与实机复核（未提交、未 push）：Deep 活跃订阅时去掉隐藏 WebGL 全场景绘制，保留作者状态推进；性能接实际 Deep 帧和时间戳，MeshBasic Unlit 主路径接入。实机发现 Unlit early-return 导致 Dawn fwidth 控制流错误，修复后真实 Studio 激活成功。Web 全量 2623 通过/2 跳过，Deep 全量 2169 通过、Node 26 通过；后续采样集成 54 项与根抗锯齿/采样 38 项通过，类型/构建通过。内嵌窄窗安装板双后端截图完成，但宽窗、运动/透明边缘与完整画质门禁仍待办；性能帧间隔与 GPU 数值差异大，未作为正式基准。恢复 WebGL 和隔离前可见性，未保存/发布。Native 新材质/阴影字段消费者尚未同步，P3 编译阻断与原有体量门禁仍在；P0/P1 未完成，18 小时窗口不变。详见 `docs/specs/deep-engine-studio-frame-checkpoint-2026-09-14.md`。

2026-09-12 22:42 Deep Engine 优先批次续跑（未提交、未 push）：修正 Browser Standard PBR 反射 LOD 从固定 7 为按实际 cubemap mip 数动态取值，并把原生 IBL 完整接入 Renderer 的 group0/binding3–6；RTX 4060 Laptop/Vulkan `--smoke-ibl` 实际 present，IBL on/off HDR readback 为 915 个变化像素、亮度 255.374535 > 184.904717。DeepSL 无纹理/非双面 Standard 固定子集已由 adapter 进入同一 v2 forward/shadow package，Browser/NVIDIA 与 Native/Vulkan 均执行。新增可复用 WebGPU GPU culling：输入独立 bounds + 144B Deep instance 行，六平面 sphere test、atomic compaction、受 capacity 限制的 `drawIndexedIndirect`，输出声明 VERTEX；Lab 同设备真实读回 4→2 可见实例、`indexCount=3`，Naga 验证通过，并已接入 PbrRenderer 的不透明与阴影批次，透明批次继续排序直绘。最新 Browser Lab 构建 `1efdfffd589d28df3c3507dbe1ce5de99701fc843601a2ec644a74ea6f1b3b51`，记录 `webgpu-1789226557820.json`，Deep Vitest 55 文件/627 项、Node 26、runtime purity 131 Browser/60 Native/194 resolved packages 通过；Native Rust 91/91、fmt、clippy 与 IBL smoke 通过，release EXE 7,895,552 B，SHA-256 `0D69FF58746DCC7066099D65E49AA3F8A7A17977729C6FCB31BBA1E0A94D94A3`。当前仍诚实保留：空间索引/HiZ/LOD/纹理压缩流式、级联阴影、Graph UI、持久化 CAS/热重载、完整材质与原生 Studio/设置切换都未完成；正式 apps/Three 默认路径未接线，不能据此宣称完整引擎、竞品领先或 Unity 90%。

2026-09-12 Deep Engine 优先批次（未提交、未 push）：用户明确“优先引擎”。Browser 主线完成 Standard Surface 的真实 GGX/Smith/Schlick、方向光、PCF shadow、diffuse/specular IBL、AO、emission、alpha 与线性 HDR lowering；DeepSL 编辑器在语法→typed IR→WGSL→当前 GPU 驱动全链路通过，失败候选保留 last-known-good。`deep-shader-package` 升级到 v2 / `webgpu-wgsl-pipeline-2`，冻结 ABI、entry、bind/vertex/attachment/depth/blend/raster/MSAA/resolve 与完整 cache key；TypeScript/Rust 共用 golden，Browser executor 已在真实 NVIDIA WebGPU 创建 4× forward 和 depth32float shadow pipeline。最终 Lab 构建 `7c185061…`，243,655 B/gzip 74,002 B，记录 `webgpu-1789219066453.json`，控制台 0 error/warn。Native ABI-1/2/3 已对齐 40B geometry、16B tangent、144B instance、160B material、208B Frame、rgba16float/4×MSAA/ACES 和 group0 b0..2；RTX 4060/Vulkan 真实 2048² shadow+3×3 PCF 读回 118 像素变化，亮度 1079.459051 < all-lit 1123.242496。根复验：Deep Vitest 50 文件/588 项、Node 26 项、11 个 ESM 入口、type/build/isolation core/runtime purity 通过；Native Rust 79/79、fmt、clippy、textured/alpha/textured+Deep2D/shadow 四项 release smoke 通过，EXE 7,227,392 B，SHA-256 `edc4a4d…`。正式 apps 没有被本批接线；全 `lab:isolation` 的 Deep 自身违规已修清，只剩并行正式工作树既有 `apps/web/src/parametric/ParametricModelWorkbench.tsx` raw fetch 架构失败，本批未越权修改。当前诚实缺口：DeepSL 通用材质 layout/entry adapter、Native package GPU executor、IBL bindings3..6、clustered lights/级联阴影、Graph UI、CAS/热重载、compute/高级材质；不能据此宣称完整引擎、竞品领先或 Unity 90%。

2026-09-12 Deep Shader 目标提升（未提交、未 push）：用户明确 Shader 必须达到 Unity 能力，同时保持类似 Three 的简单轻量，并成为编辑器一等创作能力。路线固定为“Unity 级生产模型 + 渐进式创作体验 + 自研 typed Shader Graph/DSL + WGSL 唯一运行目标”：普通作者用 Standard/Unlit 模板与 Inspector，高级作者再展开 Graph、DeepSL、Technique/Pass/变体和生成 WGSL；发布只携带实际使用的 Pass/变体/WGSL。`SHADER-00` 首批已落地版本化 Shader→Technique→Pass、typed graph、四组绑定、render state、确定性 WGSL/source map/cache key 与受预算变体；另完成低样板 `shader-presets`、带 revision/undo/LKG/stale 门禁的 `shader-authoring`、Browser/Native 共用 `deep-shader-package` v1，以及覆盖 12 类 Unity/Three 输入、9 个能力面、6 种显式策略的迁移合同。根审查补修无 attribute WGSL、Picking 错用材质色、注释伪入口和验证快照变异边界。全包 44 文件/552 Vitest、26 Node 策略及 Naga/TypeScript/build/8 ESM/runtime purity 通过；Standard 当前只保留 metallic/roughness authoring 并明确提示 PBR lighting 尚未接入，原生编辑器 UI、DeepSL parser、现有 PBR 共用包、热重载/CAS、compute/高级材质仍待后续。静态 Shader 语料为 2,239 文件、38 条证据、0 静态解析/动态 import 未决，语料 hash `c9825233…`，JSON 可重现 hash `a08e4ac1…`；缺失持久化脚本、运行时生成和 Unity 资产仍明确保留。正式 apps、默认 Three 和项目数据不变。规格与清单见 `docs/specs/deep-engine-shader-system-2026-09-12.md`、`docs/specs/deep-engine-shader-source-inventory-2026-09-12.md`。

2026-09-12 Deep Engine Unity/多格式兼容补充（未提交、未 push）：用户提醒现有编辑器可导入 Unity 包与大量模型格式，并询问 Unity 导出的 WebGL/WebGPU。核验后纠正：当前产品的 Unity“导入”是托管 Unity Web Build ZIP，以 iframe + Unity JS/WASM Player 执行，已实测版本为 2022.3/6000.0 WebGL；它不是 `.unitypackage`、UPM 或 AssetBundle 到本产品场景的转换。Unity 6.6 已正式支持 WebGPU Web backend，但本仓尚无 6.6 WebGPU 真构建，manifest 也未记录实际 graphics API，因此当前只能标为架构可兼容、待实测。旧 Studio 保留 WebGL，并可在独立门禁后托管 WebGPU；最终零 WebView Deep Native 不执行这两类网页包。新路线冻结现有 25 个模型扩展名及真实 direct/converter/provider/subset 证据，Unity project/`.unitypackage`/UPM/Scene/Prefab/AssetBundle/Addressables 经隔离 Unity Editor exporter 输出内容寻址 Deep Asset Package；每种格式按几何、层级、材质、纹理、动画、蒙皮、morph、元数据、PMI、行为等逐项验收，扩展名存在不等于 native-ready。已新增机器可判定的 `assetCompatibility` 合同与失败关闭测试，并在 Deep 交付清单加入 ASSET-00..07；正式 apps 未修改。

2026-09-12 Deep Engine 零旧包袱决策（未提交、未 push）：第一原则设为“以最终目标和可验证事实纠正局部方案”，发现用户设想、旧计划或当前实现存在目标互斥、性能包袱、兼容风险或更优路线时直接指出并修改权威方案，不机械照做。用户最新明确 Deep 路径完全放弃 WebGL，最终客户端完全放弃 WebView/Chromium/Tauri 前端，GUI、文字、图表、HUD、节点画布和 3D 全部经同一原生 `wgpu` device/surface 执行并保持跨平台；Three/Babylon/React/ECharts 只允许存在于旧正式环境、Browser Lab 或隔离迁移工具，不进入 native runtime。该决策覆盖此前“WebView Studio + native Viewer + 混合 Studio”的迁移路线。正式旧项目仍冻结保护；迁移期旧 Studio 的 Three/Deep 一键切换继续用于兼容验证，最终 Deep Native 客户端只含 Deep。已重写 `deep-engine-native-gui-migration-2026-09-12.md` 并同步执行计划/交付清单；运行时纯净门禁、Rust Deep2D 合同、全 wgpu 2D/GUI/图表和 3D 材质主线并行推进。源码迁移盘点已覆盖 1,724 文件，React 549、DOM/browser 470、ECharts 15、Monaco 6、Worker 14、direct network 9、Three/raw graphics 152；计数用于冻结语料，不直接换算工时。

2026-09-12 Deep Engine 并行加速批次（未提交、未 push）：四天仍是 9 月 16 日集中检查点，不缩减 Unity/UE5/Godot 90%、Three 插件兼容与正式项目保护分母。已完成通用 RenderPacket 与联合 GPU 事务，嵌入 PNG/JPEG、UV0、baseColor/MR、sampler、KHR_texture_transform 已进入自有 WGSL；Khronos BoxTextured 在真实 WebGPU 显示，错误回滚和 device loss 后重建通过，记录 `test-output/deep-engine/webgpu-1789204519285.json`，构建 `f9abd32f…`。Three 0.185.1 DataTexture、UV0、baseColor 和 metalness(B)/roughness(G) 合并桥通过真实依赖测试，不修改作者对象。normal map/TBN 已完成源码与 360 Vitest + 5 AST，待根最终浏览器复验。独立无 WebView 的 Rust `winit 0.30.13 + wgpu 30.0.1` Viewer 已绘制完整静态 packet：2 几何/2 材质/4 实例稳定合批、镜像绕序、非均匀缩放法线和空场景在 RTX 4060 Laptop/Vulkan 实际 present；Rust 11/11、fmt/clippy/依赖门禁通过，debug 15,461,888 bytes、SHA-256 `f1857483…`。本条记录中的旧 WebView/混合迁移判断已被上方“零旧包袱决策”覆盖；`HostCapabilities`、单一 `SessionAuthority`、`OverlayCommand`、`ChartSpec` 与 headless `Deep2dDisplayList` 仍是有效协议。开源复核纳入 React Native Windows/Fabric、@wuba/react-native-echarts、ChartGPU 和 Lumen Charts，只作为带门禁的参考，不写入正式依赖。当前并行完成运行时纯净门禁、Rust Deep2D、AO/双面材质、normal map 真机和全包复验，随后推进全 wgpu GUI/图表、透明/灯光/动画/大场景及原生打包。正式 apps、默认 Three、作者数据/脚本、账号与存储未修改；未把后台节流 RAF、固定样本或 present smoke 当 FPS/竞品/像素画质结论。计划与证据：`deep-engine-execution-plan-2026-09-12.md`、`deep-engine-native-gui-migration-2026-09-12.md`、`deep-engine-render-packet-verification-2026-09-12.md`、`deep-engine-delivery-backlog-2026-09-12.md`。

2026-09-12 WebGPU 独立管线增量（未提交、未 push）：用户后续明确“开源项目仅参考吸取精髓，自主开发核心，不影响现有项目正式环境”，覆盖此前必须整体基于 Orillusion 的实施建议；新增默认视觉/性能原生对照 Unity、UE5。已完成独立 `packages/deep-engine/src/webgpu` 固定材质夹具：设备/取消/迟到释放、真实首帧与丢失重建、实例化球体、GGX PBR、GPU 生成摄影棚 IBL/预过滤/DFG、静态阴影缓存、HDR/MSAA/输出、可选异步 GPU 时间戳；实验页 127.0.0.1:5291，无产品 API/存储调用。72 测试、类型/构建/隔离门禁通过；全仓源文件门禁 2470 通过。浏览器记录和两轮以上截图见 `docs/specs/deep-engine-webgpu-verification-2026-09-12.md`，最新构建 hash 9f343a7a；设备丢失停止、旧受管资源归零、重建首帧已验，不能当驱动显存零泄漏证明。正式 apps 无引用，未改默认引擎/设置/脚本/项目。本轮待办：通用 RenderPacket/模型/纹理/完整画质、项目兼容、真实一键切换；3D 自评 8，未宣称视觉最终达标或领先竞品。项目级后验收：Unity/UE5/Godot 90%、完整原生/GUI；明确排除：8 小时 soak 仍按用户取消执行。

2026-09-12 01:35 GLM 性能线验收完成（未提交、未 push）：用户三项任务之"性能项证据补充"已闭环。①OffscreenCanvas 此前为空开关（worker 模块存在但引擎未接线），本轮真实接线：协议扩展（ready/位图回传）、worker `transferToImageBitmap` 回传、新控制器 `viewerOffscreenController.ts`（体检→快照→worker→覆盖画布；漂移防抖重检 800ms；重启预算 2 次/20s；材质按需采样 version+90 帧兜底）、引擎 Core/Runtime/Lifecycle 集成、绑定改必选、设置页真实状态显示；真实修复两个崩溃：快照"先 await 后序列化"竞态（改为先同步序列化）与 ObjectLoader 纹理缺图像 `undefined.data`（解析前合同校验）；标注/告警 Sprite 属易变叠加层，不进快照与签名，主线程投影补绘。②遮挡剔除/大对象树虚拟化补齐浏览器实测证据，门禁 `apps/web/scripts/gate-performance-evidence.mjs`（已注册 `gate:performance-evidence`）全绿：虚拟化 10000 行→19 行挂载、DOM 降 99.8%、末行 reveal 可达；遮挡剔除 511/601 网格、免绘 62.1 万三角形、draw calls 降 84%（合批关闭口径；合批时收益体现在 avoidedTriangles）、开关切换画面 SSIM 0.9981；Offscreen 激活后主线程 drawCalls=0（worker 240 draws）、cpuFrameWorkMs 473→55ms、结构漂移静默重启 restarts≥1、关闭恢复主线程、WebGPU 如实回退（原因可读）、主/worker 画面 SSIM 0.9591（差异=OffscreenCanvas MSAA 不可用与网格 mipmap 路径，diff 图目检无几何错位）。单元 9/9，viewer+visualQa 350 用例无回归。证据：`docs/performance-verification-2026-09-12.md`、`test-output/perf-evidence-2026-09-12/run-nBoEz0/`。诚实边界：SSIM 0.959 为实现级 AA/mipmap 差异，未声明逐像素等价；CPU Tracing 主线程任务对比仅记录未断言；门禁为 headless Chrome 合成夹具口径。

2026-09-12 GLM 并行批次四线全部交付（未提交）：D 全量测试线完成——u120-ui-sweep.mjs 49 步三遍全过（1440/1280/980），唯一实锤缺陷 P1（环境面板关闭钮被视图立方体遮挡）已修（scene-workspace.css z-index 2→20）并实测验证+同族排查；待核实大问题 S1-S8 写入 docs/ui-sweep-major-issues-2026-09-12.md；控制台最终轮仅预期内 401。A 线二维资源（5 文件+三轮 34 图+待核实 6 条）、B 线模板中心（5 文件+130/130+三轮 24 图+封面重绘/结构改造回退待核实 B0-B2）、C 线预制体缩略图（78 个 14 类全真实 3D 小样+渲染器+9 用例+2024 回归+4 轮闭环+浅色主题未测如实申报 C1-C8）全部交付。集成复验：全仓 tsc 0 错误、全量 Web 2023/2026（唯一失败=并行 deep-engine 会话的 packages/deep-engine/lab 未跟踪文件违反架构边界，非本轮产物未越权修复）、性能门禁合并后全源码重跑全绿（数字保持）。总交付报告 docs/delivery-report-2026-09-12.md（含 10 维打分、诚实条款 6 条、待核实清单指引）。竞品参照 docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md + test-output/competitor-ref/。待用户：核实两份待办文档后决策是否实施封面重绘/结构改造/其余大问题。

2026-09-12 GLM 并行批次四线全部交付(本条为过程留档)（未提交）：用户任务之二"全量 UI 测试"（最高优先级）与任务之三"二维资源/看板模板/预制体缩略图商用化"（较低优先级）由四个并行代理执行，文件所有权互斥：A=二维资源库（DashboardComponentPreview/PresetFactory/相关 css）、B=模板中心（DashboardTemplatePreview/DomainPacks/ReadableChartOptions/Typography）、C=预制体缩略图（新建 src/prefabs/thumbnail/ + IndustrialPrefabThumbnail + BuiltInAssetBrowser prefab 段）、D=全量测试遍历（u120-ui-sweep）。用户纪律：只直修小问题（影响小/把握高/局部可验证），大问题一律写 `docs/ui-sweep-major-issues-2026-09-12.md` 等用户核实；A/B/C 同样遵守（大改/没把握方案写 `docs/ui-major-issues-2026-09-12.md`）。竞品参照（用户要求 1:1 复刻结构与风格，禁止复制素材/名称/Logo）：帆软 FVD（七维筛选/纯净封面卡片/素材详情标签体系）、app.fanruan.com/templates（9 大行业类/类型筛选/左列表右预览）、FVS 官方视觉规范（深色基底/行业色调映射/图表净化清单）、山海鲸市场（深色分类树+计数/金色分层角标/横向分区行）、ThingJS 资源中心（3 列真实 3D 封面+计数缩写）、Hightopo（极简网格），全部入库 `docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md` + `test-output/competitor-ref/`（u121 脚本无头抓取）。待四代理交付后：跨区同族排查、全仓 typecheck/测试合并重跑、双主题两轮视觉闭环、10 维打分、交付报告。注意：并行代理在改 B/C 文件时 tsc 曾出现 DashboardTemplatePreview/prefabThumbnailKit 错误，最终合并后必须全仓重验。

2026-09-12 WebGPU 自研引擎接续（未提交、未 push）：已读取“规划自研 WebGPU 引擎方案”任务，承接用户“分析调整并执行、正式完成前保护现有项目”的授权。新增最终目标为设置一键无感切换自研引擎/Three.js，性能与能力超过 Three/Babylon，向 Unity/UE5/Godot 各自 90% 推进；这属于长期目标，不是本次完成声明。现行实施依据 `docs/specs/deep-engine-execution-plan-2026-09-12.md`，旧路线第 5–15 节执行建议由它覆盖。采用 Orillusion 固定 commit 审计后接管绘制、初期保留 Three 作者对象与数学/动画语义、同一脚本宿主、按真实收益逐步缩减兼容依赖；原生先 Viewer 后 GUI/编辑器。已完成基础批次：修复 deep-engine 接手时 TS 失败和场景树缺陷，补失败原子性/dirty/调度传递失败/渲染图资源校验与缓存；新增独立后端切换协调器及取消、超时、迟到清理、帧边界合同；AST 清单 2157 文件、165 个模块/符号、2266 静态引用、409 未解析证据项，全部兼容状态 unverified，原始 JSON 在同目录。本轮待办：真实 GPU/PBR 与 Orillusion adapter、运行时语料、完整项目平替、真实设置切换及性能/画质门禁。项目级后验收：原生与完整能力矩阵、三大引擎 90%；明确排除继续包含用户取消的 8 小时 soak。生产 apps、默认引擎、账号/存储/数据未改；不把 headless/mock 验证当 GPU、无黑帧或性能领先证据。最终检查结果见该执行方案 §8。

2026-09-09 用户最新增量：明确要求此前尚未做的1普通拾取BVH、2大对象树按需渲染、3优化器连续图层缓存，加遮挡剔除与OffscreenCanvas同时实施；能可选开启尽量可选降低风险。此条覆盖先前对遮挡/Offscreen“暂不优先”的候选判断，但不授权以空开关或纹理编码代替实际能力。三代理当前cloud做BVH、AI先修共享缓存/合批critical再做大树、resources做连续图层缓存，根负责遮挡/Offscreen与旧UI收尾。旧模型替换/工程资产/KTX2已专项验收并从交接条目删除，证据 `model-engineering-verification-2026-09-09.md`；原全量全菜单及部分AI/交付/连贯UI尚待收尾。最新新增复核缺陷：共享DataTexture/压缩mipmap的raw写前深拷贝、非均匀父缩放造成剪切/自定义shadow回调合批回退、gltf成功但metadata失败时clone lease释放，AI代理负责修。用户问旧任务是否全部收尾，已明确答复未全部：功能主体已落地，剩页面/性能/窗口与最后全量验收，不把新任务混入旧完成数。

2026-09-09 22:33 Codex 持续验收（未提交未 push）：新增五项和性能 A–F 全部保持本轮范围。根已接入跨实例 glTF 共享加载/几何/纹理、独立材质、引用释放与可信 raw 接口写前分离，以及兼容静态网格绘制实例化（保持作者对象身份，按空间分组，不兼容材质/动画仍普通绘制）；33 项相关回归通过，Web22:27类型通过，静态QA22:33重新构建。按需渲染浏览器已观察1000对象静止 renderedFrames 固定5、skipped 持续增长，拖动恢复绘制，真实CPU/双后端/效果及资源长期回落仍在验；微基准不当作整机帧率。KTX2已本地编码UASTC/ETC1S，资源代理实际WebGPU载入通过，替换/撤销/保存继续。工业AI8files36、交付恢复11files52、云输入Worker6files21专项通过，不能代替最终页面验收。项目包API导入再导出已验证完整场景/2D/脚本/模型/模拟数据；根实际3D未保存脚本刷新后恢复成功，新应用恢复弹窗尚待验。最新真实BUG：新场景首次保存未激活（AI代理修）、替换后资源/实例ID冲突（资源代理已修等待静态验）；HMR旧engine导致QA空保存暴露保存就绪保护不足，正在同族排查。云代理继续现有诊断的分阶段加载计时与接收端RTC导出。交接清单仅删除已验收项；最终全菜单/全栈/双主题及宽度验收尚未完成，不继承旧全量结果。

2026-09-09 22:07 Codex 续跑（未提交未 push）：用户最新要求新增五项与旧问题同步，并已明确将性能方案高收益及按需渲染、重复资产实例化、KTX2 全部纳入；先前仅方案/候选的排除已被这条明确授权覆盖，最终全菜单全量验收仍最后做，5–8小时旧整轮估计失效。资源外链/优化器/参数化/拓扑旧项已验并从交接清单删，报告 `resources-optimizer-final-verification-2026-09-09.md`。真实源码调试已获用户专项授权运行既有 `gate-author-script-debug.mjs`，4/4，`test-output/codex-2026-09-05/author-script-debug-hEWRnl/report.json`，不是帧步进替代；根生产build21:47绿但后续改动仍需重验。根修旧场景脚本入口、项目导航会话恢复、菜单层叠、独立窗口返回分屏（真实12行QA脚本保留）；桌面显式非置顶/系统装饰/最小最大/任务栏，Rust5通过，CUA不能操作系统标题栏，不能宣称实际最小最大已验。根新增密集标签空间网格，首版1080负收益后改128个已显示标签才启用；7组交替采样显示4K10000标签CPU布局中位数8.67→4.14ms，输出集合一致，限定Node微基准而非FPS；21项focused过。新增五项：AI共享处置草稿/证据/保存撤销与数据查询本地真聚合已实现，待根UI，报告 `industrial-ai-usability-verification-2026-09-09.md`；cloud负责整项目包/2D脚本恢复（2恢复BUG21测试已过）；resources负责替换预检/工程配方版本预算。随后性能并行分工：根重复资产实例化与标签布局、AI代理deviceSignal缓存及按需渲染、resources KTX2、cloud云输入队列。子代理CUA browsers=[]，根browser1/tab3可用，根须代验。全量/最终UI未完成，不继承历史绿灯。

2026-09-09 21:35 Codex 持续并行（未提交未 push）：用户强调编辑器及全系统连续操作，新增“极致性能与交互优化方案”并明确不能停止原任务。云渲染旧任务已验收并从交接清单删除：实际1440P 57FPS、2160P 3840×2160 1425帧/12.55MB NVIDIA HEVC约36FPS，停止activeSessions=0，一键全服务正常；详见 `cloud-render-final-verification-2026-09-09.md`，不把4K描述为60FPS。钻取已新开真实场景确认保存恢复、预览成功，双主题两轮及防重复/撤销完成，已从清单删除；报告 `scene-drill-guide-verification-2026-09-09.md`。根修停用钻取事件状态不一致、更多菜单层叠/浅色文字；新发现AI页面刷新回首项目，已统一项目路由上下文和按账号session恢复，路由等4文件18测试过，浏览器复验待做。资源代理修资源→优化器StrictMode卡加载与资源外链，正在真实验收；AI代理修检查点磁盘失败污染和SIM尾端29/30截断，正在完成UI。云代理并行只读性能方案，不重复已有Worker/LOD/调度器。5174静态QA已21:29重建；5173源码HMR可导致测试中断，最终须冻结构建统一门禁。旧任务仍剩资源/脚本/AI-SIM联动；新增五项和全菜单全量未完成，不继承旧全量通过数字。

2026-09-09 16:34 Codex 续跑（未提交未 push）：用户新增 AI 全模块自包含审计（明确允许模型 API，禁止其它项目/外置业务服务必需依赖）；云画质分辨率；优化器图层改名/删除/隐藏与所有已支持格式入口（不体现暂不支持格式）；最终覆盖所有菜单/二级页/属性/子 Tab 的 UI、交互、功能、文字、排版，小问题直接修。三并行在用户中断后已恢复：ai_samples 正在电池真实三 ONNX 项目内置推理/移除默认8030，30测试已过；aigc_modeling 已将视觉样例改真实 YOLOX-Nano 本地识别，4API+5Web通过，继续钻取/AI/菜单清单；hightopo_topology 告警实现与28focused过，正在优化器真实编辑/撤销/导出及格式筛选。当前只有根浏览器可用，子代理浏览器报告 unavailable，由根代验。根云HTML/信令/发布origin与静音自动播放已修；1080P实际WebRTC硬件编码证据 streaming，NVIDIA HEVC、1258帧、6.6MB；720P实际videoWidth1280/videoHeight720已看到，随后源码热重启断流属测试环境，最终需稳定重验。四分辨率策略720/1080/1440/2160P按场景持久，控制面21测试过；设置UI已保存720P，实际帧率合同刚补。资源五文件类型已真实上传浏览；预制体/模板也浏览，模板首帧尺寸与浅色治理面板硬编码已修。16:11合并根typecheck/source2267/Web1834/API613/其余包测试和build全过（首屏317.9KiB），后续新改仍需终验。根为避HMR建立 test-output/review-0909 QA构建，Vite preview5174自定义代理配置运行（终验后停）；正式5173/4100仍运行，未动.env/账号/旧业务数据。剩根完整资源/脚本GLM/云/代验三代理/最终全页面和故障、发布恢复门禁，不能宣称全目标完成。

2026-09-09 16:00 并行推进：AIGC 参数化已走三模板真实几何→GLB保存→资源浏览→刷新→v1恢复，报告 `parametric-aigc-verification-2026-09-09.md`；图朴拓扑统一投影/逆变换、拖动连线及路径聚焦，两轮双主题四尺寸组合，报告 `topology-hightopo-review-2026-09-09.md`；AI 本地样例实跑、Agent检查点关闭重开已独立复核，电池下游8030不可达，报告 `ai-samples-verification-2026-09-09.md`，不能宣称真实电池推理通过。三并行当前继续钻取作者向导、共享告警、SIM 多车运输网络。根资源新增环境/PBR上传入库、所有项目类型和公共模型/环境/材质浏览、内置真实组件/模板/预制体浏览；API资源上传/失败回滚/重启恢复与目录7项通过，浏览器HDR/材质/视频上传成功（QA项目），高DPR画布缺CSS导致裁切已根治并补机器人同族。Web新类型通过，架构/资产网络10项通过；一轮Web全量1825通过但当时架构1失败已修，最终仍需合并重跑。默认studio重启三服务健康已实测；进一步发现Worker发布页同样错误使用APIorigin导致 `/published` 404，16:00已修启动区分Web页面origin与API观看origin，正在第二次重启验证真实WebRTC。根仍须完整资源双主题/失败/发布，GLM独立门禁和统一全栈验收。以上未提交未push，旧用户数据保持。

2026-09-09 Codex 实施中（未提交、全目标未完成）：用户要求推进全部任务，BUG→快修→竞品参考后改进；最新指定参数化建模参考 AIGC（Zoo/Sloyd），2.5D 参考图朴 Hightopo，并要求独立复核 GLM 已修复项。云 viewer HTML/offer/answer 受控代理 13 项通过；启动器默认 Node-RED/MediaMTX/云 Worker、独立日志/身份健康/复用外部实例，默认启动已实测成功，新增启动测试与 CLI 合计 12 项通过。脚本默认模板 ctx.self 导致首行假红已修；2D 分屏 CSS 强制隐藏、3D effect 反复关面板、窄窗固定分屏宽度与零宽网格抽屉均已定位修补，1280/980 浏览器实际点击及截图已做首批。渲染诊断原生独立 dialog、导出文字、浏览工具图标和指定转换器目录移除已修改。Web 一轮全量 432 文件/1815 项通过、API/Web 类型检查首批通过，尚需改动后统一重跑和双主题视觉门禁。IoT-NB 同步路由/客户端/本机目录发现已删除，历史关联模型及传递引用完整归档后退出活动项目（data/operations-legacy-imports-*.archive.json）；迁移幂等/保留独立记录/旧路由404与维护/仿真普通链路 6 项通过。未动 admin/admin、.env、postgres+minio，未 push。资源全类型、AI 样例、AIGC 建模、图朴拓扑、告警语义、钻取、SIM 与 GLM 独立复核仍属本轮待办，不能因本批修复缩围。

2026-09-09 Codex 现状复核：已按本轮人工测试重排 `docs/platform-gap-analysis-2026-09-09.md`。脚本真断点/单步、Agent checkpoint 恢复、SQL 受控写回、Shader 轻量版均有实现与验收依据，从待开发项移除。新增 P0 为云渲染公开地址 404、Node-RED/MediaMTX/云 Worker 默认一键启动、脚本新建工作区回归；P1 为 IoT-NB 项目解耦、全类型资源浏览/上传、AI 一键测试样例、告警语义、参数化零件生成器、拓扑 2.5D 与统一标题栏组合项；钻取向导和 SIM 多 AGV/多域交接列为 P2。暂停纯数量扩张、Monaco 内嵌调试器、完整 CAD/OLP 等低价值范围。本条仅记录复核与计划，没有实施或宣称修复。

2026-09-09 增量轮：差距调研 `docs/platform-gap-analysis-2026-09-09.md`（对标五家，量化缺口：行业包 4/10、模板 120/300+、资产 80/3000+、Shader/SQL/云渲染已补）。素材两轮清理：77 未过审 + 9 品牌/白膜全部删除，**80 项全部 approved 零遗留**（备份 test-output/source-b-prune-backup）。云渲染一键启动 `pnpm studio start web --cloud-worker`（本地 Worker 随栈、令牌进程注入、实测 configured+workerReady/RTX4060 硬编码）。SQL 受控写回确认已完成（真实 PG 测试 18/18，交接文档过时）。水处理运行包（第 4 包）gate 4/4。Shader 轻量版：材质外观"着色器效果"面板（菲涅尔轮廓光，onBeforeCompile 注入 emissive，合同可选字段持久化）。optimizer i18n 补全；frame 外 7 页字号实测 0 违例。全量：typecheck/2206 文件体量/Web 1810/API 599/其余包/u117 巡检全绿。未验证声明：Shader 真实 WebGL 目视待人工。详见 `docs/full-verification-report-2026-09-08.md` §7。

2026-09-08/09 夜间批次（GLM-5.3 定时任务 23:10 起）：用户六项已知问题全部修复并获浏览器证据——顶栏"更多">1500px 裁剪复发（overflow 根治）、分屏拖动 3D 闪烁（渲染前 resize）、云渲染 403 误判+卡片整禁+设置无引导（新增登录可读 `/api/cloud-render/capability`、可见原因行、三步启用引导）、tab 高度被 28px 兜底特异性长期压制（40/32px !important 提级+同族清剿 5 处）、2D 缩略图全同（widget.type 恒 undefined 兜底，改顶层 type+合同收窄）、optimizer 6-9px 字号与流水线语义等一族（12/11px 提级、done/active/skip/pending 三态、拖放、相机保留）；顺手修 vitest 误收集 scripts/*.test.mjs。提交 `eb0cb34`、`2d654e1`、`03f5c27`。素材线十四批视觉审核 **166 项全部审核清零**：批准 7→89（`docs/source-b-visual-review-batch{2..14}-2026-09-0{8,9}.json` 逐项留档），77 项保持待审且每项有明确问题记录（白模族约 20、品牌/商标约 10、集合包约 10、用途不符约 10、不可辨约 8、X4122 驱动警告同族 6——解决路径各异，不能靠重拍或放宽门槛绕过）。行业包 2→3：新增电力能源运行包五页（变电站联动、台账对账单测、`gate-power-grid-pack.mjs` 两轮双主题 4/4）。全量验证：根 typecheck、2199 源文件体量、Web 431 文件/1806 项、API 599 项、其余包全过、生产构建（首屏 314.6 KiB 预算内）、`gate-known-issues-fixes.mjs` 7/7（新写）、优化器工作流 4/4（实测 fontSize 12）、性能基准 4 组（1000 对象双后端 60fps 零错误）、u117 全路由无横向溢出。权威报告 `docs/full-verification-report-2026-09-08.md`（含未验证清单：云渲染真实 GPU Worker 端到端、分屏真实指针拖拽逐帧采证、素材 103 项待审等六项诚实声明）。

2026-09-08 最终收口：用户明确暂停行业包、素材新增/审批与模板数量扩充，本轮完成正式记录表单、REST/PG 写回、实际PDF、环境视口、SIM时间线/Study、AI当前页草案、必要Vapor、旧glTF材质全链路与首帧缩略图。根build/typecheck通过，Web438文件1827项、API132文件597项，2194源文件≤800；正常web全栈健康。权威验收 `docs/final-unified-validation-2026-09-08.md`，交接 `docs/codex-glm53-handoff-2026-09-08.md`。用户已授权最终完成后push `dev-studio`；两份GLM未跟踪草稿不纳入提交。

2026-09-08 r47 增量：根 build/typecheck/test 全通过，Web431文件1784项/API129文件587项，2159源文件≤800。二维填报刷新失败/只读重试/在飞后新读/面板互斥两轮4/4（`dataset-writeback-tBCU4j`），灯光增量与销毁竞态提交 `b3095b2`，无遮挡3D门禁4/4（`light-editing-8pPg9o`）。SQL真PG初版4/4但发现数据中心确认写后旧预览未刷新及浅色表格问题，进入r48；环境980收纳与AI-3当前2D页资产化也在r48实现，尚待统一构建。仿真空间门禁正在排除浮层对截图像素证据的污染。全目标仍待办，行业/素材未提前新增。

2026-09-08 用户最新执行顺序：先 3 填报与导出、4 UI/交互、5 仿真与 AI、6 必要 Vapor 改进；然后 1 行业包/业务页、2 素材审核；最后 7 全局验证与交接。当前并行实现 SQL 写回、填报刷新反馈、仿真空间层及灯光/预热增量修补，均以验证证据回填后认定状态；不提前宣称完成。行业包与素材暂缓新增但不移出本轮范围。

2026-09-08 收口增量：仓储功能提交 `cbc558e`，二维真实填报与写后指标刷新提交 `54eface`；r46 Web build通过，r45根类型/2142文件及Web1767测试通过；r46可读性4/4与实际PDF8/8已复核。当前批次细节和SQL下一实现入口见 `industry-logistics-continuation-2026-09-08.md`；全目标保持待办，不以本批验证缩围。

2026-09-08 当前批次增量：`industry-logistics-continuation-2026-09-08.md`。仓储五页已通过r44两轮4/4，目前两个业务包十页深化，3D匹配及≥10包/≥300页仍待办；素材7批准/159未批准。r44 Web build及426文件1764测试通过；二维填报成功后指标刷新已接线，正式画布表单/SQL不移出本轮。图表与素材卡视觉修补尚待最终统一构建，不宣称全目标完成。

2026-09-08 标题栏复核：`24abd5f` 的靠右修补仍生效；新增 `gate-editor-topbar.mjs`，2D/3D 双主题三宽度两轮 24/24，通过证据 `editor-topbar-FybcbB`。见 `topbar-alignment-verification-2026-09-08.md`。此项仅复核布局，不改变下列整体待办状态。

2026-09-08 最新增量：见 `industry-writeback-continuation-2026-09-08.md` 和接续检查点顶部。r40根构建/测试、r41类型、r42Web构建/1745测试通过；行业包/样本Excel/字号/计算字段各两轮4/4。r39 REST与单车仿真最终通过；r42实际PDF纸边修补两轮双主题8/8。十包/三百业务页、163资产审核、二维/SQL填报等仍待办，不宣称全项目完成。目标与明确排除项不变。

更新时间：2026-09-06（最新恢复状态见 §15.6 与接续检查点）
任务：规划 AI 开发与产品升级
任务 ID：`01a0437f-f06e-7dd1-b9d2-b866c3f76e11`
工作分支：`dev-studio`
功能闭环提交：`946e7a9c9021d211cf53b67552926955d137a797`

## 1. 使用方式

本文件用于在服务中断、任务续跑、上下文压缩或人员交接后恢复真实工作状态。恢复时按以下顺序读取：

1. 本文件：确认冻结范围、完成状态、排除项和当前待办。
2. `AGENTS.md`：确认代码、产品与验证硬门槛。
3. `docs/product-depth-experience-stability-ai-mcp-upgrade-plan-2026-08-27.md`：读取完整产品方案。
4. `docs/release-closure-2026-08-31.md`：读取最终闭环证据与诚实边界。
5. 当前 Git 状态、最新提交和最新门禁产物：以实际状态覆盖文档中的旧数字。

原始会话存档只作为本机追溯源，不进入 Git。它可能包含系统指令、临时测试配置和大量工具输出；直接提交既不可维护，也可能泄露不应公开的信息。本总账保留所有会影响产品范围和交付判断的用户决策。

## 2. 冻结目标

在不扩大范围的前提下，一次性关闭工业数字孪生平台的核心产品闭环：

- 优先完善 2D、3D、脚本编辑器和拓扑编辑器。
- 补齐高价值、轻量的工业场景，不做无意义功能堆砌。
- 补齐多脚本、离线依赖、脚本专用 Git、商业化素材/模板、发布和客户端流程。
- 统一执行功能、UI、交互、性能、稳定性和发布门禁，并自行修复发现的问题。
- 所有源文件不超过 800 行；新增业务文件优先控制在 300 行，复杂页面尽量不超过 400 行。
- 代码必须可读、可维护、命名和结构规范，并在业务约束和非直观边界处添加必要中文注释。
- 页面以“绝对易用、流程清晰、功能强大稳定”为首要目标；工作区优先，低频面板渐进展开。

产品定位不是 BIM 编辑器。BIM/CAD 只作为工程资产语义和格式输入的一部分，主线是 Web 原生工业数字孪生、2D/3D 应用交付、数据接入、仿真验证、虚拟调试与 AI 辅助。

## 3. 不得丢失的产品决策

### 3.1 产品与信息架构

- 2D、3D、脚本、拓扑共享项目与场景上下文，切换后不能丢选择、草稿或返回路径。
- 目录树保持简单；对象、灯光、模型和常用元素同层呈现，批量组织按需展开。
- 开发流程只保留文字入口，默认完全收起，不常驻状态行或进度条。
- 左右面板均可收起，收起后画布必须真实扩展；避免小字、重复标题、信息密度过高和 Demo 式说明卡。
- “浏览”和“预览”是同一个用户动作，统一称为浏览。
- 低频但有价值的能力不删除，放入二级工具、折叠区或插件层；不能与主任务争抢首屏空间。
- 产品源码、界面、安装包和公开资源不得出现竞品名称、标识或仿冒品牌；内部对标研究只保留必要事实引用。

### 3.2 2D、3D、脚本与拓扑

- 2D 组件库必须有商业化缩略图、分类、搜索、空状态、插入反馈和真实可编辑模板。
- 2D 拖拽与缩放要有可感知但不打扰的吸附：覆盖画布中心、参考线、其它元素的边缘与中心，并提供临时对齐线和可关闭的吸附设置。
- 3D 必须提供对象、灯光、相机、材质、标签、动画、测量、剖切、爆炸等高频能力，并可由图形化页面和脚本共同控制。
- 标签支持对象跟随、点击、关闭、碰撞避让、视口边缘处理和保存恢复。
- 动画统一支持自动播放、单次播放和循环播放；人物、车辆、AGV 等支持路线、速度、停靠、朝向、循环或往返。
- 脚本不是一个大文件；项目支持多个独立 JS 模块。
- 脚本允许使用受控原生 JavaScript、React/界面扩展能力和 Three.js 场景能力。
- 项目依赖支持固定版本 npm 包、本地上传 JS 和外部 JS 链接；安装后缓存到项目，离线可运行，并提供依赖、版本、引用和删除保护。
- Git 只管理脚本，不管理整个场景；支持状态、历史、提交、远端、拉取差异确认和非强制推送。
- 拓扑覆盖节点、连线、属性、运行状态、保存、刷新恢复和插入看板，不扩张成复杂独立工程套件。

### 3.3 AI 与高价值工业能力

- AI 模块插件化，通过稳定能力合同接入，不把页面直接绑死到模型供应商。
- AI 入口必须低学习成本：生成、解释、诊断和工业 Agent 统一呈现。
- 普通只读问答直接返回；写入类操作采用草案、差异预览、一次确认、应用、撤销和证据，不建设重型审批中心。
- MCP 建立在稳定领域命令、权限、版本和审计之上；不把全部 REST 接口机械包装成工具。
- 保留设备预测性维护与虚拟调试的高价值核心；不复制原项目的重型运行时。
- Plant Lite 保留离散事件、工位、队列、缓冲、输送、AGV、班次、故障维修、随机实验和置信区间。
- PS Lite 保留工位碰撞、机器人轨迹与关节约束、简单避障、多机器人时序、节拍、信号映射、故障矩阵、回放和证据；不自研完整品牌 OLP。
- PD Lite 只做轻量 PPR/BOP：工序、前置关系、资源、工时、版本、变更影响和方案对比，不新增一级导航。
- 机器人能力轻量化，但机械臂常用轴数、轨迹、工具、碰撞、节拍和负载等高价值配置必须可用。
- 数据源接入要支持采样时间、周期、触发规则、重试、检查点和运行状态；视觉、设备维护、仿真等能力通过接口、数据库、消息流和监控数据落地。
- 通知采用轻量通道模型，覆盖邮件、飞书、企业微信、钉钉和 API/Webhook；群机器人负责群推送，只有平台本身支持的企业应用能力才提供个人/部门定向。

### 3.4 素材、材质与视觉

- 数量是门槛但不是目标；模板和素材必须能进入真实工作流，不做空壳和盲目堆量。
- 2D 与 3D 在统一资源中心治理，但保留清晰类型筛选；用户都可导入自己的资源。
- 预置园区、车间和社区常用资产，包括围栏、人物、车辆、AGV、传送带、门禁、机械臂、电视大屏、货架、传感器和安全设施。
- 机械臂、传送带、人物和 AGV 的高频参数、动作和数据端口必须可配置。
- 环境资源覆盖天空、天气、背景、地面、HDRI、灯光、后处理、冲击波、扫描环、飞升线、飞线、管线流动和电子围栏。
- 材质编辑器使用专业 PBR 工作流，提供预览、纹理、环境和性能反馈。
- 外部来源资产只有在来源、许可、结构、缩略图和质量门禁满足发布要求后才能进入公共包；本地下载数量不能冒充商业质量。
- 性能优化不得让用户感知模型质量下降。自动策略优先调整内部分辨率、阴影更新频率和后处理成本，不改写用户模型几何、材质或纹理。

### 3.5 发布、部署与存储

- 发布提供 WebGL、WebGPU 优先、云渲染和 Windows 只读场景客户端四条路径。
- WebGPU 不可用或初始化失败时自动回退 WebGL。
- 发布时可选择是否显示工具栏；工具栏承载浏览、复位、视图、测量、剖切、爆炸、标签、全屏和截图等浏览能力。
- 完整编辑客户端不填服务 IP 时可进入本地工作台；需要协作和在线发布时填写服务器 Origin。
- 只读场景客户端只浏览指定发布场景，不包含项目管理、编辑、保存、脚本、AI 或数据配置；场景资源随包固化，不完全依赖网络。
- 支持导入/导出项目包，并可把整个场景导出为 GLB。
- 生产环境使用 PostgreSQL 和 MinIO；本地工作台使用 IndexedDB 和本地资源，不依赖 PostgreSQL、MinIO 或 Python。
- 项目全局不使用 Docker；本地开发、客户端联调、服务端与生产部署统一使用跨平台 Node 入口 `pnpm studio`。平台专用脚本只允许作为入口内部适配器，不再作为公开用法。
- 弱网和断网必须可控：有限重试、指数退避、取消清理、离线状态、恢复提示和冲突保护，不静默覆盖。

## 4. 明确排除或后来取消

以下项目不是当前待办，不得在恢复任务后重新加入本轮：

- WebGPU 8 小时长稳测试；保留短时资源、画质、设备丢失和恢复门禁。
- BIM 语义增强；已有能力保持不退化，但不继续扩张。
- JT、X_T/X_B、RVT、OpenUSD 等工业格式的实际转换验收；已有 reader、探测、官方加载器或转换路由保持不退化。
- PINO、PINN、TwinMoE 的生产证据和正式上线。
- 电池模型正式上线。
- 多节点并发和集群调度。
- Docker。
- 50 ms 调度和现场协议 Rust sidecar。
- 干净 Windows 虚拟机安装、升级、卸载生命周期测试。
- Fathom 集成和通用本体平台；只保留简化语义映射与问数能力。
- Babylon 双引擎；继续使用 Three.js，WebGPU 作为重要但可回退的后端。
- UE5 接入；Unity 仍保留为高价值外部资源与运行时桥接。
- 移动端、完整 PLM、完整 OLP、认证级人体工效和厂商控制器矩阵。
- 低价值格式和无法提供可靠证据的格式适配。

## 5. 上一轮全部有效工作流

过去 12 小时主线程本身只有 3 条用户消息和 7 条助手状态消息；主要开发发生在以下 10 个并行工作流中。其最终结果已合入 `946e7a9`，不是仅存在于聊天摘要中。

| 工作流 | 状态 | 关键结果 |
|---|---|---|
| 文档中心与离线依赖 | 已完成 | 15 篇离线指南；三栏搜索/目录/页内导航；npm 固定版本、本地 JS、外链缓存、引用保护和离线状态；聚焦测试 17/17 |
| UI 深度验收 | 已完成 | 修复流程默认态、拓扑画布、3D 侧栏、脚本依赖焦点与字号；四个编辑器面板可收起；在线页面和响应式审计无错误 |
| AI 脚本集成 | 已完成 | 统一生成/解释/诊断/工业 Agent；`studio.ai.invoke`；对象上下文；Worker 能力隔离与降级；相关测试 79 项通过 |
| 脚本 Git 后端 | 已完成 | 只允许脚本清单与脚本文件；状态、历史、提交、远端、拉取、推送；快进和越界保护；测试 6/6 |
| 脚本 Git 前端 | 已完成 | 拉取差异二次确认、失败恢复、草稿阻断、本地降级、焦点和窄屏；聚焦测试 38 项通过 |
| 发布交付审计 | 已完成 | 修复只读场景构建覆盖普通 Web `dist` 的并发缺陷；隔离构建、路径安全、Web/云渲染/客户端测试通过 |
| Windows 安装包 | 已完成 | 重新生成 NSIS、MSI 和桌面主程序；包内资源与元数据验证通过；未做数字签名和已排除的干净虚拟机测试 |
| 文档收口 | 已完成 | 行为脚本、发布、桌面、主计划、最终闭环和发布证据文档更新 |
| 品牌风险修复 | 已完成 | 用户可见品牌统一为 Deep Monkey Studio；强化品牌门禁；重建 Unity 离线包并增加源码一致性门禁 |
| 最终提交审计 | 已完成 | 两次独立审计确认无 P0/P1/P2 阻断、无敏感文件或生成物、所有源文件不超过 800 行，可安全完整提交 |

## 6. 当前功能进度

| 领域 | 状态 | 已交付结果 |
|---|---|---|
| 2D 编辑器 | 已完成本轮 | 页面/组件/图层任务分组、商业化资源面板、超宽画布自动聚焦、可收起面板、数据/参数/联动/下钻和刷新恢复；参考线、画布与其它元素边缘/中心吸附、动态对齐线和 Alt 临时绕过吸附均已验证 |
| 3D 编辑器 | 已完成 | 单层场景对象、上下文检查器、灯光/相机/模型/标签/材质/动画/分析工具、脚本控制和工作区切换 |
| 脚本编辑器 | 已完成 | 多文件、Monaco、原生 JS/Three.js、受控 React 扩展、离线依赖、AI、调试、错误定位、保存恢复、脚本 Git |
| 拓扑编辑器 | 已完成 | 节点、连线、属性、状态、保存恢复、插入看板、响应式与面板收起 |
| AI | 已完成本轮 | 插件式 Provider/能力、AskData、脚本 AI、工业 Agent、确认/撤销/证据和失败降级 |
| 工业闭环 | 已完成本轮 | Plant Lite、PPR/BOP、轻量工位验证、物流方案、设备诊断、虚拟调试、统一 Study 与证据链 |
| 素材与模板 | 已完成本轮 | 156 个 2D 预设、120 个商业模板、78 个 3D 工业预制体、12 套 HDRI、16 套 PBR；外部资产按质量门禁隔离 |
| 数据与运维 | 已完成本轮 | 多类数据源、连接/预览/字段、数据管道、弱网重试、PostgreSQL/MinIO、生产检查、备份与沙箱恢复；Windows/Linux 统一 Node 启停、状态检查与部署入口已闭环 |
| 发布交付 | 已完成本轮 | WebGL、WebGPU 优先回退、云渲染、Windows 只读场景客户端；发布工具栏和离线资源边界 |
| Unity | 已完成本轮 | 版本化 WebGL Bridge、manifest、uGUI/对象/相机/灯光/属性/动作/事件双向控制及离线包一致性 |
| 文档与品牌 | 已完成 | 离线文档中心、开发/部署说明、去竞品品牌门禁、第三方依赖清单 |

## 7. 最终验证证据

功能基线提交 `946e7a9` 包含 720 个文件变更、50,584 行新增和 5,318 行删除。本轮统一入口、2D 吸附与 Deep Monkey Studio 品牌收口后，在最终工作树再次执行等价完整门禁，结果为成功：

- 21 个可检查工作区类型检查通过。
- 1,628 个源文件全部不超过 800 行，无豁免。
- 2,095 项测试全部通过：API 410、Web 1,104，其余根入口、包与桌面端 581。
- 全仓生产构建、API 导入 smoke 和包体预算通过。
- Unity 离线包与源码一致性 3/3 通过。
- 品牌隔离测试和正式产物扫描通过。
- 素材/材质闭环通过：目录治理、导入、3D 应用、保存和刷新恢复。
- 数据中心闭环通过：创建连接、连接测试、数据集预览、管道运行、接口发布和调用。
- 浏览器产品门禁通过：3 个 2D 视口、WebGL 3D 和 WebGPU 验证。
- 在线闭环通过：登录、项目、2D、模型上传、3D 加载、保存、刷新恢复、浏览、发布和公开读取。
- 统一入口真实完成 API 启动、检查、重启和停止；Web 与 Windows 客户端生命周期在同一入口下完成验证。受 Codex 沙箱限制，Windows 进程树关闭需在沙箱外执行，真实系统调用已通过。
- 启动/停止/重启具备跨进程锁、PID 身份与启动时间校验；生产状态识别、自定义端口、Windows Node 绝对路径和 Linux 进程组清理均已补齐。

最新 Windows 产物：

| 产物 | 大小 | SHA-256 | 签名 |
|---|---:|---|---|
| `Deep Monkey Studio_0.1.0_x64-setup.exe` | 16.59 MiB | `12FE389FC4B31D3FE98565BF5289CE47B90B5B4913F64295175E752C4AEEFA5F` | 未签名 |
| `Deep Monkey Studio_0.1.0_x64_zh-CN.msi` | 17.41 MiB | `EAAACA7089533F9FCB6B5DB4E147FE919534EEC36E303C1104D05A9A55F1AAA1` | 未签名 |
| `bim-studio-desktop.exe` | 23.19 MiB | `3EFEC919FB7778AE08AC1478CDBEDB23ACF6DBC969A482DF1802C66A33BB281A` | 未签名 |

浏览器门禁报告位于 `test-output/product-browser/report.json` 和 `test-output/online-flow/report.json`。这些目录由测试生成且不提交 Git。

## 8. 当前待办与诚实边界

### 8.1 本轮待办

2026-09-04 冻结的五项收口任务均已实现并通过门禁：跨平台唯一入口、原生生产部署、2D 商业吸附、完整发布验证、Deep Monkey Studio 品牌与安装包。当前没有遗留的本轮代码待办；提交与远端同步状态必须以 `git status`、`git log` 和 `git rev-list --left-right --count '@{u}...HEAD'` 的实际结果为准，不能只相信本文件。

### 8.2 项目级后验收

以下不是本轮代码缺陷，也不是当前提交阻断：

- 安装包尚未配置 Authenticode 证书，因此 Windows 会显示未签名发布者。
- WebView2 bootstrapper 首次安装可能需要网络。
- 真实客户模型、客户数据、目标 GPU、现场网络和长期运行稳定性需要在具体项目中验收。
- 固定工业夹具和当前机器的性能结果不能扩大为所有客户场景均达到桌面引擎性能。
- 外部缓存中的 1,551 个 GLB 没有全部进入仓库或安装包；只有满足来源与质量门禁的资源才能正式发布。

## 9. 统一启动与部署入口

首次安装依赖后，公开用法只保留 `pnpm studio`：

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start client
pnpm studio start web
pnpm studio start api
pnpm studio stop
pnpm studio restart
pnpm studio status
pnpm studio check
pnpm studio deploy --check
pnpm studio deploy
pnpm studio undeploy
```

`client` 仅支持 Windows；`web`、`api` 和生产部署支持 Windows/Linux。主机、端口、远程 API、存储模式、备份、升级、回滚和排障的从零说明见 `docs/native-deployment.md`。安装后的客户端选择“本地工作台”时，不依赖 PostgreSQL、MinIO、Node.js 或 Python。

## 10. 过去 12 小时对话恢复核验

核验窗口：2026-09-03 20:47 至 2026-09-04 09:15（Asia/Shanghai；覆盖最近 12 小时并保留交接前的连续上下文）。

已从本机主任务存档、提交、工作树和并行工作流结果恢复这一窗口内会影响交付的指令。恢复指的是把可执行决策、代码状态、证据和边界固化到本总账，不是把含系统内容与临时配置的原始日志提交进仓库。

这一窗口内的主要用户任务为：

1. 若平台提供 `gpt-6 astra`，希望切换并使用极高推理深度。当前可用模型列表没有该模型，运行中的任务不能自行热切换；不得虚报已切换。
2. 明确允许将完整提交推送到 `github.com/fatasia/bim-studio` 的 `dev-studio` 分支。
3. 要求恢复全部对话和过去 12 小时工作，提交 Git，并汇报上一轮全部进度与待办。
4. 要求说明项目如何启动和一键脚本如何使用。
5. 启动、关闭、重启必须同时覆盖 Web 与 Windows 客户端，并且不能存在多个让用户选择的入口。
6. 启动器要兼容 Linux 服务器；API 必须能单独启动，并可配置主机、端口和存储依赖。
7. 放弃公开 Windows PowerShell 启动脚本，以跨平台 Node 命令 `pnpm studio` 统一开发和生产操作。
8. 文档必须覆盖从零搭建开发环境、JSON/local 零基础设施模式、PostgreSQL/MinIO 生产模式、Windows 客户端、Linux 部署、升级、回滚、备份和排障。
9. 2D 编辑器补齐接近商业编辑器体验的参考线、其它元素和居中吸附。

同一窗口内的开发活动由第 5 节的 10 个工作流构成；其代码、测试、文档和审计结果全部可以从最终提交、当前文件和门禁报告复核。没有仅存在于口头承诺、却未进入代码或明确边界的本轮任务。

## 11. 下一次恢复检查清单

```powershell
git status --short --branch
git log -2 --oneline
git rev-list --left-right --count '@{u}...HEAD'
pnpm studio status
pnpm studio check
```

若功能代码在当前闭环提交之后发生变化，再按风险执行聚焦测试或 `pnpm verify:release`。只更新文档且 `git diff --check`、链接和范围核验通过时，不重复消耗完整浏览器门禁。

## 12. 2026-09-04 编辑器体验与登录稳定性收口

### 12.1 本轮不可回退的产品要求

- 页面、交互和代码必须按成熟商业平台质量交付，避免低级排版、空白状态、重复入口和无意义操作。
- 面板与页面中的说明性废话默认不常驻；必要帮助通过按钮标题、鼠标悬浮或上下文错误反馈提供。
- 已经反馈过的问题必须从根因修复并加回归验证，后续不得反复返工。
- 图片、视频和组件/页面背景必须支持用户直接上传本地文件。
- 整体主题可配置，并预置深色、浅色两套主题。
- Web 与 Windows 客户端都不能因公共接口 401、网络波动或短暂网关异常错误退出登录；“记住登录”在客户端重启后必须有效。

### 12.2 已完成实现

- 场景卡片收敛为高频操作加更多菜单，修正菜单与导出子菜单排版。
- 2D 工作区默认进入“页面与图层”；页面只在左侧管理，底部重复页面标签已删除；左右面板开关统一为与 3D 一致的画布边缘按钮。
- 2D 顶部工具栏去掉常驻快捷键长文和无效禁用按钮；快捷键集中到问号悬浮层；工具栏不再产生横向滚动条。
- 3D 默认背景、地面网格、坐标轴与灯光层次重新调整为深色工业视觉，避免灰白雾面底板。
- 本地恢复只在草稿与服务器版本存在真实内容差异时提示，忽略仅时间戳变化；恢复弹窗删除英文眉题和三块无意义统计卡，按钮允许紧凑换行。
- 3D 属性检查器与数据绑定重新整理字号、间距和对齐，删除常驻说明段落，将必要解释转为悬浮提示。
- 资源组件按“图表 / 控件 / 媒体 / 3D / 资源”五类组织；删除联动诊断、模板引导和点击说明等常驻提示；组件说明保留在悬浮标题中。
- 媒体分类提供“上传图片 / 上传视频”，选中图片或视频组件后也可直接上传替换；页面背景和组件背景继续共用项目资源上传链路。
- 行业模板库恢复 120 个真实模板，修复网格自动行高度塌陷；卡片固定 286px 高，并精简弹窗标题区。
- 脚本编辑器合并布局入口和次要工具，保留明确的保存按钮与自动保存开关；2D/3D 均调用同一工作区保存逻辑；分屏拖动期间禁用过渡，并由 React 状态承接最终宽度，消除闪屏和回弹。
- 发布浏览工具栏改为底部居中的紧凑横向工具条，更多功能渐进展开，不再形成高大的空白竖栏。
- 品牌设置新增深色/浅色预设，文档根节点统一应用主题，品牌预览同步展示当前主题。
- Web 鉴权改为二次复核：业务请求携带令牌并返回 401 时，不直接清空登录态；只有 `/api/auth/me` 使用同一令牌再次明确返回 401 才退出。无令牌公共请求、网络失败和 5xx 不触发退出；页面启动恢复会话遇到断网或 5xx 时保持凭据并自动重试，不再错误跳回登录页。
- Windows 客户端的“记住登录”由纯内存升级为 Windows DPAPI 当前用户加密存储；启动连接门禁会恢复令牌，退出登录和鉴权失效会同步删除加密文件。

### 12.3 验证证据

- Web 全量测试：313 个测试文件、1,105 项测试全部通过。
- 本轮 UI 聚焦测试：6 个文件、21 项测试通过；服务端 SDK：4 个文件、54 项测试通过；桌面/浏览器鉴权适配：2 个文件、9 项测试通过。
- Web、API、contracts、server-sdk 类型检查通过。
- Windows 桌面 Rust 测试 5/5 通过，其中包含 DPAPI 密文不含明文令牌、可恢复、可清除的验证。
- 源文件质量门禁：1,628 个源文件全部不超过 800 行，无豁免；`git diff --check` 通过。
- 真实浏览器验收：2D 默认“页面与图层”；重复页面栏数量为 0；工具栏 `clientWidth` 与 `scrollWidth` 均为 744，`overflow-x: visible`；无常驻快捷键长文和“联动诊断”。
- 真实浏览器验收：资源五分类均为单行，媒体分类显示两个本地上传入口；行业模板为 120 个真实卡片，首卡尺寸 276×286px，无骨架空白。
- WebGL 真实浏览器验收：1280×720 场景完整渲染 120 个对象，页面无横向溢出，深色地面与弱化网格已生效。

本节是后续继续修改编辑器时的恢复基线；不得重新引入重复页面入口、常驻说明墙、空模板骨架、仅内存的桌面“记住登录”或收到一次业务 401 就清空 Web 登录态的旧逻辑。

Zcode GLM5.3 的完整接手顺序、现有工作树边界、文件索引和验证命令已固化在 `docs/zcode-glm53-handoff-2026-09-04.md`；换模型后应先读该文档，不得从最后提交重新实现本轮改动。

## 13. 2026-09-04 夜间极致优化轮（进行中）

用户 2026-09-04 新目标：**页面、性能、交互体验优化到极致，全面对标 ThingJS/山海鲸/帆软，部分对标 Unity、西门子 PS/PD/Plant**。用户同时明确：任务持续执行不停止；用户消息不改变方向。上一轮冻结范围（第 2-11 节）已全部闭环，本轮是新的体验优化轮，仍受总计划 §28.1 范围冻结约束（只修复、补齐、验证、轻量重构，不新增功能域）。

- 执行方案：`docs/nightly-extreme-optimization-plan-2026-09-04.md`（测试面清单、对标差距→夜间检查映射、阶段 A-E 计划、GLM-5.3-Flash 决策规则与升级路径）。
- 接手基线：`821ca74 fix: polish editors and stabilize sessions`（第 3 节改动已全部提交并推送，工作树干净；交接文档 §6/§7 已同步更新）。白天已在 `821ca74` 复核交接检查全部通过：typecheck、聚焦 UI 测试 30 项、server-sdk 54 项、Rust 测试、1,628 文件行数门禁。
- 夜间执行记录、问题清单与升级清单在执行完成后回填本节；升级清单供 GLM-5.3/GPT-5.6 白天处理（18 个 >500 行组件拆分、浅色主题全量令牌化、hooks 补测试、虚拟化等性能项）。

## 14. 2026-09-04 "全面超越"新开发展轮（已立项）

用户同日决策（原话见 `docs/platform-surpass-development-plan-2026-09-04.md` 第 1 节）：数据语义层与填报/打印、素材与模板深度、ThingJS 式 SDK 生态、Unity 级性能、差异化闭环（Web 原生协作/秒级预览/数据+AI+看板一体/Study 证据链）、AI 升级，七项纳入计划。载体优先级：最高为 2D/3D/脚本编辑器与数据中心，其次为 AI 与西门子 Lite 仿真。

- 执行计划：`docs/platform-surpass-development-plan-2026-09-04.md`（批次 S1-S7、验收标准、依赖排序）。
- 执行模型：白天 GLM-5.3/GPT-5.6 出实现规格（`docs/specs/`），夜间 GLM-5.3-Flash 免费时段照规格实现；规格外问题按夜间方案 §7 三档规则。
- 该轮取代 §28.1"不再新增功能域"约束；§28 排除清单（Docker/Babylon/UE5/移动端/完整 OLP 与 PLM/认证人体工效/厂商控制器矩阵/8 小时 soak 等）继续有效，AGENTS.md 范围段已同步。
- 与第 13 节夜间优化轮并行：优化轮打磨既有体验，本轮新增能力；共用门禁，互不阻塞。
- S1 分解为夜间规格序列：S1-001 语义模型合同/持久化/CRUD（已写规格 `docs/specs/S1-001-semantic-model-contract.md`，基于 2026-09-04 数据域摸底：复用数据产品抽象/公式引擎/MetadataStore 模式/409 引用保护；缺口为语义实体、集中口径、维度层级、参数化与缓存）→ S1-002 模型编辑器 UI → S1-003 2D 按指标/维度绑定 → S1-004 同模型组件自动联动 → S1-005 维度层级钻取 → S1-006 参数级联服务端取数 → S1-007 AskData 语义认知。每完成一个规格回填其 §8 并更新本节。
- 夜间定时任务已更新为双轨：规格实现优先（编号最小待实现规格），余时跑第 13 节优化轮；规格外发现只记录不展开。
- **S1-001 已于 2026-09-04 白天由 GLM-5.3 直接实现并通过门禁**（用户指示"现在就开始做"）：合同 `packages/contracts/src/semantic.ts`、校验/字段解析 `apps/api/src/semanticModelService.ts`、CRUD `apps/api/src/semanticModelRoutes.ts`、持久化沿 ProjectRecord+MetadataStore 模式、数据集/管道删除 409 保护。api 全量 428 项（+18 新增）、contracts 166 项、api/contracts/web typecheck、1,634 文件行数门禁全部通过。规格 §8 已回填。下一个规格：EX-001（2D 画布交互，现状盘点已完成）。
- Git 纪律（2026-09-04 用户指令）：**没有用户明确允许，只允许本地 commit，严禁 push 到远端**。夜间定时任务与白天会话同守此规。
- 2026-09-04 用户追加两项：①"现在就开始做"——S1-001 已当天完成（见上）；②素材/模型/组件补量提质到行业主流、可网上下载——已产出 `docs/asset-sourcing-plan-2026-09-04.md`（数量目标：3D 3000+/HDRI 40+/PBR 60+/2D 组件 300+/模板 300+；许可红线：仅 CC0 与 CC-BY 带署名，禁 NC/SA/EULA/付费抓取；来源：Poly Haven/ambientCG/Quaternius/Kenney/Poly Pizza/Sketchfab-CC0；管线复用既有审计发布门禁，夜间无规格余时跑下载批次）。后续规格：EX-001A（已写，画布选择与操作模型）→ S3-A1 适配器骨架+Poly Haven HDRI → EX-001B/EX-002 按 `docs/editor-interaction-benchmark-2026-09-04.md` 顺序。
- **S3-A1 首轮扩容当天完成**：Poly Haven 精选清单 12→55 HDRI（运营态工厂/机房/仓储/维修/基础设施/夜景/阴天，剔废墟风）+ 16→72 PBR 材质；下载 477 文件 1.55GiB，catalog 127 资产全部 published；Kenney 开放包 14→16（+furniture/space-station，CC0）；审计单测 10/10。**HDRI 与材质数量目标已超额达成**（55/40、72/60）。剩余缺口：3D GLB 3000+（source-b 通道待建）、2D 组件 300+（S3-B 规格待写）、模板 300+（S3-C 规格待写）。
- 规格队列（按编号夜间执行）：EX-001A（画布选择操作）→ EX-001B（批量编辑图层）→ EX-002（字段拖拽绑定+数据面板）→ S1-002（语义模型编辑器）。后续待写：S3-B（2D 组件目录扩容）、S3-C（行业模板扩容）、S3-A4/A5（Poly Pizza/Sketchfab 3D 模型通道）。
- 夜间定时任务已升级为"超越轮"：23:00-09:00 整夜多轮循环（规格实现→聚焦门禁→对标检查矩阵→修复→下一轮），08:30 收尾回归+总账+**本地提交（严禁 push）**。

## 15. 2026-09-04 用户反馈批次一（UF-001，修复中）

用户实测反馈 9 项（原话见 `docs/specs/UF-001-user-feedback-batch-1.md`，含两张截图证据：发布页排版错乱、场景卡片页）：

1. 仿真功能并入 3D 编辑器插件面板 [设→已完成设计：`docs/specs/SIM-001-simulation-in-editor-design.md`，参照西门子 PS 单工作台模型：仿真实体入左侧树（路径/碰撞对/队列/信号映射随场景保存）、上下文检查器、工具坞"仿真与开发"组挂载、时间线统一播放、结果覆盖层、Study 链路不变、/operations 转型为证据工作台；分四期 SIM-1a~1d]
2. 动画时间线帧图标过大 [修]
3. 多页面"更多"点击无效 [查]
4. 模型优化页能力回退，定位=导入/转换/压缩/优化一体，需恢复 [查→恢复]
5. 资源页卡片"导入"按钮无意义应为浏览；2D 资源/工业预制体/模板缩略图不对 [缩略图=修，交互=设→RES-001]
6. （并入 5）
7. 模型优化与资源页逻辑整合 [设→并入 RES-001]
8. 数据中心：运行监控位置不对 [修]；管道/接口两页不完善复杂 [设→并入 EX-007]；高级接入白屏 [查]
9. 3D 编辑器缩小滚动反复跳 [查]；发布页排版完全错误+介绍文字改悬浮 [修]；云渲染一键开启+全局默认 [设→CLOUD-001]；场景卡片缩略图默认截取最后保存画面 [修]；docs 太简单 [设→并入 S3-C]；场景卡"更多"项放回主卡图标展示 [修，覆盖 821ca74 精简决策，以本次反馈为准]

夜间执行顺序：UF-001 [修] 项最优先（U1-2→U1-3→U1-9b→U1-9d→U1-9f→U1-8a→U1-8c→U1-4→U1-9a），[设] 项白天出规格：SIM-001、RES-001（含 U1-5/6/7）、CLOUD-001、EX-007 补充、S3-C 文档线。每个 [修] 项必须根因修复+聚焦测试+浏览器截图，禁止表面修补。

### 15.1 AI 批次立项（2026-09-04 用户指令）

用户指令：AI 模块能力提升与交互流程提升纳入任务；预测维护对标先导智能，其余对标市面主流平台。已产出 `docs/specs/AI-UP-ai-capability-interaction-plan.md`：AI-1 统一 AI 工作台（全站侧边栏/流式+步骤可见/澄清选项/上下文芯片/能力路由/会话）→ AI-2 预测维护对标先导（健康评分/趋势 RUL/维护建议→工单→通知→复检对比闭环/OEE 三率与停机归因，全部带证据指纹入 Study）→ AI-3 看板生成资产化（落盘可迭代）→ AI-4 脚本会话化+3D 场景生成 → AI-5 评测集门禁。能力基线全量保留（不因交互轻量而削减），交互对标 FineChatBI/Copilot 类主流规律。排序：AI-1 规格先出，实现排在 S1-002 之后、AI-2 紧随（用户点名重头）。

### 15.2 UF-001 执行进度

- U1-2 ✅ 时间线关键帧图标 7px+命中区（30005ab）
- U1-9b ✅ 发布弹窗紧凑重排+描述转悬浮（1dd82f6，双主题截图待夜间补）
- U1-9f ✅ 场景卡片恢复复制/重命名/版本历史图标直达（210606c）
- SIM-001 设计定稿（8d875a4，交互=Visual Components 快速通道，能力=全量同级）
- 定时任务已调至每日 21:00 启动、08:30 收尾、严禁 push
- 待夜间：U1-3（更多点击无效）、U1-9a（编辑器缩放滚动跳）、U1-9d（场景缩略图截取）、U1-8a/c（数据中心监控位置/Node-RED 白屏）；**U1-4 已由 Codex 会话完成**（见 15.3/交接文件，勿重做）；待白天规格：RES-001、CLOUD-001、AI-1 规格
- 2026-09-04 晚间整合（Codex 交接入库）：① 交接文件 `docs/codex-glm53-handoff-2026-09-04.md` 纳入夜间必读，SIM-0 完成、下一直接任务 **SIM-1a**（交接 §6：场景域合同+持久化测试→场景树实体→引擎无关覆盖层；仿真瞬态不混入 SceneSnapshot）；② SemaPLC 价值判断已有结论（虚拟调试闭环补强 SIM-1c 与 Study 证据链，未来 PLC validation adapter；MIT 核心含 GPL/LGPL 组件，只借鉴架构不复制二进制）——夜间**不重做**该评估；③ astral-service（RVT→glTF/DWG→DXF 转换器实现，克隆在 `D:\Temp\astral-service-analysis`）分析因日间用量上限中断，转夜间低优先续做：只提炼可借鉴点（转换状态机/属性注入约定/Worker 渲染），不改产品代码；④ 夜间任务允许直接联网下载（素材同步、开源仓库克隆、文档抓取），遵守许可红线。
- 2026-09-04 用户追加：2D/3D/脚本编辑器、素材模板、数据中台的**交互逻辑**不达标，学习 ThingJS/山海鲸/帆软。已产出交互对标研究与采用设计（`docs/editor-interaction-benchmark-2026-09-04.md`，基于三家官方文档抓取：FVS 组件操作/事件-动作模型、FineBI 默认联动/依赖字段/条件语义、山海鲸拖拽槽位绑定/两级数据模型/回收站），拆为 EX-001~EX-007 批次并插队：S1-001 之后先 EX-001/002/003，S1-002/003 按 EX 新交互实现。规格按此顺序由白天模型编写。

### 15.3 用户截图反馈批次二（UI-002，已完成）

- 仿真插件面板改为紧凑的可移动、可缩放工具窗，布局始终约束在 3D 工作区并本地记忆；采用 Siemens Process Simulate“中心视口 + 可重排工具窗”的工作台原则，不照搬其传统 Ribbon 外观。
- 发布弹窗仅常驻 `WebGL / WebGPU / 云渲染`、`高画质 / 极速模式`、`显示 / 隐藏` 三组核心决策；其余兼容性、回退与诊断说明按悬浮显示，“发布不会覆盖草稿”保持单行。
- 场景卡片导出项改为在窄“更多”菜单内展开，修复按钮通用样式覆盖造成的中文竖排和二级浮窗越界。
- 聚焦测试 4/4、Web 全量测试 1,111/1,111、全仓类型检查、1,645 个源文件尺寸门禁、Web 生产构建和真实浏览器视觉检查均通过；完整证据与接手说明见 `docs/codex-glm53-handoff-2026-09-04.md`。

### 15.4 2026-09-05 用户反馈批次三（UF-002，执行中）

已修：顶栏重复面包屑+场景对象间距（24fe51f）；2D 框选恢复=空白拖拽相交命中+Shift/Ctrl 加选+导入面板说明墙删除（3099c02，功能经事件追踪证实 4/4，但 u112b 脚本偶发假阴性待查）。
**待办队列（按序，9 点后继续不停）**：① 2D 编辑器布局回退：页面 tab 放回底部、图层在左侧（用户明确否定 821ca74 的"页面与图层"合并决策，以本次为准）；② <30% 缩放抖动复现与修复；③ 页面与图层支持右键菜单+双击内联重命名（弃弹窗，对标 FVS/Figma）；④ U1-8a 数据中心监控位置；⑤ U1-8c Node-RED 白屏；⑥ SIM-1a（交接 §6）；⑦ EX-001A 剩余（Alt 拖拽复制、右键选层）；⑧ astral-service 分析（克隆在 D:\Temp\astral-service-analysis）。纪律：严禁 push；admin/admin 与存储拓扑禁改；大改先请示；每修必带聚焦测试+浏览器证据+整页目视。

- 素材 3D 通道阻塞：Poly Pizza/Sketchfab API key 需用户本人注册（邮箱验证+条款），已告知用户；用户给 key 后夜间跑批量下载。期间转 Quaternius/Kenney 无 key 直链通道（全部 CC0）：下一批先抓 quaternius.com 工业相关包直链并入 `scripts/sync-open-asset-packs.mjs`。

- 素材 3D 通道就绪（2026-09-05）：用户已提供 Poly Pizza/Sketchfab key，存于 `data/external-assets/source-b/api-keys.env`（gitignored，值不入日志）。实测：Sketchfab API 200 可用（token 认证通过，search+downloadable 可用）；Poly Pizza 本地网络不通（HTTP 000，与 quaternius.com 同为网络层超时，备用）。下一批任务：新建 `scripts/sync-sketchfab-models.mjs`——按行业关键词（pump/valve/conveyor/industrial/warehouse/forklift/AGV/robot 等）search downloadable=true，许可过滤 CC0/CC-BY（BY 记 attribution），经 download 端点取 GLB+缩略图入 source-b，写 catalog 后跑既有审计门禁；每轮限额（如 200 模型/晚）。

- **Sketchfab 通道首批完成（2026-09-05）**：`scripts/sync-sketchfab-models.mjs`（已提交）实测通过——license 字段为 {uid,label}，过滤规则=允许 CC0 与 "CC Attribution"（CC-BY，记 attribution），NC/SA 拒绝；首批 5 轮下载 31 个工业模型（pump/valve/conveyor/electrical/warehouse 等，169MiB，GLB 文件头校验有效，catalog `data/external-assets/source-b/catalog.json` 全部 review-required 待审计）。注意：约 1/6 结果无 .glb（仅 glTF zip）被跳过，后续可加 zip 解包。持续推进方式：每夜无规格余时跑 `node scripts/sync-sketchfab-models.mjs --per-keyword=8 --keywords=<轮换关键词>`（幂等，catalog 去重），旋转关键词直至 3000+。

- U1-8a 排查记录：监控面板 `data-connector-health-panel` 渲染在全部连接卡之后（DataCenter.tsx:395，列表 343）导致选中与监控脱节。修复方向=面板上移至 `data-card-list` 之前；脚本移动未命中标记，下一会话手工编辑完成（约 30 行块整体迁移），随后浏览器截图验证。

- U1-10 补充（<30% 抖动）：画布滚动条常驻 `overflow:scroll`（滚动条明灭根除，实测普通滚轮 0 反转）；Ctrl+滚轮缩放路径的 <30% 专项复现待下一窗口（Playwright wheel 无修饰键参数，需 keyboard.down 组合）。

- 素材进度：Sketchfab 第 5 批 +57（阀门/法兰/风机/电梯机房/托辊等），catalog **138 个模型**（约 1/3 无 .glb 被跳过，后续加 zip 解包可再提升产出）。下载通道稳定，夜间自动轮换关键词。

- **U1-10 <30% 抖动终验通过**：Ctrl+滚轮缩至下限全程 14 秒逐帧采样，scrollLeft 0 次方向反转（单次单调写入 0→30），滚动完全稳定。修复组合=自动 fit 防抖+等值零写入+滚动条常驻。U1-10 整体关闭。

- 素材下载限速判断（2026-09-05）：大批量运行时 Sketchfab 服务端限流/每日下载配额可能触顶（60s 无新增 GLB，脚本含 429 退避会自动等待恢复）。脚本幂等可重入，配额恢复后每次运行自动续传——夜间循环持续补量即可，无需人工干预。当前落地：主库 164 GLB + 三路并行批次产出入库后合并（uid 去重）。stdout 管道缓冲导致后台运行时中间日志不可见属正常，结果以 catalog.json 为准。

- 2026-09-05 用户指令：下载暂停（catalog 164 个保持），集中做剩余 5 项+全量测试。队列：① SIM-1a 场景树仿真域渲染+检查器挂载 ② 覆盖层 ③ U1-8a 双主题截图补档 ④ EX-001A Alt 拖拽复制+右键选层 ⑤ S3-B/S3-C 规格；全量测试=Web 全量+全部路由巡检（u117 脚本已备）。

- EX-001A Alt拖拽复制实现方案（下一窗口照做）：① `pasteCopiedNodes`（controller:217）改为返回新建节点 id 数组；② `DashboardCanvasNode.tsx` 移动手柄（314 行 onPointerDown→onTransformStart(event,"move")）前置判断：event.altKey 时先调 copy+paste（偏移 0），用返回的首个新 id 构造合成 pointer 事件参数继续 onTransformStart；③ 拖动事务与手柄解耦（beginNodeTransform 接受 nodeId 参数而非从 DOM 读），避免粘贴后 React 重渲染打断手势；④ 回归：DashboardWorkspace.test.tsx 加 Alt+拖拽副本断言。已确认 Ctrl+D 复制已存在（508-513），Alt 拖拽是补充交互。

### 15.5 2026-09-05 Codex 接手复核与持续优化

本节覆盖 §15.4 中已经过时的待建描述：GLM 的 `b1b2222` 交接及此前提交为基线，必须先查当前代码，不能重新实现已提交的 Alt 拖拽/右键选层、语义合同或 SIM 场景树。

- 用户更新：Codex 在本任务范围内直接改，不需逐项请示；仅本地提交、严禁 push，admin/admin、PostgreSQL+MinIO 拓扑及原数据不动。用户飞行期间继续执行，并增量复核 GLM 测试输出。
- **已完成**：SIM 仿真实体 controller 直连、快照保存/并发返回合并/导入引用迁移、检查器编辑删除、静态路径与 flowLink 覆盖层及关闭清理。专用 QA 场景保存→刷新恢复已实测；不代表完整 SIM-1a 运行闭环完成。
- **已完成**：2D 页面仅底部、图层左侧；框选使用实际 artboard 坐标；Ctrl+滚轮 passive:false；确定性浏览器门禁四组合通过，10%→11% 60 帧无漂移。
- **已完成**：UI 报告确认项的加载反馈、菜单/AI Esc、搜索上下文、登录 502 指引、窄屏导航、连接名称/监控、局部主题与优化器禁用态、datetime/ANSI 清理；旧发布快照兼容读取与保留、版本错误/重试。未复现与已修项分开记录，未覆盖 GLM 原报告。
- **已完成**：SemaPLC/Astral3D/astral-service 分析与 S3-B/S3-C 规格。Astral Revit 配置处于注释状态，不能宣称已获得可用 RVT 解析器；300+ 数量是待实现目标。
- **本轮待办**：以 `docs/ui-report-recheck-2026-09-05.md` 的 33 项复核表和 `docs/codex-glm53-handoff-2026-09-05.md` §4 为直接队列。优先 Agent 数据集缺失/AI 取消生命周期、四仿真面板深测、SIM 源汇/队列到运行/覆盖层/Study/统一时间线、拓扑交互、素材深度与大文件职责拆分。
- **明确排除**：继承 §28；外部素材下载暂停 164 GLB，不因定时续跑恢复下载；不做工业格式真实转换/Revit/Docker/完整 OLP/认证动力学或 8 小时 WebGPU soak。
- **项目级后验收**：任意客户格式/规模/仿真正确性矩阵及开发完成后的统一全站、性能、稳定性、故障注入与发布回滚。不把固定夹具测试扩成“全面超过行业平台”。
- 验证：2026-09-05 10:47 全仓 typecheck、`pnpm -r test` 通过（Web 320 文件/1127 测试，API 110 文件/434 测试）；源文件 1704 个均 ≤800；10:55 Web 全量再次 1127/1127。新增门禁、最新构建及截图结论继续回填交接 §7。
- 产物：`test-output/codex-2026-09-05/`；权威交接 `docs/codex-glm53-handoff-2026-09-05.md`，分析 `docs/semaplc-astral-value-analysis-2026-09-05.md`。GLM 原报告截至 10:01:16 共 33 条（其中重复与未复现项已标出）。本任务 heartbeat 每 30 分钟检查新增项，飞行检查窗口到 15:00；无新项时继续上述队列。
- 收口增补：四仿真面板 32 组基础布局/折叠检查通过；根启动/CLI 测试 16/16；Web 及依赖生产构建通过，首屏 JS 304.8 KiB / gzip 99.0 KiB，11 chunk。单独 Web 构建的首次缺失导出来自旧 contracts dist，依赖顺序构建后通过；既有外部化/大 chunk 构建提示未抹掉，详见交接 §7。
- **已完成（12:00 接续）**：Agent 服务端项目数据目录发现（P2-11 根因）、上下文有界/隔离与工具描述；普通 AI 的 BIM 准备、SQL 两阶段、流式读取取消及后续草稿保护；服务器响应断开传播到提供方，不再只取消界面。Web 1136/API 448 测试、真实 HTTP 取消与双主题双宽度 AI 浏览器门禁通过；完整记录与真实 504 证据见交接 §8。
- **本轮待办（更新）**：Agent 多候选选择卡片/续答、可重试决策失败的受控恢复、跨项目异步返回；原问题实测已校验查询计划，但后续上游模型 HTTP 504，不能标记在线风险诊断已完成。仿真、拓扑、素材等其余队列不变。
- 增量协作：已读 GLM `0d49388` 素材统计补记，无新增 UI 报告项，不恢复暂停下载。仅本地提交、固定账户/存储/原场景不变。
- 12:04 门禁：Web/API 生产构建通过，首屏 JS 304.8 KiB / gzip 99.0 KiB 未回退；1715 源文件尺寸与 diff 检查通过。旧构建 externalization/大 chunk 提示不因本轮通过而视为已消除。
- **用户最新要求（12:51）**：GLM 全部测试完成，Codex 整体修复并整体重新检查；当前最终报告仍 33 条，继续以逐项复核表区分真缺陷/误报/已修，不重新建设已有修复。
- **已完成（12:55 接续）**：拓扑 P3-2/P3-3：投影边界 fit/中心缩放/空态首节点、手动视角保留、无保存副作用；运行态待数据/未知/离线分离与 unknown 适配修正、局部亮色令牌。四组真实浏览器原项目只读和内存拖拽/撤销/负投影/切文档通过，证据及完整限制见交接 §9。下一任务为报告剩余项和全站整体重测，不是项目已结束。
- **已完成（13:38 接续）**：最终 UI 报告 32/33 条已修或复核，剩 P2-5 生产冷加载。新增四组浏览器门禁覆盖长名称/复制权限拒绝与恢复/真实拓扑预览/主 CTA/健康键盘诊断/真实日志/能耗布局/480 AI 芯片/404 提示。额外修复运营页挂载误同步维护模型、设置和 Study 亮色、运营导航旧预留与 CSV 裁切。首次误同步已如实记录于交接 §10，未声称零维护记录影响；后续门禁主动拦截非预期写请求。
- 本机全服务复核：MediaMTX 已按原配置恢复；Node-RED 锁定依赖缺文件已按官方包 integrity 核验补齐，仍需实际节点/iframe/桥链路验证。没有改 admin/admin、存储拓扑、旧场景或恢复模型下载。13:38 全仓测试/最终构建复跑中；交接 §10 为恢复入口。
- 13:40：全仓测试通过（Web 1148/API 448/contracts 170 等）、最终 Web 生产构建通过，首屏预算不变。Node-RED Started flows 后发现 TDengine finalize 裸 await 语法错误、OPC UA 的 @peculiar/utils 依赖声明缺失；当前优先修正这两个额外真问题，再做 iframe/桥链路与 P2-5，不能只看监听端口。
- **已完成（14:15 接续）**：33 条报告范围全部修复或复核关闭。P2-5 增补预览/发布场景读取进度、错误与重试、零外部模型 ready；生产双主题小场景禁缓存 ready 393–954ms，接口延迟/503/重试与 HTML 先于 JS 的状态均通过。不是大模型/全项目验收，精确条件见交接 §11。
- Node-RED 全服务真实检查已通过四组合：修 TDengine finalize 编译/清理，恢复锁定包缺文件，健康接口走统一鉴权（原 401 被误判 offline），状态/复制失败反馈与主题。未部署流程/触发真实工业数据库。MediaMTX、Web/API/Postgres/MinIO 拓扑未改；尚未声称所有设备消息端到端验证。
- 14:14 全仓测试通过（Web 1155、API 448 等）、Web 构建/类型通过，首屏 304.7 KiB / gzip 98.9 KiB。WebGL 发布免除无用 WebGPU 探测；首次 ANGLE X4122 上游精度警告保留证据，不宣称所有浏览器警告归零。当前主线接续按交接 §4，仿真运行与 Agent 恢复仍为本轮待办。
- **已完成（后续修复批次）**：SIM 旧闭包 revision/history 防护、跨 tab/折叠状态保留；Agent 跨项目/取消后迟到响应与重复操作；API audit 关闭写入竞态；环境面板隐式网格列/竖排名称/标题压缩、980 工具菜单无可访问名称、Agent 亮色样式。详细限制与截图见交接 §12；504 恢复、停靠与 SIM-1a 完整运行仍待办。
- 验证更新：全仓测试通过（Web 1156/API 449 等），最新 Web 全量 1156、根 typecheck、生产构建及 artifact 门禁通过；四面板 32 组和 UI/Agent/环境/状态保留等双主题双宽度真实门禁通过。1739 源文件无 >800，60 文件 >500；不再沿用旧 18 文件扫描口径。
- **用户最新方案授权**：按 `quality-acceptance-gap-review-2026-09-05.md` 六阶段一次推进，数据/2D→模型素材→仿真→性能/结构→行业深度与整体后验收；每批验证并本地提交。GPT/GPT-6 接入不做，外部下载暂停 164 GLB。GLM heartbeat 与旧夜间 cron 已 PAUSED，覆盖上文历史“自动续跑”状态；当前普通任务继续。
- **已完成（EX-002）**：字段面板/类型槽位/计算字段/管道预览与重试、拖放/键盘/单步撤销/解绑；检查器按来源、分析角色、报表拆分至 290 行。四组真实浏览器与隔离生产数据→保存→刷新→发布匿名读取→草稿隔离通过；完整索引交接 §13、EX-002 规格。下一直接任务 S1-002，不重复建设本批。
- **已完成（S1-002）**：语义模型定义编辑/CRUD、源切换失效提示、管道真实预览、未保存保护；修复数据中心非默认项目刷新失去身份。四组合生产浏览器、Web 1179、根类型/1773 源文件/生产构建通过，交接 §14。
- **本轮待办（用户追加优先）**：脚本/3D/2D 统一体验；预览和发布生命周期自动挂载，手动播放仅用于作者试运行；先补运行模型，再处理快捷键、日志、保存反馈和真调试，方案 `editor-workflow-refinement-2026-09-05.md`。六阶段其他待办不取消，禁止将全量测试通过当作全项目完成。
- **用户最新决策**：所有此前问题都继续，不限编辑器；允许直接补充缺少的素材/模板，必须核验许可及真实缩略图。这条授权覆盖上文“外部下载暂停164 GLB”，不恢复暂停的定时任务。GPT 接入仍暂停。编辑器以 ThingJS 工作流为主、Unity 补充；文件栏缩窄可收起、挂载选择单行；几百行代码按职责提高可维护性，不机械拆行。
- **已完成（编辑器增量）**：浏览预览自动生命周期与私有运行状态、视口就绪后挂载/退出清理、快捷键最新草稿、保存失败重试、完整日志筛选/结构化数据/源码定位、单行目标/152px文件栏/窄窗与亮色根因修复。`script-editor-Fxb4X8` 与 `script-playback-GWxuU2` 各四组合真实浏览器通过；后者13/13 Worker关闭、零作者PUT，1条已知ANGLE X4122驱动诊断单列。详细证据/剩余边界见交接§15。
- **本轮待办（持续）**：正式发布自动运行、作者试运行隔离/运行范围、真调试和跨编辑器联动；语义消费/联动钻取、模型优化全流水线、有效素材模板、SIM真实运行/覆盖层/Study、Agent恢复、16.7ms性能及全仓职责治理。不得把上述已完成增量误报为“所有问题已做好”。
- **已完成（用户配色复核）**：首张亮色截图确有深浅混搭和品牌强调不同步，已修工作区/面包屑/标尺/工具栏及状态色；保留用户画布内容色。`script-editor-Fxb4X8`四组合及实际文字对比度、公共UI `report-final`四组合、Web1190项均通过；交接§15记录漏检根因与当前权威截图。
- **已完成（结构独立批次）**：§15功能先提交`d1c68ac`；纯重构将ProfessionalCodeEditor664→341，服务/类型声明/降级边界独立。原聚焦15项、全仓pnpm test（Web1190/API449及其余包）、根typecheck/构建通过；`script-editor-ljfIQ0`四组合与前一批布局/颜色测量相同，首屏305.3KiB/gzip99.1KiB不变。1793源文件58个>500、零>800；全仓职责治理未完成，下一作者运行控制器及原六阶段见交接§16。
- **已完成（草稿边界）**：真实复现并修复画布点选切脚本丢稿，统一新建/导入/文件切换保护，保存回声保留后续编辑，迟到反馈不跨文件。Web1194/构建、`script-drafts-F8is4b`和相邻`script-editor-1EZHD0`各四组合通过；下一补已复制却无前端的`/apps/:id`公开应用运行页，详见交接§17。其它六阶段待办保留。
- **已完成（EX-004）**：`/apps/:id`只读发布运行、版本依赖授权/历史文件保留、自动生命周期/3D挂载/键盘联动/筛选/导航、撤回与503重试、发布草稿隔离；四组合 `published-application-rbGKnK` 每组8/8 Worker释放、0匿名写和私有接口请求。相邻预览/脚本门禁均4组通过，全仓测试/类型/构建通过；完整证据和明确未启用的匿名数据/AI/旧脚本边界见交接§18，不以当前闭环代替全项目完成。
- **已完成（ASSET-001下载前置）**：原子下载、实际字节/GLB/PNG/许可详情、目录锁与坏目录拒绝、准确计数，素材聚焦24项通过；真实新增2个CC-BY-4.0模型，164→166。**仍未入统一素材库**，保持review-required，后续真实渲染/准确缩略图/署名随导入与交付、目录适配及模型优化闭环见交接§19。原六阶段和作者调试任务不取消。
- **已完成（ASSET-001入库，覆盖上一条缓存状态）**：新增2项真实WebGL审核并接入统一素材库，正常API4100已核实；原164项仍待审，原GLB不改。修导入哈希/待审绕过/6并发重复、资源页刷新身份/精选筛选/跨项目迟到响应、亮色对比度和干净预览图下载。`source-b-library-pUMxr4`四组合通过，暗5.53/亮4.56，原文件哈希/署名/转换/恢复/503/迟到响应均验证。交接§20和ASSET-001为新恢复点；优化另存/交付署名、模型回场景、作者调试、语义消费、SIM/AI/性能等仍本轮待办。
- **接手续更**：用户已要求能并行尽量并行及用量不足提前留档，当前首读`NEXT-AGENT-START-HERE-2026-09-05.md`（检查点提交84ca27c）与交接§21。Agent选择恢复已提交0967ef6；优化器可靠性/追溯和作者隔离有最终四组证据但源码仍待集成提交。语义查询浮层补丁、SIM-1a、公开署名与ASSET-002无缝模型工作流正在接线/最后验收。23:20全仓API492通过、Web1240通过/1架构失败已根因修并13项聚焦通过，不能写成全仓已绿。所有剩余门槛在新检查点逐项保留，不重复建设、不回退并行改动。

### 15.6 2026-09-06 并行修补与功能推进

2026-09-07 r30阶段增量：生产模板可编辑示例→整组修改→筛选→保存刷新→CSV→匿名发布已验证。Web405文件1634测试、Contracts20文件201测试、Web build通过；两轮浏览器 `dashboard-samples-MkpwSQ` 4/4。详见 `dashboard-sample-verification-2026-09-07.md`，原120模板数不变、未完成完整行业包/填报写回，不冒充全项目完成。

2026-09-07 最新用户再次排序（覆盖下方历史顺序）：先做最近七项清单中的 **2 素材/行业模板 → 3 填报/打印/导出 → 6 仿真与 AI**，随后 **1 第三轮 V3 报告修复 → 4 UI 整体收尾 → 5 Vapor 方案 → 7 全量测试/对标/交接/本地提交**。开发中的聚焦测试与必要 UI 验证照常执行，不等同于提前展开全站 UI 专项。协作不做；恢复/SDK仅必要修补；统一语义/公开数据治理仍暂停。V3 与 Vapor 原文已完整阅读，纳入后续队列，未证实项不直接定性为缺陷。已在工作区完成但尚未浏览器验收的 V3-P2 场景回写字段剥离修补保留，不抢占当前主线。

后续模板/打印/素材批次：模板空态/键盘隔离、结构预览、A4打印及优化器八角点取景修补；164旧模型官方许可和结构证据补齐，source-b166缓存/3审核入库/163待视觉审查。完整证据和未完成项见 `template-print-assets-verification-2026-09-07.md`。不是300模板/十行业包/填报全链路已经完成。

2026-09-07 用户最新缩围优先于以下历史顺序：主做交互收尾、素材/模板、填报/打印等原功能；**协作明确排除**。恢复和SDK只修影响正常使用或上述主任务的必要问题，不展开备份演练和插件生态。此前暂停的统一语义/公开数据治理、专项性能/长文件治理仍暂停。具体恢复点见接续检查点“用户最新范围”。

2026-09-07 r19：Vision/2D 检查器/左侧页签/全局工具按钮同族主题缺陷已修；Web401文件1615测试、Web build、根typecheck及2043源文件体量通过。两轮真实浏览器 `workspace-themes-5dc7aC`4/4、相邻Esc `dialog-escape-wvf2hh`4/4，图片源上传与480/800表单实测；准确边界及十维自检见 `workspace-theme-verification-2026-09-07.md`。完整焦点/2D组件属性窄窗仍本轮待办，不宣称全站完成。仿真和AI保持最后；GLM新写的shader/vapor候选方案不自动升级为当前实现任务。

用户最新排序：先推进UI/交互、恢复兼容、SDK插件跨项目与素材/模板，仿真和AI最后做；原第3/6项暂停不变。本批机器人/脚本真调试/独立模型/SDK样例及研究已本地提交 `f3c624e`，严禁push。随后r17空集合恢复误报修补通过：Web400文件1613项/build/typecheck、2041源文件体量；两轮恢复4/4、相邻Esc4/4，见 `recovery-collections-verification-2026-09-06.md`；不把r16机器人证据说成r17全站复跑。

最新追加（r16）：脚本真调试、模型独立实例/保引用替换、SDK文档样例已完成限定两轮真实浏览器验证；URDF原包→素材/压缩→独立姿态→保存/2D/公开，以及ROS1/2显式会话接入也已通过限定集成验证。r15根build/test、r16 Web400文件1606测试/build、根typecheck/2040源文件体量通过。准确构建与两轮截图见 `robot-integration-verification-2026-09-06.md` 和接续检查点；不是实机/认证动力学或全项目最终验收。uni-app X评估已落档，新微信正文未获取。仅本地提交、不改admin/admin和存储；第3/6项、GPT及自动化继续暂停。

最新入口：`continuation-checkpoint-2026-09-06.md`，覆盖上一节历史的“下一直接任务”与旧测试数字。用户继续要求功能并行推进，不是只做报告或测试；仅本地 `dev-studio` 提交、严禁 push。

- **明确排除（用户当前暂停）**：上一进度清单第 3 项 AskData / 统一语义消费 / 公开数据授权治理，第 6 项专项性能 / 大模型稳定性 / 全仓长文件治理；必要回归与新代码体量门禁仍执行。GPT 接入和旧自动化保持暂停。账号、拓扑、原场景不改。
- **已完成（R2）**：React 根渲染/启动失败受控恢复，作者与公开入口 18 个隔离真实浏览器故障用例、零自动写、同路径手动恢复；提交 `752b085`，证据 `application-error-verification-2026-09-06.md`。不宣称任意事件/异步错误都由 React boundary 捕获。
- **已完成（相机取景修补）**：真实 17.5 cm 夹爪旧固定最小 2 m 导致只占屏 10.3%，修八角点透视适配、默认轨道范围、近景标记与网格遮挡；用户自定义范围和原模型不改。两轮 `camera-framing-wGgINY/ihB18A` 共 44 作者状态、4 保存/刷新/发布匿名链路通过，44 个取景状态最长边 33.11–81.96%（dark）/39.36–76.81%（light），匿名零写、GLB 哈希不变。取景飞行动效与跨比例公开构图仍待办，详见相机报告，不声称全套画质或 Kimi-95 完成。
- **已完成（限定浏览器验证）**：F1 显式 Esc 仲裁、发布 busy 保护、弹窗局部双主题最终 `dialog-escape-gaDn1U` 四组通过；检查器数字输入与局部主题 `inspector-theme-7ajweL` 四组通过。代码与完整报告将按批次本地提交，Vision 整套主题不包含在本次通过范围。
- **本轮待办（并行）**：SIM 停靠/收起与真实视口让位；SDK 外部独立消费打包验收；编辑器保存快照回声与 3D→2D 模型状态完整同步；限定读请求恢复与目录失败重试。已发现 SDK 归档缺 dist、保存响应误把外部引擎变化当作新草稿而留空场景，按真实根因修，不删除数据或放宽断言。
- **项目级后验收**：全功能/真实工业场景整体验收继续，不以当前修补或固定夹具代表全部功能完成。原事故无可靠事故前基线，不能独立保证历史数据全恢复；不运行旧 GLM 破坏性脚本。
- **已完成（SDK 可消费性前置）**：三个私有包补明确 `files` 清单解决 tarball 漏 dist；外部独立消费者 `sdk-consumer-cGONEo/lKsvLC` 两轮空 store 离线安装、NodeNext/Bundler 严格声明、Node 与 Chrome 同结果、零外部/业务请求通过。新增 `pnpm gate:sdk-consumer` 与可执行样例；完整证据 `sdk-external-consumer-verification-2026-09-06.md`。仅协议/调度/HTTP SDK，不代表公开发行、嵌入式 Viewer 或第三方插件生态完成。
- **已完成（保存一致性）**：修复冻结场景缩略图直接赋值与 Store 把外部引擎新增模型误当并发草稿而拒收的两重根因。发送前取实时基线，三方回声合并保留后续本地编辑/删除/撤销历史，迟到响应不跨项目/文档。r6 `scene-shell-theme-ulm3QR/ScDsCs` 共8组实际模型保存→二维显示→三维返回，完整models数组及原GLB哈希保持，详见 `application-save-reconciliation-verification-2026-09-06.md`。
- **已完成（r6局部验证）**：对象目录/品牌焦点两轮8组、检查器 `inspector-theme-slAvBf` 4组、Esc/真实非空历史/恢复副本 `dialog-escape-xMgPZC` 两轮4组通过。局部令牌改进遵循 design-taste-digitaltwin，报告保留2D/Vision旧主题及980计数等不足，不据局部通过称全站Kimi-95。目录 `read-recovery-oHT3I5` 两轮4组验证有限读取恢复、持久错误、真实鼠标双击/键盘重试、写失败保稿，真空CTA精修仍待新构建。
- **已完成（命令基线）**：r5 根 build/typecheck/test均退出0（Web1364/API494/Core79/server-sdk90及其余包）；r6 Web构建/全量1367通过。09:06 r7前置Web1373、根typecheck/1931源文件体量通过；随后恢复比较修补需追加回归，不混用旧数字。正常web API4100/Web5173健康，未改账号与拓扑。
- **本轮待办（收口）**：SIM菜单窄画布边界/手柄覆盖最终验收、目录空态主CTA、仅字段顺序不同引发恢复提示的稳定比较修补；统一新构建与浏览器复跑、按模块本地提交。非修补功能完整队列保留在最新检查点，不降级为全部完成。

#### r9 本批最终状态（覆盖上文历史待验收描述）

本批本地提交：保存一致性`b0f5fb4`、目录/弹窗/局部主题修补`e62bb8b`、SIM停靠`5c3c843`；同在内层`dev-studio`，未push。恢复入口为`continuation-checkpoint-2026-09-06.md`。

- **已完成**：三目录有限读取恢复/持久错误/手动重试/取消身份保护；真空单主CTA及按品牌亮度选择中性文字。`read-recovery-EVkckS/mqaLz2`两品牌各两轮双主题共8/8，金9.716:1/紫6.441:1；真实鼠标双击/键盘/POST失败保稿再提交仍通过。
- **已完成**：Esc/发布busy/非空历史/真实草稿恢复 `dialog-escape-p6S2iL`两轮4/4；2D/3D模型保存与主按钮相邻 `scene-shell-theme-ER7rgY`紫色4/4，API模型与原文件哈希不变。仅键序差异的恢复误报已修，真实字段/数组/微小数值差异仍保护。
- **已完成**：SIM左右停靠/44px收起/恢复浮动/真实canvas让位、窄画布菜单和六方向按钮可达、输入DOM连续。`simulation-docking-33Wdbl`两轮4/4，布局零API写；真实正式Study全链仍为r7 `scene-plant-flow-ApwMDa`四组证据，不混用构建归属。
- **已完成**：r9 Web构建与371文件1387测试退出0；r8根typecheck/1932源文件体量通过；r5根build/test包含API494项通过。09:30正常web服务健康，API4100/Web5173，未修改账号、拓扑或原数据。截图两轮亲审和同族检查按design-taste-digitaltwin执行，各报告明确低于9分或未测项，不声称全站Kimi-95。
- **本轮待办**：脚本源码断点/单步/调用栈、独立模型实例与保引用替换、SIM历史/连续AGV/机器人/多域轨道、AI工业工作流、行业包/真实模板、SDK文档样例与插件工作流；已知2D/Vision旧主题、更窄断点/焦点、稀疏快照兼容和R3隔离恢复证据也保留。准确列表与报告链接见`continuation-checkpoint-2026-09-06.md`，不能把本批完结写成全项目完成。第3/6项和GPT/自动化继续明确排除当前执行。

#### 2026-09-13 编辑器对象、导入与导演台收口

- **已完成（本次增量）**：项目资源卡片、可选择/裁剪/截取并保存缩略图；优化回填的快照恢复竞态；2D/3D 右键编组/取消和出组；轨道双击加帧、相机手势录制、四位参数与分段过渡；导演台窄布局和按钮统一；面板收起按钮锚定、ViewCube 间距、视觉样例栏与 AI 模式按钮对齐。Web 2330、Contracts 248、API 缩略图 4 项通过，生产构建通过；两轮双主题浏览器主链路、二维和媒体缩略图各 4/4。报告：`docs/specs/resource-director-refinement-verification-2026-09-13.md`。
- **已完成（最新收口）**：隐藏二维右键无效的重叠对象选择子菜单；现有场景实例进入优化时携带准确实例 ID，优化页显示“应用优化并返回场景”，返回通过 `replaceModelManifest` 原位替换并保留身份、位姿与绑定，新上传才新增。导演台移除重复时间滑块，帧/轨道支持按钮和 Delete 删除，相机与变换手势自动录帧；对象和主方向光再次点击取消选择，方向光文字对齐；3D→2D 在旧应用 ID 失效时按场景重新解析所属应用。Web 494 文件/2342 测试通过（另 2 文件/2 测试跳过），类型检查和生产构建通过；1440/980 深浅主题两轮截图通过。
- **项目级后验收**：仓库门禁仍被 Git 索引中的已删除 `apps/node-red/package.json` 阻断；未恢复 Node-RED 或改治理规则。模型替换需要保引用兼容检查，不把固定 GLB/媒体样本推广到任意格式。其他引擎/脚本/业务域的排除和待办不变。

#### 2026-09-13 AI 电池原生推理与分析报告

- **已接入**：BatteryMFormer SPM-PINN 导出为独立 FP32 ONNX 包，由 Rust `ort` 执行；制品包含适配器、BatteryLife 工况嵌入和哈希清单，产品运行不依赖 Python 或原模型项目。真实合成业务记录经 API 的“标准专家 → PINN 风险路由”贯通，PINN 输出保留可辨识度、融合门、物理拟合、等效内阻、有效扩散时间、衰减率与 OCV 证据。
- **页面收口**：保留 SPM-PINO 多物理神经算子与 TwinMoE 风险路由主技术轨；新增结构化分析报告，呈现观测/预测边界、目标 SOH 与删失语义、路由原因/分歧、PINN 物理证据、模型版本和依据。电池页不再显示无关的全局 Study 底部记录，电池绑定的最近运行移入右侧证据栏；示例动作移出数据来源页签，改为“运行示例”次操作。
- **验证边界**：PINN PyTorch/ONNX 最大绝对误差 `3.8147e-6`；Rust 实际推理与 API 动态路由已运行；聚焦测试、类型、构建和浏览器无横向溢出门禁以本任务最终回执为准。PINN 严格测试 MAPE 仍低于标准专家，因此仅由风险路由触发，不替代标准主专家。
- **数字孪生续接**：Rust 原生运行时补齐源项目在线同化、10 分钟 LFP 多物理域门禁、TwinMoE 风险收益路由、受门控迁移校准、风险不确定性区间、CLF-CBF 影子安全投影和可回放证据；域外动态模式明确由 SPM 守恒回退，`both` 模式只把 PINO 保留为分歧观察。未迁移离线训练展示卡、市场工单和研究型适配器训练流程，不把这些非在线孪生能力写成已接入。
- **最终验证**：Rust 7 项测试与 Clippy 严格门禁、API 电池聚焦 27 项、Web 电池与样式 4 项、两端类型检查、API/Web 生产构建均通过；真实 ONNX 服务已覆盖域内 PINO、三项域外 SPM 回退、64 点迁移修正、CLF-CBF 影子限幅、证据回放和非法会话 400。1280/980/480 三档浏览器无页面横向溢出，RUL 示例实际路由到 PINN 并呈现物理辨识证据，控制台零警告/错误。全仓源文件体量门禁仍被 6 个本任务外既有文件阻断，不将其记为本批完成。
- **样例与结果补全（本次最新）**：内置样例改为首选数据源并扩为 8 个，覆盖 NCA/LFP 公开验证、NMC/LFP 大容量工程、TEMPEST 280 Ah 右删失老化、SOC 连续窗口、96 电芯 Pack 与 LFP 极端脉冲；不再保留独立“运行示例”按钮，选择不兼容样例时自动切换到可执行目标。8 个样例均已在真实浏览器通过主按钮运行。报告新增输入行数/圈数/电芯数与电流、电压、温度、SOH、容量范围；Pack 以 96 电芯聚合和最弱电芯为主结论，不再用展平后的单模型值冒充 Pack 健康度；RUL 同时展示标准/PINN 候选寿命，并在标准结果因 24.4% 分歧被保留时继续呈现 PINN 物理辨识证据。
- **可编辑工况推演（本次最新）**：电池页可编辑初始 SOC/SOH/温度以及最多 6 段时长、C-rate、环境温度，经 `battery.twin.initialize` 和 `battery.twin.simulate` 直接调用 Rust 原生孪生。真实浏览器已验证 10 分钟域内工况由 SPM-PINO 生成 64 点主轨迹，改为 21 分钟后 TwinMoE 按验证域自动切至 SPM 守恒回退；结果包含终点 SOC、峰值温度、最高电压、吞吐量、不确定度、路由路径、安全投影次数、模型版本和告警。未加入 Python 运行依赖。

- **2026-09-14 电池页信息层级修补**：分析目标改为四列同排，副文案缩短并保留 `title` 完整提示；“模型与证据”从首屏常驻右栏改为仅在已有分析结果或周期任务时显示，默认只保留模型/版本摘要，运行时与发布细节继续折叠。电池聚焦测试 4/4、Web 类型检查通过；1280 桌面与 480 窄屏真实浏览器复核通过。

- **2026-09-14 证据栏统一修正**：移除工作台左右分栏，避免旧生产数据绑定在内置样例 SOH 时误触发右侧历史卡；证据卡仅在生产数据源本次返回结果后作为单栏结果后的次级信息出现。内置样例 SOH、生产数据源无结果状态均已真实浏览器复核无证据卡；Web 聚焦测试、类型检查和构建通过。

- **已实现**：三维对象管理收敛为单一目录；对象行与选择集统一多选标记、隔离、碰撞和编组入口；二维支持 Ctrl/Cmd+G 编组、Ctrl/Cmd+Shift+G 解组，三维支持 Delete/Backspace 删除未锁定对象；更多菜单支持外部点击与 Escape 关闭。
- **已实现**：RVT 转换方式与 Revit 版本移入“添加模型”的 RVT 条件导入设置，不再挤占对象目录；上传后的优化或直接插入会等待项目中的权威 ready 模型，转换失败不会继续打开后续工作流。模型优化和拓扑编辑的回场景参数继续沿用现有回填链路。
- **已实现**：场景导演台统一时间线、镜头与漫游，新增相机/对象轨道首帧、逐轨加帧、关键帧选择/拖动/编辑/复制/删除和属性检查器；面板拖动缩放时只扩展轨道工作区，不整体放大按钮与文字。
- **视觉修补**：ViewCube 工具栏上移并留出间距；主方向光不再默认伪选中；二维基础控件/资源库标签完整显示，卡片密度收紧；三维项目资源和工业预制体缩略图提升至可辨识尺寸；对象空态不再出现第二套创建入口。
- **验证边界**：聚焦单元测试、Web 全量测试、生产构建和深浅主题真实浏览器门禁结果以本任务最终回执为准；不将此批编辑器交互收口描述为全项目或任意工业文件转换器的完整验收。
2026-09-13 23:00 Codex Deep Engine 本轮收尾（未提交、未 push）：当前目标平台冻结为 Browser WebGPU + Windows 原生 wgpu，macOS/Linux/Android/iOS 全部移出当前开发、构建、测试和完成分母；Unity 相关兼容继续暂缓。P2 明确保留 Shader、Three 插件兼容、无感切换、Windows 原生客户端、Deep2D/GUI/Chart/Host、统一资产包与 Windows 发布。P0 新增确定性缺失法线生成、真实导出器四元数舍入归一化、通用 authored FLOAT VEC4 TANGENT ownership/正交/手性验证；固定 Khronos TextureEncodingTest 与 AlphaBlendModeTest 已入库并核验许可/hash，分别覆盖色彩空间+2 条缺失 NORMAL 和 9 条 authored tangent+OPAQUE/MASK/BLEND。Deep 全包 181 文件、1554 通过/28 跳过，Node 策略 26、runtime purity 400 Browser/142 Native/194 Windows packages、882 文件体量零告警，type/build 通过；NVIDIA 浏览器真机两样本首帧和控制台 0 warning/error，证据 `webgpu-1789310375339.json`、`webgpu-1789310831043.json`。完整接手边界、下一直接任务与命令见 `docs/codex-glm53-handoff-2026-09-13.md`。

2026-09-13 23:00 九小时并行续跑：用户把 23:00 定为本轮文档检查点，随后 Codex 与 ZCode GLM 并行到 2026-09-14 约 07:50。Codex heartbeat 每 30 分钟继续 Browser P0，当前三支为 sparse accessor、真实资产 GPU 像素断言、公平 benchmark shader 等价/冻结画面修复；GLM 按交接 §7.2 独占 `packages/deep-engine-native/**`，以多个中等复杂度小任务完成缓存复用、revision 失效、device epoch、失败回滚、Windows smoke，提前完成才二选一补矩形 clip 或 image quad。两边不得改同一文件，不 push。
2026-09-13 23:23 Codex 全仓提交前收口：用户授权 Codex 后续在功能切片与门禁通过后自主管理 commit/push，禁止强推；同时删除完整 Three 插件逐个兼容、复杂 Shader Graph 产品、非 Windows 平台适配、重型 RT/路径追踪、UE 全套虚拟几何和长尾格式新 decoder，保留高频 Three 桥、轻量 Shader、Nanite Lite、glTF/GLB 深度支持、Browser WebGPU 与 Windows native。权威执行计划、backlog、Three/Shader 规格和 GLM 交接已同步，并把“先核对依赖/标准/本地实现，能复用或接线就不重写”设为硬门禁。提交前修复 6 个 >800 行源文件，按稳定职责拆为最大 268 行的新模块；全仓 `pnpm gate:repository`、typecheck、生产 build/API import smoke、3496 文件体量门禁和串行 `pnpm test` 通过：Deep 182 文件/1566 通过/28 跳过，API 145/643，Web 496 通过/2 跳过、2349 通过/2 跳过。并行高负载首轮曾使 API 两个 1 秒异步转换等待超时，聚焦 13/13 与随后全量串行复跑均通过。
2026-09-14 00:20 Deep Engine Browser/native 并行批次（未提交、未 push）：Browser direct PBR 已与冻结 separate diffuse、优化 Schlick、correlated Smith 公式对齐，1024 竞争基准 SSIM `0.949514` 通过；在双方显式关闭 occlusion 且 AO/TAA 关闭时使用 color-only pass、跳过 Hi-Z 与关闭特性采样，Deep GPU P95 `0.531456→0.458752 ms`（改善 13.68%），相对 Three 差距 `+45.38%→+16.67%`，图像 hash 不变，GPU +5% 目标仍诚实未过。glTF 新增严格 PNG/JPEG/KTX2 data URI 解码；动画运行层新增多 clip、loop/once、TRS+morph cross-fade、revision 去重与失败重试；WEB-07 新增默认关闭的有界分段 P50/P95/P99；WEB-10 新增共享 shadow atlas 计划与 device-epoch 原子 GPU 生命周期，尚未接 renderer/shader 采样。Native 补齐跨帧资源复用/revision/回滚/device epoch 真 GPU 证据和 Deep2D 矩形 clip/scissor readback，源文件 304 行已拆分恢复门禁。根复验 Deep 188 文件/1598 通过/28 跳过、Node 策略 26、runtime purity 412 Browser/core+146 native+194 Windows packages、source-size 911 文件零失败、双 tsc/build/Lab build；Native fmt/test/clippy 与 ignored 真 GPU 5+2 项全绿。GLM 交接已由首批 8 项扩为 40 个按序原子任务并明确继续，正式 apps/Three 默认路径未接线。

2026-09-14 Codex 重新汇总与客户端修补（未提交、未 push）：按 GLM 40 项逐条复核，校正为 11 完成 / 14 部分 / 15 未开始；新增审计报告 `docs/specs/deep-engine-consolidated-audit-2026-09-14.md`，明确 Browser 组件与正式 Studio 集成的边界及阶段工期。修复 `packages/deep-engine-native` Windows PowerShell 5.1 便携包脚本的 `GetRelativePath`、`ToHexString`、ZIP 清理兼容性，powershell.exe/pwsh 回归均通过；修复 Deep2D dash 大 offset 相位 bug并补测试。主桌面壳改为无系统装饰深色自绘标题栏（拖拽/最小化/最大化/关闭），Web typecheck、桌面 cargo check、source-size、git diff check 通过。正式完整 Web 模式已启动，API4100/Web5173健康；桌面模式因 Tauri 进程随父命令退出的启动器行为暂以持续 Web 模式供测试，后续需单独验收桌面窗口视觉与进程驻留。
2026-09-14 任务规划口径修正（未提交、未 push）：用户指出上一版汇总遗漏“分析优化 WebGPU 引擎方案”窗口中的完整待办，尤其是 Lumen Lite。新增 `docs/specs/deep-engine-webgpu-remaining-plan-2026-09-14.md`，只保留未闭环任务：WEB-01..08、Nanite Lite、Deep Lights、Deep GI Lite（Lumen Lite/WEB-11）、轻量烘焙、GLM Native 40 项中剩余 29 项、Shader/Three 切换、Native GUI/Chart/Host、Asset Package 与 PACK 发布链；已完成项不再重复列入任务规划。`docs/specs/deep-engine-consolidated-audit-2026-09-14.md` 标注为专项审计并链接该规划，`docs/README.md` 已加入入口。
2026-09-14 P0 重排与正式任务建立（覆盖上一条的优先级，不覆盖审计事实）：执行主旨为“多路并行，全力推进任务”。P0 统一为完整 Studio 内 Deep WebGPU Beta 的 14 项收口：当前任务、真实资产、RenderPacket、材质、动画、基础光照、后处理、性能、可靠性、LOD/Meshlet 合流、空间流式、同一作者状态、后台准备/原子切换和设置入口；P1 为 Native Viewer/统一 Deep Asset Package/HostCapabilities/Windows，P2 为轻量烘焙/Nanite Lite/Deep Lights/Deep GI Lite（Lumen Lite），P3 为 Deep2D/原生 GUI 与图表，P4 为可选硬件光追。规划文档已重写，当前 Codex 任务目标已建立；三条工程线并行执行，主线负责合同、测试、构建和真机证据合流。
2026-09-14 P2 所有权调整：用户将 P2 全部交给 GLM，Codex 继续负责 P0 Studio Deep WebGPU Beta 合流。新增 `docs/specs/deep-engine-p2-glm-handoff-2026-09-14.md`，冻结 P2-A 轻量离线烘焙、P2-N Nanite Lite、P2-L Deep Lights、P2-G Deep GI Lite/Lumen Lite 的复用基线、工作包、公共合同、Browser/Native/真 GPU 验收、禁止误报和 35–55 人日估算。GLM 先交付 A1～A4 bake artifact v2 与 TS/Rust golden；合同冻结后才并行 N/L，GI 正式接入等待场景/灯光 dirty 合同稳定。P2 不接管 P0 Studio 切换、作者状态和设置入口，不包含硬件 RT、UE 全套 Nanite/Lumen/VSM 或完整 lightmap 工作流。

2026-09-14 用户纠正最终分工（覆盖上一条 P2 分配）：P3 Deep2D、原生 GUI 与图表完整交给 GLM；P2 恢复 Codex 主线负责。有效交接为 `docs/specs/deep-engine-p3-glm-handoff-2026-09-14.md`，含 D01–D09、U01–U09、C01–C06 共 24 项待办、现有代码入口、共享文件所有权、第一批任务、45–70 人日估算和 Native 输入/DPI/性能/视觉验收。误建 P2 交接已加撤销标记；索引与总规划已更新。Codex 继续 P0/P1/P2/P4，并在 P3 提交后复核集成证据。

2026-09-14 P0 Studio 切换增量：`StudioDeepWebGpuBridge` 修复旧 sync 的失败/finally 污染新后端、取消后迟到模块创建 GPU、同后端请求无法取消待发布回切，以及 dispose 未恢复展示身份。React effect 清理显式取消候选，保留失败原因。`getAuthorRendererBackend()` 区分作者资源后端与展示后端，场景替换回收只作用于真实 Three WebGPU，不因 Deep 展示触发作者 Viewer 重建。聚焦五文件 20 项（含桥 8 项、电池执行 5 项）、Web 类型检查及 diff 检查通过。电池拆分的 output 类型保留与绑定刷新迟到保护已在当前工作树复核。上述为生命周期增量，P0 仍为本轮待办：桥的独立 RAF/full sync/Box3 与隐藏 WebGL 重复绘制、首帧最新 revision 追平、作者 overlay、实际光照/环境接入、三项目/20 次切换及两轮视觉验收尚未通过。下一接线位置为 `viewerEngineRuntime.ts` 唯一作者更新与 renderDemand 调度，需保留动画、相机、测量与控件的行为，不可直接停掉作者循环。
2026-09-14 P0 并行调度与准备续接：Deep 移除独立 RAF，订阅唯一作者 renderDemand；同步期间通知合并，最后上传完成后补绘，静止 device loss 主动回退。候选准备接入 30 秒总超时、即时取消和迟到资源回收；桥/准备/调度/偏好/回收五文件 54 项通过，Web 类型检查通过。新增环境纯适配及支持差异清单，尚未发布到产品路径；核心灯光修复显式 directional 空列表不再注入默认太阳，6 项聚焦通过，省略列表的旧预览默认保留。Deep 全量 249 文件、1851 通过/34 跳过、26 脚本测试和 runtime purity 通过；source-size 被 player_diagnostics.rs 306 行阻断，独立原生线处理中。最新证据与未完成项见 `docs/specs/deep-engine-studio-frame-checkpoint-2026-09-14.md`。隐藏 WebGL 活动帧重复绘制、辅助层、环境合同扩展及真实三项目/20 次切换/视觉仍为本轮待办。
2026-09-14 P0 门禁后续：原生诊断按 ContentIdentity 职责提取子模块，fmt、诊断2项、全目标Clippy通过；Deep source-size复跑1067文件零告警/失败。Web全量2414通过/1失败/2跳过；唯一旧能力文案断言已修，相关12项复测通过，全量待复跑。继续以帧调度检查点记录当前边界，不将聚焦验证扩大为P0交付完成。
2026-09-14 14:18 P0 续接：Web 全量502文件/2415测试通过，2文件/2测试跳过；之后回切即时取消增量桥16项、环境+桥25项通过。局部光CPU/WGSL按本地Three r185对齐0.01距离衰减下限与smoothstep半影，灯光线启用Naga后31项通过；Native仅单方向光能力缺口保留。完整Studio已由启动器恢复健康，5173/4100及配套服务正常。细节与剩余边界见帧调度检查点；P0整体未验收。
2026-09-14 14:20 用户新增硬时间目标：连续12小时高质量完成P0/P1全部任务，截止北京时间2026-09-15 02:20。总规划新增窗口、三线并行和检查点；范围/验收标准不减，P2/P4本窗口延后，GLM P3分工不变。截止目标不等同于已验证可行性，届时按19项真实证据审计，未通过必须保留待办，禁止以改名、删项或后验收替代完成。
2026-09-14 用户延长执行窗口（覆盖原12小时）：连续18小时，沿用14:20起点，截止北京时间2026-09-15 08:20；P0/P1全项范围、质量门槛与并行分工不变。总规划检查点调整为0–2、2–12、12–15、15–18小时，不取消后续任务。
2026-09-14 14:37 P0 续接：候选切换在创建后重新准备当前作者快照；自动恢复偏好与发布后端选择只在 idle 状态执行，失败不再反复自动重试。环境强度内核沿用 0..64 校验，Studio 环境纯适配已透传该值并拒绝非法值，不再报告强度未支持；原始 HDR/旋转及完整桥接仍为本轮待办。独立复跑桥、候选、偏好、环境四文件70项通过，Web typecheck、Deep build、diff check通过。上一轮类型检查句柄已不存在，本轮以新复跑为证。Studio status显示未运行，正在用完整服务模式恢复；Native拖放打开和环境实际接线并行推进。尚无本批真实GPU/视觉验收，不计P0/P1整体完成。
2026-09-14 14:38 完整Studio恢复验证：`pnpm studio start web --no-open --full-services`退出0，启动器报告PID44484健康；API4100、Web5173、电池Rust ONNX、实时视频、云渲染Worker均正常。该结果仅证明服务健康，浏览器任务流与GPU画质仍待验收。
2026-09-14 14:53 用户反馈明显锯齿：实际浏览器确认Deep Beta已启用，canvas525×800对应CSS420×640/DPR1.25，没有发现本场景分辨率缩减。修复Deep历史nearest在半像素边界突跳，改CPU/WGSL深度感知双线性，保留原深度拒绝；引擎线51项含Naga、双tsc通过。Studio新增有限16帧已提交快照收敛，不推进作者/脚本/同步/Box3，隐藏暂停和迟到回调隔离。另修Three后处理默认中间缓冲丢MSAA，按HDR和深度格式共同支持档位选最多4样本；Offscreen复用同一路径。主线桥/settle/MSAA/环境转换四文件67项、Deep build与Web typecheck通过；浏览器重载和场景画面复核控制台无warn/error。小视口截图不足以证明全项目画质达标；正在增加settle首帧延迟避免活跃作者帧额外绘制，后续继续真实大视口和运动边缘比较。
2026-09-14 15:00 作者环境续接：修复applyEnvironment的旧HDR迟到覆盖、旧失败覆盖新成功、dispose后发布以及清除HDR时旧资源滞留；环境提交后requestRender，原失败回退语义保持。新增5项真实Three Scene/Texture宿主测试。环境纹理转换新增共享generator异步API，每16384像素让出宏任务并复核版本/取消；27项转换加19项环境、5项竞态共51项通过，Web类型检查通过。此处未将原始环境适配宣称已全部接入Deep产品配置。Native package_open/test与clippy复验仍在编译阶段被P3 deep2d_gpu.rs:55缺queue参数、deep2d_gpu_cache.rs:138 Arc/Option返回类型阻断，fmt另报deep2d_gpu.rs:278；不记为测试通过，不修改GLM文件。主方向光castShadow合同接线已分配独立引擎线继续。
2026-09-14 15:18 P0灯光与环境增量：Studio环境光/半球光接入Deep真实PBR，按Three r185线性irradiance及Lambert/PI语义，独立64-byte uniform保留Frame ABI，相同系数不重复上传；全局shadowMap开关参与作者投影。核心80项/Naga/双类型/build通过，Web全量2509通过2跳过；随后灯光/bridge53项通过、Web类型通过。实际场景9999临时关阴影后成功Deep激活且控制台无warning/error；恢复阴影后按未实现参数映射受控回退WebGL，未保存或发布。画面仍有天空/地面配置脱离作者、偏亮和辅助层缺失，不能记P0画质通过。PbrEnvironmentState补准备后取消、已取消请求不替换候选、activation重入dispose及cleanup异常仍释放active，状态10项通过，连漫反射和binding33项通过。Native仍被GLM P3两处编译错误阻断，便携包README使用说明已补且PowerShell语法/求值通过。后续优先作者环境/后处理实际配置和阴影参数，再继续统一真实资产/Native门禁；18小时范围不变。
2026-09-14 15:35 P0作者环境实际接线：Deep创建传当前已加载天空/HDR真实RGB source与独立backgroundImage、环境强度、背景强度/逆旋转和Three ACES，关闭内置实心地面/预览grid。后台GPU替换复用原后端，旧视图维持，B→C/A→B→A取消和迟到隔离、dispose/timeout/GPU失败/参数变坏回退均补测试。实际9999临时关阴影成功Deep，工业摄影棚→明亮展厅→工业摄影棚切换成功，控制台0warning/error；原天空及阴影恢复后回退WebGL，未保存发布。Web2567通过2跳过、聚焦85、背景35含Naga、核心bridge/环境47、Deep双类型/build通过；Web生产build在39876进程验证中，不记完成。无Composer的纯色/sRGB背景显示域合成、IBL旋转/天空blur、作者阴影全参数、透明接影地面/辅助层/后处理实际参数及宽窗最终视觉仍待办。当前明细见deep-engine-studio-frame-checkpoint-2026-09-14.md最新15:35节。
2026-09-14 15:36 构建补记：上条Web build 39876已退出0，含类型/Vite/预算；首屏19 chunks、339.4 KiB/gzip111.7 KiB，既有fs/path外置及大chunk警告保留。没有待轮询构建进程，不重复启动。
2026-09-14 16:08 Codex P0 渲染接线增量（未提交、未 push）：作者透明 caster、阴影分辨率后台验证/帧边界替换/提交后退休、Studio 真实尺寸确认与 Fog/FogExp2 HDR 路径已接线。取消/覆盖立即释放在途资源，零尺寸帧不发布阴影候选。Web 全量 2603 通过/2 跳过，后续新增独立会话 3 项通过，Web 类型/生产构建和 Deep 构建/双类型通过。真实 Studio 阴影开启时启用 Deep，晴天→雾天→晴天保持 Deep 可见，未保存/发布；Three/ANGLE 出现 1 条双精度编译 warning，未计为零警告验收。仍为本轮待办：材质 fog=false、隐藏 WebGL 重复绘制、独立性能证据、透明接影地面/辅助层/作者后处理/非 Composer 显示域、三项目/20 次切换/资源故障矩阵与多尺寸画质；P0/P1 整体未完成，18 小时截止不变。细节见 `docs/specs/deep-engine-studio-frame-checkpoint-2026-09-14.md` 的 16:08 节。
2026-09-15 用户范围调整：本轮暂时移除 Shader/Three.js 兼容专项（新增能力、兼容矩阵及其竞品对标），保留现有代码与必要回归，避免破坏既有项目。当前收口分母只包含 P0/P1/P2 正式产品接线、Native/Studio、真实 GPU 基准与发布门禁；P4 RT 仍按既有 API 阻塞记录。
2026-09-15 P0/P2 收口增量：Deep backend diagnostics 已暴露 backend、chunk streaming、shadow selection、meshlets、deformation，并由 Studio bridge 提供统一读取；benchmark 显式冻结 meshlets+deformation，baseline 关闭 spatialAa/occlusionCulling。P2 光源预算对 NaN/Infinity 导入值做 finite 降级，避免排序不确定；相关测试 3/3。Browser isolation gate 已更新为允许正式 Studio viewer 集成边界（apps/web/src/viewer/** 与 web workspace 依赖），其余生产目录仍拦截；artifact 33 files、架构测试 6/6。当前仍无真实 factory/power/warehouse GPU 对标数据，不宣称 Unity 90% 或竞品领先。
2026-09-15 收尾核验：Native asset_package_directory 4 passed/1 GPU ignored，asset_package_recovery 1 passed/3 GPU ignored，runtime_package_contract 4/4，portable-package-common verifier 通过，Web tsc 通过，competitiveBenchmarkRunner + combinedLoadBenchmark 9/9；Shader/Three 兼容增强按用户指令移出当前范围。真实 BIM 资产同设备 GPU 对标、浏览器真实 PlayerContent/Deep2D/chart/IME、Windows 真 GPU 发布链和正式上线门禁仍未取得充分证据，不能宣称达成 Unity 90% 或超过 Three/Babylon。


2026-09-15 Native GPU benchmark补记：RTX 4060 Laptop/Vulkan，million-point 通道真实 GPU 测试通过；decode 2.9355ms、slice+decimate 3.7549ms、render 12.0217ms、gpu_prepare+draw 44.5468ms。该负载与 Unity 1000物体场景不等价，暂不用于 Unity 90% 结论。

2026-09-15 Native benchmark复测：RTX 4060 Laptop/Vulkan million-point 通道 gpu_prepare+draw 37.7274ms（上次44.5468ms；不同运行的波动，未证明优化收益），decode 2.5957ms、slice+decimate 4.1025ms、render 11.0192ms，测试通过。

2026-09-15 基准证据纠正：Unity 6 初次 Player 使用 -nographics，0.0148ms 仅为无渲染帧间隔，撤销其作为 Unity 渲染基线的结论。Native million-point 的 gpu_prepare+draw 使用 Instant 包含 painter/target 创建、提交与同步等待，并非 GPU timestamp；render 为 CPU 显示列表生成时间。两次无代码变化的运行不能记优化收益。后续对比必须验证图形设备、计时来源、固定资产/轨迹及视觉质量。

2026-09-15 Unity基准纠正：Unity 6 Native Player 构建成功（86,216,396 bytes），-nographics 负向验证 exit=2；启用 Vulkan 运行时因 Player 未包含 Vulkan shader（InitializeEngineGraphics failed）未取得渲染数据，不能作为 GPU 基线。
### 2026-09-15 Deep Engine 编辑器接入收尾（Codex）

- 本轮用户要求：完成 1–8 并交付可直接接入编辑器、可直接测试的引擎。
- 已完成：新增根脚本 `pnpm gate:deep-engine-editor`，串联 Deep Engine typecheck/test/build、编辑器相机/测量/Deep WebGPU bridge focused tests、Unity bridge/tgz 一致性。
- 已验证：Deep Engine 331 文件/2702 passed/41 skipped；Lab build/verify/isolation；编辑器 focused 78/78；Unity archive 3/3；Native RTX4060 Vulkan GPU culling/LOD/indirect draw/CSM/portable smoke 全通过。
- Unity 6 原生 D3D11 实渲染基准有效；Unity Vulkan 因构建缺少 Vulkan shader 模块仍阻塞跨引擎等价对标。Native 百万点 timing 为 host wall time，禁止当作 GPU timestamp。
- 当前状态：编辑器接入与本地回归入口可交付；P0/P1/P2 的最终 GPU timestamp、固定 BIM 资产视觉截图和 Unity 同资产等价基准属于项目级后验收，不得用合成轻负载或 host timing 冒充完成。
- 追加收尾：Deep WebGPU 正式画布已投影 measurement、annotation、clipping、space、BIM placement 及 selection/transform/light 辅助根，避免编辑器辅助层只留在作者 WebGL 画布；新增回归覆盖。
- 追加收尾：修复 Unity package 公开 tgz 与插件源码清单漂移，重新打包后 `pnpm test:unity-bridge` 3/3 通过。
- 追加收尾：产品浏览器门发现编辑态 9px/7px 文字和 14px 标尺原点可点击目标，已提升到 10px 与 24px 并扩大标尺尺寸；首次门禁的 Long Task 204ms 仍需复跑确认。
- 追加收尾复验：产品浏览器门 `--require-webgpu` 通过，覆盖 1440/1366/1024 三视口、WebGL 三维和 WebGPU 三维；报告 `test-output/product-browser/report.json`。文档中心新增 Deep Engine 接入/切换/测试/客户端打包指南和架构 SVG，DocsCenter/docsCatalog 9 项测试通过。
2026-09-15 发布页客户端打包入口：场景发布对话框新增“仅发布 / Three WebView / Deep Native”目标选择；发布成功后下载 `.bimscene.zip`，包内含二维应用、三维场景、资源、绑定及脱敏数据运行时。编辑器继续运行 WebView；Deep Native 当前是原生 wgpu 交付清单，完整独立 EXE 与场景快照→RenderPacket/Deep2D 转换仍待工程化验证。HTTP/PostgreSQL 凭据不入包，`sim:` 可随包运行。web typecheck、发布对话框/动作/docs 13 测通过，web 全量 2690 passed / 2 skipped。
2026-09-15 DeepSeek 多维分析复核：采纳其“渲染后端/编辑器宿主/发布运行时”分层、BIM 夹具不足、GPU timestamp 与 Unity Vulkan 证据边界；纠正其将当前交互/LOD 合流/源文件门禁判为未完成的过时结论。新增分析结论写入 docs/specs/deep-engine-full-audit-2026-09-15.md：发布页现可选 Three WebView 或 Deep Native，后者仍需场景快照→原生 RenderPacket/Deep2D runtime-package、数据连接运行时和独立 EXE 生产门。

### 2026-09-15 后续任务规划与提交授权

- 已完成：将后续方案拆为 M0–M4、D01–D28，入口 `docs/specs/deep-engine-execution-plan-2026-09-15.md` 链接 `deep-engine-next-development-tasks-2026-09-15.md`；本次只改文档，没有执行开发或产品验收。
- 本轮待办：先 D01 文件职责拆分、D02 发布兼容合同、D24 合法 BIM 资产盘点，再按依赖接发布预检、产物状态、转换与 Native 正式运行路径。已核对现有 runtime hash、PlayerContent 与 LKG，复用不重建。
- 项目级后验收：固定资产 GPU/视觉/Windows 完整发布与统一体验；没有新增通过证据。明确排除项保持原范围。
- 用户明确授权：commit/push 由 Codex 自主管理，代码、文件和日志按正式项目标准管理。逐文件审查和暂存、按功能切片、相关质量检查通过后提交推送；不纳入并行无关改动、不提交日志/凭据/临时产物、不强推。当前混合工作区没有整批提交。

### 2026-09-15 D01 回归增量

- 已完成：模型加载逻辑抽离后的 focused 回归新增 9 项，覆盖立即就绪、轮询、失败/等待转换器、资源丢失、网络失败、60 秒轮询截止、多模型隔离和 superseded 错误识别；`pnpm --filter @bim-studio/web test src/appModelLoading.test.ts --run` 9/9，通过现有 Node 环境模拟计时器，无新增依赖。
- 已完成：`pnpm quality:source-size` 4063 个源文件通过，无豁免。此项不代表 D01 整体验收完成。
- 本轮待办：Web typecheck 仍被 `packages/deep-engine/src/sceneSnapshotRenderPacket.ts` 的 contracts 包解析及 readonly instances.push 两项错误阻断；交互效果抽离尚待 focused 与全量回归。上述转换器还需审查几何、变换与可见性语义，不能只修类型后视为 D07 完成。
- 本轮待办：Deep2D 发布替代方案按用户要求移出当前实施路径，最终富文本、ECharts、媒体、输入、脚本及双向联动能力要求保留；不将旧子集方案当作已批准的最终交付。并行代理本轮因 429 退出，本线程继续本地实施。

### 2026-09-15 18:14 Deep Engine 主线续接与并行分工

- 已完成：恢复原窗口最后一次实际改动；快照转换器已移至 `apps/web/src/delivery/sceneSnapshotRenderPacket.ts`，旧记录中的包边界/readonly 类型阻断已解除。本轮 Web typecheck 退出 0，转换器能力验收仍未完成。
- 已完成：新增 `useAppInteractionEffects.test.ts` 14 项，覆盖双事件总线、卸载/重挂载、应用内页面与场景身份、异步跳转失败、Unity 目标、零值数据及 URL 打开行为。与模型加载、场景同步、事件宿主合计 4 文件 27 项通过；Web 全量 533 文件通过/2 跳过，2713 项通过/2 跳过，退出 0；source-size 4065 个源文件通过。
- 本轮待办：当前窗口目标为 D01 工程收口及发布动作可靠性/预检。D01 生命周期抽离的完整回归、生产构建及浏览器验收仍须补齐；本批仅新增测试，不新增视觉验收结论。
- 本轮待办：已与“评估 Deep2D 终局方案效果”窗口确认文件所有权：其负责 Deep2D P0/P1、`runtimePackage/**`、`webgpu/runtimePackagePrewarmAdapter*`、`delivery/sceneSnapshotRenderPacket*`、`delivery/sceneClientPackage*` 和独立转换/加载模块；当前窗口负责 App/hooks、`controllers/scenePublicationActions*` 与 `components/publicationReadiness*`。导出函数签名和跨端合同改变前先协调，总账只追加各自小节。逐批复核 Git 与另一窗口进度，复用已有工作。
- 项目级后验收：Native 完整交付、真实 BIM GPU/视觉和 Windows 发布链仍按原计划；本批未提交或推送。

### 2026-09-15 Deep2D P0 预热提交竞态修复（Codex）

- 已完成：RuntimePackagePrewarmExecutor 在 A 已显示、B 预热时重新请求 A，会取消 B，迟到产物不覆盖 A；已取消的同包请求返回 aborted 且不取消其它有效请求。取消上一轮前先登记新一轮，避免 AbortSignal 回调重入覆盖最新意图。
- 已完成：修复 throw undefined 被误判无失败与稀疏候选数组跳过完整性检查的组合缺陷，阻止半包提交。新增 prewarmLifecycle.test.ts 八项回归，覆盖 A/B/A、预取消、坏包、迟到销毁、取消重入和释放异常。
- 验证：先复现 5 项中 4 项失败；修复后 runtimePackage 全目录与 WebGPU 预热适配器共 11 文件 179 项通过，Deep Engine core/lab typecheck 与 build 通过，仓库治理门禁通过。未执行本片真实浏览器/GPU 验收，不表示端到端发布完成。全工作树 diff 检查发现其它车道 Unity ProjectSettings.asset 尾空格，本片未修改该文件。
- 本轮待办：接通真实运行包导出、语义证据与 Web loader。旧转换器实际已迁到 apps/web/src/delivery/sceneSnapshotRenderPacket.ts；代码复核发现基础体手工几何法线/绕序、Euler 组合旋转、颜色线性空间、隐藏对象与材质参数需要对齐作者实现，且模型与二维转换尚未接通，不能直接包装为完整 Runtime Package。
- 协作：本窗口负责 runtimePackage/**、webgpu/runtimePackagePrewarmAdapter*、delivery/sceneSnapshotRenderPacket*、delivery/sceneClientPackage* 与独立转换/加载模块；另一 Codex 窗口负责 D01 App/hooks 及发布动作可靠性。涉及导出签名或共享能力合同先协调，总账各自追加。没有将并行未提交代码整批纳入提交。

### 2026-09-15 Deep2D P0 基础体编译校正（Codex）

- 已完成：sceneSnapshotRenderPacket 复用编辑器 primitiveGeometry，覆盖 box/sphere/cylinder/cone/torus/plane/capsule；修复手工立方体法线/绕序、XYZ 旋转、sRGB 到线性颜色、隐藏对象仍绘制、透明度与基础 PBR 参数不一致。稳定实例排序、保留 UV、重复 ID/非法数值明确报错；几何资源复用，实例材质独立。
- 已完成：新增 13 项编译回归，含七种几何真实 Runtime Package builder/序列化/validator 往返、立方体向外法线、带平移/负非均匀缩放的作者矩阵对照、隐藏与透明、材质覆盖、乱序确定性、输入无修改与输出隔离。相邻发布应用/几何/材质合计 4 文件 24 项通过。
- 验证：首次类型检查暴露新夹具缺少 CameraState.mode，已补为 orbit；复跑 Web build（含 tsc、Vite、预算）退出 0，首屏 339.5 KiB/gzip111.7 KiB。既有外置模块与大 chunk 提示仍在。没有新增依赖。
- 本轮待办：转换器仍未接入导出调用方；模型资源、完整材质/预制体外观、相机/环境/行为/二维需分层编译和对象级能力报告。当前不支持的模型与外观明确拒绝，不能将基础体投影称为完整场景转换。下一步建立资源解析与运行包编译入口，再替换 conversionRequired 路径。
- 项目级后验收：当前只是离线转换与合同测试，未获得实际发布画面/Native 截图证据，不标记 P0 或视觉验收完成。目标 P0–P3 保持 active，未提交或 push 混合工作区。

### 2026-09-15 Deep Engine D01 实测修补与 D02 前置（主线窗口）

- 已完成：生命周期回归 15 项；修复 auth-required 后在途 me 恢复旧用户、旧 retryTimer 继续请求的竞争，两项红→绿。新增交互回归 14 项与已有模型等待 9 项共同保护抽离边界。
- 已完成：真实浏览器发现选择→清除引发 `Editor overlay revision went backwards.`。根因为异步 sync 完成后重放旧 view；已有新作者帧时跳过旧 view，由既有追帧处理。选择、相机和 resize 三项竞争反例覆盖同根因，相关 focused 35/35，通过且未放宽引擎单调守卫。
- 已完成：新增单场景发布审计入口，保留全部场景作跳转引用上下文；模型/基础体共享 ID 和 widget 重复显式阻断，基础体交互目标正常解析。预检 16/16 通过，尚未接发布控制器。
- 验证：Web 全量 535 文件通过/2 跳过、2752 项通过/2 跳过；Web typecheck、最终生产 build/预算、repository gate 均退出 0；source-size 4069 源文件通过，App/runtime effects 分别 795/769 行。首屏 339.5 KiB/gzip111.7 KiB；构建既有外置模块与大 chunk 提示保留。
- 验证：修复后浏览器两轮选择/清除及 980×768↔1440×900 变更保持 Deep，最终后端诊断确认，控制台 0 warning/error。结束恢复 WebGL 和默认视口。首次返回管理页触发产品自动保存并更新场景时间；未发布，后续重挂载使用刷新。
- 本轮待办：D01 浅色/完整视觉收口及分批提交归属审查；D02 Native 能力合同、D03 发布确定版本与硬阻断、D05 产物失败/重试。完整记录与十维回归自评见 `docs/specs/deep-engine-d01-regression-2026-09-15.md`，局部截图不关闭 Kimi-95 全视觉门。
- 协作：新增两条子代理仅操作本窗口分配的 hooks、预检与 Studio bridge；Deep2D 独占边界不变，无覆盖其文件。当前未提交/push 混合工作树，主线目标保持 active。

### 2026-09-15 Deep2D P0 静态 GLB 场景编译接线（Codex）

- 已完成：新增 compileSceneRenderPacket，复用公开 decodeTexturedGlb API，宿主注入资源读取/图像解码。共享资产一次解码、几何/纹理按资产隔离 ID、材质按实例应用、根 XYZ 变换与 GLB 内部 world matrix 相乘、作者 nodeId 到绘制 instanceIds 映射、隐藏资源不读取。
- 已完成：编译前复制场景，读取后复制资源字节；取消、重复 ID、源字节预算和坏包失败不返回半份产物。提取 sceneModelMatrix 供模型与基础体共同使用，无新增依赖。
- 验证：现有合法 Box.glb 与 BoxTextured.glb 通过实际解码、Runtime Package builder、JSON 往返与 validator；纹理使用现有 sharp 解码真实像素，无图像 mock。带贴图往返约 5 秒，测试超时设 30 秒，不作为发布性能达标证据。编译/基础体/发布应用共 3 文件 23 项通过；Web build（tsc/Vite/预算）退出 0，最后字节复制调整后复跑类型检查。首屏 339.5 KiB/gzip111.7 KiB，既有构建提示保留。
- 本轮待办：该静态编译函数尚未接入正式导出入口；完整材质/层级覆盖、动画和实例模型资源宿主适配、相机/环境/二维/行为合同与 capability report、运行包输出和消费者接线继续推进。不将静态 GLB 夹具扩大为任意客户模型或完整 Native 发布支持。
- 项目级后验收：未新增 GPU/实际发布画面截图；端到端与视觉验收未完成。本片文件在当前窗口独占 delivery 车道，未提交混合工作树，目标继续 active。

### 2026-09-15 Deep2D P0 Runtime Package 编译入口与证据（Codex）

- 已完成：新增 compileSceneRuntimePackage，调用真实 scene packet 编译和 build/serializeDeepRuntimePackage，产出运行包 JSON；分开记录源语义 canonical hash、编译输入图 hash、实际 UTF-8 产物 SHA-256。读取资源后先预算检查，再复制/计算原始字节 SHA-256，记录资产 ID/大小/摘要与作者对象映射。
- 已完成：证据范围显式为 static-render-packet；deferredSceneFields/deferredObjectFields 列出相机、环境、行为等未编译字段。与另一窗口确认，不重复定义其 D02 Native capability 公共合同，保留后续接入点。
- 验证：新增六项覆盖独立 Node crypto 核验源资产/实际产物 hash、重复编译确定性、版本/源相机/资产变化各自身份、异步源快照隔离、NaN/取消拒绝、未接入对象行为字段。编译相关 3 文件 25 项通过；首次 build 发现 exactOptionalPropertyTypes 可选参数构造问题，修复后 Web build（含类型/Vite/预算）退出 0，首屏仍 339.5 KiB/gzip111.7 KiB，原构建提示保留。
- 本轮待办：正式 exportSceneClientPackage 尚未调用新入口；相机/环境/二维/行为与能力报告必须接完并由消费者实测，才能去掉 conversionRequired。下一片优先用真实编译产物做 Native 结构互通基线，并接宿主场景配置；不能把当前静态包当作完整发布完成。
- 项目级后验收：本片无新增实际画面/Native GPU 证据，P0–P3 目标保持 active。未覆盖并行车道文件，未提交混合工作树。

## 2026-09-15 发布产物失败反馈修补（Deep Engine 主线窗口）

- 已完成：客户端包生成失败时，`scenePublicationActions` 返回 false，Studio/场景管理发布对话框保持打开；已发布快照保留，消息明确区分发布成功与打包失败。
- 已完成：控制器 7 项测试通过，覆盖异步打包完成前不关闭、打包失败保留版本、保存/发布失败不导出、保存取消。Web typecheck、source-size（4072 文件）、repository gate 通过。
- 本轮待办：D05 的原版本重试、取消、持久化状态和刷新恢复尚未实现；本修补不标记 D05 完成。D01 全视觉验收仍按回归报告保留。
- 本轮待办：D02 公共兼容报告由主线窗口实现，消费另一窗口的 sourceSemanticHash / compileGraphHash / targetArtifactHash 及对象映射；静态 CPU 编译证据与 Native 窗口证据分开。另一窗口继续编译/运行包/Native 互通，本窗口不重复开发其编译器。

### 2026-09-15 Deep2D P0 真实 Native 互通基线（Codex）

- 已完成：新增 apps/web/scripts/verify-scene-runtime-interop.mjs，打包实际场景编译入口，记录编译源码/bundle/EXE hash；七种基础体、共享 Box 双实例、BoxTextured 双实例分别写真实 Runtime Package，再由 Native --headless-package / --smoke-package 消费。三组结构/GPU smoke通过，三组篡改包均按 hash mismatch 拒绝。
- 验证：当前 Native debug 构建退出0；RTX4060 Laptop/Vulkan/Bgra8UnormSrgb，三组 scopes=clean callbacks=clean，64×64已呈现，LKG在present后提交。最终证据 test-output/deep2d/scene-interop/39b26160-9cd5-4832-afac-90bbc2a9511f/report.json；复跑与边界见 docs/specs/deep2d-scene-runtime-interop-2026-09-15.md。
- 本轮待办：该证据只验证 static-runtime-interop，不得标记 native-window 画面已认证。尚需相机/环境/二维/行为宿主合同、D02能力报告与正式导出接线。已通知另一窗口保留 Native ready 的实际窗口证据要求，不为64×64 smoke放宽门禁。
- 项目级后验收：两轮正式视觉、动态能力、任意客户资产与P0整体未完成。无Native生产代码改动，本片新增验证脚本和报告，目标保持active，未提交混合工作树。

## 2026-09-15 D02 公共兼容报告合同（Deep Engine 主线窗口）

- 已完成：新增 contracts/scenePublicationCompatibility.ts 并从 index 导出；汇总检查项、三 hash、目标、能力、样本、平台和运行范围。未知能力、重复检查/证据、错场景及缺证据阻断；静态 CPU 编译不能放行 Native。
- 已完成：新合同专项 17 项通过；contracts 全量 25 文件 265 项通过；contracts/Web typecheck、source-size（4075 文件）、repository gate、目标文件 diff 检查通过。
- 已完成：接口与另一窗口协商并交付；说明见 docs/specs/scene-publication-compatibility-contract-2026-09-15.md。汇总器只判断输入检查项，不替代场景能力完整遍历或证据真实性验证。
- 本轮待办：编译证据适配、完整场景检查和发布控制器硬阻断尚未接入，D02/D03 保持本轮待办。Native 64×64 smoke 由另一窗口负责，不扩大为正式窗口验收。
- 本批未提交或推送，保留并行工作区；控制器基础导出实现包含先前未提交工作，后续按归属审查提交。

### 2026-09-15 Deep2D Native 相机方向基线修正（Codex）

- 已完成：gpu_lod_views 从当前透视投影矩阵读取观察方向，修正旧实现把相机到世界原点的方向当作相机朝向的问题。偏移设备聚焦后的 LOD 深度与实际渲染一致；相机位于世界原点时不再产生 NaN。
- 验证：新增两项回归覆盖四个 yaw、三个目标位置、投影 w 与 LOD 深度一致性、级联阴影相机方向、原点相机及未改变的阴影视图 ABI。Native binary 常规测试 60 通过、17 显式 GPU 测试忽略；cargo build 和 repository gate 通过。
- 验证：重建 EXE 后三组真实编译产物 GPU smoke 及三组篡改拒绝再次通过。EXE SHA256 为 5364ed0e0dda19a3ddde181b050d153db0bd0d967740f189549e1cc0541ddf4d，报告 test-output/deep2d/scene-interop/4591f15f-81fd-440d-a95b-2b89b234d197/report.json。该 smoke 不替代正式窗口视觉验收。
- 本轮待办：作者相机仍未写入运行包；当前 Native yaw-only 视图及固定投影与 Web 作者相机不同。需统一渲染、拾取、LOD、阴影的相机参数后接版本化合同、原子加载与正式导出，不能仅添加未消费的元数据。P0–P3 目标保持 active。
- 项目级后验收：完整 Native 窗口画面对比与动态功能验收仍未完成。本片未触及另一窗口发布控制器/兼容报告文件，未提交混合工作树。

## 2026-09-15 D03 保存后预检与原子发布（Deep Engine 主线窗口）

- 已完成：Studio/场景管理的 publishScene 对服务端保存结果运行单场景引用检查；断链、重复 ID、跨项目或保存身份不符时不调用发布API/云启动/导出。其他草稿只作为场景跳转引用上下文。
- 已完成：Web发布请求带expectedSnapshot；API停止旧云会话前初检，并在store文档事务内再次比较草稿和当前发布版本。冲突409，草稿发布标记、线上快照、版本号和历史单次持久化；复用既有历史规则，JsonStore 787行。
- 验证：Web相关3文件31项、API全量147文件664项通过；API typecheck、Web生产build含tsc与预算通过，首屏339.6 KiB/gzip111.8 KiB；source-size4079文件、repository gate、目标diff检查通过。测试覆盖保存/发布等待竞争、持久化失败及重启恢复。
- 本轮待办：D02完整Native能力遍历与D03降级确认仍未接；单API写实例是现有存储边界。云停止按sceneId存在迟到竞争，下一切片处理publication/session守卫及相关撤回/恢复同族问题。浏览器实际发布与全视觉门本批未执行。
- 记录：docs/specs/scene-publication-snapshot-consistency-2026-09-15.md；未改另一窗口Deep2D/runtimePackage/编译器文件，未提交混合工作树。目标保持active。

### 2026-09-15 Deep2D Native 俯仰相机消费基础（Codex）

- 已完成：PlayerView 增加 pitch（默认0）及共享 basis/eye；Renderer 初始化、resize、set_view 使用完整视图，CPU 拾取沿相同基向量发射射线，阴影相机使用投影的 up，LOD 继续从实际投影读取方向。保留旧测试用 yaw 接口，不改变运行包 v1/v2。
- 验证：新增倾斜相机非中心世界点投影→拾取、横竖分辨率、正负俯仰、极点有限性、LOD/阴影朝向及零俯仰旧帧一致性测试。Native binary 常规测试63通过、17显式GPU测试未运行；cargo build/repository gate通过。三组真实编译产物GPU smoke及篡改拒绝通过，报告test-output/deep2d/scene-interop/eb42677f-1474-40cd-8294-2277cbcd740c/report.json，EXE SHA256为4ad0edac17d83df0b5687924cf091e6ec986e056be89a7b384a6d157cb3ed7be。
- 本轮待办：版本化相机合同、作者position/target转换、FOV/near/far消费与加载原子提交尚未接入；编译证据camera仍deferred。当前GPU smoke仍使用默认相机，不作为倾斜作者视角的窗口验证。P0–P3目标保持active。
- 项目级后验收：完整Native窗口两轮视觉对比未完成。未改发布窗口文件，未提交混合工作树。

### 2026-09-15 Deep2D Native 投影参数消费（Codex）

- 已完成：PlayerView增加focal/near/far，默认沿用现有投影。主投影、拾取、聚焦、LOD像素尺度/近裁面、阴影FOV/裁面以及初始化、resize、set_view、场景替换全部接入。阴影直接接收原参数，避免从f32矩阵反推大远裁面产生误差。
- 验证：Native binary常规测试65通过、17显式GPU测试未运行，cargo build/repository gate通过。新增0.05–100000裁面范围、近远裁面裁除、非默认FOV倾斜投影拾取和小远裁面聚焦测试；LOD像素尺度断言按归一化焦距比较，避免绝对像素浮点误差。
- 本轮待办：运行包v1/v2尚未携带相机，作者相机仍deferred；需继续版本化合同、position/target转换及原子加载。所有测试只能证明当前消费者能力，不能证明正式发布已支持作者相机。P0–P3保持active，未提交混合工作树。

## 2026-09-15 D03 云会话并发保护（Deep Engine 主线窗口）

- 已完成：活动会话的项目/发布身份检查，旧停用或刷新不再改写新会话；健康检查前占用启动槽，政策变化中止旧启动；迟到停用不覆盖新启用；并发停止同会话共用Worker请求；迟到刷新不改写closed；注册表串行持久化。
- 验证：四项红测复现后转绿，新增并发回归共10项；API全量148文件674项、API typecheck、source-size4080文件、repository gate和目标diff检查通过。未改Web/UI/Native/Deep2D文件，未运行真实GPU云媒体验收。
- 本轮待办：无活动会话时的权威publication校验、Worker创建后的取消/清理、持久化失败恢复及发布/撤回/恢复跨模块协调仍未完成。D02完整能力遍历、D03完整生命周期和D05重试仍待办，不把本片局部竞态修复标为全链路完成。
- 记录：docs/specs/cloud-publication-concurrency-2026-09-15.md；另一窗口继续Native作者相机合同及消费，camera deferred仍保留。未提交混合工作树，目标保持active。

### 2026-09-15 Deep2D 相机负载 v1 合同（Codex）

- 已完成：TS RuntimeSceneCamera及严格快照校验、Rust同字段serde/validate、共享JSON样本、Native position/target→PlayerView转换。范围、数值预算、float32退化检查与极点约定见docs/specs/deep2d-scene-camera-contract-2026-09-15.md。
- 验证：TS相机17项、runtimePackage目录192项、Deep类型检查/构建通过；Rust负载2项及视图转换1项通过；repository gate通过。Native生产构建提示from_camera尚未被调用，符合当前未接包入口状态，不隐去该待办。
- 本轮待办：运行包新版本、资源入口/哈希/预热/Native加载提交尚未接入；compiler camera仍deferred，不能扩大为Native支持证据。P0–P3保持active。未改另一窗口能力适配器文件，未提交混合工作树。

## 2026-09-15 D02 编译报告适配与创建中云会话停止（Deep Engine 主线窗口）

- 已完成：新增 delivery/scenePublicationCompatibility.ts，复用公共汇总器、sourceSemanticHash、对象映射和 deferred 字段；验证保存快照身份、缺失/重复映射、可见对象无实例，未消费字段保留对象级阻断。未复制几何/材质/二维编译器，不把CPU编译当Native就绪。
- 已完成：创建Worker期间stop/disable等待返回Worker ID再停止并等ack，启动不会迟到复活；创建拒绝保留诊断，停止失败保留Worker身份可重试。仅修改本窗口cloud控制器和并发测试。
- 验证：适配器7项含真实基础体/Box.glb输出，Web相关3文件25项通过；后端新增4项deferred回归，API全量148文件678项/API typecheck通过；Web build含tsc/预算通过，首屏339.6 KiB/gzip111.8 KiB。source-size4086源文件/repository gate通过。
- 本轮待办：报告尚未接正式导出入口，Native窗口证据、完整能力覆盖/降级确认及D03其他生命周期保持待办；Worker未知分配结果和持久化失败恢复未完成。另一窗口继续相机合同/消费者，不修改其编译模块；本批未提交混合工作树。

### 2026-09-15 Deep2D TS 运行包 v3 与相机预热交付（Codex）

- 已完成：新增DeepRuntimePackageV3，必填camera入口/scene-camera资源、独立内容hash与身份校验、预热计划。v3允许无着色器时空materialBindings，v2非空规则保留。WebGPU预热commit一次交付projection和camera，旧包为null。
- 验证：runtimePackage及WebGPU适配器13文件208项通过，覆盖重签损坏/降级包拒绝、camera单独变化hash、提交拒绝不替换旧状态、重试、回旧包与资源清理。Deep类型检查/构建通过。契约记录见docs/specs/deep2d-scene-camera-contract-2026-09-15.md。
- 本轮待办：Native解析器尚未接受v3，不能将TS通过视为跨端完成；下一片接Native v3资源解码及视图加载/提交，再接场景编译器与Web宿主应用。camera仍deferred。P0–P3目标保持active，未提交混合工作树。

### 2026-09-15 Deep2D Native v3 相机包解析与跨端样本（Codex）

- 已完成：Native v3 envelope/必填相机入口/负载身份与hash/材质绑定规则接入；LoadedRuntimePackage返回camera，资源差异计划支持SceneCamera。新增实际TS builder生成的v3样本，两端测试直接消费并核对。
- 已完成：全目标编译暴露前轮相机私有类型依赖及两处GPU测试调用遗漏，已将PlayerView抽到公共player_view模块，并修复集成调用；未掩盖编译错误。
- 验证：Native合同/绑定/差异/JSON/相机包共26项通过；TS相机包11项通过；cargo check --all-targets及repository gate通过。显式运行LOD/材质GPU读回6项通过（不是相机窗口画面验收）。
- 本轮待办：播放器PlayerContent仍未保存相机，初始/拖包/热更新提交接线待做；编译camera仍deferred，正式发布相机不标supported。另已接收并行窗口的sceneClientPackage下载前取消检查修复请求，下一片处理。P0–P3保持active，未提交混合工作树。

## 2026-09-15 D03 迟到结果所有权与 D05 原版本定位（Deep Engine 主线窗口）

- 已完成：发布控制器复用getActiveScene与sceneApplyVersionRef，保存期间切走不继续发布，迟到发布/打包不覆盖新场景、不关闭新对话框；覆盖同ID重新打开、跨项目、卸载和打包迟到，控制器18项通过。
- 已完成：scenePublicationArtifactRecord纯定位层，只记录服务器history版本/时间/快照指纹和导出配置，key区分target/renderer/toolbar；历史缺失/重复/内容变化拒绝，不回退新草稿；中断preparing/building可恢复failed。新增18项通过，尚未接执行器/IDB/UI。
- 验证：Web全量539文件通过/2跳过，2807项通过/2跳过；Web typecheck、生产build/预算通过，首屏339.6 KiB/gzip111.8 KiB；source-size4091文件、repository gate通过。
- 本轮待办：D05任务执行器/稳定hook/持久化/UI重试取消与刷新恢复；已请求另一窗口在其独占导出器补ZIP生成后下载前取消检查，对方确认会处理。当前导出资源/app仍动态读取，不宣称整个包依赖冻结。
- 记录：docs/specs/scene-publication-artifact-retry-2026-09-15.md。未触及另一窗口Deep2D/Native/编译器文件，未提交混合工作树，目标保持active。

### 2026-09-15 Deep2D 客户端包取消下载修复（Codex）

- 已完成：sceneClientPackage补资源读取前后、hash完成、动态导入后、ZIP生成前后取消检查；进度回调触发取消时不继续进入读取/压缩。保持函数签名，取消后迟到的ZIP不调用downloadBlob，也不报告已下载。
- 验证：新6项测试覆盖成功下载、预取消、ZIP迟到、进度回调取消、忽略signal的资源迟到、压缩失败及取消后重新导出；与发布控制器/兼容报告合计31项通过。
- 本轮待办：Native相机加载与提交仍待接线，P0–P3目标保持active。本片按另一发布窗口反馈修复其依赖的实际副作用；未修改该窗口控制器或job状态文件，未提交混合工作树。
- 验证补充：Web typecheck、完整build（含bundle预算）及repository gate退出0；首屏339.6 KiB/gzip111.8 KiB，既有node模块externalized和大chunk构建提示保留。已将修复接口与结果通知发布窗口。

### 2026-09-15 Deep2D Native 作者相机加载与窗口交接（Codex）

- 已完成：PlayerContent保存作者视图，NativeApp首次启动应用；热更新按作者相机变化决定替换/保留当前视图。拖包相机变化先准备候选渲染器并离屏验证，成功后一次发布；回旧包恢复默认视图。
- 已完成：真实GPU测试发现新旧渲染器同时配置同一窗口交换链导致进程退出，已将new_candidate离屏准备和activate_surface分开，旧交换链释放后才激活新表面。完整热更新同样采用此路径。
- 验证：Native常规67项通过、全目标check/build与repository gate通过；真实GPU拖包扩展验证v3视角、回旧包、候选初始化失败保留原视图及继续present。v3首次启动smoke通过（64×64、scopes/callbacks clean），日志test-output/deep2d/camera-startup/1ad10894-1f04-4d25-8b8d-a2ebf5083090/native.log。
- 本轮待办：相机热更新专项GPU验证、默认阴影距离与大near协调、作者场景编译/Web宿主应用/正式窗口视觉仍待完成。compiler camera仍deferred，不能据此放宽D02。P0–P3保持active，未提交混合工作树。

## 2026-09-15 D05 执行器与恢复存储（Deep Engine 主线窗口）

- 已完成：任务执行器复用原发布历史定位，重复调用共享执行，重试递增尝试编号；状态写入成功后通知调用方，存储失败直接报错。取消拦截历史/导出迟到结果；文件交付后取消无效，ready写入失败保留存储错误。
- 已完成：复用现有IndexedDB恢复访问层，按用户/项目/场景隔离记录；刷新恢复只将中断任务持久化为failed，终态不重复写入。已核对另一窗口补齐的下载前取消检查，未重复改导出器。
- 验证：执行器15项；与定位、存储和既有恢复测试合计4文件51项通过；Web最终typecheck通过，生产build/预算、source-size4097文件及repository gate通过。存储测试使用可控替身，真实IDB刷新与下载尚待浏览器验证。
- 本轮待办：App稳定hook、两个发布入口委托、UI重试/取消、跨标签页竞争及浏览器验收；D05未完成。当前项目资源和应用仍动态读取，依赖冻结另列后续范围。
- 记录：docs/specs/scene-publication-artifact-retry-2026-09-15.md。未提交混合工作树，目标保持active。

### 2026-09-15 Deep2D 作者相机编译与独立能力证据（Codex）

- 已完成：compileSceneCamera复用发布默认视角选择/裁面归一化/orbit范围逻辑，生成v3相机。配方更新deep-scene-static-compile-v2；cameraHash参与compileGraph，实际产物随相机变化。新增compiledSceneFields，与另一窗口独立camera capability适配协调完成。
- 已完成：仅纯orbit且无角色/未知字段时移出camera deferred；其他模式/角色/未知字段及cameraViews/cameraConstraints等仍阻断。没有匹配native-window证据仍不能标Native supported。
- 验证：编译/相机/兼容报告当前23项通过（含默认视角、裁面覆盖、快照隔离、相机变化hash、未编译语义保留）。三组实际v3编译产物GPU smoke及篡改拒绝通过，脚本追加相机位置/目标/能力项断言；最终报告test-output/deep2d/scene-interop/9c4a3f95-056d-4615-b1af-200060de9266/report.json。
- 本轮待办：正式导出接线、Web宿主相机应用、Native热更新专项、大near与阴影距离协调及正式视觉验收。P0–P3保持active，未提交混合工作树。
- 验证限制：全量Web typecheck/build被并行开发的useScenePublicationArtifacts.ts类型错误阻断（useRef初始化及exactOptionalPropertyTypes）；已通知归属窗口修复，未覆盖其文件。repository gate与本轮目标文件diff检查通过，未将全量构建标为通过。

### 2026-09-15 Deep2D GLB 镂空材质保真修复（Codex）

- 已完成：模型透明度覆盖保留source MASK及alphaCutoff，修复opacity=1时强制改OPAQUE导致镂空填实。原BLEND在模型opacity=1时仍按发布查看器的显式覆盖改OPAQUE；cutoff=0可安全转BLEND。
- 已完成：MASK且cutoff>0与半透明叠加暂不能用现有互斥alphaMode表示，编译器明确拒绝，不静默丢弃alphaTest。此组合仍是本轮待办，不作为已兼容能力。
- 验证：使用现有Box.glb在内存改写材质JSON并保留原BIN，真实解码覆盖0.999/1阈值、cutoff保留、MASK+透明拒绝、零cutoff及原BLEND覆盖；与运行包编译共19项通过，repository gate通过。
- 本轮待办：正式导出/跨端完整能力与视觉验证保持未完成。目标active，未覆盖并行窗口文件，未提交混合工作树。
- 验证补充：当前Web完整build（含tsc/Vite/bundle预算）退出0，前轮并行Hook类型阻断已消失；首屏339.6 KiB/gzip111.8 KiB，既有externalized与大chunk提示保留。已通知发布窗口。

## 2026-09-15 D05 App 任务委托与 D02 相机独立证据（Deep Engine 主线窗口）

- 已完成：App持有稳定useScenePublicationArtifacts，Studio与场景管理共享控制器通过buildPublicationArtifact执行；已发布版本与ready/failed/cancelled分别反馈。App保持798行。hook首次恢复后再执行，存储异常上抛，未增加草稿保存或再次发布。
- 已完成：卸载/用户切换使旧回调失效；StrictMode重挂载可用；A→B→A等待旧取消写入，再恢复同用户任务。快速多次空会话回切保留最早存储屏障；hook13项、控制器20项通过。
- 已完成：与另一窗口约定compiledSceneFields消费；camera独立deep.scene.camera.v1检查，未知/重复/错误资源映射、compiled与deferred矛盾、双清单漏相机均阻断。适配器10项通过；没有Native窗口证据仍blocked，未改另一窗口编译器。
- 验证：本轮Web全量544文件通过/2跳过，2854项通过/2跳过；随后新增快速多次回切回归13项focused通过。Web独立typecheck与生产build/预算通过，首屏339.6 KiB/gzip111.8 KiB；source-size4101文件与repository gate通过。未新增UI及浏览器截图。
- 本轮待办：两个对话框的任务加载/原版本展示/重试与取消按钮、真实IndexedDB刷新/下载验收、跨标签页任务竞争；D05仍待办。D02正式导出硬门禁和完整能力覆盖、D01全视觉验收也仍待办。
- 记录：scene-publication-artifact-retry与scene-publication-compatibility-contract两份规格已同步；未提交混合工作树，目标保持active。

### 2026-09-15 Deep2D 正式Native ZIP真实编译接线（Codex）

- 已完成：sceneClientPackage调用真实Native编译器，写native/runtime-package.json、compilation-evidence.json、compatibility-report.json并纳入逐文件SHA。nativeRuntime移除conversionRequired，改实际版本/路径/hash/status；缺窗口证据保持blocked，不固定宣称二维/绑定已支持。细节见docs/specs/deep2d-native-client-artifact-2026-09-15.md。
- 已完成：场景首次异步前快照；GLB复用下载字节；浏览器图片解码器由lab提升共享webgpu宿主适配器。修复导出把所有普通字符串当URL改写的问题，并保留签名URL到本地路径映射和脱敏。
- 验证：导出/编译/适配器28项、图片解码资源释放3项通过；导出集成测试因真实懒加载编译器在并行全量CPU拥塞时超默认5s，设30s并保留真实路径，隔离9项2.85s通过。Deep typecheck/build、contracts build、Web完整build及repository gate通过；首屏339.8 KiB/gzip111.8 KiB。最初build因共享dist缺新导出失败，按依赖重建后通过，已与并行窗口约定后续互斥构建dist。
- 本轮待办：正式发布控制器硬阻断、可信窗口证据、完整语义编译与增量版本策略仍未完成。报告blocked的ZIP只是实际构建产物，不是Native ready。P0–P3目标active，未提交混合工作树。

### 2026-09-15 Native导出初始化依赖修正（Codex）

- 已完成：图片解码器独立browser-image-decoder子入口，Native helper及lab不再通过200行webgpu总入口加载完整渲染依赖。集成测试恢复默认5s，9项focused通过，测试耗时1.03s。
- 本轮待办：前次全量首项在30s仍超时，因此撤回以提高超时处理该问题的结论；独立入口修改后的默认worker全量结果待复核。P0–P3保持active。

## 2026-09-15 D05 双入口任务界面与浏览器验证（Deep Engine 主线窗口）

- 已完成：两个发布对话框展示原版本、目标、状态及错误；提供原版本重试、取消和再次下载；较旧记录折叠。App bindings复用稳定hook，App799行；同tick重复发布由ref阻止，保存/发布等待期间选项与关闭冻结，子任务取消可达。
- 已完成：首轮截图发现通用dialog样式覆盖发布弹窗宽度，已提高专属选择器优先级，恢复原540px；两入口深/浅主题1440×900与980×768截图复检，目标名称和底栏完整。原深色主题已恢复。
- 验证：新增任务组件9项、父弹窗交互4项；连同静态与hook共4文件29项通过，source-size4108文件/repository gate通过。maxWorkers=4的Web全量546文件通过/2跳过，2878项通过/2跳过；默认worker仍遇另一窗口新增Native导出集成测试初始化超时。已交该窗口修真实导入及迟到mock隔离，未跳过测试。
- 验证：独立QA项目4099aab5-8297-4ae4-b3cf-7afb3b9599c9、场景96b1d58a-d8f8-477c-a1a3-5bd4e8e9f63d完成Studio发布与两入口记录读取；重试后历史仅v1；整页刷新后从真实IndexedDB恢复v1已生成记录。IAB下载事件15秒超时、默认Downloads无对应文件，未确认文件落盘。一次短暂API502在重新读取后恢复，运行管理器确认API/Web健康。
- 本轮待办：真实执行中取消/失败/刷新中断、下载落盘与更多记录浏览器验收、跨标签页竞争；D05未完成。视觉自评中交互/动效/反馈8分，未宣称完整Kimi-95出口，见docs/specs/scene-publication-artifact-ui-verification-2026-09-15.md。
- 本轮待办：最终默认全量与Web build由另一窗口接手统一验证；本窗口最后build因对方进行中的sceneClientPackage测试类型错误退出，已通知修复，待追加结果。未提交混合工作树，目标保持active。

### 2026-09-15 Native ZIP真实归档与默认全量复核（Codex）

- 已完成：真实JSZip生成下载Blob后解压，核对CRC、索引文件大小/SHA、Box.glb原字节、运行包内部hash、编译证据产物hash与blocked报告。README明确解压后的--headless-package/--package入口；ZIP不是Native启动器直接输入。
- 已完成：测试收集阶段加载真实编译模块，每项导出绑定测试取消信号并在afterEach取消/等待，避免Vitest转换排队超时及迟到导出污染下项。保留默认5s和默认worker，未mock编译器。
- 验证：focused10项通过；默认Web全量546文件通过/2跳过，2879项通过/2跳过，67.86s（test-output/deep2d-native-export-web-full.log）。Web完整生产build及repository gate退出0。新增JSZip类型错误已修并经build检查。独立入口不足以单独修复全量超时，最终测试隔离与初始化修正后才通过。
- 本轮待办：P0契约冻结、可信Native窗口证据及发布门禁、完整2D/数据/行为语义仍待完成；P1–P3目标保持active。未提交混合工作树。

### D05 UI 切片最终共享树验证补记

- 已完成：另一窗口修复Native导出集成测试的模块初始化与测试间迟到操作隔离，保留默认5秒和默认worker。根已读取原始日志核对：Web全量546文件通过/2跳过，2879项通过/2跳过，67.86秒；Web生产build含tsc/Vite/包预算退出0，repository gate通过。
- 验证：日志test-output/deep2d-native-export-web-full.log与test-output/deep2d-native-export-web-build.log；该窗口增加真实ZIP解压、CRC、文件SHA-256、GLB字节与运行包校验。生成包内容校验不替代本窗口仍待办的浏览器文件落盘验证。
- 本轮待办：D05真实取消/失败/执行中刷新、跨标签页任务竞争及下载落盘不因本次共享门禁通过而关闭；目标保持active。

### 2026-09-15 P0 ChartIR严格运行时读取（Codex）

- 已完成：公开validateChartIR/parseChartIR，完整字段/版本/集合类型检查，复用ChartSpec字段引用数值交互预算，纯JSON快照隔离调用方嵌套数据；不在运行时补作者默认值。
- 验证：读取器/ChartSpec/EChartsOptionCompat共33项通过，Deep typecheck/build、repository gate通过。Deep source-size failures0，12项既有文件超长提示仍在。
- 本轮待办：Native ChartIR缺legend/tooltip/dataZoom/actions且未知字段未严格拒绝，尚不能宣称v1跨端冻结；Native结构和运行时对齐、双端golden与DashboardDocument继续推进，见docs/specs/deep2d-chart-ir-v1-freeze-2026-09-15.md。完整P0–P3目标active，未提交混合工作树。

### 2026-09-15 Native ChartIR交互字段与双端结构golden（Codex）

- 已完成：Native ChartIR保存legend/tooltip/dataZoom/actions，严格未知字段与必需编译字段读取；新增源版本、zoom与初始动作引用/预算/范围校验。类型与交互合同从校验模块分开；现有Native构造点补显式程序默认，其serde不使用默认。
- 已完成：同一ChartSpec真实TS编译输出六类图表共享golden，TS重编译比对、Native读取再序列化完整结构比对。JSON数字按JS double语义处理10/10.0表示差异。布局测试独立成文件，原chart_render从797行降到748行。
- 验证：TS图表34项；Native wire/contract/layout/render20项、chart库11项通过；Native all-target check、Deep typecheck及repository gate通过；source-size failures0/11既有提示。未重建Web/Deep dist，避免并行窗口构建冲突。
- 本轮待办：Native布局/交互执行尚未完整消费新增字段，series按类型严格拒绝与数值/ID校验仍需对齐；不能称ChartIR完全冻结或图表已支持发布。DashboardDocument与P0–P3剩余范围保持active。

## 2026-09-15 D05 跨标签页执行锁（Deep Engine 主线窗口）

- 已完成：复用浏览器 Web Locks，按用户/项目/场景独占恢复和整个导出过程，最终状态写入结束才释放。锁被占用立即提示，不排队；缺 API 停止执行。同页并发读取共用进行中 Promise，完成后重新读取查库；重试取得锁后重新读取最新 attempt，防止旧缓存覆盖另一页。
- 已完成：两个子代理分别实现锁 helper 与审计 hook；18+18 focused 通过，覆盖持久化失败释放、取消落盘屏障、账号与场景隔离、同场景不同目标竞争、并发读取与最新记录重试。没有修改 Deep2D/ChartIR/Native 编译器。
- 验证：真实 IAB 双标签同时重试 QA 场景 v1，两轮均一页执行、另一页报冲突；重新读取恢复已生成记录，错误态截图可见恢复按钮与底栏。空场景运行过快，本次未验证执行中取消/刷新中断，文件落盘仍未确认。
- 验证：Web 默认全量547文件通过/2跳过，2902项通过/2跳过，79.48秒；独立typecheck、生产build/预算、source-size4116文件与repository gate通过。日志test-output/d05-artifact-lock-web-full.log及d05-artifact-lock-web-build.log。首屏339.8KiB/gzip111.9KiB。
- 本轮待办：真实取消、失败、执行中刷新/标签页终止、文件落盘与更多记录验收；D05及完整目标继续active。Web Locks只覆盖同源已升级客户端；不覆盖旧代码页面或其他浏览器配置。未提交混合工作树。

### 2026-09-15 Native ChartIR严格series与数值语义（Codex）

- 已完成：Native按series类型读取允许字段，拒绝不适用字段即使为null；必需维度不能缺失/null。补稳定ID、引用标识、标签/单元格UTF-16预算、线性/对数轴、热力图数值及轴通道、单侧非有限axis限制；超限数据集在逐行校验前拒绝。
- 验证：共享12个负例，每例先验证基线有效再修改，两端拒绝一致。TS35项、Native wire/contract/layout/render22项和chart库11项通过；Native all-target check、Deep typecheck、repository gate通过，source-size无阻断（既有超长提示保留）。
- 本轮待办：完整JSON预算与程序构造语义、Native新增配置的布局和交互执行继续核验，P0契约尚未完全冻结。D02 exporter与编译发布戳投影交给并行发布窗口接线，本窗口不再同时编辑；完整目标active。

### 2026-09-15 Native ChartIR字节入口与CLI校验（Codex）

- 已完成：parse_chart_ir串联JSON解析、节点/深度/UTF-16文本预算、严格字段读取和语义验证。预算在通用JSON解析后执行，未声称流式内存约束。统一预算常量供已有语义校验复用。
- 已完成：--headless-chart命令调用同一入口，帮助已列出；只输出结构及数量，不报告窗口/行为验证。真实Native二进制子进程覆盖共享golden、作者ChartSpec、缺文件和额外参数。
- 验证：wire7、预算2、CLI2项通过，Native all-target check无新增警告，repository gate通过，source-size failures0/既有12提示。未触并行Web构建dist。
- 本轮待办：程序构造对象约束、完整Native布局/交互执行与DashboardDocument继续推进；P0–P3目标active，未提交混合树。

## 2026-09-15 D02 正式交付阻断与编译源身份（Deep Engine 主线窗口）

- 已完成：正式exportSceneClientPackage在ZIP创建前消费Native报告，重验合同上下文和证据绑定；blocked/未确认降级停止交付。诊断独立exportSceneClientDiagnosticPackage，仅Deep Native，文件名含.diagnostic、manifest.purpose=diagnostic、返回diagnosticFileName/kind而非正式fileName。原真实ZIP/CRC/资源hash验证保留在显式诊断入口。
- 已完成：经另一窗口确认后，编译器与预检共用sceneCompilationSource，仅排除顶层updatedAt/publishedAt，recipe升v3且预检拒绝旧recipe。其他字段、嵌套时间与createdAt仍参与hash；CAS与历史任务fingerprint仍比较全文。没有修改Deep2D/Native/ChartIR。
- 验证：gate25项；真实runner→exporter→Native compiler→gate集成证明failed、零ZIP/下载、重试attempt2且只读原历史；编译投影16项含时间稳定和历史身份敏感。相关5文件64项通过。Web全量550文件通过/2跳过，2946项通过/2跳过，65.57秒；独立typecheck、生产build/预算、repository gate与source-size4125通过。日志test-output/d02-native-delivery-gate-web-full.log及d02-native-delivery-gate-web-build.log。
- 验证：QA场景新增v2/v3。首次开发HMR保留旧App runner导出引用，v2曾显示旧ready；冷刷新后v2重试按新门禁failed。新发布v3打包failed保留弹窗，显示对象路径和替代方式；历史v1–v3均在，v3当前发布，更多记录展开可见v1。此结果证明发布后失败保护，尚不是发布前阻断。
- 本轮待办：D03在保存后、publish前准备并检查；准备结果用opaque handle交给首次任务，避免重复编译，并核对发布快照除两时间字段外一致。可信Native窗口证据、完整能力覆盖及降级确认仍缺；D05真实取消/中断/文件落盘待验收，目标active。未提交混合工作树。
- 浏览器补记：整页刷新后重新打开发布对话框，真实IndexedDB恢复v3 failed及原错误，重试按钮可见。控制台仅保留12:02:48 UTC开发HMR旧错误，冷刷新后本次交互无新错误。

### 2026-09-15 Native图表初始状态接线（Codex）

- 已完成：InteractionState::from_ir按顺序消费初始zoom和actions，百分比换算为[0,1]；reset_from_ir独立构造后替换，非法候选保留旧状态。headless-chart实际执行初始化并输出状态数量。
- 验证：初始状态3、真实CLI2、既有interaction3项通过，Native all-target check和repository gate通过。
- 本轮待办：highlight目前沿用单活动目标模型，多目标强调及tooltip/legend/绘制消费继续对齐；不能称完整图表交互支持。未改并行窗口D03/exporter/compilation-source，P0–P3目标active。

### 2026-09-15 Native多目标强调状态（Codex）

- 已完成：highlight/downplay从单hover目标分离为EmphasisState，支持多系列/多点；整系列默认值+例外集支持单点取消及后续数据行，不按全量行数展开。初始动作已消费；set_emphasis实时更新先校验目标，失败保留状态。
- 验证：强调3、初始化3、真实CLI2项通过，Native all-target check及repository gate通过。一次新增测试Rust借用错误已修复并复跑。
- 本轮待办：实际绘制、tooltip/legend、双端行为对照与DashboardDocument继续推进；P0契约尚未完整冻结，目标active。未改并行D03/compiler/exporter。

### 2026-09-15 Native tooltip配置与失效索引（Codex）

- 已完成：hover/select/deselect与emphasis共用数据索引校验，越界事件先拒绝；tooltip disabled/none不生成提示状态但保留悬停目标。隐藏系列清除其瞬时tooltip/hover并保留持久强调。交互测试移到独立模块，主状态文件不再超长。
- 验证：hover3、emphasis3、初始化3、实际CLI2及既有interaction3项通过；Native all-target check、repository gate通过，source-size failures0/11既有提示。
- 本轮待办：axis提示聚合、legend布局和实际绘制、跨端行为、DashboardDocument继续推进。P0–P3保持active，未触并行D03领域。

### 2026-09-15 DashboardDocument v1源封装（Codex）

- 已完成：复用现有ApplicationDocument v2完整快照定义DashboardDocument v1（schema/version/entryPageId/application），避免拆源丢失数据/交互/脚本/3D依赖；身份与revision仍取metadata。新增create/assert入口、源快照复制、入口引用和全局page/widget唯一性校验。
- 验证：新增4项+既有应用验证95项通过，contracts typecheck及repository gate通过。并行窗口持有Web构建，未同时清理contracts/Deep dist。
- 本轮待办：权威应用发布源接线、应用全引用校验、对象revision/依赖、实际二维lowering与Native golden仍需补齐；此源封装不是Native运行包，不宣称DashboardDocument完整发布已支持。详见docs/specs/deep2d-dashboard-document-v1-2026-09-15.md。目标active。

### 2026-09-15 DashboardDocument内部引用（Codex）

- 已完成：源创建接入内部引用校验，视口scene/camera、交互来源page/widget/scene/object、publication入口、spatial显式scene/page必须存在；场景、其对象与camera视图ID拒绝重复。校验与源封装分文件，复用既有作者结构。
- 验证：内部引用7项+源封装4项+应用验证95项共106通过，contracts typecheck和repository gate通过。未并行清理共享dist。
- 本轮待办：外部资产、动作/脚本目标、layer层级和继承导航目标仍需依赖解析；发布源到二维运行包接线、Native/跨端证据待完成，目标active。

## 2026-09-15 D03 发布前预检与一次性准备结果（Deep Engine 主线窗口）

- 已完成：Native在configured保存/引用检查后prepareSceneClientPackage，兼容通过才publish；正式导出与历史重试共用同一gate。准备无ZIP/下载，返回当前模块WeakMap的一次性句柄，经context→App hook→runner原样传递；普通retry不保存或复用旧句柄。
- 已完成：交付核对项目/场景/target/renderer/toolbar与编译源hash，伪造/克隆/重复句柄或内容变化拒绝；发布两时间字段进入最终scene.json/manifest，已读取的项目/应用/资源字节拷贝和编译产物复用。准备与交付取消信号联合有效；句柄不持久化，不把此临时冻结扩大为D06全依赖版本冻结。
- 已完成：save/prepare/publish/cloud/build异步返回均核对场景身份/加载代次；旧请求成功或失败不覆盖新界面。当前请求错误showError一次后透传给已有发布弹窗catch，正常取消保持false；修复了仅返回false导致弹窗看不到预检错误的问题。
- 验证：controller37、runner/hook37、prepared通用19、Native prepared3等focused通过；Native成功分支使用真实Box.glb/编译/JSZip，仅窗口证据为明确test-only替身，验证编译及资源各一次、两时间变化外包更新且内包字节保持。真实无证据路径仍blocked。默认Web全量552文件通过/2跳过，2989项通过/2跳过，70.66秒；生产build/预算通过，首屏339.8KiB/gzip111.9KiB，repository/source-size4135通过。测试新增implicit-any类型问题修复后重跑build退出0。
- 验证：真实管理页与三维编辑器入口均在Native预检失败后保持弹窗，并出现可见role=alert原因。管理页历史确认仍v3当前发布、v1/v2保留，未生成新版本；两入口错误态截图可见底栏。期间API短暂502，日志为4100端口ECONNREFUSED，运行管理器随后健康；未重启共享服务，未声称全程零错误。
- 本轮待办：真实Native窗口证据提供方、完整能力覆盖/降级确认、D05实际取消/中断/文件落盘、D06版本化依赖与后续Native交付仍待验收；目标active。已与另一窗口错开构建，未动Deep2D/Native/ChartIR及其文档，未提交混合工作树。

### 2026-09-15 Dashboard外框布局真实编译与Native对照（Codex）

- 已完成：compileDashboardLayout复用RetainedUiTree/layout引擎，将页面与节点外框、z序、visible转为真实布局树；稳定ID按源身份hash，source及逐节点未消费字段保留。仅外框pass，不以container冒充文字/图表内容。
- 验证：Web编译5项、Native读取实际TS编译golden并比较可见矩形/顺序1项通过；源fixture包含完整既有ApplicationDocument。Web typecheck及repository gate通过。
- 本轮待办：发布/运行包接线、文字/图表/视觉/viewportFit/命中/a11y及对象revision仍未完成；不可见节点TS保留矩形与Native剔除的差异已记录，不扩大该可见fixture证据。目标active，未动并行D04归档领域。

## 2026-09-15 D04 全负载索引与稳定内容哈希（Deep Engine 主线窗口）

- 已完成：manifest.files由仅assets/native扩为全部payload，补scene.json/applications.json/project.json/runtime.json/README.txt，manifest不自索引，目录不算payload。路径排序固定，每项按实际UTF8/原始字节计算大小及SHA256；contentHash绑定交付metadata及path/bytes/sha256，不包含generatedAt/ZIP时间/sourceUrl。
- 已完成：同步预检与最终索引复用validateSceneClientArchivePaths，拒绝大小写重复、文件/目录前缀冲突、manifest.json根保留路径及Windows危险路径；准备阶段检查，防止拿到prepared后才发现路径冲突。索引首await前复制输入字节，导出负载沿用准备阶段私有拷贝。
- 验证：路径/索引35项，真实ZIP清单7项，准备阶段冲突1项；包含五类文本完整索引、独立重算contentHash、构建时间稳定性、runtime/renderer变化及三类文本单字节篡改。现有Native真实编译ZIP/CRC校验保留。Web默认全量555文件通过/2跳过，3037项通过/2跳过，74.03秒；独立typecheck、生产build/预算、repository gate/source-size4143均通过，首屏339.8KiB/gzip111.9KiB。
- 记录：docs/specs/scene-client-package-integrity-2026-09-15.md说明索引/哈希协议与限制；日志test-output/d04-package-index-web-full.log及d04-package-index-web-build.log。未改UI，本轮无新增浏览器验收。
- 本轮待办：外包消费者统一强制校验、版本/后端/feature flags门禁、D06依赖冻结及Native实际交付仍待推进；本批不是完整D04完成。用户询问两小时能否完成全目标，已说明完整目标不能保证，继续优先发布链/关键失败路径验收，不缩减目标，保持active。未提交混合工作树，未碰Deep2D车道。

### 2026-09-15 Native图例布局接线（Codex）

- 已完成：layout_chart消费legend.visible及四方位，隐藏释放空间；上下24px、左右120px，沿用8px外边距。实际render_chart路径共用plot矩形，空间不足拒绝。修正旧文档“没有legend字段”的过时假设。
- 验证：layout5、render11、wire7、hover3共26项通过；Native all-target check、repository gate、范围diff检查通过。显式运行3项真实GPU测试通过，RTX4060 Laptop，CPU/GPU既有参考内部一致率0.9812；该参考仅覆盖既有线图夹具，不代表四方位窗口视觉验收。
- 本轮待办：图例条目文字/点击、状态到实际绘制和命中、二维内容运行包接线继续推进；仍未过Native窗口两轮视觉闭环，不评分、不宣称完整图表支持。目标active，未改并行D04领域与共享dist。

### 2026-09-15 Native图例系列几何与GPU读回（Codex）

- 已完成：render_chart_with_hidden_series消费隐藏系列，拒绝未知系列、合并重复ID；系列命令/资源使用图表+系列hash和内部序号，其他系列隐藏/重排不改变资源身份。render_frame按绘制组装职责独立，图元仍在render。
- 验证：六类型实际几何隐藏/恢复、全隐藏、重复/未知ID及重排身份3项，加layout/render共19项通过；实际GPU4项通过，新增隐藏alpha清零/恢复像素完全相同。拆分后复跑以上测试，Native all-target check、repository gate及范围diff检查通过。
- 本轮待办：窗口图例点击、zoom/emphasis/selection/tooltip绘制、命中索引及动态数据点身份/revision仍待接入；新GPU读回每次新建painter，不扩大为长期缓存/窗口视觉验收。二维运行包及完整P0–P3继续active，未动并行D04归档读取领域。

### 2026-09-15 Native轴坐标映射修正（Codex）

- 已完成：查缩放链路发现Y轴固定线性、单侧min/max丢失；统一numeric_mapper/resolve_domain，双轴支持log并保留单侧界限，无效log域不再降为线性。域逻辑独立render_domain。
- 验证：实际路径坐标3项（十倍刻度等距、单侧/双侧界限、非法log域），加render/visibility共17通过；既有GPU4项回归、Native all-target check、repository gate与范围diff通过。
- 本轮待办：缩放窗口、窗口交互/命中、二维运行包集成仍待推进，未新增窗口视觉验收；完整P0–P3保持active。未触并行ZIP读取依赖文件。

### 2026-09-15 Native缩放窗口到绘制（Codex）

- 已完成：render_chart_with_windows消费隐藏系列/归一化窗口；数值与log双轴、X类目带映射缩放，受影响系列使用plot clipRect并保留原投影，空窗口复位。初始窗口可由from_ir传入。非法/重复/未知轴窗口拒绝；热力图缩放显式报未支持。
- 验证：axis8/layout5/render11/visibility3共27通过，GPU5项通过，新增缩放像素变化、绘图区外透明及复位像素相同；Native all-target check、repository gate与范围diff通过。新增浮点测试调整为1e-9容差后通过。
- 已完成：坐标映射按职责移至render_cartesian，域解析/图元/帧组装分开，拆分后复跑相关测试。
- 本轮待办：热力图缩放、窗口控制器、命中/tooltip/selection/emphasis、数据增量/缓存revision及二维运行包继续推进；过大投影仍按DisplayList预算拒绝，固定GPU夹具不替代窗口视觉验收。完整目标active，未动并行ZIP依赖领域。

## 2026-09-15 D04 客户端 ZIP 读取校验（Deep Engine 主线窗口）

- 已完成：新增 verify:scene-client CLI 与只读读取器，使用锁文件已有 yauzl 3.4.0 并声明根开发依赖；MIT 证据核对与 notices 更新，保留并行依赖改动。命令要求目标，输出 integrity-verified 或非零退出码，不提取/启动。
- 已完成：复用既有路径校验与 canonical hash，检查清单 schema/目标/renderer/purpose、必须文件、Native 清单基本合同；逐项检查实际 ZIP 集合、SHA/大小/CRC、重复 entry/大小写、危险目录/特殊文件、本地/中央头一致、重叠区间及普通流式 descriptor。输入复制、读取限额和 AbortSignal 支持。
- 验证：69 项 Node 专项通过（ZIP 29、manifest 39、真实 CLI 1），Web exporter 实际字节交给 CLI 的集成及既有清单共 8 项通过；Web typecheck、repository gate、source-size 4154、生产许可证扫描 528 版本通过。独立审查发现 descriptor 缺口后修复，真实流式成功与缺失/损坏反例通过。日志 test-output/d04-consumer-*.log。
- 限制：默认 ZIP512MiB/manifest1MiB/单文件256MiB/总展开1GiB/10000 条目；ZIP64 descriptor 明确拒绝。取消验证覆盖调用前/调用后，实际流中取消暂无独立确定性证据。未改产品 UI，本片无新增视觉验收；未重跑产品构建，沿用上片3037项及构建基线，本片新增测试/typecheck通过。
- 本轮待办：Native 内包语义与可信窗口证据校验、完整 feature/backend 合同、启动器强制调用及 D06 版本依赖冻结继续；integrity-verified 不代表 Native ready/签名真实性。另一任务继续图表 GPU/zoom，未碰 Deep2D 车道。用户要求按正常进度推进，取消两小时优先时间假设，原目标保持 active。未提交混合工作树。

### 2026-09-15 Native热力图轴与缩放（Codex）

- 已完成：热力图独立render_heatmap模块，类目带/数值及log轴定位，按最小变换域间距推导单元格，作者界限生效；双轴窗口改变位置/尺寸、始终plot裁剪，完整色值域保持。移除上一批热力图缩放拒绝。
- 验证：axis8/heatmap2/render11/visibility3共24通过；GPU6项通过，新增色值像素不变/缩放位置变化/裁剪/复位验证，最后裁剪调整后复跑。Native all-target check、repository gate、范围diff通过。
- 本轮待办：命中、tooltip/selection/emphasis及窗口控制器、动态缓存revision和二维包仍待推进；数值格宽策略需跨端对照，固定GPU不等于窗口视觉验收。完整目标active，未动并行D04。

### 2026-09-15 Native图表几何命中快照（Codex）

- 已完成：ChartGeometryFrame拥有只读绘制列表、既有Deep2D路径命中索引与目标表；柱/散点/饼/热力图hitId保留原始行号，线/仪表返回系列级身份。源校验、可见性/缩放、绘制和命中一起准备，拒绝非有限命中坐标。
- 验证：geometry4/render11/heatmap2/visibility3共20通过，覆盖负值/零柱跳过、原始行号、缩放裁剪、隐藏、叠层、失败候选与旧快照；GPU6项回归、Native all-target check、repository gate和范围diff通过。一次Point元组/数组类型错误修复后检查通过。
- 本轮待办：窗口事件、线最近数据点和axis tooltip、强调/选中绘制、动态缓存revision及二维运行包仍未完成；该不可变快照不是全局Epoch，固定GPU不等于窗口视觉验收。完整P0–P3 active，未动并行D04。

## 2026-09-15 D04 Native 外包与实际内包绑定（Deep Engine 主线窗口）

- 已完成：只读 ZIP verifier 接入现有 parseDeepRuntimePackage，检查内部资源/hash及外manifest schema3/packageHash一致；场景/项目/发布时间、sourceSemanticHash、实际内包字节SHA、编译recipe及报告hash/fixture/platform/profile/status相互绑定。复用sceneCompilationSource、getSceneModelAssetId及contracts汇总，不另写编译器或哈希算法。
- 已完成：报告项精确覆盖runtime、camera和所有作者对象，objectBindings与实际runtime实例集合一一对应，隐藏对象不得保留实例；可见模型sourceAssets必须对应唯一同项目模型及包内文件的bytes/hash。映射使用Map/Set，避免逐对象二次扫描。Native元数据（场景/项目/证据/报告）单文件限64MiB，内包限256MiB。
- 验证：Node完整性专项102项通过，其中Native33项；Web真实导出与Node CLI集成所在两文件22项通过。Box.glb真实编译成功样本使用明确test-only窗口证据，11种内包/源/报告/资源映射破坏后重封外层hash仍由Native内容校验拒绝。额外覆盖隐藏对象且重绑源hash、跨项目模型。Webtypecheck/repository gate/source-size4161通过；日志test-output/d04-native-consumer-*.log。此片未改产品渲染/UI，无新增视觉验收或全量产品构建。
- 本轮待办：compileGraphHash仅检查记录间一致（现有evidence未携带完整编译选项）；证据真实性、相机/几何重新编译一致性不由此校验器证明。Native启动器强制调用、后端/feature flags合同与D06依赖冻结继续active，未碰Deep2D/Native实现车道，未提交混合工作树。
- D06只读核对：当前exporter全量applications、空modelIds回退全项目、泛递归误收modelId、URL includes选asset且遗漏maps/scriptDependencies。后续复用getSceneModelAssetId，先选择明确关联应用/页面和场景依赖再读取资源，处理导航循环/跨项目/空引用；动态脚本页面依赖不能静默裁剪。既有prepared测试中的非法简化application及空引用全模型假设需换真实夹具，不能保留泄露语义迁就旧测试。

### 2026-09-15 Native图表运行提交与指针路由（Codex）

- 已完成：ChartRuntime拥有源/状态/尺寸/几何命中帧，dispatch/resize/replace候选成功后提交；失败保持所有旧字段。几何提交更新DisplayList与Path revision并清过时hover，非几何事件保留路径；replace重放作者初始状态。
- 已完成：pointer_move从已提交命中/源提取提示数据，pointer_select切换选中；HoverSeries提供线/仪表系列级hover。--headless-chart接真实控制器，在固定640x360准备几何与命中索引后报告。
- 验证：runtime4/geometry4/hover3/initial3通过，真实CLI2/interaction3通过；极小合法窗口导致几何预算失败、坏尺寸/坏源替换保持旧帧，初始动作、指针值、选中、revision和resize/noop均验证。Native all-target check、repository gate及范围diff通过。
- 本轮待办：winit事件和覆盖层、axis tooltip/线最近点、长驻GPU缓存及增量数据/完整Epoch和二维包仍待推进，未宣称窗口视觉验收或整体完成。目标active，未动并行D06。

### 2026-09-15 Native ChartIR窗口宿主接线（Codex）

- 已完成：--chart/--smoke-chart复用现有Native窗口，PlayerContent保存ChartRuntime与实际Deep2D内容；固定640x360逻辑画布经LetterboxMapping映射光标，点击选中、滚轮X轴缩放、Home复位，状态暂呈现标题栏。
- 已完成：宿主缩放先CPU候选再既有GPU stage/publish，成功后更新CPU/恢复源；指针状态不克隆整图，缩放仍全候选待增量。非图表场景保持既有选中/Home行为。
- 验证：真实--smoke-chart读取六系列golden，在RTX4060 Laptop Vulkan BGRA8sRGB 64x64窗口初始/zoom/reset三帧均提交，scopes/callbacks clean；CLI/runtime6测试、Native all-target检查/repository gate及范围diff通过。help已列新命令。
- 本轮待办：图内tooltip/legend/选中覆盖层、真实OS输入遍历与双轮视觉评分、失败GPU注入、增量更新和正式二维发布包仍待完成；此程序驱动窗口冒烟不是可信发布证据。完整目标active，未动并行D06。

### 2026-09-15 Native真实字体栅格化（Codex）

- 已完成：核对现有platform_text仅占位图集/纯布局，新增cosmic-text0.19.0固定依赖（std/swash），复用系统字体生成真实straight-alpha RGBA；调用方颜色/尺寸，输入预算/缺字拒绝，保留字体系统并限制跨标签图片缓存积累。
- 验证：Windows实际msyh安装存在；text_raster3通过，涵盖中文/阿拉伯文/组合字符、颜色/重复像素、空态/极值恢复。Native all-target check和repository gate通过。cargo metadata核对25项新增解析依赖许可，self_cell采用Apache-2.0，THIRD_PARTY已补记录；无字体二进制入库。
- 本轮待办：实际图内tooltip/legend适配、字体GlyphRun/版本和许可打包、IME/跨端视觉仍未完成。Raster是可见视口输出，未宣称整体文字/窗口验收。spec见deep2d-native-text-raster-2026-09-15.md；完整目标active，未触Web共享dist或并行D06。

## 2026-09-15 D06 显式依赖选择与资源打包（Deep Engine 主线窗口）

- 已完成：exporter接应用/页面、模型/外观资源、运行数据三个纯选择器；空引用不回退全项目，模型按getSceneModelAssetId解析，缺/未ready/跨项目在读取前拒绝。按明确媒体字段完整URL匹配，不再JSON.includes；模型几何/层级/属性/PMI/检查/LOD及所选资源maps、安装脚本依赖进入包；同URL只读一次，声明size/hash/SRI验证，首次prepare字节仍冻结。
- 已完成：应用页面/场景按明确来源、viewport、启用动作和空间导航选择，保留活动分支后代与必要祖先，排除无关根/兄弟；profile随entry裁剪，资产声明按每应用及kind裁剪。保存根场景在selector引用检查前替换旧副本，已删除对象的旧交互拒绝；跨应用同ID跳转目标拒绝歧义。data绑定/组件/app.data到pipeline source/dataset/connection闭包，不含未引用全项目运行数据。
- 验证：应用22、资源11、runtime18项纯测试；真实JSZip依赖集成9项，检查无关应用/页面/模型排除、逐URL读取、贴图及脚本bytes/hash、缺失/跨项目零读取和hash失败零ZIP/download。Native/manifest/prepared既有夹具改显式引用/真实迁移应用，新增未引用dataset不改变contentHash。最终Web全量559文件通过/2跳过，3110项通过/2跳过，69.54秒；生产typecheck/build/预算、repository/source-size4179通过，首屏仍339.8KiB/gzip111.9KiB。新增Primitive测试缺color的类型错误已补齐并复跑31项+build退出0。日志test-output/d06-web-full-final.log、d06-web-build-final.log、d06-closure-regression.log。
- 本轮待办：启用动态脚本与语义模型依赖尚不能静态枚举，当前明确阻断打包并提示停用或仅发布；只读Worker按既有SDK权限检查，数据访问仍需声明。未登记外部静态URL、格式内部未声明外链尚未自动镜像；仅应用内及唯一显式跳转可选，未自动读取应用外项目场景。依赖版本未随发布历史冻结，重试仍可能读取更新资源，D06不标完成。Native可信窗口证据/启动器强制验证、D01/D05真实UI剩余验收及D07–D10继续active。
- 记录：新增docs/specs/scene-client-dependencies-2026-09-15.md及changelog。此片未改UI/渲染，未追加视觉评分；未提交混合工作树，已与另一窗口错开dist构建，未动Deep2D实现/合同。

### 2026-09-15 Native文字图像上传与图集UV（Codex）

- 已完成：RasterizedText生成真实Image/Atlas显示合同，身份hash/显式revision、RGBA和坐标校验；补无新依赖base64编码及RFC/全字节回读测试。
- 已完成：中文实际GPU对照暴露已有UV半像素内缩模糊，改边缘插值+片元子区域中心clamp；内部atlas顶点13float/stride52，JSON合同不变。更新旧UV断言并保留独立clamp边界检查。
- 验证：image5/runtime_atlas7/text3/新layer2共17通过、编码1通过；GPU中文alpha≤1、单格放大无串色、既有烘焙文字失败回退3通过；Native all-target/repository/diff通过。初次GPU对照失败已按根因修复，未放宽像素断言。
- 本轮待办：图内tooltip/legend、GlyphRun语义与字体版本/打包、IME和跨端视觉仍待推进。此片是图像通道和采样修复，非整个文字/产品验收，目标active。未清共享dist或改并行D06。

## 2026-09-15 D05 历史恢复原子提交（Deep Engine 主线窗口）

- 已完成：restoreScenePublication 复用既有单写实例文档事务，在入队前克隆草稿/当前发布/历史预期，事务中完整复核，发布快照/历史/版本/草稿发布设置一次提交。草稿内容和编辑时间保留；冲突 409、删除 404，写失败回滚，无半更新。
- 已完成：历史同发布时间的不同版本/内容不再被补全 helper 吞掉；仅单方缺 version 且其余 JSON 内容一致时保留旧兼容。路由先拒绝歧义历史，再停旧云会话，事务内仍复核。恢复沿用既有通知行为。
- 验证：API 全量149文件704项通过，typecheck/build/repository gate/source-size4181通过；新存储15项覆盖队列、并行保存/发布/删除、单写与重载、失败回滚、请求/返回值隔离、重复时间和错误身份。路由新增9项含公开读取、停止期间竞争与并行恢复，history新增3项含碰撞后的版本递增。日志test-output/d05-restore-api-full-final.log及同前缀typecheck/build/repository/source-size。首次全量在并行测试先写、helper后写期间读到中间态，历史2项失败；代码收口后全量704通过。未改UI，本片无新增浏览器视觉验收。
- 本轮待办：撤回/删除仍需在停止旧云会话后按捕获身份复核，避免误删新发布；数据库多API写实例CAS未实现。本片不改变postgres+minio拓扑，未提交混合工作树，未碰另一任务Deep2D/Native车道。
- D06只读方案已回填依赖文档：先发布身份绑定裁剪元数据与资源bytes/hash，重试禁止用当前项目补缺；再接内容寻址字节保留。不要把含项目运行配置的依赖附加到匿名PublishedSceneRecord，应走受保护记录/接口。已有模型历史删除保护可复用，外观资源/覆盖写入仍缺；本片尚未实现冻结协议。D01完整视觉、D05浏览器执行中取消/真实文件持久化、D06版本冻结、D07–D10 Native正式交付继续本轮待办，目标active。用户按正常进度推进，无两小时截止限制。

### 2026-09-15 Native图内tooltip呈现（Codex）

- 已完成：tooltip_render使用base.css导出令牌，真实文字/背景合成到ChartIR显示列表，靠近首次命中位置且翻转/clamp，非命中覆盖层；去控制字符/每字段64字符上限，固定文本视口仍可能裁剪。宿主深色，两主题注入测试。
- 已完成：ChartRuntime源/几何帧Arc共享，候选不复制数据集与命中索引；hover变化先CPU合成/GPU stage，成功后提交状态/恢复源；离开与zoom清除。重复同datum不栅格重建，指针不跟随浮层移动。
- 验证：runtime5/tooltip2/CLI2共9通过，真实RTX4060 Vulkan 64x64窗口initial/zoom/reset/tooltip/clear五帧GPU scopes/callbacks clean；all-target、repository gate及范围diff通过。禁用tooltip或探测分辨率无datum时冒烟明确跳过此段。
- 本轮待办：图例点击、axis聚合/线最近点、强调与选中绘制、文字溢出完善、完整二维包和动态核心仍active。未过两轮视觉闭环，无10维评分或真实OS输入证据；详见字体spec，未改并行API或共享dist。

## 2026-09-15 D05 撤回/删除与云会话完整身份（Deep Engine 主线窗口）

- 已完成：discardScene 事务捕获并克隆草稿/当前发布/操作，停止云会话后完整CAS。新保存/发布/撤回返回409，已删除404；撤回保留历史仅清publishedAt，删除清指定项目场景/current/history。legacy removeScene/removePublication复用清理函数并限定project，同sceneId其他项目记录不受影响。删除路由先查项目草稿再停Worker，错项目不触云会话。
- 已完成：云控制面publicationIdentity按project/scene/version/time/完整snapshot规范化SHA256，绑定session对象并写入registry；start/refresh/stop/policy/overview统一检查。同时间戳不同version/内容不能误停新Worker。旧registry缺身份报publication_identity_missing，保留管理员无publication stop清理路径，停止后重建；损坏hash拒绝加载。Worker现有scope合同不变，身份证明控制面归属，不证明实际加载的资源字节。
- 已完成：发布/恢复/撤回/删除的云停止错误保留CloudRenderControlError状态与code，版本冲突409，普通Worker故障502。跨系统无法原子回滚：原Worker已停止而metadataCAS/写入失败时保留元数据，不自动重启。
- 验证：API全量153文件761项通过，API独立typecheck和最终build、repository gate/source-size4193通过。新存储26项、路由17项、真实route+JsonStore+CloudRenderControlPlane联通5项（仅Worker fake）、身份9项含真实JsonRegistry磁盘重载/坏hash/health等待输入修改。日志test-output/d05-discard-api-full.log、d05-discard-api-build.log、d05-discard-api-typecheck.log及repository/source-size。无UI修改，本片无新增浏览器视觉验收。未提交混合工作树，未改Deep2D/Native/共享dist，已同步另一任务。
- 本轮待办：没有活动会话时的权威发布校验、项目DELETE整项目Worker清理、control持久化失败恢复/多API实例CAS仍缺。前端deleteScene/unpublishScene仍读取捕获activeScene；unpublish用旧scene替换列表/当前编辑器，需补成功迟到切场景及未保存编辑保护，不能以本片API保护宣称前端生命周期完成。D06元数据+字节依赖冻结继续，D01视觉、D05真实浏览器取消/文件持久化、D07–D10 Native正式交付未完成，完整目标active。

### 2026-09-15 Native图例呈现与分页点击（Codex）

- 已完成：LegendFrame复用四位置预留带，label/勾选空圈/令牌文字明暗；点击矩形与绘制相同，ToggleLegend隐藏恢复，容量不足可前后分页，128系列可达。极窄带显式错误，固定行高长标签裁剪仍待完善。
- 已完成：present_chart统一首帧/tooltip/legend呈现；翻页GPU stage成功后才提交恢复源与页码。烟测从chart控制器按职责提取chart_smoke。图例可见项暂每次hover重栅格，缓存增量待优化。
- 验证：legend4/runtime5/tooltip2/CLI2共13通过；实际RTX4060 Vulkan七系列衍生窗口九帧含显示/隐藏恢复/前后翻页，scopes/callbacks clean；all-target、repository、范围diff通过。六系列刚好容纳无需翻页，另加第七系列验证分页路径。
- 本轮待办：键盘焦点/长标签测量、省略号、强调和选中绘制、axis tooltip/线最近点、动态核心/真实二维包仍active。未过双轮截图或10维评分，未宣称真实OS输入与可信发布证据；未触并行API身份/CAS车道或共享dist。

### 2026-09-15 Native图表状态轮廓（Codex）

- 已完成：选中3px实线、hover2px、持久强调2px虚线，accent令牌；复用原路径/裁剪/变换，不新增命中/资源，隐藏系列无轮廓。系列目标从不可变几何帧读取，selection索引避免平方扫描。
- 已完成：宿主所有变化状态先GPU候选再提交，选中不再只显示标题。整体强调支持行例外；线/仪表暂无datum几何，单行强调不扩大为整系列。
- 验证：state3/runtime5/legend4/tooltip2共14通过；初测填充路径遗留fillRule错误已修复。真实GPU1确认颜色/变化像素/取消逐像素恢复；七系列窗口九帧含选中取消/图例翻页，scopes/callbacks clean。all-target/repository/范围diff通过。
- 本轮待办：axis聚合、线最近点、键盘/文字溢出、动态缓存与全局Epoch/真实二维包仍active；未过双轮视觉/10维评分、未宣称OS输入或可信发布证据。未改并行Web发布动作或共享dist。

### 2026-09-15 Native折线原始数据点拾取（Codex）

- 已完成：几何帧复用map_cartesian构建16px网格，8px逻辑半径拾取原始点，数据点不随包络降采样丢失；实际前景命中优先，距离相同后系列/较小行号稳定选择。非有限/图外/隐藏点排除，指针move/select接pick。
- 验证：line_pick4/geometry4/runtime5共13通过，1000行稠密包络保留501原始行、半径/重叠/zoom/隐藏与旧快照覆盖。测试首次缺第四列已补齐。all-target/repository/diff通过，无新增GPU或完整视觉证据。
- 本轮待办：线点选择标记、线段中部最近X和axis聚合、字体/键盘/动态缓存及完整二维包仍active；点选择暂仅状态与提示，未扩大成整线强调。空间索引按邻格查询，高密度单格仍线性扫描，未宣称全局Epoch或最终性能。未触并行Web及共享dist。

## 2026-09-15 D05 前端撤回/删除迟到响应（Deep Engine 主线窗口）

- 已完成：delete/unpublish捕获项目/场景/名称/原发布时间，跨项目输入不发API；列表按project+id更新。撤回仅对最新对象清原publishedAt，保留等待期间编辑字段和已出现的新发布标记。稳定getRoute/getScenes接AppState/context，场景代次+owner身份+route对象身份共同隔离迟到响应，含切页面但保留scene、路由A→B→A。active functional updater执行时再检查，旧结果不清新编辑器、不抢导航、不弹旧消息/错误；新发布出现抑制旧撤回成功提示。
- 验证：新增真实stateful setter回归31项；独立审查发现只检查scene不能防docs/data导航及新pub旧toast后修复并补测。最终Web560文件通过/2跳过，3141项通过/2跳过（68.60s）；build含typecheck、预算、repository gate/source-size4200通过。App保持800行门禁以下；首屏339.8KiB/gzip111.9KiB。日志test-output/d05-discard-web-full-final.log、d05-discard-web-build-final.log及repository/source-size-final。首轮3130全量通过后又补31测试/getters，最终结果取3141；中间typecheck因测试getter尚未补齐失败，最终build通过。
- 浏览器本轮证据：既有QA D05项目中复制独立副本并命名D05 撤回交互验证 2134，保存名称、仅发布成功，截图查看卡片及更多菜单，撤回confirm文案实际出现。随后CUA回报confirm中断，getJsDialog空，AX/pressEscape/close均因CDP Emulation.setFocusEmulationEnabled超时，未重复撤回，不能证明confirm已取消或撤回成功；标签可能仍留确认框。原D05场景与历史未动，副本保留。
- 本轮待办：真实浏览器撤回/删除、两轮双主题视觉及Kimi95评分未过；未以截图或单元测试代替，下一次先检查现存tab状态再继续。D06依赖版本+字节冻结、D01完整视觉、Native正式交付仍未完成；无活动会话权威发布校验/项目级Worker清理/存储恢复为并发待办。未改Deep2D/Native，最终Web构建后共享dist占用释放，未提交混合工作树；完整目标active。

### 2026-09-15 Native折线选择与悬停点标记（Codex）

- 已完成：索引增原始行排序坐标表，折线select/hover按相同已提交坐标绘制5/4px令牌色填充点；plot裁剪、无命中、隐藏/zoom同步，同点select优先。state合成仍候选原子提交。
- 验证：state4/pick4共8通过；GPU2确认整线与点局部变化/取消逐像素恢复；真实纯折线窗口五帧含提示/点选取消，GPU scopes/callbacks clean；all-target/repository/diff通过。初版闭合stroke被几何校验拒绝，复用圆角fill后通过，未放宽校验。
- 本轮待办：持久单行强调标记、axis聚合与线段中部最近X、文字/键盘/动态核心及真实二维包仍active；坐标表增加内存尚待整体预算核算。无两轮视觉评分/可信发布证据，未改并行Web与共享dist。

### 2026-09-15 Native轴Tooltip聚合（Codex）

- 已完成：TooltipContent按共享xAxisId/同值聚合可见line/bar/scatter，保留源行、label/value，最多8项并报告omitted；Item仍单项，对数轴拒绝无效值，隐藏系列不显示。视口高度随条目数调整。
- 验证：tooltip_content3/tooltip_render2/runtime5共10通过；all-target/repository/diff通过。测试覆盖共享X、隐藏、单项、20系列截断。当前锚点仍来自命中数据点，线中部最近X、时间对齐与跨帧文字缓存待做。
- 本轮待办：动态Epoch/缓存/二维包、键盘/溢出、P0正式发布证据和视觉闭环仍active；未宣称任意ECharts兼容、OS输入或最终发布。

### 2026-09-15 D05 前端路由/新发布归属补强（Codex）

- 已完成：撤回/删除作用域再加入最新 route 与 scene list getter；打开文档/数据页但保留同一场景时，旧删除不再抢 manager 导航；新发布出现时旧撤回不清除发布标记，也不显示旧成功消息。功能式 updater 保留新编辑字段。
- 验证：focused discard/publication 68项通过；最终 Web 全量3141通过/2跳过、build和门禁通过。当前工作树未修改 Deep2D/Native合同。
- D06判断：当前 artifact record 只冻结 publication snapshot fingerprint，runner重试仍调用实时 project/app/resource API；依赖版本+字节冻结不能靠现有 record 宣称完成。下一片需在受保护发布记录中保存裁剪依赖与内容寻址字节，不能回退读取当前项目。

### 2026-09-15 GLM交接文档（Codex）

- 新增 docs/GLM-Deep2D-接手交接-2026-09-15.md：整理主方案目标、Native/Deep2D已完成能力与证据、专项命令、P0/P1剩余缺口、并行文件边界和GLM首个动作。明确未把夹具/GPU冒烟扩大为正式发布或三端等价。
- 验证：本文件链接/格式经repository gate与git diff --check通过；不修改并行Web/API实现。

### 2026-09-15 GLM交接文档
- 已新增 docs/deep-engine-glm-handoff-2026-09-15.md，记录D01-D10当前证据、D06依赖冻结下一步、禁止触碰Deep2D范围和验证命令。

### 2026-09-15 继续研发与轴提示证据修正（Codex）

- 用户取消GLM交接，明确由本任务继续完整P0–P3目标；交接文档仅保留历史，不作为暂停或完成依据。
- 已完成：纠正隐藏系列测试误走heat单项路径，显式line锚点断言剩余line/scatter；补跨dataset倒序原始行映射、独立xAxis排除、格式化标签不参与源值匹配。清除调试输出和名不副实的log测试名，旧“已测试log无效值”表述无对应证据，撤回该验证结论。
- 已完成：same_value避免大整数经f64舍入误合并，保留小整数/浮点等值与数字/字符串区别。数值单元1、聚合4、呈现2共7通过，all-target/repository/范围diff通过。
- 本轮待办：P0二维运行包和权威loader集成仍优先；当前未完成全局Epoch、可信发布证据和跨端视觉验收，完整目标active。

### 2026-09-15 P0独立二维运行包入口（Codex）

- 已完成：buildDashboardRuntimePackage复用现有builder包装真实已编译Deep2d路径/atlas/quad，稳定空场景入口，无占位模型；沿用schema/hash/资源检查及深拷贝。已从runtime-package叶入口导出。
- 验证：真实atlas夹具专项2通过，覆盖serialize/parse、revision与ID、输入隔离、坏像素拒绝/恢复；deep-engine tsc、repository及范围diff通过。本批未构建共享dist。
- 本轮待办：组件lowering、DashboardDocument实际发布接线、ChartIR动态语义入包、能力报告/hash绑定和Native跨端golden尚未完成；此入口不能视为整个二维发布完成。spec见deep2d-dashboard-runtime-entry-2026-09-15.md，目标active。

### 2026-09-15 P0二维包跨语言golden与真窗口（Codex）

- 已完成：独立脚本从真实TS builder生成dashboard-runtime-v1.json，临时bundle在test-output，不改共享dist；TS对照重建，Native读同包准备路径/atlas并拒绝篡改像素。
- 验证：TS2/Rust2通过；RTX4060 Vulkan --smoke-package呈现64x64、path1/atlas2/glyph2/image1，GPU scopes/callbacks clean，present后恢复检查点提交。包hash 8e2f1292db93a43d7b15f63f4933a6c60f29dee6560212c51ccd31ac96f417c6。TS typecheck/Native all-target/repository/diff通过。
- 本轮待办：输入仍为已编译atlas夹具，未完成DashboardDocument组件lowering/动态ChartIR入包/发布接线和对象能力报告，也不等于可信发布证据或双轮视觉；P0–P3 active。

### 2026-09-15 用户期限与性能要求（Codex）

- 用户要求从本次指令起三小时内全力推进全部任务；收到时间约北京时间22:28，期限约2026-09-16 01:28。持续推进原P0–P3范围，时间限制不改变验收条件；到点按实际证据报告完成与未完成项。
- 用户补充研发要深度思考，以WebGPU/GPU性能为核心。按CPU/GPU耗时、显存、增量更新、上传与恢复证据判断优化，不以“最强”口号代替基准。

### 2026-09-15 作者形状内容与二维GPU分配（Codex）

- 已完成：compileDashboardContent复用外框合同，矩形/圆角/椭圆真实矢量内容，17px内容内缩、稳定ID/z/隐藏；显式颜色/无边框子集，逐对象degraded/blocked和未消费字段，publicationReady=false。source/compile/target hash绑定真实内容；生成器生成作者源/编译结果/运行包共享golden。
- 验证：Web内容/布局17项、Native内容2项通过，实际RTX4060 Vulkan 64x64窗口path3/segments116/triangles110/vertices330、scopes/callbacks clean；包hash 9e61ac0688ffb6e830ffd22be61c0aca4134561b36e72e594bbd2884a0a4f84e。完整组件背景/阴影/文字/行为和正式发布接线未完成。
- 已完成：二维空场景且无差分probe时CSM深度贴图从64MiB降到64KiB，保留级联/绑定ABI；文件打开/包热更新跨分配配置走独立候选renderer验证，底层增量API拒绝跨配置。三维仍完整2048²×4层。
- 验证：profile单元1+真实GPU切换1通过（2D→3D→2D，65536→67108864→65536字节；错误增量更新后旧帧可用）。这是纹理描述符字节，不是总显存或FPS收益。完整三维管线/IBL仍分配，继续测量优化。
- 并行Web D06正在改动：首次Web tsc除本片fixture类型问题外有对方中间态错误，已同步；本片fixture类型已修正，最终检查结果另记。未改D06文件或共享dist，无正式视觉评分，完整目标active。详情见spec deep2d-dashboard-content-2026-09-15.md。

### 2026-09-15 二维管线按内容创建与最终检查（Codex）

- 已完成：同一二维配置跳过12 mesh+9 shadow pipeline及mesh shader模块；启动诊断按实际计数报告。3D配置仍完整创建；跨配置走前述完整候选epoch。
- 验证：最终profile单元1+GPU1通过，2D/3D/2D实际pipeline=0/0→12/9→0/0。真实package drop GPU完整回归1通过（6.25s），新增3D→2D→3D文件打开与present后LKG检查，既有IBL/Shader/源域像素与错误回退均通过。
- 验证：Web内容/布局17通过、Web独立tsc通过；Native内容/包4通过、Native普通bin68通过25显式GPU忽略、all-target无warning通过；repository gate通过。增加跳过pipeline后又跑profile/drop GPU与all-target，后续门禁继续。
- 未完成：二维仍分配IBL/前向目标并编码空背景pass，未测总显存/帧率收益；组件整体/正式发布/动态核心和视觉证据仍active。GPU空档已交还并行D06/D10任务执行v3窗口验证，本任务不与其并发GPU。

### 2026-09-15 D06 发布依赖冻结与 D10 启动入口（主线 Codex）

- 用户取消 GLM 交接，要求本窗口继续并最大并行，以三小时窗口推进 D01–D10；范围未扩大到另一窗口 Deep2D。handoff 文档保留为历史记录，不再交由 GLM 执行。
- 已完成：Web 三个依赖选择器迁到 studio-core；SDK scriptModuleAdapter 移入 scene-sdk，Web 原路径重导出。新 selectSceneClientDependencyInputs 共用裁剪与脱敏，诊断导出保留本次签名读取并在写包前脱敏。
- 已完成：带 clientTarget 的发布先服务端捕获内容寻址资源，事务复核草稿/原发布/依赖输入再提交独立 scenePublicationDependencies；Native 必须携带预检输入和实际资源 SHA。旧仅发布兼容，无冻结记录的历史打包明确拒绝；恢复复制历史依赖并重绑新发布身份，撤回保留，场景/项目删除及历史裁剪清理元数据。
- 已完成：Local 完整 staging 文件 hardlink no-clobber，现有坏文件拒绝；MinIO 上传后读回 SHA/bytes，流取消清理子进程。256MiB 单文件/1GiB 总预算；路径拒绝跨项目、dot/empty、junction/设备名等；文件symlink测试因权限skip，真实junction覆盖。失败不删除共享hash blob；未做自动GC。
- 已完成：依赖与资源走受保护项目版本路由；公开 assets 拒绝 private 冻结目录及点段/重复slash/Windows短名等别名。Web首次交付/重试只读对应完整发布身份记录；prepared需匹配被冻结输入和资源SHA；不读实时project/apps/rawURL。公开browse/云渲染仍有实时项目读取，不属于本片保证。
- 验证：API全量158文件，818通过/1skip，build通过；Web最终564文件通过/2skip，3185通过/2skip（73.40s），typecheck/build通过；首屏340.8KiB/gzip112.2KiB；repository gate和source-size4240通过。日志test-output/d06-api-full.log、d06-api-build.log、d06-web-full-final.log、d06-web-build.log、d06-repository.log、d06-source-size.log。首次Web全量仅旧历史compatibility测试漏mock失败，补真实冻结fixture后最终通过。
- 验证：真实MinIO源32字节捕获后覆盖，冻结仍old；错误hash/取消拒绝，独立qa-d06前缀已全部清理。证据test-output/d06-minio-live.json。固定admin/admin及postgres+minio未改。
- 浏览器：按既有启动器恢复web core，API4100/Web5173健康。在QA D05项目复制独立场景“D06 冻结版本打包验证 2240”，Three WebView发布v1，重新打开及刷新后显示“已生成 版本1”。再次下载后仍ready且console error/warn空，但CUA waitForEvent(download)超时，不能据此证明文件已落用户磁盘。旧D05场景保留。
- 已完成：scripts/run-scene-client-native.mjs + pnpm run:scene-native 显式Native exe入口，正式ZIP全量验证后同buffer固定runtime文件提取再spawn，close/失败清临时目录；launcher和旧verifier共108测试通过，进程替身不代表真实最终窗口。
- 验证：当前v3真实headless三组通过report test-output/deep2d/scene-interop/7783c106-d5bb-42b3-bebb-674d4536e18a/report.json。与另一窗口协调空档后cargo build --locked及v3 GPU三组Primitives/Box/BoxTextured通过，report e262bbce-6318-4237-a8f2-07178fa5946d/report.json，EXE SHA 47db6377cb3ed8e3c48131675be40a5a8016a870067cb7f21bd56b1313075499。GPU已归还，无Native源码改动。
- 本轮待办：D09局部原点纯helper sceneLocalCoordinates.ts + tests15已完成，但尚未接compiler recipe/evidence/verifier；不能关闭完整D09。D01完整双主题双轮视觉及评分、D10可信证据注入与正式ZIP真实启动仍待完成。主目标active，不把无窗口/64x64smoke/进程替身扩大成正式交付。混合工作树未整批提交。

### 2026-09-15 ChartRuntime批量数据与滚动窗口（Codex）

- 已完成：独立data_revision，expected+next校验；多数据集Replace/AppendWindow候选批次、重复/未知引用/行宽/标量/预算失败不提交。全量ChartIR替换也推进data revision。窗口淘汰后选中、持久强调和初始动作按原始行迁移，全量替换清逐行身份但保留图例/zoom/系列选择。
- 已完成：同内容数据复用source/frame；只改未引用或完全隐藏数据复用几何/命中帧。宿主在frame指针与呈现状态均未变时只提交数据、跳过文字与GPU候选；可见变化走既有CPU候选/GPU stage/恢复源提交。
- 验证：数据7/runtime5/tooltip4共16通过，Native all-target、repository与范围diff通过。真实RTX4060 Vulkan --smoke-chart共享golden，main 2→3行/data_revision=1后继续zoom/reset/tooltip/select/clear，scopes/callbacks clean；pure2D profile仍0/0 pipeline与64KiB shadow。不是OS输入或外部数据传输证据。
- 本轮待办：接口为Rust typed host command，尚无外部消息envelope/sim连接/动态ChartIR包入口。可见数据变化仍复制ChartIR容器并重建整图；列块共享、逐系列依赖图/局部GPU上传、全局Epoch继续P1。spec见deep2d-chart-data-update-2026-09-15.md，完整目标active。

### 2026-09-15 ChartDataUpdate v1消息与跨语言回放（Codex）

- 已完成：TS/Native严格v1 envelope，chartId归属、expected/next revision、16MiB UTF-8入口和既有JSON预算，操作/字段/引用/行宽分别在parse与apply检查。Native窗口data smoke已从typed直调改为encode→parse→apply消息入口。
- 已完成：TS apply参考源协调与真实生成器产出chart-data-update-v1.json；Native回放同消息并按完整ChartIR类型对照滚动窗口/替换、行与initial actions。提取数值相等公共函数，整数/等值浮点不误清选择，保留大整数类别身份规则。
- 验证：TS消息19+IR reader22=41通过，tsc通过；Native消息5/数据7/tooltip4=16通过，旧数值单元1通过，all-target/repository通过。初次JSON Value对照因f64字段80.0与80差异失败，改为合同解码后完整类型比较，未删除任何字段。
- 本轮待办：TS参考apply仍全验证/快照；外部传输、sim宿主、包内动态ChartIR、全局Epoch/列块与逐系列GPU增量仍未完成。新消息GPU链尚未重跑（GPU空档交并行任务做D09/D10正常窗口）；之前typed数据GPU证据保留，不能扩大为新消息GPU结果。目标active。

### 2026-09-15 离线 Chart sim 与固定时钟回放（Codex）

- 已完成：TS/Native Chart sim v1夹具合同，固定时间步、seed旋转循环行、bounded append-window消息。prepare不消费游标；chart/GPU候选提交后才确认revision。实例身份、重复/伪造帧、取消、时钟/版本耗尽校验，所有输入行均检查。
- 已完成：Native --chart-sim普通入口与--smoke-chart-sim探针；source/单调时钟归属PlayerContent，换包销毁。普通宿主每次唤醒至多一帧、追赶至少10ms、失败100ms重试、相同错误去重；取消/无源回事件等待。
- 验证：TS sim20+data消息19共39通过、tsc通过；Native sim9+data消息5+data更新7共21通过，bin72通过/25显式GPU忽略，all-target无warning通过。生成器执行实际TS代码，Native逐帧比较消息/时间戳/dataRevision/完整ChartIR。repository与范围diff检查通过。
- 验证：RTX4060 Laptop Vulkan 64x64真实sim初始+3数据帧Presented，scopes/callbacks clean，取消后无消息；普通chart smoke的新消息encode→parse→apply链及zoom/reset/select/tooltip/clear也通过。未并发占用GPU，已与主线协调。
- 本轮待办：普通入口真实定时/正常尺寸窗口及故障恢复长流程、GPU拒绝sim游标的真实注入仍待；本次失败候选为CPU测试。此sim是离线行夹具，未接API sim://telemetry；包内动态ChartIR、HTTP状态机、全局Epoch/共享列块/逐系列GPU增量未完成，可见数据仍整图重建。无FPS/总显存收益结论、无完整视觉验收。详情spec deep2d-chart-sim-2026-09-15.md，目标active。


### 2026-09-15 D09 v4 与 D10 服务端 Native 候选流水线（Codex）

- 已完成：固定构建 bundle 复用 Web 编译/兼容逻辑，服务端冻结字节→独立 Worker→正常窗口验证→同编译器证据复核→私有运行包→actor/快照绑定的10分钟单次候选租约；HTTP 与浏览器发布接线已落地。部署配置与边界见 `docs/specs/scene-native-publication-evidence-2026-09-15.md`。
- 验证：v4 三样本及十亿坐标对照共6 headless，近远相机/packet/对象映射一致，坐标帧参与graph hash；`56fa5958-ff27-4249-8dbb-3cf75e24b6e3` GPU报告只有3个近原点样本实际smoke，不计Large的null字段为GPU通过。
- 验证：真实BoxTextured十亿坐标完整service.prepare，Vulkan正常窗口1200×800/3 Presented/GPU clean，私有产物hash核对及reserve-release-reserve-commit通过；临时项目已清理。证据 `test-output/native-service-real-report.json`，EXE SHA `6be778a10e3747f8bd9426bdb633fa1588e1e5d2a9ef573c400e77ae0797aa70`。独立正常窗口早期证据保留于 `test-output/d10-native-window-live.log`，不混用EXE身份。
- 本轮待办：完整浏览器发布→正式Native ZIP下载→launcher打开同包、断网与失败恢复以及截图视觉验收；当前服务实跑不替代该完整UI交付门禁。

- 验证补充：API build（tsc与两类bundle）通过。4 worker API全量165文件中947通过/1跳过，1个既有scriptGitService本地bare仓库用例超20秒并产生EBUSY清理错误；隔离单worker复核该文件4项通过（9.84秒），不记作全量全绿。日志 `test-output/d10-api-full-final.log`、`d10-api-scriptgit-recheck.log`、`d10-api-build-final.log`。真实sharp worker用例单独设置15秒测试预算与12秒取消，重跑已通过。

### 2026-09-15 Chart按系列增量几何与CPU基准（Codex）

- 已完成：ChartGeometryFrame按系列保存依赖与Arc命中/线索引；数据更新、axis zoom和resize接增量准备。未变数据/轴/window/plot的系列复用路径与索引，保持path revision；新系列资源直接移动入扁平帧，不缓存第二份路径或历史帧链。隐藏项移除，重新显示读当前数据；全源替换清依赖。
- 已完成：折线绘制与原始点索引共用一次坐标映射；降采样仍保留原始行身份，前景/逆绘制顺序/等距后系列优先与原行为一致。work诊断公开实际重建/复用系列与索引计数。
- 验证：新增增量5项覆盖完整显示列表与全渲染器相等、网格hit/pick/command target、独立数据/轴缩放/resize/隐藏更新/替换重排/失败原子性；Arc共享单元1通过；原33项回归通过。合并映射后22项相关回归再通过，chart库15通过，all-target/repository/diff检查通过。GPU最终结果另记。
- 性能：i9-12900HX Release，1280x720，8系列各8192行，预热5/样本20交替执行；保留旧全帧算法步骤为基准。最终同轮旧全帧median11.3270ms/P9514.6453ms，当前全量10.5913/14.3080ms，局部重建1复用7为3.8502/7.1539ms；局部中位约减少66%，全量约减少6%。中间全量回退已通过共用映射修正。仅几何/验证/命中准备，不含source patch、文字、GPU上传/呈现，非FPS收益；不同轮并行负载不直接比较。
- 本轮待办：ChartIR仍整体克隆/校验、扁平列表仍复制保留路径，未接共享列块/局部顶点上传/全局Epoch。其他P0–P3原范围保留，完整视觉与正式发布验收未完成；详情spec deep2d-chart-series-incremental-2026-09-15.md，目标active。
- 最终GPU：合并映射后chart_gpu_tests再次11项通过（1.24s），涵盖增量对全量逐像素一致、拒绝更新旧帧、缩放/图例/选择/中文文字/atlas边缘；此前sim三数据Presented证据保留。GPU已归还主线。无实际GPU局部上传或最终视觉评分结论。

### 2026-09-15 D10 真实 HTTP 发布与同 ZIP 离线首帧（Codex）

- 已完成切片：独立 JsonStore/LocalObjectStore + localhost 真实登录/鉴权 → 私有固定 compiler bundle → 十亿单位偏移 box → Native 正常窗口候选 → 发布候选租约 → 私有 runtime → 真实 Web exporter ZIP → 正式 CLI 校验 → 同 ZIP launcher `--verify-window`。复用脚本 `scripts/verify-native-publication-http.mts`；未读取或改动用户项目，不代表实际 Postgres/MinIO 加浏览器点击下载链已验收。
- 证据目录：`test-output/native-publication-http/d22e72ec-0881-4e2d-a2ce-a342745611bd/`，report/window-evidence/offline-window-evidence/candidate/publication/dependencies JSON 与原始 offline-window.log 齐。ZIP SHA `547122966b1234d0e473098796c6f7af2d6a0f80c9aa275648c6a9f02d5fe84d`；运行包字节 SHA `2c18f5e33d84123a03a95699901b8408763cd7a35315ef4eca5c6db1dd497b38`，CLI 8 文件/11560 字节通过。
- 实际窗口：候选 Vulkan1200×800/12帧/GPU clean，EXE SHA `fa788f780ed26c42e745cb710bf8149e6a9307c613f7a81606f134d29130b946`；同 ZIP 离线 Vulkan1200×800/3帧/GPU clean，EXE SHA `e72182573db3683d792a5d2e8ddb65862f5d0343485b8a6c975841cc7e9b4ee0`。并行构建更新 EXE，两次分别记录，不混为同版本。离线步骤无需 API，未做系统断网注入。
- 验证：HTTP专项19项，相关5文件72通过，API类型检查通过；launcher/window核心33通过。正常launcher仍--package，显式--verify-window共用同buffer归档校验/提取并固定3帧检查，拒绝传入report/nonce/frames；坏包、报告身份、GPU/帧数失败及清理覆盖。详见specs/scene-native-publication-evidence-2026-09-15.md与scene-client-package-integrity-2026-09-15.md。
- 本轮待办：实际Postgres/MinIO浏览器发布下载、断网/失败恢复与完整视觉门；D09 GLB内部大坐标、测量拾取、跨原点和阴影容差未因此关闭。

- D10 取消审查修复：发现路由检查signal后进入存储队列，排队时断连仍可提交。现publishSceneSnapshot通过独立options.signal在真正mutation入口再次检查；信号不写入合同。PostgresStore继承同一方法，覆盖同族；写盘已开始后按提交结果处理，避免内存/磁盘分叉。增加4项回归，HTTP专项现23项，相关5文件76通过、API tsc通过；含真实socket排队断开后的lease重试、排队Abort/timeout、写盘开始后取消的一致提交。

### 2026-09-15 D10 API 最终 v2 门禁（Codex）

- 发布取消采用独立options.signal，排队前与真正mutation入口检查；JsonStore/PostgresStore共用，写盘开始后以提交结果为准。HTTP专项23项及相关5文件76通过，排队socket断连/timeout/lease重试/写盘后取消一致性均覆盖。
- 最终全量：`pnpm --filter @bim-studio/api test --maxWorkers=2` 退出0，165文件全部通过，954通过/1显式跳过，77.42秒；此前scriptGit并发超时本轮未复现。日志 `test-output/d10-api-full-final-v2.log`。
- 最终构建：`pnpm --filter @bim-studio/api build` 退出0，tsc与固定compiler/window-verifier bundle通过，已包含当前D09 helper源码。日志 `test-output/d10-api-build-final-v2.log`。本次仅CPU门禁，不新增GPU或真实窗口结论。

### 2026-09-15 Deep2d路径顶点增量传输（Codex）

- 已完成：stage_update按细分命令的完整顶点字节匹配旧范围，CPU上传变化部分，GPU copy保留范围到独立候选缓冲；合并连续区域，保持原单buffer与绘制批次。重排/删除/变长支持，局部匹配哈希后精确字节复核；全buffer缓存命中直接复用。旧GPU缓冲不写入。
- 已完成：CPU shadow按painter/device epoch持有，最大8MiB/4096范围；不足16KiB保留数据或超过64个copy区域退回连续上传，避免小更新碎片化提交。公开路径uploaded/copied/reused/region/shadow统计，renderer getter与启动诊断接入；未改camera/主线verification。
- 验证：CPU planner5项通过；首轮chart GPU12项通过。加入小数据阈值后的真实128点改1点：path total55296字节，CPU upload432，GPU copy54864，draw chunks仍1；像素与全量上传完全一致，重排零CPU上传/同内容缓存/非法候选旧画面保持通过。原deep2d缓存/中文/路径裁剪/DPI等6项真实GPU通过；Native普通bin77通过/27显式GPU忽略、all-target通过。GPU已归还主线。
- 本轮待办：只证明该夹具CPU路径上传减少99.2%，仍新分配GPU候选缓冲并GPU复制，非FPS/显存收益。路径仍全细分，ChartIR/扁平列表/atlas仍有全量路径；共享数据、命令细分缓存、持久顶点分配、全局Epoch与P0–P3其他任务未完成。spec deep2d-vertex-transfer-2026-09-15.md，目标active。

### 2026-09-15 Deep2d命令细分缓存（Codex）

- 已完成：pure painter/runtime与真实GPU painter接入Deep2dPathCache，比较真实路径/样式/transform/opacity/clip路径/scaleFactor。revision-only不重建，同revision改内容强制失效；z/hit/scissor使用当前元数据。缓存输出与原Prepared全结构相同；图片文字atlas仍原路径。
- 已完成：每painter链共享、设备重建新建缓存；4096条/8MiB记账载荷、有序LRU触碰/淘汰，避免逐条线性扫描全缓存。计账不等于精确进程内存。命中/失效/淘汰/条目/载荷统计接renderer与启动报告。
- 验证：缓存集成6+容量/LRU2通过，既有painter7/描边矩阵4/atlas7通过；最终图表真实GPU12项通过，128点改1点同次path hits127/misses1、upload432/copied54864/total55296字节、1批次，像素一致且失败旧帧保持。all-target无warning通过；最终仓库门禁另跑。
- 性能：i9-12900HX Release、128条曲线路径改1条、预热5/样本20交替；无缓存median13.0562ms/P9514.2828，冷缓存13.7404/15.7270，局部0.8106/0.9991，载荷1223972字节。局部约减94%，首次构建增加0.68ms/约5%；首次成本和内存权衡留作优化项，不能宣称所有负载不退化。仅显示列表校验/细分阶段，不含ChartIR/atlas/GPU。
- 本轮待办：ChartIR数据快照/校验、扁平列表、atlas仍有全量路径，细分缓存与顶点shadow存在独立驻留；共享数据/减少重复驻留/全局Epoch/持久GPU分配与原P0–P3任务、设备故障和完整视觉门禁继续active。spec deep2d-path-cache-2026-09-15.md。

### 2026-09-16 D09 v5 六样本 GPU 与跨原点回退（Codex）

- v5 互通补齐：Primitives/Box/BoxTextured及十亿偏移，六个GPU字段均有真实64×64 Presented/scopes+callbacks clean，不是OS截图。报告 `test-output/deep2d/scene-interop/07f43a8d-5707-4611-bf5e-1019364ad797/report.json`；对应headless `8f334bcf-8802-40d4-87e9-54c0cdabcc8a/report.json`。固定EXE SHA `3d75c506006d6c9994ed640ea499a5e28492e62421c1ef81de014f411baa351d`，旧v4仅三个近原点GPU记录不改写。
- 已完成切片：真实v5 compiler生成非空box，再对同世界场景/相机重基1000单位并重封hash，Native验证两包ID/geometry/material/world位置一致。PlayerContent保持用户旋转/距离并转换target，生产Renderer候选离屏验证→activate surface→实际present；失败候选不替换active，旧场景再present。新测试只cfg(test)注册，不改主renderer/Deep2D行为。
- 实测阈值在首跑前冻结：640×480 HDR纹理逐字节变化像素≤1%、总亮度相对差≤0.1%、失败回退逐字节一致。实际变化0.3974609375%，亮度差0.00101685605%，回退0变化；RTX4060 Laptop Vulkan，GPU scopes/callbacks clean。日志 `test-output/d09-coordinate-frame-gpu.log`，这是渲染纹理读回，不是系统截图。
- scoped review及CPU门禁：当前runtime相关17、PlayerContent4、双包身份1共22通过，GPU1在CPU命令显式忽略；all-target check通过无warning。日志 `test-output/d09-native-camera-review.log`、`d09-native-all-target-review.log`。TS相机/坐标/runtimePackage三文件82通过，`test-output/d09-camera-final-v3.log`。未发现本片新增需修缺陷。
- 边界：只覆盖固定box/1000单位重基/当前相机配置；拾取测量工具、连续跨原点运动、法线与独立阴影容差尚未关闭。规格已更新 `docs/specs/scene-local-coordinates-2026-09-15.md`。本次复核不重复运行GPU。

### 2026-09-16 Chart数据快照共享（Codex）

- 已完成：ChartRows共享未修改数据集行存储，可变访问只分离当前数据集；JSON v1仍为二维数组，Rust Vec构造增加into。追加窗口移动输入新行，空追加且不淘汰时复用源。完整候选校验与旧帧/状态/版本保持沿用现有事务，无依赖/存储拓扑变化。
- 验证：新增共享/写隔离/完整wire/成功事务/窗口/候选失败5项，数据7+消息5+sim9+增量5通过；chart_*集成全套和lib全套通过，bin81通过/28显式GPU忽略，all-target通过。未因行容器修改重跑GPU；CPU完整几何和TS消息回放保持一致。
- 性能：i9-12900HX Release，8数据集×8192行×4列混合中文数值，5预热/20交替样本；源快照逐单元复制median25.5731ms/P9530.0249，共享median0.0124/P950.0207。仅源clone，旧方式复现含每数据集一次额外Arc clone；不包括校验、数据patch、geometry或GPU。spec deep2d-chart-rows-snapshot-2026-09-16.md。
- 上片收尾：路径缓存最终Deep2d真实GPU6项及repository/diff检查通过。全局目标继续active；数据集内旧行追加仍复制、全量校验重复扫描、列块/全局Epoch和原P0–P3剩余任务未完成。

### 2026-09-16 主线 00:30 交接收尾（Codex）

- 用户最新安排：本主线于00:30前收尾交给其他模型，不再扩展新范围；冻结目标仍D01–D10，Deep2D由另一任务交接。未将总目标标为完成。
- 发布语义复核修复：Web assessor从源重新计算scene/object deferred并与证据取并集；CLI v4/v5独立检查相同集合并重算完整camera，重封hash后FOV/near/far/revision/weather/object binding伪装均拒绝。CLI矩阵172通过；Web全量3294通过/2跳过，API954通过/1跳过，类型/APIbuild通过。日志 `test-output/d10-cli-source-audit-final.log`、`d10-deferred-web-full.log`、`d10-deferred-api-full.log`、`d10-deferred-web-typecheck.log`、`d10-deferred-api-build.log`。最后Webbuild通过，`d10-handoff-web-build.log`，首屏341.3KiB/gzip112.3KiB。
- D10 v5独立HTTP→同EXE候选12帧→Web ZIP→停止测试API→同ZIP离线3帧通过，Vulkan1200×800/GPU clean；报告 `test-output/native-publication-http/e324c9e2-c692-4bab-a2fb-68d979f36432/report.json`。复用脚本现在独立冻结EXE，避免并行构建改变两次身份。
- 实际PG/Minio：导入最小十亿坐标box后在工作台发布版本1成功，scene8cde10ca-af44-4c3e-8920-4f3077653765；浏览器落盘未捕获。只读同版本私有字节→真实Web导出函数→CLI8文件12133字节→正常窗口3帧通过，报告 `test-output/d10-browser-native-evidence/b4110c70-99e3-4303-8658-636ab008cefc/report.json`。发布/运行EXE和compiler分别记录，未重新发布/未重编译历史包；此公共服务未停止，不能记为系统断网验证。
- D09工具：复用pick_world边界输出f64世界点，measurement存f64，渲染/标注局部点不变；reset恢复作者相机。冻结逐轴拾取.001、往返1e-6、双点距离.004；实测最大2.38419e-7/0/4.08885e-7。bin84通过/28显式GPU忽略，all-target通过；旧packet selection probe真实输入/measurement/blankclear/GPU64×64通过，origin-a/b工具仍仅CPU。日志 `test-output/d09-world-tools-bin.log`、`d09-world-tools-check.log`、`d09-world-tools-selection-gpu.log`。
- 运行恢复：文档生成PNG造成Vite FSWatcher EBUSY，supervisor带停API；恢复相同postgres/minio拓扑后PID51408健康。文档任务停止直接写public，生成资产改临时文件后替换。未改账号/.env/用户数据。
- 门禁：`test-output/d10-handoff-repository.log`通过；`d10-handoff-source-size.log`全仓4304源文件通过800行上限，无豁免。本主线没有整批暂存或提交混合工作树。
- 本轮待办：浏览器真实ZIP落盘及同包链、带帧包真实拾取/测量输入、连续跨原点、法线/独立阴影容差、持久化标注世界合同、系统断网/完整失败恢复与完整视觉验收。普通Studio默认环境/灯光/后处理等仍严格阻断。详见主线任务清单及坐标/候选/视觉规格，不按历史“待建”表重复实现。

### 2026-09-16 Deep2D 00:30收尾交接（Codex）

- 用户最新决策：将收尾提前至00:30，写交接，由其他模型完成剩余任务。本窗口停止扩展和编码；原Deep2D研发目标未完成，不标记complete。
- 永久剩余总表：docs/specs/deep2d-remaining-tasks-2026-09-16.md，P0 8项/P1 23项/P2 4项/P3 5项/项目级后验收5项，共45项，覆盖原方案全部未关闭任务并列明确排除。旧GLM交接新增过期提示和新入口。
- 交接入口：C:/Users/rain/AppData/Local/Temp/Deep2D-handoff-2026-09-16-0030.md；包含五节状态/决策/技能/证据，引用永久总表及三维主线独立交接。结构自检、敏感信息检查通过。
- 最终检查：ChartRows相关测试及前述chart/lib/bin通过；新增重复校验Release基准median4.7761ms/P957.2712ms。行统计缓存没有实现，未接线草稿已移除。最终cargo check all-targets无warning、repository gate、范围diff均通过。README架构图片断链为文档并行任务中间态，恢复后门禁已重跑通过。
- 交接边界：本窗口无运行中的测试/构建/GPU进程；主线独立任务继续世界拾取/测量与正式发布收尾。未commit/push，保留全部并行变化；交接不把当前CPU证据扩张成行容器GPU复测或完整视觉验收。

### 2026-09-16 主线续跑与 Deep2D 00:45 统一交接（Codex）

- 用户最新安排：主线继续至00:45，并与“评估 Deep2D 终局方案效果”窗口交接合并。Deep2D确认00:30交接后无代码/文档改动及运行中的任务；该窗口45项剩余表全部保留。本节取代前两节的停止时间与独立交接安排，两条研发目标仍未完成。
- 已完成：新增严格 `--smoke-package-selection <runtime-package.json>`，复用精确package loader，无LKG回退；缺参、多参、不存在及packet冒充包在创建窗口前拒绝。旧packet入口不变；独占改动为cli_viewer_tools、player_cli help和app/selection_probe，未改ChartRows/Deep2D实现。
- 已完成：origin-a/b及legacy三组64×64 GPU smoke，合成Cursor/Mouse/IME事件进入实际window handler，校验世界测量、选择聚焦、清除、作者相机reset及旧局部标注保存恢复。报告 `test-output/d09-package-selection-report.json` 明确两个独立启动包，不是同进程连续重基点、OS硬件输入或正式发布ready。
- 已完成：独立审查发现初版probe打印参考距离，修正为工具实际值和参考值分别记录，并重建重跑三组。实际距离A=0.11901376068130892、B=0.11905884074703188，跨原点差0.00004508006572295775，逐轴点差0.00004863739013671875，低于原预算0.004/0.001。EXE SHA `b4555b2017042717c44ef617cacd106db5210bebe67b410b1ce81e0f5c86571e`，第二次独立复核确认report从actualDistance生成。
- 已完成：Native bin85通过/28GPU显式忽略，build/all-target通过；日志 `test-output/d09-package-selection-bin.log`、`-build.log`、`-check.log`、`-a.log`、`-b.log`、`-legacy.log`。续跑repository gate和4304源文件800行门禁通过，日志 `test-output/d10-0045-repository.log`、`d10-0045-source-size.log`。Web/API代码本次续跑未修改，前节完整测试结果保持其原时间和源范围。
- 已完成：合并入口 `C:/Users/rain/AppData/Local/Temp/Deep-Engine-Deep2D-handoff-2026-09-16-0045.md`，包含两领域状态、证据、45项分类、D11–D23交叉复用与D24–D28项目级后验收；完整条件仍引用永久任务表。结构/敏感信息检查通过；57个明确文件路径存在，45项ID无重复无遗漏。
- 本轮待办：D03原定义的降级确认后继续尚未实现，当前confirmation-required严格拒绝；此次据源码补入任务清单。浏览器ZIP实际落盘仍未证实，旧失败data URL再次触发工具策略阻断，未定位为产品缺陷。D09连续运动/法线/独立阴影、持久化标注世界合同，D10系统断网/完整故障链，动态Dashboard发布及完整视觉继续按两张表执行。
- 项目级后验收：D24–D28与Deep2D V-01～05协调执行，不把Box/64×64探针或局部性能基准用作真实BIM、跨设备竞品或全项目完成证据。所有明确排除项保持，不重启8小时soak或非Windows实现。
- 运行状态：本次复查API4100/Web5173、supervisor51408健康，固定拓扑与用户数据未改；本轮所有子Agent、GPU与构建任务已结束。无commit/push，保留文档任务及其他并行改动，旧00:30交接仅留历史记录。

### 2026-09-16 文档与社区治理收尾（Codex）

- 已完成：离线文档扩至 25 篇、6 类，补安装、核心概念、模型导入、FAQ、贡献与社区入口；3D 生成 API 按当前路由和适配器改写，移除离线解析器不支持的表格。仓库入口补架构说明、开发指南、维护者职责、路线图、发布说明模板与文档 Issue 表单。
- 已完成：治理门禁覆盖新增文件与链接；目录测试检查注册遗漏、图片文件、锚点、搜索与 Markdown。CI 使用固定 pnpm 版本，在依赖检查作业增加文档构建和测试。
- 已完成：Web 类型检查、文档运行时构建、运行时 5 项测试、目录与页面渲染 12 项测试、仓库治理 5 项测试及门禁通过；本轮文件 diff 空白检查通过。未将本地结果记为远程 CI 或浏览器交互验收。
- 明确排除：停止生成图片；按用户最新要求保留全部已有图片作为素材，仅重点文章引用配图。不改许可证政策，不混入其他任务的引擎和发布改动。
- 项目级后验收：公开发布前仍需核验实际托管设置、完整历史敏感信息、资产再分发清单和正式发布门禁，见 OPEN_SOURCE_READINESS.md。此次没有执行公开发布或历史重写。

### 2026-09-16 七方向三维格式内置接入方案（Codex）

- 统一入口已补充为 [工业三维格式接入工作计划](./specs/industrial-3d-format-work-plan-2026-09-16.md)，集中定义“无外部产品/云/商业 SDK 前置，但存在随包开源运行依赖”的边界、七方向工作包、阶段顺序、共用任务和停止条件。
- 已完成：按用户要求编写 JT、Parasolid X_T、RVT 内置离线接入总方案，并追加点云（E57/LAS/LAZ/COPC）、3D Tiles、Rhino 3DM、SolidWorks（SLDPRT/SLDASM）四方向细案及格式价值分析。入口 [总方案](./specs/jt-xt-rvt-offline-integration-plan-2026-09-16.md)、[四方向细案](./specs/additional-four-formats-integration-plan-2026-09-16.md)、[价值排序](./specs/high-value-3d-formats-2026-09-16.md)。
- 已完成：核对上传 ConversionQueue 与内存 ConversionTaskService、Provider 目录、既有格式能力目录、GLB 审计、单位与身份、Web/Native 发布边界；方案复用现有系统，不把容器读取或单样本几何当完整格式支持。候选源码提交和未确认许可记录在文档中。
- 本轮待办：本轮仅文档交付与检查；实现启动后按 FMT-01～15、PC/TILE/RHINO/SW 各 01～04、EXT-01～08 执行。新增能力尚未实现、未安装依赖、未运行候选真实模型转换，兼容率和性能没有实测结论。
- 明确排除：本轮不改产品代码、存储拓扑、历史模型或源格式写回；公开 X_B 入口不自动扩大。其他格式仍为投资候选。SolidWorks 旧目录 excluded 状态的迁移列入后续实施，当前目录与测试保持原状。
- 项目级后验收：各格式真实保留集、系统全链路、Windows 干净机断网、双主题与至少两轮视觉、Native 分档发布和回滚；RVT/SolidWorks 完整覆盖属于持续研发，基础试点完成不关闭全部格式目标。

### 2026-09-16 Deep2D P0-02 动态 ChartIR 入包(GLM)

- 已完成：运行包 v4 chart 时代合同双侧落地(Rust `runtime_package/`、TS `runtimePackage/`):`chart-runtime`/`chart-sim-runtime` 资源种类与入口键(`chart` 必填非空、`chartSim` 可空、v4 必须显式声明、v1–v3 禁止)、信封 id/revision 绑定资源索引、内层走既有 ChartIR/sim fixture 严格校验、`chart` 与 `deep2d` 入口互斥、camera 自 v4 可选。载荷定义与验收条件见 [spec](./specs/deep2d-chart-package-2026-09-16.md)。
- 已完成:`buildChartRuntimePackage`(空三维场景包,packet id 内容寻址派生);`PlayerContent::from_package` 经 `player_content_chart_entry.rs` 重建 ChartRuntime/sim 宿主/展示列表;CLI 零新增,`--package/--headless-package/--smoke-package/--package-recover` 全部自动支持图表包。
- 已完成：跨端 golden 双夹具由 `packages/deep-engine/scripts/generateChartRuntimeGolden.mjs` 调真实 TS 构建器生成(`chart-runtime-v1.json` 带 sim 哈希 `99e0beb9…3fc3f1b`、`chart-runtime-static-v1.json` 哈希 `82fdf617…601c5fed`);TS `chart.test.ts` 3 项逐字段对照+输入隔离+v4 合同拒绝;Rust `tests/chart_runtime_golden.rs` 5 项;bin from_package 2 项。
- 已完成：验证 deep-engine vitest 2821 通过、tsc 通过;Native 全套 697 通过/0 失败、bin 87 通过、all-target 0 warning;真实 GPU 窗口(RTX 4060 Laptop/Vulkan,EXE SHA `60343016d777691c162f0a85bc1e88224befa5a2f65e7cbf31b526fc62cbf2e2`)sim 包 3 帧固定时钟提交+取消干净+恢复检查点、静态包数据追加/缩放/选中/tooltip 交互序列提交,scopes/callbacks clean;日志 `test-output/p002-chart-package-sim.log`、`p002-chart-package-static.log`、`p002-native-full.log`、`p002-deep-engine-full.log`。repository gate 与 800 行门禁(4311 文件)通过。
- 边界：deep-engine 包级 300 行门禁与 runtime purity 门禁的失败全部来自并行会话未跟踪/在途文件(`browserImageDecoder.ts` 等 13 项),本切片文件达标且未代改;同一问题两处记录于 spec。浏览器下载落盘、Dashboard lowering、正式发布证据等其余 P0 项未动。
- 运行状态：API4100/Web5173/supervisor51408 健康;无 commit/push;共享脏树保留全部并行改动。

### 2026-09-16 Deep2D P1-04 行统计缓存(GLM)

- 已完成:`ChartRows` 升级为行+惰性统计缓存结构(`Mutex<Option<Arc<RowStats>>>`);手动 `Clone` 使分离克隆不继承统计,`DerefMut` 即失效点;`semantic_validation` 三处行扫描(字符串预算/heatmap 有限性/数值轴 linear-log)改为统计查询,空数据集与短行缺列语义与原 `any()`/`get()` 判定逐一对齐。spec:`docs/specs/deep2d-row-stats-cache-2026-09-16.md`。
- 已完成:行为对照测试 3 项(缓存共享 Arc 指针、可变访问失效、坏数据与边界查询),`chart_rows_snapshot` 全套 8 通过/2 基准忽略;lib 与 chart_* 集成全套通过。
- 已完成:release 重复完整源校验基准两次独立进程 median 0.279/0.3816ms、P95 0.3006/0.5904ms(基线 4.7761/7.2712ms,约 13~17 倍);日志 `test-output` 后台运行记录。
- 边界:失效粒度为数据集行存储级,未做列级局部失效;未重跑 GPU(纯 CPU 校验路径,渲染输入不变)。

### 2026-09-16 Deep2D P1-01 全局 Epoch + P1-17 测量式文字截断(GLM,含子代理实现)

- 已完成:`chart/epoch.rs` ChartEpoch 五元组(document/data/layout/resource_set/published);data_revision 直读 ChartRuntime 同源零复制;ChartEpochCommit 事务消除「GPU 已 publish 而内容未更新」中间态;`app/chart.rs` update/change_legend_page 事务化;from_package 以 (package_id,package_hash) 哈希初始化 document_revision。7 项新测试+12 项既有同跑 19 通过;详见 [spec](./specs/deep2d-epoch-and-text-fit-2026-09-16.md)。
- 已完成:platform_text `measure()`(自然单行宽度)+ legend `fit_ellipsis()`(二分实测省略,图标前缀实测占宽)+ tooltip 按行整体实测截断,替代字符数硬截断;`tests/chart_text_fit.rs` 3 项通过,chart_tooltip_render 4 项/chart_legend 2 项回归通过。
- 已完成:chart_* 全家族+lib+bin 回归全绿(chart_epoch 19、bin 87);all-target 0 warning。layout_revision 仅开 bump 入口(resize 接线后续);字体打包(P1-19)/字体资源 revision(P1-08)边界不变。
- 已知基线红项(早前并行会话遗留,非本夜引入):`tests/chart_runtime.rs` 一项 selected/hover 断言失败,涉事 runtime.rs/emphasis.rs 修改时间早于本夜,下一会话归因。
- 运行状态:GPU 无并发任务;无 commit/push;共享脏树保留并行改动。

### 2026-09-16 Deep2D P1-03 分块存储 + P1-14 Axis/线段拾取(GLM,含子代理实现;合并回归)

- 已完成:`chart/chunked_rows.rs` 混合值行块存储(Arc 共享/整块淘汰/部分边界 COW/预算 fail-closed/null 与中文语义保留),5 项测试含引用计数证明;未接 ChartIR(任务明示)。spec:`docs/specs/deep2d-chunked-rows-and-axis-pick-2026-09-16.md`。
- 已完成(子代理):`render_cartesian.rs` XInverter 三态反解×zoom、`geometry_frame.rs` invert_x/nearest_x_targets(前景优先跨系列聚合)、`line_point_index.rs` nearest_x/nearest_segment;顶点绝对优先+线段补空隙,线段命中保持系列级合同;chart_axis_pick 12 项+chart_line_pick 7 项。
- 已完成:合并回归 Native 全套 742 通过/0 失败/52 GPU 忽略(102 目标);all-target 0 warning;repository gate 与 800 行门禁(4317 文件)通过。早前记录的 chart_runtime.rs 基线红项(selected/hover)已由本批拾取的语义修正解决,前条账目的"遗留红项"就此关闭。
- 已完成:真实 GPU 窗口复验(新 EXE SHA `1b97faab040af02f5554d65264bf50172a50e309e3176d4a4945dea861f1da1d`):chart 静态包交互序列与 sim 包 3 帧提交全过,scopes/callbacks clean,恢复检查点提交(epoch 事务/测量文字/新拾取生效);日志 `test-output/p003-*.log`。
- 本轮待办:P1-03 数据通道接线、P1-14 axis tooltip 宿主组装入 pointer_move,分别在两行任务表保留;P0-03/04/06 确认需要 Dashboard 发布链路(当前 API 无此通道),属产品级架构切片,不在夜间盲目开工。
- 运行状态:GPU 无并发任务;无 commit/push;服务 API4100/Web5173 健康。

### 2026-09-16 夜班服务事故与恢复(GLM)

- 事故:supervisor 51408 在夜间的某个时点整体退出(studio-manager.json 状态 stale),`pnpm studio status` 报未运行。日志尾部同时可见此前已记录的 Vite FSWatcher EBUSY(`apps/web/public/docs-assets/generated/dashboard-scene-gold.png`)崩溃记录与随后的重启尝试;无法从日志区分 supervisor 退出与该 EBUSY 是否同因,如实记录不妄断。
- 恢复:按原 PG/MinIO 配置 `pnpm studio start` 重启,API 4100/Web 5173/电池 ONNX/实时视频/云渲染 Worker 全部正常;存储拓扑与数据未动。
- 提醒:该 PNG 直写 public 的 EBUSY 触发器仍活着(文档任务或生成脚本再写该路径会再次打挂 Web watcher),后续会话应把生成物移出 Vite watch 范围或排除 public/docs-assets/generated。
- 本夜门禁基线:Web 全量 570 文件/3297 测试通过,API 全量 954 通过(`test-output/p003-web-full.log`、`p003-api-full.log`);Native 742/0/52。

### 2026-09-16 Deep2D P1-12 sim 窗口恢复 + P1-15 单行持久强调(GLM 子代理实现)

- 已完成(子代理):`app/chart_sim.rs` 重构为 `pump()` 唯一推进实现 + `wake_delay()` 纯调度数学;`--smoke-chart-sim` 升级 8 阶段注入状态机(正常视口/空闲/到期提交/积压制造/逐帧追赶+不跳样本证据/renderer 失败注入游标不动/恢复续跑无缺口/取消终态);`simulation.rs` 取消后 next_due 终态化;`tests/chart_simulation_lifecycle.rs` 5 项固定时钟测试;真实 GPU 冒烟走通 8 阶段并输出失败注入路径。
- 已完成(子代理):折线单行持久强调——`MarkerKind{Selected>Emphasis>Hover}` 强度合成,accent 持久/hover 瞬态;隐藏系列状态保留恢复渲染;AppendWindow 淘汰+行身份迁移(旧3→新0);row 覆盖系列/单行 downplay/系列全清;authored Highlight/Downplay data_index 既有通道零新 action。chart_emphasis_markers.rs 5 项+chart_emphasis 3 项新增。
- 验证:chart_simulation 9/5、chart_emphasis 6、chart_emphasis_markers 5、chart_state_render 4、lib 116、all-target 0 warning;子代理如实披露越权最小收窄 state_render 断言(新语义使旧断言过强,复核接受)。合并回归 `test-output/p004-native-full.log`。
- 边界:P1-12 真实换包端到端 GPU 注入待包切换通路;P1-15 TS dispatch 通道与 ChartAction 合同对齐、系列级 all 刻意不展开逐行 marker(防爆炸,已固化注释+测试)。
- 运行状态:GPU 单车道使用;无 commit/push。

### 2026-09-16 Deep2D P1-05 chunk ABI 第一批 + P1-06 GPU 传输策略评估(GLM 子代理实现,最终合并回归)

- 已完成(子代理):帧内存按系列三 Arc chunk(geometry/commands/resources)+ OnceLock 惰性扁平视图;增量更新 prepare 2.41→2.09ms(-13%),命令内存 8 份→1 份;诚实修正任务前提(frame 本就 Arc);等价性 ptr_eq/z 序逐值/失败时机等价均有测试;Send/Sync 保持。
- 已完成(子代理):P1-06 三场景评估数据否决 ring/arena(分配占 stage 0.1–0.2%,复用交接点在禁区且会缓存投毒);落地 `buffer_allocations` 可观测字段+三场景字节预算+逐像素旧帧保护+release 计时基准。spec:`docs/specs/deep2d-frame-chunks-and-gpu-transfer-2026-09-16.md`。
- 最终合并回归(全夜 11 切片):Native 全套 **760 通过/0 失败/55 GPU 忽略**(105 目标),`test-output/p005-native-full.log`;check 0 warning。真实 GPU 窗口最终态 EXE SHA `790b1df992acecc96166472f1c0cb29310ab25029e4dbe3adc4251e526e94fd0`:chart 静态包交互序列+sim 包 8 阶段全流程通过,scopes/callbacks clean,恢复检查点提交(`test-output/p005-smoke-*.log`)。
- 交接文档:`docs/GLM-Deep-Engine-Deep2D-交接-2026-09-16.md`(9:00 交付)。无 commit/push;GPU 已空闲;服务 API4100/Web5173 健康。

### 2026-09-16 doc1 PLAN-03 格式导入合同骨架(GLM 子代理实现)

- 已完成:`packages/contracts/src/formatImportContracts.ts`(255 行)四类 v1 合同:SourceBundleRecord(sha256 小写/随包路径防逃逸/许可 reference)、ImportRecipe(声明性转换配方:单位/坐标/LOD 抽稀规则/可复现 steps)、CoordinateFrameV1(与 sceneLocalCoordinates 逐字段对齐+网格约束互锁)、QualityReport(计数器+抽稀规则+算术校验)。vitest 10 项新增/286 全过,tsc 通过。
- 边界:纯合同骨架,不执行转换、不声称任何格式已支持;组合层约束(跨对象一致性/质量档)留 PLAN-04/06;枚举漂移风险已在注释声明。

### 2026-09-16 Deep2D P1-13 宿主数据源状态机第一批(GLM 子代理实现)

- 已完成:`chart/data_source.rs`(290 行)离线优先状态机 + Transport trait 注入(零真实 IO/零新 crate);版本治理(迟到/重复/串源拒绝且串源优先于版本判定,不污染版本历史)、有界环形离线缓存(淘汰计数+水位续传对接)、取消终态幂等、凭据类型上不出现;`payload_to_chart_message` 与 ChartRuntime CAS 对接有真 runtime 测试。
- 验证:lib data_source 11 项全绿;lib 全量 130 通过;all-target 0 warning。mod.rs 仅追加一行。
- 剩余(后续切片):HTTP Transport 真实绑定(受控 HTTP/订阅/异步握手 Connecting 驻留)、宿主侧 deadline、缓存字节预算、订阅协议层。

### 2026-09-16 Deep2D P1-07 细分缓存测量与结论(GLM 子代理实现)

- 已完成:GlobalAlloc 计数 wrapper 实测缓存真实堆驻留(比 payload 记账高 ~5.95%,量级可信;drop 后堆水位精确回基线的闭环验证);**证实缓存顶点与 8MiB vertex shadow 全量重复驻留**(夹具 1,124,352B),Arc 化消除需跨 deep2d_vertex_transfer/painter 禁区,立项数据齐备;冷启动拆解:可归因缓存写入 0.056ms,冷增量其余部分在 ±0.3–0.4ms 噪声底内;仅实施 clips 单次收集(可证实的小优化),其余"不做"均有测量依据。deep2d_path_cache_memory/cold_bench 两新测试文件,lib 131 通过。
- 诚实声明:shadow 捕获 CPU 耗时未测(GPU 车道+pub(super) 边界);"实际进程内存"以分配器字节+峰值口径交付,RSS 未测。

### 2026-09-16 Deep2D P1-11 缓存故障与裁剪矩阵(GLM 子代理实现)

- 已完成:R1 缓存失效矩阵 11 格(atlas 内容变化/revision 不参与 key/内容驱动失效/同 id 换 style 四维度/超预算逐出+超容量 thrash 但几何与 uncached 逐字节相等/重载零漂移/坏 atlas 候选 fail-closed 不污染缓存四字段);R2 深层 clip 4 格(3 层嵌套×nonuniform、嵌套×旋转/镜像、clip×dash×round-cap、内外层资源变更只牵连依赖命令);R3 GPU 混合内容 2 项(文字+图片+clip 路径同帧 readback,CPU raster_reference 400/400 像素精确一致 0 divergent;同 id 换像素新建 texture 不复用陈旧槽位;glyph 候选拒绝旧帧保持;新 epoch cache 零复用)。
- 验证:cache_failure_matrix 11+mixed_content_gpu_matrix 2+既有 clip/stroke 家族全绿;check 0/0。子代理越权裁决:新文件 deep2d_mixed_content_gpu_matrix.rs 超出授权清单(为守 300 行红线拆分),复核接受。src 零缺陷发现。
- 未覆盖(注明于测试注释):真实 device-lost 回调不可注入,以新 epoch cache 重建+旧 epoch 零复用替代。

### 2026-09-16 Deep2D P1-10 端到端性能基线 + P1-11 矩阵(收口;最终回归)

- 已完成(子代理):`tests/chart_e2e_perf.rs`(299 行)真实 Win32+Vulkan 窗口七场景性能基线(初始 16.4ms/静态 0.21ms/局部 8.7ms/全量 27.1ms/resize 43.3ms/图例 4.7ms/tooltip 4.9ms,p50 口径;GPU timestamp 实测,present 延迟与显存估计口径已注明;上传零重传证明内容寻址健康)。P1-11 矩阵见前节。
- 最终合并回归:Native 全套 **802 通过/0 失败/59 GPU 忽略**(`test-output/p007-native-final.log`);repository gate、4330 文件 800 行门禁通过;服务 API4100/Web5173 健康(watch 重启瞬态自愈)。
- 夜班总计:Deep2D 12 行完成/实质推进(P0-01 一批、P0-02、P1-01/03 一批/04/05 一批/06 评估/07 测量/10/11/12/13 一批/14/15/17)+ P0-01/P0-02 打通发布语义;doc1 PLAN-03 骨架+PLAN-04 审计、doc2 README 漂移;交接文档 `docs/GLM-Deep-Engine-Deep2D-交接-2026-09-16.md`。无 commit/push。

### 2026-09-16 Deep2D P1-08 文字栅格缓存 + P1-16 键盘无障碍(GLM 子代理实现;最终回归)

- 已完成(子代理):`GlyphRasterCache`(双预算 LRU、Arc 值、错误重试语义、resource_revision)+ `GlyphAtlasBook.place_text` 对接真实栅格化;7 项测试(命中计数/逐出重算/双预算/size 全重建/ Arc 隔离/revision 语义/place 幂等)。`native_ui/chart_a11y.rs` 键盘状态机+语义树+window_events 最小接线;键盘与鼠标同 dispatch 路径双图对拍逐字节一致;模态优先级(标注草稿>图例键盘>section>关窗)锁定;8 项新测试。
- 验证:最终合并回归 **802→817 通过/0 失败/59 GPU 忽略**(110 目标,`test-output/p008-native-final.log`);all-target 0 warning;repository gate 与 800 行门禁通过。
- 边界如实:P1-08 GPU 区域上传属 deep2d_gpu 车道;P1-16 焦点环画进 chart 像素需 chart 渲染层追加点(按 STOP 未动)、OS 屏幕阅读器桥不在本批、真实窗口键盘 smoke 未跑(以 CPU 键盘驱动状态断言替代)。

### 2026-09-16 收口:P1-02 失效记账 + P1-16 焦点环入像素 + PLAN-01/02 部分产物(GLM)

- 已完成(子代理):painter_cache miss 原因五分类记账(结构→clip→resource→style 固定顺序+有界 evicted 记忆),行为逐字节等价;8 项子图失效证明测试。P1-02 剩余:epoch/字体/相机维度、vertex transfer 侧、删除检测。
- 已完成(主线程):图例焦点环画进像素——append_legend 按 focused_item 外扩 3px accent 描边环(越界静默跳过),焦点移动/释放触发图例重呈现;present_chart 增 legend_focus 参数(包路径传 None)。chart_legend 焦点环测试通过。
- 部分产物(代理收口中断):PLAN-01/02 已下载 6+ 方向 SHA256SUMS 与 corpus-manifest.json(v1,13 键),lock 报告文档未写完,目录 `data/external-assets/industrial-format-plan/` 不入 git;接手先盘点再补报告。
- 最终回归:**826 通过/0 失败/59 GPU 忽略**(113 目标,`test-output/p009-native-final.log`);本夜累计 Native 全量八次全绿(756→817→826),Web 3297/API 954/contracts 286 同日全绿。交接文档已更新至交付态。

### 2026-09-16 PLAN-01/02 第一批语料与依赖锁定(Codex)

- 已完成:`docs/specs/industrial-format-plan01-02-lock-2026-09-16.md` 收口第一批本地证据；8 个已下载依赖工件与 6 个单独样本哈希全部匹配，7 份解包校验表共 463 个文件复算一致，`data/` 忽略规则确认覆盖全部原始工件。
- 边界:候选库均未试编译/集成；PDAL 仅锁官方 sha256sum，3D Tiles 示例许可未声明，openNURBS 待法务复核，SolidWorks 无真实语料。不得据此声明七方向已支持。
- 本轮待办:PLAN-02 Windows 离线试构建与体量/RSS记录；优先补真实 SLDPRT/SLDASM、X_T/X_B、多学科 RVT、明确许可 3D Tiles 与多站大坐标点云。

### 2026-09-16 Deep2D P1-14 Axis tooltip 宿主接线(Codex)

- 已完成:`chart/runtime_pointer.rs` 在 axis tooltip 模式按 screen-X 调用 `nearest_x_targets`，复用同一 `Hover` action 读取提交源单元；无点索引的 bar-only 场景回退到命中矩形，固定 16px 逻辑容差。重复指针、空白退出仍走既有事务与 `HoverEnd`。
- 验证:axis pick 12、runtime 5、tooltip content 5(含“y 远离几何仍按 X 聚合”与退出清理)全绿；未改变 ChartAction 合同。
- 边界:多 X 轴仍按现有“首个绘制序 cartesian 轴”规则；真实 GPU 窗口复核已在下一条记录完成。

### 2026-09-16 Deep2D P1-14 真实 GPU 冒烟复核(Codex)

- 已完成:release `deep-engine-native.exe --smoke-chart packages/deep-engine/fixtures/chart-ir-v1.json` 在 NVIDIA GeForce RTX 4060 Laptop GPU/Vulkan 真实窗口执行 initial/zoom/reset/tooltip/clear 序列；输出为 `native chart smoke: initial/zoom/reset/tooltip/clear GPU frames presented`，每次提交 `scopes=clean callbacks=clean`。
- 证据:命令退出码 0；chart fixture 数据集 `main` 3 行，GPU frame committed，Deep2D smoke frame 64x64 presented。
- 边界:本次只复核 P1-14 已接线链路，不等同于全量 native gate；P1-16 OS 屏幕阅读器桥与 V-02 视觉闭环仍未完成。

### 2026-09-16 Deep2D P1-02 删除检测子切片(Codex)

- 已完成:`Deep2dPathCache` 在成功准备整帧后按 path command id 执行孤儿条目清理，新增累计 `deletions` 计数与启动诊断输出；失败候选在错误返回前不执行 prune，避免污染活动缓存。
- 验证:`deep2d_path_cache_invalidation` 9 项、`deep2d_path_cache` 6 项通过，新增删除/重加回归覆盖 entries、payload 与结构 miss 语义；`cargo check --all-targets` 通过。
- 边界:本切片只完成 P1-02 删除检测，epoch/字体/相机依赖维度与 vertex transfer 侧记账仍待后续切片。

### 2026-09-16 Deep2D P1-02 第二批 epoch/相机依赖图(接手会话)

- 已完成:`Deep2dPathCache` 条目携带 `EntryWitness{camera_scale_bits, resource_epoch}`；新增公开入口 `set_resource_epoch` / `set_camera_scale`。归因顺序固定为「相机 → epoch → 结构 → clip → resource → 风格」,LRU 逐出优先;一次 miss 只记首个维度。相机见证存 f64 位模式(消除 -0.0/NaN 歧义),非有限值不写入见证。
- **缺陷修复(本批最重要产出)**:原实现见证取显式相机值、细分却仍用 `display_list.scale_factor`,产生「见证 2.0 / 几何 1.0」的自相矛盾条目并会被后续帧永久命中(实测 387 vs 等价静态帧 591 顶点),且归因伪装成 `camera_changed`。已抽出 `CameraWitness{scale_bits, scale}` 使见证与细分缩放同源产出,修复后 591=591。
- 依赖图边界(刻意排除,有测试锁定):`display_list.revision`、`z_order`、`hit_id` 不进图——不改细分几何,进图只制造假失效;命中产物仍逐值正确。
- 公开合同变化(已披露):`Deep2dPathCacheMissReasons` 新增 `camera_changed`/`epoch_changed`,`Display` 与 serde JSON 字段序前移;`deep2d_path_cache_invalidation::stats_display_and_json_summarize_miss_reasons` 断言同步到新形状并新增维度暴露检查。
- 验证:新增 7 项单元测试(painter_cache 共 10 项);既有 `deep2d_path_cache` 6 项 + `deep2d_path_cache_invalidation` 11 项全绿;`cargo check --all-targets` 0 warning;Native 全量见 `test-output/p012-native-p102b2-final.log`。
- 边界:宿主侧未接线——`deep2d_gpu.rs::stage` 未调用两个新入口,运行时行为与第一批等价(默认 None),接线归 P0 发布链路/宿主组装切片;本批未跑真实 GPU 窗口与浏览器视觉闭环。
- [spec](specs/deep2d-path-cache-dependency-graph-2026-09-16.md)

### 2026-09-16 Deep2D 接手会话:宿主接线 + 传输记账 + 四项剩余切片

- 已完成(P1-02 剩余①,宿主侧接线):`Deep2dFrameContext` + `deep2d_frame_context()`(app 与 renderer 共用纯函数);缩放口径取 **letterbox 实际比值**而非窗口 DPI 标称值。入口 `new_with_context`/`stage_update_with_context`/`stage_deep2d_update_inner`;三条生产路径全部接线(chart update → 当前 resource_set;换页 → **目标页号**;换包 → 候选内容 epoch 折叠)。**关键约束**:整帧只能有一个物理缩放——`display_list.scale_factor` 同时被 path 细分/文字图片/clip/stroke 容差消费,只喂缓存见证会重现「见证与几何不同源」缺陷,故新增 `painter::effective_scale()` 在命令循环前定格一次。未提供上下文时两维保持 None,与第一批逐字节一致。
- 已完成(P1-02 剩余②,vertex transfer 记账):`VertexTransferReasons` 六分类 + 纯函数 `upload_reason(has_previous,copyable,planned)` 锁定判定顺序;`total()` 恒等于 stage 次数。与 path cache miss 账构成两层可观测(细分为什么重算 / 顶点为什么重传);启动报告新增两行分解。
- 已完成(P1-13 第二批):①缓存**字节预算**与条数上限共同生效(谁先触顶谁淘汰),单条超预算不入缓存但照常交付(`cache_oversized`);②宿主**静默窗口**——**口径修订**:同步 Transport 下 `connect()` 立即返回、不存在可观察的在途窗口,原任务「宿主侧 deadline」改为覆盖「连接建立后无活动」这一唯一死链形态;`idle_deadline_ms`+`last_activity`+`poll_idle_deadline`,`on_receive_at` 带时间戳重载保持既有 11 项调用方零改动。data_source 测试 11→17 项。
- 已完成(P1-15 剩余):`ChartAction` 新增运行期 `Highlight`/`Downplay`,对齐 TS/ECharts `dispatchAction`;`initial_state` 初始 highlight/downplay 改为经同一条 `apply` 派发(此前直接写 emphasis 并 continue,形成双轨)。2 项新测试锁定「初始与运行期同一状态」与守卫。测试第一版因共享夹具自带初始 highlight 而失败,属指纹口径问题,改为先清空 actions/data_zoom。
- 已完成(P1-16 第三批):新增 `--smoke-chart-keyboard`(`app/chart_keyboard_smoke.rs`),**复用生产入口** `chart_key`(提升 `pub(super)`)驱动 6 阶段;断言焦点变化与展示列表**命令形状**(含变换位模式)变化。**真机 RTX 4060 Laptop/Vulkan 6 阶段全绿**,命令数 17→18→18→18→17→16→17,每步 scopes/callbacks clean。修正两处探针口径:焦点环不推进几何 revision(须比展示列表形状);图例激活语义是切换隐藏而非 selected。
- 已完成(P1-05 第二批,测量后数据否决):新增呈现层克隆基准——`display_list().clone()` median **0.0149ms**(占 prepare 2.09ms 约 0.7%),真正成本是首次物化 0.366ms(承载「拼接期统一定版 z 序/revision」已锁定语义)。改造需动公共消费面,收益不足,不改造。
- 已完成(P1-08 第二批,测量后数据否决):区域上传需上游脏矩形通道,当前仅有整块 data;实测 chart 场景 atlas 总量约 **63KB**(6 张),整块重传微秒级,收益不可测量。否决跨层通道引入;per-cluster/色分离同此判断,待 MB 级再重估。
- 已完成(P1-09,测量与判据):IBL 约 27KB、紧凑阴影 64KB 可忽略;**前向目标约 44 B/px(1280x720 ≈ 40MB)是唯一大头**,已确认 `output_pass` 用 `LoadOp::Clear` 且 Deep2d 直接画 surface(零像素依赖)。落地 `planeless`/`skip_forward_targets` 判据(实例+探针两道否决)+ `ContentProfileReport` 启动报告,5 项测试含字节口径断言。**未改帧路径行为**,跳过实施属独立切片。
- 验证:Native 全量 **862 通过 / 0 失败 / 60 GPU 忽略**(交接态 826/0/59,净增 36 项);`cargo check --all-targets` 0 warning;真实 GPU 静态包(5 阶段)、sim 包(8 阶段含失败恢复/取消)、键盘 smoke(6 阶段)全绿且 scopes/callbacks clean;repository gate 与 4340 文件体量门禁通过。新增测试 20 项。
- 边界(诚实):P1-02 宿主接线未跑真实换包窗口注入;本轮产出全部为 Rust 侧与探针,未做浏览器交互遍历与双主题视觉闭环(V-02 仍未达);三项数据否决项若规模变化应重估。
- [spec](specs/deep2d-host-wiring-and-transfer-accounting-2026-09-16.md)

### 2026-09-16 Deep2D P1-18 版本化文本 IR(接手会话)

- 已完成:`platform_text/text_document.rs`(696 行)交付 `TextDocumentV1`——文本 + 样式区间 + 段落 + inline object 的版本化表示。关键决定:①区间一律用**字素簇索引**而非字节偏移(字节偏移会在组合字符/emoji/ZWJ 中间切开);②样式用 `TextStyleId(u16)` 标识而非内联属性(改样式定义不动区间,跨语言比对稳定);③半开区间 + 二分查询;④修改返回 `TextChange{previous_revision,revision,start_cluster,end_cluster,cluster_count_changed}` 供局部失效,被拒修改不推进 revision;⑤段落覆盖文本、inline object 锚定簇位置,两类分离。复用既有 `layout::grapheme_clusters`,不造第二套文本模型。
- **对抗式自查抓到并修复三个真实缺陷**(初版 11 项测试全绿仍存在):①删除横跨多条样式区间时产出**重叠区间**(实测 `[{0,3,s1},{2,3,s2},{3,4,s4}]`),根因是逐区间独立映射端点,重叠会让 `style_at` 的二分给出矛盾答案,修复为映射后排序 + 左端推到上一条右端;②段落「每簇必属某段」只在编辑期维护,构造期只校验不补全,导致 6 簇文档中簇 5 无归属(`paragraph_at` 返回 None),修复为抽出 `fill_paragraph_gaps` 供**构造期与编辑期共用**,并明确分工:重叠/乱序/越界是调用方错误必须拒绝,空洞是允许输入形态需补全;③同族排查发现 `shift_inline_objects` 压缩后可能产生**重复位置**(构造期明确禁止),修复为按 object_id 稳定排序后去重(结果可复算)。
- 验证:`text_document_tests.rs` **16 项全绿**(其中 4 项为对抗性/不变量测试,正是它们抓到上述缺陷:删除跨多区间不重叠、连续 6 步编辑全不变量保持、组合序列不被切开、对象压缩去重);`cargo check --all-targets` 0 warning;全量 Native **878 通过 / 0 失败 / 60 GPU 忽略**(接手态 826,净增 52);体量门禁 4342 文件通过(text_document.rs 696 行 < 800 线)。
- 边界(诚实):**TS 侧同一合同与跨语言 golden 未做**,P1-18 的「TS/Rust 共同解释」只完成 Rust 侧;bidi/fallback/shaping 仍依赖已批准的 shaping 库,沿用既有简化实现而不冒充完整;文档 IR 尚无宿主消费方(接线归后续切片);纯 CPU 逻辑,无 GPU/浏览器验证面。
- [spec](specs/deep2d-text-document-ir-2026-09-16.md)

### 2026-09-16 Deep2D P1-19/P1-20/P1-21 文本与行为族(接手会话,同批三项)

- 已完成(P1-19 字体身份与能力矩阵):`platform_text/font_capability.rs`——以**字体数据 FNV-1a hash** 为唯一可信身份(家族名相同不代表文件相同),矩阵按 hash 稳定排序去重、跨机器可复算;来源/许可显式建模,系统字体一律 `usable_in_artifact=false`(能渲染≠可交付,保守默认有测试锁定);`family_blocked_reason` 区分「机器没装」与「装了不能发」;产品接线经 `TextRasterizer::font_capability()` 在启动报告输出(实测全库遍历约 9ms,**仅图表内容存在时执行**)。**顺带修正一个语义陷阱并固化为测试**:整形器遇缺失家族会**静默 fallback**,故成形结果不能证明家族覆盖——已拆成 `family_exists`(家族可用性正确判据)与 `text_shapes_without_missing_glyphs`(系统整体成形能力)两个口径。8 项测试。
- 已完成(P1-20 IME 事务):`platform_text/ime_session.rs` 的 `ImeSession` 把 `TextEditState`/`CompositionState`/`WinitImeAdapter` 收成事务化会话并接 P1-18 的 `TextDocumentV1`。五条不变量:组合期文档逐字节不变 / 提交单一编辑路径 / 失焦必取消在途组合 / 撤销按事务粒度且自身推进 revision / 删除按簇(emoji 与组合序列整体删)。**对抗式测试抓到真实缺陷**:历史条目只记一个簇区间,而撤销与重做口径不同(插入型在空位置重插、删除型重删区间),redo 越界失败;改为同时记 `insert_at`+`inserted_clusters`+`is_insert` 并夹取当前文档边界。16 项测试。**剩余**:bidi/RTL 与 DPI 候选窗未实现(后者由宿主窗口层负责,只提供 caret 锚点)、未接产品窗口事件循环。
- 已完成(P1-21 行为 IR 与命令总线):`behavior_ir.rs` 的 `BehaviorCommand`(封闭枚举)+ `CommandBus<T: BehaviorTarget>` + `HostCapabilities` + `CommandBudget` + `CommandCounters`。与 `ChartAction` 划清边界(后者是图表专用语义,本模块是通用容器,语义经 `BehaviorTarget` 注入,同 `data_source::Transport` 范式)。**N0 铁律**:封闭枚举载荷、`Scalar` 刻意不含字符串(防「用数据当代码」)、能力缺失即拒绝不降级。**两阶段提交**:幂等在 submit 消耗、CAS 在 submit 与 settle 双次核对、取消后 settle 返回 `Cancelled`(区别于从未提交的 `NotInFlight`)、预算硬拒且取消释放、幂等键与取消记忆有界有损(计数可见);时间全部注入 `now_ms` 零真实 IO。自查修正一处语义混淆(应用失败曾复用 `NotInFlight`,已独立为 `ApplyFailed`)。20 项测试。
- 验证:三项合计 **44 项新测试**;`cargo check --all-targets` **0 warning**;`cargo test --lib` **204 通过 / 0 失败**;体量门禁 4348 文件通过(新文件最大 588 行 < 800 线)。全量 Native 回归见 `ds-full5`。
- 边界(诚实):三项均为纯 CPU 合同切片,**未接产品路径、未做浏览器/GPU 验证**;P1-19 未内嵌字体(再分发权未决)且未做子集化与跨机器实测;P1-20 的 RTL/DPI 与 P1-21 的真实异步/签名扩展显式排除。
- [spec](specs/deep2d-font-capability-2026-09-16.md)、[spec](specs/deep2d-ime-and-behavior-ir-2026-09-16.md)
