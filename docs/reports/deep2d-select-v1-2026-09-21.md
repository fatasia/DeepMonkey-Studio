# Deep2D 单选筛选弹层切片

正式 Dashboard 编译链新增 `select-v1`，解决旧 frozen-filter 最多 16 项、始终展开的问题。本切片是代码与运行时合同验证；Native 实机画面和真实输入回放尚待验收。

## 合同

- 新包可选字段 `filter.presentation = { kind: "select-v1", rowHeight: 32, visibleRows: 8 }`。支持 1–256 项，保留 4 MiB 冻结变体与 64 MiB 页面 atlas 预算；超限或字形缺失直接拒绝。最小控件尺寸 59×66。
- 无 `presentation` 的旧包保持原有展开列表、16 项与原键盘逻辑，不改旧载荷解释。
- 默认值仍是作者第一项，与 `DashboardWidgetRuntime` 在未提供筛选值时一致。选项顺序、原始值、精确匹配/全部语义及冻结数据事务不改变。
- 单击值框或聚焦后 Enter/Space 打开。上下/Home/End 移动高亮并让其进入可见窗口；Enter/Space 或点击选项确认。Esc、外部点击、窗口失焦、切页关闭弹层而不提交高亮值。
- 聚焦后直接键入会打开弹层并按正式发布包中的 `option.value` 定位：900 ms 内连续输入组成查询，先做 Unicode 小写前缀匹配，再做包含匹配；超时开始新查询。英文键盘文本与系统 IME commit 走同一入口，只移动待确认高亮，Enter 仍沿用原子筛选事务。Esc、Tab、方向键、鼠标关闭及提交都会清理查询。
- Tab/Shift+Tab 在当前唯一单选控件与页面焦点之间切换；没有在本切片中宣称图表/表格完整统一焦点树。方向键 repeat 已由正式宿主转发；Esc 在弹层打开时先被控件消费。
- 滚轮只在弹层命中范围内移动可见窗口。底部空间不足时向上展开；菜单与完整标签提示作为页面末尾图层绘制，优先于后续图表/表格命中。
- 长标签按冻结字体实际行信息二分测量省略文本；完整值不变。完整标签另外冻结并由悬停提示展示；提示本身装不下时拒绝编译，不能静默丢字。

## 接线

作者到产物：`dashboardFrozenFilter`、`dashboardFilterDataVariants`、`dashboardFilterRaster` → `compileDashboardRasterContent` v6 → `dashboardCompositionTypes` / `dashboardFilterValidation`。

Native：`runtime_package/dashboard_types` → `dashboard_runtime/filter_select`（状态和命令）、`filter_select_typeahead`（键入匹配）、`filter_select_validation`（字形池约束）、`filter_select_paint`（值框、菜单、提示）→ `compose`。正式宿主 `app/dashboard_text_input` 接收键盘文本与 IME commit、定位系统候选窗，`app/dashboard_input` 经既有整帧 `apply` 事务提交，窗口键盘 repeat 与失焦从 `window_events` 接入。

`app/dashboard` 原输入路由抽至 `dashboard_input`；两个文件分别约 280 / 163 行，新增 Select 状态、绘制、校验与测试均小于 300 行。未修改无人消费的 `native_ui::Select` 原型来替代产品接线。

关闭状态仅复制选中项纹理，展开状态仅复制可见项纹理，不先复制整个 256 项字形池再过滤。这个结论来自代码路径；没有将其换算为 FPS 或端到端性能倍率。

## 已验证

- Web 正式编译及相关 4 文件 25 项测试通过：25 项完整身份、长标签原值/省略/提示、257 项拒绝、无合法 filter 时不绘制重叠字形池。
- Deep Engine 合同 3 项测试通过：旧包拒绝超 16 项，新 profile 接收 25 项，未知 profile 与超预算拒绝。
- Native `DashboardRuntime` 全部 20 项测试通过：真实运行状态、数据更新、组合绘制 prepare、末项可见/命中、上弹/提示、焦点与取消、失败事务回滚、缺失/越界字形拒绝，包含旧筛选、表格和页面切换回归。
- Web / Deep Engine 类型检查、Native bins 检查和开发二进制构建通过。编排测试用的栅格桩不属于真实字体画面证据。
- 本轮开发二进制：`packages/deep-engine-native/target/debug/deep-engine-native.exe`，2026-09-21 17:33:44，42,332,160 字节，SHA-256 `aff5dcbc84339554966c861b7acc3e0dcb41da4596bfd5fb3b13a43fcafe1fe4`；不是最终发布 EXE。
- 2026-09-22 键入搜索增量：Native 单选聚焦测试现为 7/7，Dashboard Runtime 同族回归 30/30；覆盖英文连续输入、中文 IME commit 所用 Unicode 值匹配、900 ms 超时重置、控制字符拒绝和 Enter 提交前不改数据；bins 编译继续通过。编译器和发布合同未扩张，直接复用已经冻结并校验的作者选项值与字形池。

## 本轮待验收

正式冻结作者页面经当前编译器重新发布，核对产物身份，在实际 Native 窗口回放鼠标滚动、Tab/Shift+Tab、键入搜索与真实 IME、长按方向键、Home/End、Enter/Esc、窗口切换和重新打开。覆盖中英文长文本、不同 DPR、页面边缘、表格覆盖位置与不同主题截图。

当前控件 chrome 复用 Native 设计令牌并沿用冻结容器背景，不代表所有 Web CSS、标题布局和主题均已像素等价；完整主题/布局呈现合同及实机差分仍待验收。多筛选、级联、输入框、视频与全页焦点树不属于本切片完成项。
