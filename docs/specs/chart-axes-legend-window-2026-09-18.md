# P0-01 切片：Native 图表轴与图例色样进窗口（2026-09-18）

P0-06 验收缺陷 3 的修复（[验收报告](dashboard-http-multicomponent-2026-09-18.md)），也是 Native 图表完整度的直接提升。

## 新增能力（全部在 `present_chart` presenter 层）

- **轴**：X/Y 轴线（plot 边界 1px line-strong）、外向 4px 刻度线（与标签框重叠时按"标签优先"省略）、轴标签 quad。新文件 `chart/axis_ticks.rs`（纯推导，含 fmt_tick 单测）+ `chart/axis_render.rs`（绘制）。
- **刻度语义同源**：`axis_presentation`（render_cartesian.rs）复用 `shared_axis_values/resolve_domain/zoom_domain/numeric_mapper`，与 `map_cartesian` 同输入——linear/log/time 走 nice ticks，category 逐行取 ChartIR 原始单元格文本；zoom 窗口后刻度域同步变化，域外行不出标签。
- **图例色样**：`legend_render.rs` 每系列项前 10px 系列色 chip（与几何同色源，hidden 时 25% 透明度），文本 quad 右移让位。
- **文字通道**：复用 legend/tooltip 的 `TextRasterizer`→`into_display_list`（image quad + atlas）；光栅化前以 P1-19 `.notdef` 探针整体拦截，缺字形 fail-closed 返回结构化错误，不画方框。
- `render_chart` path-only 几何零改动——TS golden `chart-web-geometry-reference-v1.json` 与 Web `dashboardChartFrame.ts` 逐值对拍锁死 plot，golden 无需更新两侧自动一致。
- pie/gauge/heatmap：ChartIR 合同无轴标签字段，明示跳过不硬造。

## 测试与证据

- `tests/chart_axes_present.rs` 4 项（标签 id 由文本重算精确对拍、轴线位置、legend 可见性语义、zoom 后类目确定性）+ golden 夹具 `chart-axes-legend-golden-v1.json`。
- GPU 读回 `src/chart_axes_gpu_tests.rs`：X 标签带 492 / Y 刻度带 390 文字像素、色样与轴线像素断言、生产包 13 个标签 quad 逐个 in-window 验证。
- lib 323 / bin 126 通过；clippy `-D warnings --all-targets --all-features`、fmt 通过。
- 生产包复核（1200×800 letterbox）：华东/华北/华南标签、0–90 Y 刻度、标题全部可见；2 轮视觉闭环（第 1 轮发现 X 标签压柱对比不足，第 2 轮加半透明遮罩 chip + 主文本色后达标）。证据 `test-output/chart-axes-legend-20260918/`。

## 边界（如实声明）

- 该生产包 IR `legend.visible=false`，按语义纪律图例不出现在该包窗口（正确行为）；图例能力由本地夹具 GPU 测试证明。
- time 轴标签暂为毫秒数值形式（日历格式化未实现，后续切片）。
