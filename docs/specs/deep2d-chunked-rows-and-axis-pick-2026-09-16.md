# 混合值分块存储(P1-03)与 Axis/线段拾取(P1-14)

日期:2026-09-16 凌晨。与 [Epoch 与文字测量](deep2d-epoch-and-text-fit-2026-09-16.md) 同夜的后续切片。

## P1-03 混合值分块存储

`chart/chunked_rows.rs`(新,239 行):与 C05 f64 专用 `ChunkedSeries` 不同,本容器以 `ChartValue` 原样存储,保留分类/中文/空值语义;按 8192 行/块的 Arc 行块共享。

- **旧快照隔离**:clone 共享全部块 Arc;任何写入只按需写时复制受影响块,`chunk_strong_counts()`/`shares_chunk_storage_with()` 提供引用计数证据。
- **窗口淘汰**:`append_window(new_rows, window)` 先整块追加再从头部整块淘汰;窗口边界落在首块中间时仅该首块写时复制收缩。`head_start + total_rows` 恒等于末行绝对行号 + 1,块起始行号绝对化不重排。
- **预算**:`with_budget` 对初始行数 fail-closed;`append_window` 的窗口是淘汰后驻留上限(与 C05 无窗口通道的 fail-closed 语义有意区分,已注释);`window == 0` 或单批超预算拒绝。
- **未接 ChartIR**:按任务要求不声称现有数值列已接入 ChartIR;本容器是数据通道的存储层,JSON `ChartRows` 合同不变。

验证:5 项单测(混合语义遍历、克隆共享与写时分离、整块淘汰+旧快照完整保留、部分边界仅复制首块、预算 fail-closed+null 行合法)。

## P1-14 Axis 最近 X 与线段拾取

- `chart/render_cartesian.rs`:`XInverter` 屏幕 x→数据坐标反解(连续域线性/log 反插值、类目行带/行窗),正向投影与反解器成对产出,分支条件与原映射逐字一致。
- `chart/geometry_frame.rs`:`invert_x(x)` 与 `nearest_x_targets(x, tolerance)`(前景优先跨系列聚合);`chart/line_point_index.rs` 新增 `nearest_x`(最近点,平局取小行号)与 `nearest_segment`(点到线段 ≤8px、x 包围剪枝),`data_index` 语义不变。
- **顶点优先**:顶点半径内 datum 绝对优先,线段只补顶点之间的空隙,密集线不因段距离≈0 而压过顶点;线段命中为系列级(与既有 stroke 命中合同一致),datum 聚合由 `nearest_x_targets` 承担。
- 覆盖:linear/time/log×zoom、category×zoom、span 0.01 极端窗口、空数据集有界轴、单点系列、图例隐藏、tolerance 0/NaN、zoom 裁剪行不参与拾取。
- 限制(代码已注释):多 X 轴取绘制序第一个 cartesian 系列所属轴。Axis tooltip 的 pointer_move 宿主已接线：先按 screen-X 聚合最近可见 datum，bar-only 场景回退到命中矩形，再复用同一 `Hover` action 读取源单元；逻辑坐标容差固定为 16px。

验证:`tests/chart_axis_pick.rs` 12 项 + `chart_line_pick.rs` 7 项;新增 `chart_tooltip_content.rs` axis pointer 回归 1 项，cartesian 家族与 hover/legend/tooltip 回归通过。

## 合并回归与真实窗口(2026-09-16 03:20)

- Native 全套(两代理+主线程三方改动合并):**742 通过 / 0 失败 / 52 GPU 忽略**,102 个测试目标;`cargo check --all-targets` 0 warning。此前遗留的 `chart_runtime.rs` 基线红项(selected/hover 语义)已由本批拾取修正顺带解决。
- 真实 GPU 窗口(RTX 4060 Laptop/Vulkan,EXE SHA `1b97faab040af02f5554d65264bf50172a50e309e3176d4a4945dea861f1da1d`):chart 静态包交互序列(数据追加+缩放/选中/tooltip/图例)与 sim 包 3 帧固定时钟提交均通过,GPU scopes/callbacks clean,恢复检查点提交——即 epoch 事务、测量文字、新拾取在真实窗口链路全部生效。
- P1-14 pointer 宿主复核(2026-09-16):release `deep-engine-native.exe --smoke-chart chart-ir-v1.json` 在 RTX 4060 Laptop GPU/Vulkan 完成 initial/zoom/reset/tooltip/clear 五段序列，GPU scopes/callbacks clean；本次 smoke 输出确认 axis tooltip 宿主接线进入真实窗口提交链路。
- 工作区门禁:repository gate 通过;800 行源文件门禁 4317 文件通过。
