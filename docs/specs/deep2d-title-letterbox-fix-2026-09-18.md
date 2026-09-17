# Deep2D 缺陷修复：裁剪层在 letterbox 窗口整条消失（2026-09-18）

P0-06 验收缺陷 1 的根因修复（[验收报告](dashboard-http-multicomponent-2026-09-18.md)）。

## 根因

`packages/deep-engine-native/src/deep2d_scissor.rs` 的 `chunk_scissor` 用**逐轴拉伸 scale（physical/logical 逐轴相除）且不加居中偏移**，而顶点着色器 `native_deep2d_v1.wgsl::logical_to_ndc` 用**等比 letterbox（min 轴比例 + 居中偏移）**。真实窗口 1200×800 物理 vs 960×540 逻辑（宽高比 1.5 vs 1.78）下，shader ratio=1.25、offset=(0, 62.5)，scissor 却按 (1.25, 1.481)、零偏移计算：标题层 chunk 的 clip 是精确页面矩形 (287,121,90,26)，其 scissor 落在 y179..215，而 quad 实际绘制在 y214..246——交集不足 2px，标题整条被裁掉。

凡被 `node.clip` 收窄的 chunk 全部同根因（标题+单位两个 image quad）；clip 为整页的层（横幅、面板、柱形）不受影响——与全部症状吻合。同族排查：命中测试与相机缩放均已使用 `LetterboxMapping`，`chunk_scissor` 是全仓唯一手写逐轴 scale 处。

## 修复（2cb395d）

1. `chunk_scissor` 改用同一 `deep2d::LetterboxMapping`（与 shader/命中/相机四者同源），附 letterbox 错位单元测试钉子。
2. `dashboard_composition_gpu_tests.rs`：新增 `draw_in_format_at`（任意物理尺寸读回）+ 2 个 GPU 读回测试；顺带修复读回 harness 的 bytes_per_row 256 对齐缺口（1200 宽曾静默返回全零 buffer）。

## 测试与证据

- 合成级 `clipped_layer_survives_letterbox_window`：修复前 0/3220 红 → 修复后 3220/3220 绿。
- 真实包 `producer_package_clipped_layers_survive_letterbox_window`（`DEEP_DASHBOARD_PACKAGE_PATH` 指向多组件验收生产包）：修复前 0 → 修复后标题 3876px、单位 1326px。
- bin 全量 126 通过；GPU 全量 45 通过；clippy `-D warnings --all-targets --all-features`、fmt 通过；修复前后整帧像素 diff 仅 2537px 且全部落在两个标题 quad 区域，其余零变化。
- 真实窗口截图：`test-output/dashboard-title-fix-20260918/standalone-exe-window-fixed.png`——「分区域出力」「MW」真实窗口可见（本会话主线独立复核）。

## 未修复的兄弟问题

- 轴标签/图例：编译层缺口——`present_chart` 不生成 axes/legend quad，非裁剪根因，归 P0-01 剩余项。
- KPI/表格测量：缺陷 2 已分层修复（2e1d15a），value/table 尺寸合同决策仍开放。
