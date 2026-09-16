# Dashboard 冻结字体编译

本切片为 Dashboard 发布编译提供 CPU 文字光栅化：输入明确字体文件和样式，输出真实 RGBA、完整布局和实际字体身份。它是 C2 文字/图片内容编译的基础，不改变发布批准状态。

## 输入与输出

新增 `TextRasterizer::from_frozen_fonts` 与 `FrozenTextRasterizer::rasterize_styled`，旧系统字体 API 和缓存保持原行为。冻结数据库只加载调用方提供的字体字节，校验 SHA-256 和字体面索引，不扫描系统字体。字重、样式不匹配、未提供的字体回退、缺字、可变轴与超预算输入明确拒绝。

请求包含水平/垂直对齐、换行、字号、行高、颜色和视口；使用真实整形布局。先检查全文，再裁剪输出，视口外缺字同样拒绝。`usedFaces` 记录实际字体 SHA-256、faceIndex 和样式；同一 TTC 的不同字体面分别记账。`inkBounds` 为左、上、右开区间、下开区间。

```text
deep-engine-native --rasterize-text request.json --output new-result.json
```

CLI 接受 `deep-engine.text-raster-request` v1，返回 `deep-engine.text-raster-result` v1。输出文件必须不存在；失败不覆盖旧结果。Node adapter 使用私有请求目录、固定 executable 副本、关闭 shell、超时和取消，进程退出后才读取结果并清理临时文件。请求、像素、字体与可执行程序的 SHA-256 绑定编译证据。

字体许可与发布资源授权由资源冻结层确认。本工具不自动批准许可，不把本机安装字体写入仓库或发布包。

## 验证

- 新增 Native 字体与布局 14 项通过：中文、组合字符、RTL、TTC 字体面、实际像素、对齐、全文缺字、裁剪、身份和预算；包含字体别名精确选择、半像素刚性平移、栅格前全文校验三项复核回归。`frozen` 筛选另含一项既有测试，共 15 项通过。
- CLI 两项失败路径通过；Node adapter 23 项真实子进程测试通过，覆盖超时、取消、坏输出、篡改、诊断与文件限额。
- Node → Native CLI → 校验结果完整成功，使用本机雅黑字节显式冻结：27 glyph、两行，实际像素与字体 hash 已记录于本地 `test-output/c2-real-text-evidence.json`，输出 PNG 已目检。该样本验证编译链，不是字体再分发许可。

中间完整 Native 回归 1000 通过/63 忽略，最终修复后定向 15 项、严格 Clippy、独立 HEAD 加 24 文件的 all-targets 检查通过，仓库与体量门禁通过。新增可选 producer 包 GPU capture 测试已在真实设备通过，中文与组合字符读回 PNG 已目检；不替代浏览器视觉验收。

垂直对齐保留逻辑小数位置，像素平移只量化一次，避免跨零坐标撕裂。作者组件接线、图片 producer、数据值、表格和筛选仍按 [C2～C5](codex-dashboard-delivery-slices-2026-09-16.md) 推进。
