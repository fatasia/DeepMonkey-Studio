# 发布客户端缩窗裁切

Three WebView 实窗品牌验收暴露模型偏右、标签裁切。本片按 design-taste-digitaltwin 的双轮截图流程复现并检查，不改场景机位、材质或令牌。

## 根因与修复

Three 渲染调用 `setSize(width, height, false)`，不写 canvas CSS 尺寸；已初始化且启用阴影的 WebGPU 又保留绘图缓冲以避开既有交换链缺陷。只读页面缺 canvas 尺寸约束，导致显示尺寸取缓冲固有尺寸。

实际反例：从 1920×900 缩至 980×900 后，canvas 仍为 1920×900，超过可见容器。DPR 会进一步放大此差异。

修复仅在 `.scene-viewer-viewport > canvas` 设置 `display:block;width:100%;height:100%`。绘图缓冲、阴影、作者机位与分辨率策略保持不变。

## 验证

- 反例：`test-output/scene-viewer-resize-before-20260918/evidence.json`。
- 修复源码样式注入旧构建：两轮 × DPR 1/1.25/2 × 1920→980→480→1280 连续缩放，24 格 canvas/容器尺寸相等、无 pageerror。截图 `test-output/scene-viewer-resize-after-20260918/`。
- 已人工查看两轮 980px 高 DPI 截图，场景主体和标签不再因 canvas 溢出而裁切。
- 新发布产物类型检查/生产构建通过，同一 24 格矩阵在实际构建上通过（未注入样式），证据 `test-output/scene-viewer-resize-production-20260918/`。
- Tauri release EXE 重建通过；Windows DPI 120 的真实客户端分别缩放至 980×700、1200×800，两轮截图已人工复核主体、标签和工具栏完整，见 `test-output/scene-viewer-resize-native-20260918/round-1.png` 与 `round-2.png`。

同族检查：二维场景预览与参数化预览已有 canvas 100% 规则；编辑器 `.viewport canvas` 只有 display 规则，需结合实际宿主布局独立复现，未据此盲改共享样式。

## 视觉验收范围

对标 FVS 的等比显示纪律和 Unity 的发布一致性。截图验证本片布局/响应尺寸；十维完整评分暂不出具，尚缺双主题交互矩阵与同族编辑器检查，不能以此宣称完整 Kimi-95 或全场景视觉验收完成。
