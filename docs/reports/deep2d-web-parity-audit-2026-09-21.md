# Deep2D 对照 Web 作者效果与交互审计

**视频后续更新（2026-09-22）：** 正式编译链已把作者视频资源引用与播放意图写入 v1 能力合同；项目内 MP4 可经发布冻结、内容寻址、32 MiB 预算与 ISO BMFF `ftyp` 探测进入运行包。Windows Native Dashboard Runtime 使用 Media Foundation 连续解码真实 H.264 MP4，按单调时钟与 PTS 更新 BGRA sRGB GPU 纹理，并已接入持续播放、暂停、绝对/相对 seek、循环、fit 与窗口生命周期暂停恢复。GPU 合成器现在绘制可见播放按钮和进度条；正式窗口事件把点击、拖动、Space/Enter、左右键、Home/End 接到同一控制命令，视频焦点优先于三维相机。已打包且静音的资源状态升级为 `ready/autoplay|poster`，不再伪留 controls/seek blocker；非静音仍精确阻断 `audio-output`。Media Foundation、运行时、输入命中和 DX12 合成聚焦测试通过；正式发布 EXE 的可见窗口、系统输入回放和音频仍留最终集中验收。

**文本输入后续更新：** 正式 Dashboard 编译与 Native Runtime 已接 `text-v1`，含冻结字体、文本编辑、IME 与有界 sample 图表筛选。基本链路关键测试通过；剪贴板、完整键鼠、CSS/主题/DPR 与正式产物实机尚未完成，见 [文本输入切片](deep2d-text-input-v1-2026-09-21.md)。下文输入框“尚未接线”是此次更新前的基线。

**后续源码更新：** 正式编译链已新增有界 `select-v1` 弹层，支持 1–256 项、滚动、键盘确认/取消和长标签提示，旧包保留 16 项展开列表。下文为更新前审计基线；最新实现、测试与未完成的实机画面范围见 [单选弹层切片](deep2d-select-v1-2026-09-21.md)。

**下拉键入搜索后续更新（2026-09-22）：** `select-v1` 直接使用正式发布包中的选项值完成 Unicode 键入定位，连续输入窗口为 900 ms，先前缀后包含匹配；英文键盘文本和系统 IME commit 均进入同一待确认高亮，仍由 Enter 原子提交筛选。查询在超时、Esc、Tab、方向键、鼠标关闭及提交后清理。Native 7 项单选聚焦测试、Dashboard Runtime 同族回归 30/30 及 bins 编译通过；正式 EXE 的真实 IME 候选窗与多 DPI 画面对拍仍归最终验收。

2026-09-21；范围为自研 Deep2D/Deep Native，以及二维页面内嵌三维的交界。本报告是源码与调用路径审计，不是本轮实机验收。当前结论：已有可运行的二维原生子集，尚未完整复刻 Web 的组件、样式、数据行为和键鼠交互；能够生成 EXE 不代表效果与行为等价。

## 0. 用户关心的五类基本元素

| 元素 | 自研引擎当前能力 | 精确边界与接线证据 |
|---|---|---|
| 图片 | 静态图片已闭合到正式编译、冻结资源和 Native 纹理绘制 | 支持 cover/contain/fill、内容哈希和离线包；动画 GIF、多页图片仍明确拒绝，不能写成动态图像等价 |
| 文字 | 静态文字与 `text-v1` 单行编辑已进入正式编译和 Native Runtime | 冻结字体、字素光标、选区、撤销、IME、剪贴板和横向滚动已有生产路径；RTL/bidi、全部 CSS 排版和正式窗口像素对拍仍未完成 |
| 输入框 | 作者 `filterMode:text` 已接正式 Dashboard 编译、筛选事务和统一焦点表 | 支持 1–16 个输入、Tab/Shift+Tab、Enter/Esc、键鼠选区、Windows 剪贴板快捷键和 IME；跨维度任意筛选、通用表单控件与实机候选窗仍不完整 |
| 视频 | 已打包的 H.264 MP4 进入 Media Foundation 连续解码、PTS 时钟、GPU 纹理和播放器控制 | 静音视频为 `ready`，支持播放/暂停、seek、循环、fit、点击拖动及 Space/Enter/方向键/Home/End；非静音仍精确缺 `audio-output`，正式 EXE 窗口需最终验收 |
| 下拉选择 | `select-v1` 已实现真正弹层、1–256 项、滚动、有界可见窗口与键入定位 | 支持开合、焦点、上下/Home/End、Enter/Space、Esc、外部点击、向上展开、长标签提示、英文键盘和 IME commit 搜索；多选、级联及完整主题像素对拍仍待补齐 |

**IME 与剪贴板已经进入 Dashboard 输入路径。** Winit 的文本/IME 事件、Windows Unicode 剪贴板、点击/拖选/双击选词与 `TextEditState` 使用同一事务；失焦、换页和焦点切换会取消预编辑并保留已提交值。当前未完成项是正式 EXE 的系统候选窗、真实剪贴板和多 DPI 输入回放，不再是“底层存在但 Dashboard 未接线”。

