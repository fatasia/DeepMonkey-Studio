# Native 筛选生产交互复核（2026-09-18）

单选筛选已接入冻结图表、KPI、表格的同帧联动。适用一个 select、最多 16 个选项、sample 来源；复杂筛选和表格导出不在已验收范围。

## 最新验收

- `test-output/dashboard-filter-linked-r10-20260918/evidence.json`：真实 HTTP 201、两轮 8 次窗口点击。华东表格 2 行、华北 1 行，KPI/图表与选项同时变化。图表标题不再与柱体重叠。
- 包 SHA-256 `49a295cc1b2530893738c694488eecdb9599b454563d46044ecf6f89d2e921b8`；EXE `3792c93f2c6a860adf72b45468ee89bd09d8dafc7a75092c2c3aead8f057111a`。包共 86 节点，保留原 128 节点/64 MiB 门槛。
- 同包真实 RTX 4060/Vulkan GPU 事务测试通过：零尺寸跳过 present 保留整帧、选择及行；恢复后提交；非法/重复选择不改变状态；上下键和“全部”恢复通过。
- `test-output/dashboard-filter-linked-states-20260918/evidence.json`：该完整联动包两轮共 6 次 hover/键盘/480×480 验证通过。
- `test-output/dashboard-filter-linked-batch-r11-20260918/`：批量字形生产的正式候选用时 109245.8 ms，8 窗口通过；91 张 atlas 与 R10 的像素字节全部相同。字体优化另见[批量生产报告](deep2d-text-batch-production-2026-09-18.md)。
- `test-output/dashboard-filter-empty-batch-r12-20260918/`：保留原表无 region 字段的正式候选用时 122398.9 ms，8 窗口通过；区域筛选后显示真实“暂无数据”。该夹具与 R11 不同，不能据此比较发布加速比例。

节点优化复用既有 Deep2D v2 `z-ordered` 合成：文字完全被 clip 包含时去除冗余 clip；真实裁切仍保持独立层和原 paint 顺序。相同冻结变体复用层，未被任何选项引用的初值资源不进入运行包。测试覆盖真实裁去底 1 px 的交错 clip、无裁切像素/quad 等价和节点超预算拒绝。

输入准备优化后的固定 EXE 为 `9e8f5a947df3d2b1113dd9bbdb3ffc6a3428da93d573420d888a6a867efaaa4f`。`dashboard-filter-cached-window-r6-20260918/evidence.json` 同一 R10 包两轮 8 窗口通过：六次有效选项切换为 42.748–48.773 ms，另两次点已选“全部”为 no-op；专项 profile 两次点击为 45.206/42.918 ms。口径为 handler 至成功 present，不含 OS 输入队列。启动首次准备仍为约 104–124 ms，不能扩大为所有输入均 ≤100 ms。

`dashboard-filter-input-profile-r6-20260918/pixel-equivalence.json` 比较缓存优化前 R3 与 R6 的华东/华北两个完整 960×540 客户区：各 2073600 字节、差异 0，仅排除 OS 窗口装饰。缓存复用既有 Deep2dPathCache，最多 256 个包、64 MiB 计费负载（不是进程 RSS）；完整类型/像素字节相等才复用。样式改变时仅复用精确相等的已验证 atlas，结构、quad、预算、裁切、相机与资源代次检查保持。新增单测覆盖像素和尺寸篡改、非法 quad、裁切/平移/排序/相机等价、LRU；34 项 Deep2D 和 12 项 dashboard runtime 通过，真实 GPU 失败帧保留测试再次通过。

**剩余边界**：浅色作者版式未验，空态图标未导出，表格分页/排序/行操作/CSV/Excel 下载仍未接 Native。页面整体视觉门禁未关闭。以下为早期基线，不能覆盖本节最新结果。

最新 R6 两轮 hover/键盘/480×480 共 6 窗口通过（`dashboard-filter-cached-states-r6-20260918/evidence.json`）；人工复核 round-1-keyboard 和 round-2-narrow，焦点框、联动内容与等比缩放保持。对标仍为帆软的等比画布与西门子的状态明确性，未重做作者版式。当前切片自评：布局 9、令牌一致性 9、排版 9、交互状态 9、信息设计 9、即时反馈 9（仅上述实际切换）、响应式/主题 8（窄窗等比、浅色未验）、语义文案 9；动效与 3D 不适用。不是整个页面 95 分完成声明。

## 早期实现与证据（历史基线）

