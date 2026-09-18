# Native 图表数据更新

供数据宿主向 ChartRuntime 提交批量数据使用。现有 Rust 类型接口与 TS/Native 共用的 v1 数据消息；外部订阅传输和包内动态 ChartIR 入口尚未接通。

## 提交与身份

`ChartDataUpdate` 带 expected_data_revision 和新的 data_revision，后者必须为当前值加一且为 JSON 安全整数。一次请求最多更新32个不同数据集，支持替换所有行或追加后保留末尾固定数量的行。行宽、标量类型、字符串和行数预算在接受前校验；窗口会丢弃的输入行同样必须有效。

候选先校验数据集身份、整个批次和最终 ChartIR，再协调交互状态并生成几何/命中帧；全部成功后提交源、状态、帧和版本。错误、旧版本、重复数据集或未知引用不改变旧状态。完整图表替换也递增 data_revision，旧数据生产者不能向替换后的图表提交迟到结果。

窗口移除开头 N 行时，保留行的选中/强调/初始动作索引减 N，已淘汰行移除。全量替换清除被替换数据集的逐行选择，保留整系列选择、整系列强调、图例可见性和缩放窗口。悬停提示在数据变化时清除，下一次命中从新源读取数值。

## 已实现的复用

- 同内容替换复用源和几何/命中帧，只推进数据版本。
- 只改无引用数据或完全隐藏系列的数据时，复用几何/命中帧；显示系列时才编译新数据。
- 宿主确认几何帧与呈现状态都未变化时，提交数据源后直接返回，跳过文字合成和GPU候选准备。
- 可见数据变化时复用现有候选GPU提交路径；失败保留旧图表与恢复源。

候选源现已[共享未修改数据集的行存储](deep2d-chart-rows-snapshot-2026-09-16.md)。可见数据更新按数据集和系列依赖复用未变化的路径、命中/线索引及资源版本，见[按系列增量准备](deep2d-chart-series-incremental-2026-09-15.md)；GPU 路径已接[局部顶点传输](deep2d-vertex-transfer-2026-09-15.md)。列块共享和全局文档/数据/布局/资源 Epoch 尚未完成。`ChunkedSeries` 数值列通道尚未替代包含分类/文本单元格的 ChartIR 数据集。

## 验证

数据更新7项、既有runtime5项通过：覆盖批量失败原子性、旧版本、重复/未知数据集、淘汰行映射、强调与初始动作恢复、相同内容/隐藏数据帧共享、新命中值和淘汰前非法行。

真实 RTX4060 Vulkan `--smoke-chart packages/deep-engine/fixtures/chart-ir-v1.json` 将 main 从2行追加到3行、data_revision=1，经GPU候选提交后继续完成zoom/reset/tooltip/select/clear窗口帧。GPU scopes/callbacks clean。此程序化探测不代表真实数据连接、OS输入、动态包发布或正式视觉验收。

## v1 数据消息与跨语言回放

消息包含 schema=`deep-engine.chart-data-update`、schemaVersion=1、chartId、expectedDataRevision、dataRevision 和 datasets。操作 kind 为 replace 或 append-window，后者要求 maxRows。未知字段、重复数据集、非法版本/ID、嵌套对象单元格及超预算消息拒绝。chartId 与当前实例不符时不得更新。

TS 入口为 `parseChartDataUpdate` / `applyChartDataUpdate`，Native 为 `parse_chart_data_update` / `ChartRuntime::apply_data_message`。解析入口限制 UTF-8 16MiB，并复用 ChartIR 的 JSON 节点/深度/字符串预算；行宽和引用在绑定实际图表时检查。1、1.0、1e0 等整数写法对安全整数版本字段等价，数据行中的等值整数/浮点不会误清选择。超过 JS 精确整数范围的业务 ID 应使用字符串。

`chart-data-update-v1.json` 由真实 TS 源协调函数生成，包含初始 ChartIR、追加窗口/整表替换消息和各步结果。Native 读取同消息后，按完整 ChartIR 类型逐字段对照数据、坐标轴、系列及迁移后的初始动作。只证明该夹具及边界测试范围，不表示任意外部数据或跨端像素一致。

新增消息测试：TS19项；Native5项，另复跑数据更新7、tooltip4、数值等价1。TS现有ChartIR reader22项同时通过。Native最初以serde_json字面量比较IR时，f64字段80.0与TS JSON的80产生差异；修正为双方读取同一个ChartIR类型后比较完整结构，数值字段并未移除。

TS apply 是源协调参考实现，当前仍做完整输入验证与快照；尚未接高频TS渲染宿主或增量依赖缓存。Native窗口探测已改走消息编码/解析入口，新增消息链的实际GPU结果另记。