这些结论限定自研二维产品路径，不扩大成所有底层模块都不存在相关基础能力。

## 1. 正式生产路径与发布门禁

| 阶段 | 当前入口与证据 | 判断 |
|---|---|---|
| 部署接线 | `apps/api/src/dashboardNativeStartup.ts:31`：读取部署配置，导入 `dist/dashboard-content-compiler/deployment.mjs`；未配置则不注册 | 路由是否开放取决于实际部署，不能只凭源码推断当前服务已启用 |
| 冻结、编译、验窗 | `apps/api/src/dashboardNativeCandidateService.ts:125` 建立能力报告，`:138` 准备同一冻结输入，`:144` worker 编译，`:150` 接收产物，`:165` 验证发布 gate | 绑定作者版本、资源与产物身份；不是浏览器自报支持 |
| 当前编译器 | `scripts/dashboard-content-compiler.mjs:50` 测量图表/筛选/表格；`:71` 调用 `compileDashboardRasterContent`；`:80` 返回序列化运行包及对象证据 | 当前正式路径不是早期仅矢量内容 pass |
| 支持度判定 | `apps/api/src/dashboardPublicationCapability.ts:140`：有内容、实际渲染、字体证据完整且 deferred 为空才 supported，否则 degraded/blocked | 窗口能出图不自动变为 supported |
| 最终候选 gate | `apps/api/src/dashboardNativeCandidateRegistry.ts:15` 校验身份、对象非空及状态自洽；`:37` 只拒绝无原因的 blocked，`:40` 拒绝仍有 deferred 的 supported | **有原因的 blocked 和 degraded 均允许通过**，没有要求所有对象 supported |
| 下载 EXE | `apps/api/src/dashboardOfflineArchiveDownloadRoutes.ts:125` 再跑同一 gate；`:146` 创建归档；`:157` 根据格式生成 ZIP/EXE | 最终下载没有另加“所有对象 supported”的门槛 |

`compileDashboardRasterContent.ts:134` 的 `publicationReady:false` 不是最终下载阻断条件：正式包装器未把它作为 gate 输入，而是把对象内容与 deferred 字段交给服务端重建报告。`scripts/dashboard-content-compiler.mjs:84` 还统一追加 `runtime.interactions`、`appearance.crossHost`，因此该路径保留降级事实。准确表述是“允许带已登记缺口的产物打包”，不能写成“false 所以不可发布”，也不能写成“EXE 已生成所以完整支持”。

候选摘要 `dashboardNativeCandidateRegistry.ts:47` 仅含身份/哈希，不含对象支持度；能力报告随归档保留。应把缺口摘要接到发布前预检与结果页，避免用户直到运行时才发现差异。

## 2. 已有实现与明确限制

| 能力 | 已有实现 | 仍未等价的部分 |
|---|---|---|
| 文字/图片/形状 | raster 节点支持冻结字体与样式、文字图集、图片像素、矢量形状；`dashboardRasterNode.ts:29` | 资源与字体必须闭合；不是通用 HTML/CSS 渲染器 |
| 页面背景 | `compileDashboardRasterContent.ts:90` 支持已冻结背景图片；`:141` 背景颜色 | 页面背景已接入，不能因组件背景图缺口误写“所有背景图不支持” |
| KPI/表格 | `dashboardRasterNode.ts:111` 有测量数据视图；`compileDashboardRasterContent.ts:100` 接 `compileDashboardTables` | 基础静态测量与后续表格交互通道不同，不能把早期 deferred 注释当全部现状 |
| 报表交互 | `packages/deep-engine-native/src/dashboard_runtime/table.rs:57` 命中控件；`src/app/dashboard.rs:15` 分发分页/排序及 CSV/XLSX 保存 | 依据冻结表格视图和导出数据，未证明全部实时数据、行操作和任意控件键盘等价 |
| 图表 | `lowerDashboardChart.ts:32` 支持作者 bar/line/scatter/pie 数据转换；Native 支持 hover、选择、图例、缩放 | 堆叠、数据标签、双轴、钻取明确拒绝；超过20类饼图拒绝。其他底层 ChartIR 图形存在不等于作者组件已接线 |
| 图表视觉 | 正式路径可组合 ChartIR 和测量标题 | `lowerDashboardChart.ts:95` 明列字体、配色、网格、平滑曲线、饼环外观仍待呈现合同和像素验收；`:96` 作者点击联动/筛选/动画未由该 lowering 完成 |
| 筛选联动 | 可混合 1 个 `select-v1` 与 1–16 个 `text-v1`，共享目标按交集提交；下拉字段可不同于图表维度 | 多个 select、级联、多选和任意跨维度文本仍未支持；当前图表数据推导仍是有界 sample profile，冻结变体不等于在线查询 |
| 容器效果 | 背景及受支持路径已有 | `dashboardRasterNode.ts:21` 明列阴影、圆角、组件背景图片与运行行为未编译 |
| 排版变换 | 支持测量后的限定布局 | `dashboardDataCaptureGeometry.ts:38` 拒绝旋转、镜像、非等比捕获；`:46`、`:55` 拒绝不支持的断词/换行配置 |
| 三维视口 | 需要三维编译通道 | `compileDashboardRasterContent.ts:69` 对此二维 pass 中的 scene viewport 登记 blocked；不能据此推导整个自研3D引擎不支持三维 |