- `dashboardFrozenFilter.ts` 复用 Web 的 `applyDashboardFilters`、`buildDashboardSampleMetric` 和 `lowerDashboardChart`，不另建查询引擎。支持一个 select、最多 16 个选项、sample 来源、bar/line/scatter/pie 的固定结构变体；总变体限制 4 MiB。
- Native 复用 ChartDataMessage 和候选帧事务。选项、高亮、图表行和帧在呈现成功后一起提交；空匹配是真空数据，不补假值。鼠标点击和上下键均接入。
- 多筛选组合、级联、非 sample 数据派生、结构变化保持明确诊断。KPI、表格联动未完成，不能把筛选图表通过视为这些组件也更新。
- 原夹具“全部区域”不是 Web 的清空值；测试仅在隔离副本改为“全部”，不修改原发布记录。编译器对该类误导名称给出纠正提示。

## 已核验的证据

`test-output/dashboard-filter-window-20260918/evidence.json` 保存两轮各四个选项、共 8 次真实窗口点击；第一轮客户区 960×540，第二轮 1280×720，系统 DPI 为 120。每次日志断言选中项及图表行数，真实截图显示高亮与区域标签一致。不是四种系统 DPI 验收。

- 包 SHA-256：`3ced2a9006144eb000305079a0c6e72e25ca8291f538e4952fe13076efa57c23`。
- 窗口矩阵 EXE SHA-256：`443d24e562f7d7737f35f2d592ed0af31bf172c3b16748467ea7c84e9cf1a156`。
- 两轮截图人工复核：`round-1-option-1.png`、`round-2-option-2.png`。保留原作者暗色版式；未补造浅色版式。
- 接续复核额外执行 `app::dashboard_filter_gpu_tests::production_filter_preserves_selection_and_rows_until_presented`，真实 RTX 4060 / Vulkan 表面通过 1/1。复用现存、晚于相关源文件的 `deep_engine_native-dccca31078b8376d.exe`，没有重复编译。
- GPU 测试覆盖零尺寸跳过 present 时旧帧/选择/行保留，恢复后提交，重复选项与非法序号不改变状态，上下键提交，以及“全部”恢复原数据。它不是设备丢失注入测试。

复跑 GPU 测试时设 `DEEP_FILTER_PACKAGE` 为 `test-output/dashboard-filter-production-20260918-r2/runtime-package.json`，执行 `cargo test --bin deep-engine-native production_filter_preserves_selection_and_rows_until_presented -- --ignored --nocapture`（在 Native crate 目录）。实窗矩阵入口是 `scripts/verify-dashboard-filter-window.mts`。

## 视觉复核与剩余门禁

对标帆软 FVS 的等比画布、西门子的状态明确性；沿用作者冻结颜色和排版，没有引入新 CSS 令牌。该切片只证明交互数据路径，尚未通过整个页面的 Kimi-95 视觉验收。

| 维度 | 复核结果 |
|---|---|
| 布局构图 | 8：柱体与标题区域重叠，需独立图表布局修复 |
| 令牌一致性 | 9：沿用冻结作者样式，无平行配色系统 |
| 排版 | 9：两个尺寸选项与数值可辨 |
| 交互状态 | 8：选择/错误保留已验；独立 hover/focus 视觉仍欠缺 |
| 动效 | 不适用：此切片没有新增动效 |
| 3D | 不适用 |
| 信息设计 | 8：图表更新但 KPI/表格仍静态，页面联动未闭合 |
| 即时反馈 | 未测量 ≤100 ms 延迟；不凭截图给分 |
| 响应式与主题 | 8：两尺寸已验，浅色与更窄断点未验 |
| 语义与文案 | 9：选项与图表区域一致，“全部”使用既有清空语义 |

## 接线检查点更新

标题避让、悬停和键盘焦点已完成：图表绘图区依据真实测量的标题/单位底边留出内距，保持原图表节点身份；键盘焦点和悬停状态沿用选择色派生。`test-output/dashboard-filter-title-fix-r2-20260918/evidence.json` 两轮共 8 窗口通过；`test-output/dashboard-filter-states-20260918/evidence.json` 两轮共 6 窗口覆盖 hover、键盘和 480×480 等比画布。窄窗为等比缩放，不是响应式重排；浅色尚未实测。

KPI/表格的 sample 单选派生已接既有 Web 查询、真实 DOM 测量和文本生产器，编译为受 128 节点/64 MiB 限制的静态层，Native 在原 present 事务内一起切换。R10/R11 已通过正式 HTTP 候选和实窗验收。空表测量补了真实空态文本；空态图标尚未导出。原表没有 region 字段，因此匹配区域后为空，R12 已实窗验证；联动夹具仅在隔离作者副本增加明确 region 数据，不能算原表自带该字段。KPI 与表格是独立作者样本，不宣称表格数值相加等于 KPI。

完整 KPI/表格包的 GPU 回滚和两轮实窗已通过；新增缓存版本再次通过真实 GPU 事务测试。标题布局与焦点视觉维度更新为 9；即时反馈、跨主题维度仍不标为达标。
