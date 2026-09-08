# 看板实际 PDF 验证 · 2026-09-08

## 范围

本批只补看板打印纸面门禁，不等于全部打印场景完成。采用既有隔离 API / 数据目录和真实 Chrome，将应用保存并刷新后进入运行态，调用浏览器实际 PDF 导出；用 pdfplumber 解码纸张尺寸、页数和文字位置，用 PDFium 渲染生成的 PDF，人工检查纸面图片。不是用 `emulateMedia` 截图代替 PDF。

门禁：`apps/web/scripts/gate-dashboard-print-pdf.mjs`。环境需要 Python 的 `pdfplumber` / `pypdfium2`，自动查找本机 Codex 依赖目录；其他机器可用 `BIM_STUDIO_PDF_PYTHON` 指定解释器。无项目依赖或正常存储拓扑改动。

验证矩阵：两轮 × dark 1440 / light 980 × 样本 / 无样本静态页，共 8 份 PDF；深色横向 1920×1080，浅色纵向 1080×1920，均为单张 A4 等比缩放。主题以运行时 `html[data-theme]` 断言，不只采用测试配置名称；画布保留已保存的深色外观，不强行改为白底。

## 已核实问题与修补

1. r39 第一张实际 PDF 的纸边被染黑，页码白字；表格 CSV / Excel 按钮也进入纸面。证据 `test-output/codex-2026-09-05/dashboard-print-pdf-zyLbJ5/r1-dark-sample-page-1.png`。该次因门禁静态标题类型误写为 text（实际为 decoration）停止，不能记通过。
2. r41 的打印操作隐藏已生效，但纸边仍黑。证据 `test-output/codex-2026-09-05/dashboard-print-pdf-yNHkab/r1-dark-sample-page-1.png`。根因为 `documentBranding.ts` 给根元素写入内联 `colorScheme=dark`，普通打印 CSS 的 `color-scheme:light` 无法覆盖，导致 `Canvas` 仍解析成暗色。
3. 最终修补限定 `DashboardPrint.css`：打印时根元素 / body 的 `color-scheme:light !important`、`Canvas` 纸色 / `CanvasText`；隐藏表格导出、分页按钮及排序图标，保留标题及当前表格内容。不改屏幕样式和保存数据。
4. 独立 Chrome 页面注入诊断已验证：保留内联 dark 时，最终打印 CSS 得到 `scheme=light`、`background=rgb(255,255,255)`。该诊断不计正式打包 PDF 通过。

聚焦 `dashboardPrintLayout.test.ts` 8 项通过；包含横纵及极端比例、非法旧尺寸、仅可见样本声明、内联品牌色方案覆盖保护。新门禁语法检查通过。

## 正式复验

r42 Web index SHA256：`9d254b30129d1f61b60826781a728c0c791b490ffb1e7822c19eefba10960789`。

首遍 `test-output/codex-2026-09-05/dashboard-print-pdf-2w3vBR/report.json`：4 组 / 8 份 PDF 全部通过，exit 0；两轮全部 8 张 PDFium 纸面图已亲审。各页四个纸角像素均 `[255,255,255]`，纸张尺寸为 841.91998 × 594.95996 pt 或反向；PDF 页数均 1，均有 `1 / 1`，无编辑壳 / CSV / Excel。样本 4 页保留 2600 KPI、图表和样本声明；静态 4 页没有样本声明。纸面页眉、主体和页脚无重叠。浏览器错误 / 警告均 0，返回屏幕后比例与返回编辑控件正常。

最终增加实际主题断言后，`test-output/codex-2026-09-05/dashboard-print-pdf-XaqbHH/report.json` 再次 4 组 / 8 份 PDF 全部通过，exit 0；主题断言全部通过，8 份纸角均纯白，错误 / 警告 0。最终两轮 dark / light 样本 PDF 渲染再次亲审，与首遍无新增视觉回归。目录内 `*-decoded.json` 保存 PDF 解码原始文字位置与像素信息，`*.pdf` 为真实导出文件，`*-page-1.png` 为 PDFium 渲染，不是 DOM 截图。

纸面局部自评（10 分制，不是全产品达标证明）：信息层级 9、对齐 9、字体可读性 7、主题 / 纸色 9、组件一致性 9、状态与恢复 9、数据诚实性 9、画布比例 9、性能 8、整体留白 7。纵向模板仍有过多内容空区，图表刻度和明细字随整幅 1920 画布缩放仍偏小；不以自动断言通过冒称达到 Kimi-95 或“排版极致”。本次只消除纸边 / 交互控件进入纸面的回归。

## r44 字号调整后的回归（不能沿用 r42 的视觉结论）

r44 index SHA256 `6ea958aad46791d5cde738a3c3cec03b2651c87696fb91d0e3a27436afe8b874`。`dashboard-print-pdf-jBkzk7` 原自动纸张 / 页数 / 声明检查 8/8，纸边纯白、操作隐藏、单页与页眉页脚仍正常，字体整体更可读；但两轮 PDFium 纵向样本图显示饼图百分比被截为“4...”与“23.0...”，**该轮不记视觉通过**。

门禁增加 Canvas 最新帧实际 `fillText` 记录，禁止数字省略号，并保留真实百分比必须绘制的断言；旧 r44 反证 `dashboard-print-pdf-l0kFku` 准确失败，根因是新 24px 字号的图外标签在 1080 纵向模板窄次图中余量不足。局部修补保留全部分类 / 图例和原值，窄图收缩环半径，百分比显示一位小数。正式复验采用下述 r46 冻结构建，不混用 r45。

## r46 最终实际 PDF 复验

Web index SHA256：`8c371ea6a9012901332294e1dfce8b5f233c03a02c02f0e416545def38df7a0a`。证据：`test-output/codex-2026-09-05/dashboard-print-pdf-F6Rd6T/report.json`。

两轮 × 双主题 × 样本 / 静态共 8/8 PDF 通过，浏览器错误 / 警告 0。8 份均单张 A4、四角纯白、有 `1 / 1`，页眉 / 主体 / 页脚无重叠；样本声明仅在 4 张样本页出现，无 CSV / Excel 或编辑壳进入纸面。样本原始数值 1080 / 920 / 600 及 A / B / C 图例保留；Canvas 实际百分比文字为 `41.5% / 35.4% / 23.1%`，无数字省略号。

已亲审最终两轮 dark 横向、light 纵向的 4 张样本 PDFium 渲染，及第二轮双主题静态渲染：百分比完整，纸边和页码正常，静态页无样本声明。因此 r44 的真实标签截断已修复，不再沿用仅页数 / 文字断言的通过口径。

本批字体可读性局部评分由 r42 的 7 提至 9；纵向明细区留白仍为 7，来自当前设计画布高度，不自动裁切客户作品。其他 r42 局部评分与下列验证边界维持，不宣称全产品或全部打印任务达到 Kimi-95。

## 验证边界（继续有效）

- 无样本页是明确的静态标题页，不把去掉样本标识的虚构数据冒称真实数据源。
- 表格是当前画布的打印快照；多页长报表、跨浏览器 / 实体打印机、远程字体离线、外部数据源和匿名发布打印未在本门禁覆盖。
- 对标采用既有 FVS 1920 画布等比布局、克制报表页眉与渐进披露原则；没有新增竞品现场实验，不声称超越 FVS。