较早 `compileDashboardContent` 的“文字/图表待接入”只描述该 pass。正式 raster 通道已经补文字、图片、KPI、表格和图表组合，审计必须同时检查后续消费者。

## 3. 键鼠并不完整等价

1. **已有鼠标行为**：`packages/deep-engine-native/src/dashboard_runtime/input.rs:7` 支持筛选点击、图表 hover/选择、图例切换/翻页；`:68` 缩放 X 轴。表格控件命中与报表保存已有正式宿主调用。
2. **整页焦点已有正式子集**：当前页可见且与裁切相交的 text/select、表格分页/排序/导出按钮进入同一焦点顺序，支持 Tab/Shift+Tab、Enter/Space 与分层 Esc。作者通用按钮和 dashboard 内全部图表动作尚未进入同一生产焦点表，不能扩大为整页所有控件等价。
3. **独立图表不能代表整页**：`packages/deep-engine-native/src/app/window_events/keyboard.rs:36` 的图例焦点快照取 `active().chart`，并非 dashboard 内 charts；独立图表 Tab/Enter/Space 测试不能替代整页键盘验收。
4. **宿主差异**：`packages/deep-engine-native/src/app/window_events.rs:106` 忽略按键 repeat；`:147` Escape 可关闭窗口。需要明确焦点控件、弹层、全屏、窗口四层的消费顺序，不能默认它与 Web 作者运行页一致。

本报告没有把“未见接线”等同于底层完全不存在。输入法、文本编辑、触控、表格横向滚动等仍应按生产入口查验；当前证据不足以给出完整支持承诺。

## 4. 测试证据应如何解读

- 单测可证明限定输入的转换/拒绝行为；不能证明任意页面兼容。
- native GPU 测试可证明限定绘制和资源路径；不能单独证明生产发布已调用该路径。
- 固定窗口截图可证明当时画面；不能证明筛选、焦点、滚动、导出、断网和重开状态。
- `renderedNodeIds`、资源哈希与字体证据可证明身份与覆盖；不是全样式像素相等或完整键鼠等价声明。
- 当前报告未重新运行原生窗口，也未核对正在运行服务的编译 bundle 哈希；上述生产调用结论指当前仓库源码，部署二进制仍需逐项对照。

## 5. 可执行整改顺序

| 优先级 | 切片 | 验收与同族范围 |
|---|---|---|
| P0 | 发布缺口可见化与产品策略 | 返回对象/字段/严重性报告；预检可定位作者节点。对不可见内容和必需交互制定显式阻断规则；视觉近似能被准确识别。同步候选生成、重试、再次下载、离线归档、独立EXE入口。不要简单把全部 degraded 一刀切阻断 |
| P0 | 统一整页输入与焦点路由 | Dashboard 建立控件焦点顺序，复用同一命令处理鼠标/键盘；Tab/Shift+Tab、方向键、Enter/Space、Esc 分层消费、滚轮及repeat都有产品测试。覆盖筛选/图表/表格/分页/导出及2D-3D混排 |
| P0 | 五类基本元素最终验收与剩余边界 | 用当前正式编译器重新发布，在真实 EXE 覆盖图片/文字、输入框 IME 与剪贴板、下拉弹层及键入定位、静音视频播放/seek、保存重开和离线运行；补视频音频输出、多选/级联、RTL/bidi 与通用作者按钮前保持精确能力提示 |
| P1 | 作者组件能力矩阵单源 | 每类组件逐字段声明编译、视觉、交互、数据来源状态；绑定发布目标与版本。用消费者证据判定，底层图形库存在不自动登记支持 |
| P1 | 高频图表呈现合同 | 先补堆叠、标签、双轴及作者色板/字体/曲线/环图；固定同数据、尺寸、DPR、字体、主题的像素与交互回放。低频图表保持精确诊断 |
| P1 | 容器与排版 | 补圆角裁切、阴影和背景图的明确绘制顺序；覆盖嵌套、遮挡、透明、文本缩放与不同字体。不要用整页静态截图覆盖交互缺口 |
| P1 | 数据与联动 | 区分冻结快照、冻结变体和实时数据；逐步补多筛选/级联/钻取与行操作，设组合预算和增量更新合同，失败时保留旧状态 |
| P2 | 三维嵌入协同 | 二维合成与自研3D共享视口坐标、裁切、输入捕获和焦点归属；跨视口拖动、测量、图表联动后保存/重开/离线回放 |

完成定义：一份作者文档经生产发布链得到当前 Native 产物，组件外观、状态变化、键鼠序列、数据来源和错误恢复均有证据。每个组件分别记录通过范围，不使用“全量完美复刻”替代能力矩阵。
