# Deep2D 文本筛选正式接线

2026-09-21。作者 `filterMode:text` 已接入正式 Dashboard 编译与 Native Runtime。当前为有界功能切片；正式 EXE、宿主实机输入和 Web 画面对拍留在统一验收阶段。

## 本轮实现

- 复用在途 `dashboardTextInputCompile`、独立合同、`TextEditState`、`WinitImeAdapter`、`FrozenTextRasterizer`；没有重建编辑器或接无人消费的原型控件。
- `compileDashboardRasterContent` v8 生成 `textInput` 和真实命中节点，保留 `degraded` 与剩余呈现原因。Native 从包内字体字节建立隔离字体库，验证哈希和面索引，不查系统字体、不联网补字体。
- 原生单行输入支持键入、退格/删除、左右/Home/End、Ctrl 左右、Shift 选区、Ctrl+A、Ctrl+Z/Y、Ctrl+Shift+Z、Tab 焦点及 Enter/Esc 离开。点击按冻结字体测量定位字素边界，长值随光标横向滚动。
- Winit 正式宿主接收文本、IME、修饰键、重复键。预编辑单独绘制，提交才更新数据；IME 候选区域按真实光标与 letterbox 变换定位。失焦、换页清掉预编辑，失焦清修饰键。
- 输入编辑、筛选图表数据和整帧呈现沿用既有候选事务；缺字、预算、数据或呈现失败保留已提交状态。筛选遵循 Web 空值、`all`/`全部`、区分大小写 exact、ASCII 不区分大小写 contains 语义。

## 边界

支持 1–16 个文本筛选，旧包保留 `textInput`，多个控件使用互斥的 `textInputs`；每控件 1–32 个 sample bar/line 目标；筛选字段等于图表维度，无系列/计算字段/limit。共享目标对所有相关文本值求交，不允许后输入覆盖前输入。冻结分类仅支持 ASCII 或没有大小写转换的文字（例如中文）。每控件字体最多 8 面，所有输入字体合计 32 MiB，单控件绑定 4 MiB、每目标 10,000 行；控件宽 96–2048、高至少 66，字体及行高最多 32。输入最多 256 字素，同时受当前 2048 像素文字光栅范围限制；超限明确拒绝，不截断保存值。

任意跨维度文本筛选、通用作者按钮/图表的完整焦点树、RTL/bidi 光标、组合输入内部候选光标、完整 CSS/主题/占位文字与标题对齐、DPR 字体采样仍未完成。不能称为“所有输入框和键鼠完全复刻”。当前文字绘制会在重建时光栅化，缓存与性能指标尚未验收。

## 多输入与统一焦点后续更新

当前页可见且与页面/节点裁剪相交的 text/select 控件、表格已启用的分页/排序/导出按钮进入同一 Dashboard Runtime 焦点顺序。Tab/Shift+Tab 双向遍历，在页首/页尾返回页面焦点；表格 Enter/Space 调用原有动作与导出路径。表格控件有实际 Deep2D 焦点环，不虚构未编译的作者按钮。每个文本控件保留独立编辑值、选区和撤销历史；切换/失焦取消预编辑，保留已提交文字。文本横向滚动和 select 可见窗口沿用原实现。

Native 共享 retained-control 状态机已补齐作者按钮类控件的 Enter/Space 语义：`Button` 返回一次 `Clicked`，`Toggle`/`Checkbox` 返回一次状态翻转；disabled/loading 控件吞掉键盘激活，键盘路径清除悬挂的 pointer press，避免键盘与后续 Release 重复触发。`cargo test controls -- --nocapture` 相关 7 项通过。该证据限定在控件状态层；Dashboard 作者按钮尚未拥有生产 runtime 字段、焦点登记和动作消费，因此仍不能写成作者按钮页面已接通。

生产编译器、TS 严格校验、Rust 载荷、Runtime 和宿主均消费多输入合同。关键验证新增：两个真实输入在同页正反向切换、各自文字保留、交集筛选与清空恢复、切换取消 IME、页面焦点恢复；表格按钮正反焦点与原动作。Web 编译测试现 4 项通过，Native 输入相关 5 项与表格焦点 1 项通过，Web 类型检查与 Native bins 检查通过。完整页面输入回放与视觉仍待统一实机验收。

后续键鼠接线：Windows `Ctrl+C/X/V`、`Ctrl+Insert`、`Shift+Insert/Delete` 接到原生 Unicode 剪贴板，读取最多 128 KiB，校验 UTF-16 终止与编码，剪贴板占用/格式错误有诊断，复制成功后才尝试剪切事务。粘贴按单行控件移除 CR/LF，其余输入预算和缺字失败仍保留旧值。左键拖选、Shift 点击扩选、Unicode 双击词选复用同一 `TextEditState`，双击时间使用 Windows 当前设置；释放/失焦清手势。仅启用现有锁定 `windows` crate 的 DataExchange/Memory/KeyboardAndMouse feature，无新 crate。系统剪贴板及实际窗口拖选还需最终实机验收。

## 关键证据

- `dashboardTextInputCompile.test.ts`：3 项通过；冻结原图表分组值、拒绝系列/多筛选/缺字体、真实生产编译→包校验与命中节点。字体字节使用编排测试桩，不作为字体视觉证据。
- `dashboard_runtime::input_text_tests`：2 项通过；真实本机 Latin 字体字节冻结后，通过正式 Runtime 合成与 prepare，验证预编辑不改数据、提交空匹配、撤销恢复、全选删除、鼠标光标、失焦取消、非法输入回滚、字体哈希及数据绑定拒绝。测试字体发现仅在测试夹具内，生产不发现系统字体。
- `cargo check --bins --offline` 与 Web 类型检查通过。光标移动不会更新图表数据版本，关键测试已覆盖。
- 后续选区/剪贴板 Runtime 关键测试共 4 项通过（原 2 项加 Unicode 词边界、真实 Runtime 粘贴/剪切/撤销/拖选/超预算回滚）。没有改写用户系统剪贴板做测试；Windows API 适配的真实读写留在实机验收。

没有重跑全量、生成发布 EXE 或追加视觉截图；这些统一在最终验收执行。

## 文本与下拉混合筛选更新

生产编译支持 1 个 select 与 1–16 个 text 控件共同派生。select 继续用已有原始行筛选、聚合和冻结选项变体；Native 先选定不可变变体，再对共享目标叠加全部文本条件。不同控件顺序不影响结果；文本清空恢复当前 select 的变体，select 清空仍保留文本条件。共享图表每事务只提交一次数据更新。

select 字段可以不同于图表维度：例如按工厂选下拉、按地区输文字，保留该工厂实际地区汇总值。文本字段仍必须等于 bar/line 维度；任意跨维度文本需原始行派生合同，尚未完成。重复 key 或同节点绑定拒绝，未支持的多个 select 不因旁边存在有效 text 就被标成已编译。

混合控件沿用统一焦点表；Tab/Shift+Tab 从 select 切入 text 关闭弹层，从 text 离开取消 IME 预编辑。宿主鼠标优先交给打开的 select 弹层，避免覆盖下方文本框时错误抢焦点。

本次验证：Web 编译/文本/下拉 14 项测试与类型检查通过；Native 输入 6 项通过，追加混合焦点后 group 3 项通过（合计 7 个不同输入测试）。跨维度 select 数据编译证据使用原始多维行，Native 交集测试使用真实冻结字体。宿主 bin 同批由性能切片完成编译及其 4 项定向测试。完整窗口、剪贴板、IME 候选窗口、正式包和画面对拍继续留最终验收。
