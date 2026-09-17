# P0-08 像素矩阵：Native 读回第一格（2026-09-17）

对应交接阶段 2 P0-08 的第一档："选定标题图表冻结 fixture，Native 纹理读回先行，四类证据（正常窗口/smoke/读回/系统截图）分开记录"。

## 本片交付：Native GPU 读回格

- 命令：`DEEP_DASHBOARD_CAPTURE_DIR=... cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native producer_package_renders_real_pixels -- --ignored --nocapture`
- 环境：Windows 10.0.22621、RTX 4060（真实 GPU，`device_type != Cpu` 由测试内断言）、wgpu 默认后端、Rgba8UnormSrgb 目标、960×540。
- fixture：`packages/deep-engine/fixtures/dashboard-composition-v1.json`（与 P0-07 身份 golden 同源，双页组合包：双 chart + 双 sim + 双 static deep2d + dashboard root + IBL）。
- 证据：`test-output/dashboard-pixel-matrix-20260917/native/`——`producer-page-{0,1}.rgba`（原始读回字节）、`dimensions.json`、`producer-page-{0,1}.png`（sharp 按原始字节转换，无缩放无滤镜）。
- 结果：page 0 = 132,913 彩色像素、page 1 = 22,000 彩色像素，GPU 校验错误作用域为空；PNG 人工复核：双仪表盘图表、图例卡（RGB 色块与青色图）、双色柱条均按作者数据渲染，无空白/花屏/错位。

## 明确未完成（不标成完成）

- **跨端对比格未做**：浏览器 WebGPU 画布同 fixture 截图需要先组装 `createDashboardCompositionGpuHost` 的完整依赖（BackendCanvasDeck/DeviceSession/候选状态机/资源 loader），属于 C1 Web 宿主范围；在宿主可跑之前不存在诚实的"浏览器同包像素"，本片不用 author 组件截图冒充。
- 输入矩阵（真实 OS 输入、DPI、980 窄窗、双主题）未做，归后续格。
- 阈值与差异原因记录在跨端格成立时才有意义，本片不预置数字。

## 下一步

1. C1 Web 宿主最小可跑（复用 `renderDeep2dGpuFrame`/`buildDeep2dGpuFrame` 与候选合同），浏览器对同一 fixture 出 960×540 截图。
2. 跨端像素对比（复用 `apps/web/scripts/renderImageSimilarity.mjs`）+ 差异原因分级记录。
