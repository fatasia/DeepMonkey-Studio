# ChartIR v1 契约冻结进度

## 已完成

TS 运行时入口为 `validateChartIR` / `parseChartIR`，从 `@bim-studio/deep-engine` 导出；实现见 `packages/deep-engine/src/chartIrReader.ts`。作者输入仍使用 `compileChartSpec`。

运行时要求完整字段：`schemaVersion:1`、`sourceSpecVersion:1`、`id`、`datasets`、`axes`、`series`、`legend`、`tooltip`、`dataZoom`、`actions`。集合不能为 null；axis 的 min/max 必须显式为数值或 null；legend 和 tooltip 的全部字段必须存在。未知字段、无效引用、数值、交互及预算复用 ChartSpec 校验，运行时不补作者侧默认值。

读取器复制通过纯 JSON 检查的输入，数据行、series、zoom 和 action 不引用调用方对象。该快照隔离尚不等于完整 Epoch 提交协议。

Native 已保存同一组 legend、tooltip、dataZoom、actions 字段，未知对象字段由 serde 拒绝；编译字段缺失不套默认值。Rust 构造器的 Default 只供程序创建对象，未启用 serde default。交互校验覆盖源版本、zoom ID/引用/窗口/数量及 action 的系列、数据索引、轴和窗口。

Native 字节入口为 `chart::parse_chart_ir`，依次执行 JSON 解析、2,000,000 节点/32 层/4096 UTF-16 单元字符串预算、严格字段读取与语义校验，返回拥有独立数据的 ChartIR。预算在通用 JSON 解析后、类型构造前执行，不等同于流式解析的内存上限。直接调用 serde 仅代表结构反序列化，不能替代该入口。

命令 `deep-engine-native --headless-chart <chart-ir.json>` 调用同一入口，成功时报告结构、初始状态以及固定640×360视口的真实几何/命中索引准备结果；不打开窗口，不报告视觉验收完成。`--help` 已列出该命令。

`InteractionState::from_ir` 已消费初始 zoom 与 action：百分比转为内部 `[0,1]` 区间，zoom 配置先应用，actions 按数组顺序执行。`reset_from_ir` 先构建独立候选，失败保留旧状态。命令行校验会实际构造这份初始状态。

持久 highlight/downplay 使用独立 `EmphasisState`，支持多系列和多个数据点，与瞬时 hover 目标分开。整系列强调采用默认值与例外索引集表示，单点 downplay 不影响其他点；新加入的数据行遵循整系列默认值，无需在初始化时展开所有行。运行时 `set_emphasis` 先校验系列和数据索引，失败不修改状态。tooltip/legend 配置与实际绘制消费仍需继续对齐，不能据此宣称完整 ECharts 交互支持。

悬停/选中/取消选中与持久强调复用数据索引校验，失效索引不修改状态。tooltip 的 enabled=false 或 trigger=none 抑制提示状态，保留悬停目标；隐藏系列清除其瞬时 tooltip/hover，持久强调保留。axis tooltip 的跨系列聚合及实际绘制仍待接入。

`packages/deep-engine/fixtures/chart-spec-v1.json` 经真实 TS 编译生成 `chart-ir-v1.json`。TS 测试重新编译并比较完整对象；Native 测试读取同一 IR 后再序列化，比较完整 JSON 结构。数值以 JS double 语义比较，允许 JSON 的 `10` 与 `10.0` 表示差异；字段及数组顺序不丢失。夹具覆盖六类 series、中文标签、非默认 legend/tooltip、zoom 及五类动作。

## 本轮待办

`render_chart_with_windows` 接受隐藏系列与归一化窗口，消费线性/时间数值域、log 域和 X 类目带范围，支持 X/Y 数值轴缩放；复位时传入空窗口恢复静态几何。初始 dataZoom/actions 通过 `InteractionState::from_ir` 生成窗口再传入此入口。旧 `render_chart` 保留静态入口，不自动消费初始交互。

受缩放轴影响的系列使用 plot clipRect，不在 CPU 上把越界点压到画布边缘；过大的投影仍由 DisplayList 坐标预算拒绝。窗口必须有有效轴、唯一轴 ID 和有限的 `0≤start<end≤1`。Heatmap 已接入双轴窗口及裁剪；窗口控制器接线仍待验收。

坐标映射独立为 `render_cartesian.rs`，与域解析、图元及帧组装分开。axis 8、layout 5、render 11、visibility 3 共 27 项通过；5 项真实 GPU 测试通过，新增缩放像素变化、绘图区外透明和复位逐像素一致。GPU 为固定小图夹具，未替代窗口交互或视觉验收。

Native 布局已消费 legend.visible 与 top/right/bottom/left：隐藏时释放空间，上下预留 24px，左右预留 120px，保持 8px 外边距。实际图表路径使用这一 plot 矩形；空间不足返回错误。侧栏宽度为当前布局策略，图例文字测量、条目绘制与点击仍待接入，未完成视觉验收。

程序构造对象的完整约束、运行时状态到绘制和命中的接线仍需核验，不能把解析成功等同于完整消费。

`render_chart_with_hidden_series` 已接入 `InteractionState.hidden_series` 对应的系列几何筛选；未知系列拒绝，重复隐藏 ID 合并。资源 ID 使用图表/系列身份哈希与系列内路径序号，隐藏或重排其他系列不改变该系列资源 ID；命令 z 序仍遵循当前源顺序。路径数量变化时系列内部数据点身份及 revision 管理仍待动态编译接入。此入口只消费系列可见性，不消费 zoom、emphasis、selection 或 tooltip。

