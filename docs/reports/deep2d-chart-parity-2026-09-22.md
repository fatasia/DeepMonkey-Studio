# Deep2D 图表双轴接入（2026-09-22）

`combo` 图表现在复用已有 ChartIR 和 Native 多轴渲染器。`lowerDashboardChart` 生成 `axis.y.secondary`：未指定时最后一个系列进入次 Y 轴，作者提供 `secondaryAxisSeries` 时按系列名称映射；显式名称完全无法匹配会失败关闭，避免静默改变图表语义。

验证：图表 lowering 与 `renderChartFrame` 消费回归 16/16；与发布兼容性相关回归合计 32/32；Web 类型检查通过。

范围边界：本切片只补双轴语义和生产 ChartIR 接线，饼图、曲线平滑、复杂 tooltip/动画和正式窗口视觉对拍仍留 Deep2D 最终验收。