绘制组装在 `chart/render_frame.rs`，图元几何仍在 `chart/render.rs`。六类图表隐藏/恢复、全隐藏、未知系列、重复项、重排身份共 3 项测试通过，加既有 layout/render 共 19 项通过。4 项实际 GPU 测试通过，新增线图隐藏后 alpha 全零、恢复逐像素相同；每次读回新建 painter，不代表长期 GPU 缓存或窗口点击验收。

下一步接入图表运行时状态，随后验证视觉和行为；本文件不证明完整图表发布支持。DashboardDocument v1 源合同与外框编译已建立，二维内容及发布接线见 deep2d-dashboard-document-v1-2026-09-15.md。

## 验证

`ChartGeometryFrame::prepare` 校验源后构建只读 DisplayList、现有 Deep2D 路径命中索引和目标表；绘制与命中共用变换、裁剪和 z 顺序。通过 `display_list()` 获取绘制数据，通过 `hit(x,y)` 返回系列和可选原始行号。柱/散点/饼/热力图保留筛选前行号，线图包络与仪表盘返回系列级目标。修改调用方 state 不会改变已准备快照，候选失败保留调用方持有的旧帧；这不是全局 Epoch 提交协议。

命中4、render11、heatmap2、visibility3共20项通过，涵盖跳过负值/零柱后行号、缩放裁剪、全隐藏、重叠顺序、非有限坐标和失败候选，既有6项GPU回归通过。窗口指针事件、最近线数据点/轴tooltip、强调绘制和长驻缓存revision仍待接入。

笛卡尔图形坐标映射已修复 Y 轴忽略 log、min/max 必须成对才生效的问题。独立 `render_domain.rs` 按单侧作者界限和数据范围解析域，双轴支持 log；无效程序构造 log 域不再偷偷转为线性。3 项实际路径坐标测试覆盖等距十倍刻度、单侧界限和非法域，加既有 render/visibility 共 17 项通过，既有 GPU 4 项回归通过。该批未接入缩放窗口或新增窗口视觉验收。

ChartIR 读取器、ChartSpec 编译器和 EChartsOptionCompat 的 35 项测试通过，覆盖完整 JSON 往返、源修改隔离、逐个必需字段、null 集合、版本和未知字段、引用/数值/交互错误、非法 JSON 与 accessor 拒绝。Native wire/contract/layout/render 共 22 项测试通过，chart 库 11 项通过。

`chart-ir-v1-invalid.json` 的 12 个失败样例由两端读取，每例先证明未变更的基线有效，再改变一个约束验证拒绝：ID、空标签、线性/对数轴、热力图数值与轴通道、必需维度以及不适用的 series 字段（含 null）。Native wire 读取按 series 类型检查字段，语义校验补齐 ID、单侧非有限轴界限、UTF-16 文本预算；数据集超限在遍历数据行前拒绝。

字节入口补充测试覆盖错误 JSON、版本/字段/语义拒绝、emoji 字符预算及节点/深度边界；实际 Native 二进制子进程通过 golden 校验，并拒绝作者 ChartSpec、缺文件和多余参数。该批 wire 7 项、预算 2 项和 CLI 2 项通过，Native all-target 检查通过。

热力图布局按轴解析：category 保留键首次出现顺序，linear/time/log 使用数值位置；数值单元格宽度取变换域内相邻唯一值的最小间隔，单值回退为一个单位，无显式界限时两端各扩半格，作者单侧界限优先。数值 Y 轴向上，类目 Y 轴按来源顺序向下。所有热力图始终裁剪到 plot，缩放只改变位置/尺寸，色值域仍取完整数据。几何逻辑位于 render_heatmap.rs。

本批 axis8/heatmap2/render11/visibility3 共24项通过，实际GPU6项通过；新增GPU断言缩放前后同一单元格颜色一致、图外透明、复位像素相同。此数值单元格策略仍需跨端对照与正式能力报告，不代表任意ECharts热力图等价。

ChartRuntime 拥有源、交互状态、尺寸和几何命中快照。dispatch、resize、replace先准备候选再提交；全量replace重放作者初始动作。几何变化清除过时hover，并递增DisplayList/Path revision；纯hover/selection只改交互状态，保持路径。pointer_move从已提交数据提取标签/值，pointer_select切换命中目标选中；线/仪表系列级hover不生成伪造数据点tooltip。坐标为图表逻辑坐标，宿主负责DPI/偏移换算。

runtime4/geometry4/hover3/initial3通过，真实CLI2和既有interaction3通过；覆盖极窄缩放导致几何超预算、无效尺寸、非法替换均保留源/状态/帧/revision，正常替换重置作者状态，几何revision跟随提交。此控制器尚未接winit窗口事件/覆盖层，不是完整Epoch、依赖增量或长驻GPU缓存验收。

`--chart <chart-ir.json>` 复用既有winit/wgpu窗口显示固定640×360逻辑画布，按窗口尺寸等比适配。点击切换选中，滚轮缩放首个X轴，Home复位；光标经既有LetterboxMapping换算。提示和选中计数暂显示标题栏，图内文字/覆盖层仍待实现。

宿主缩放先准备独立ChartRuntime候选，再调用既有stage_deep2d_update/publish_deep2d_update，通过后更新CPU源帧，失败保留旧CPU/GPU帧。指针状态不复制整份数据/几何；缩放候选仍复制整帧，增量优化待办。content保存当前图表和Deep2D用于GPU恢复。

`--smoke-chart` 的真实64×64窗口已在RTX4060 Laptop/Vulkan/BGRA8sRGB依次呈现初始、缩放、复位三帧，三次GPU scopes/callbacks均clean。此探针调用同一宿主缩放入口，未注入真实OS鼠标事件；不提供截图评分、发布可信窗口证据或完整产品视觉验收。CLI/runtime6测试、Native all-target check及repository gate通过。
