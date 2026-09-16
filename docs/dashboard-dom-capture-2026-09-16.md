# 已渲染 Dashboard 数据布局捕获

`captureRenderedDashboardData(root, { logicalSize, resolveFonts })` 从已挂载的生产 KPI / 报表组件读取冻结布局，供可信编译宿主调用。字体必须由调用方绑定到冻结资源；等待 `document.fonts.ready` 后捕获。

- 生产组件只新增语义 data 属性，样式不变；KPI 数字与单位、列名与排序图标分别用真实 DOM Range 测量。
- 保留实际分页、排序、滚动和 sticky 绘制顺序；不推算列宽。缺失字体、重复角色、混合文本、未支持的效果明确失败。
- 单文本分页按钮支持统一圆角、实线边框及整组 opacity。先将原生文字像素与按钮背景合成，再应用一次透明度；形状边缘使用 8×8 面积采样。
- 组合证据绑定冻结 recipe、原生文字源像素、最终 atlas 像素；可信编译器重放后才接受字体证据。没有组合时仍要求原始像素逐字节哈希一致。

验证入口：`node apps/web/scripts/test-dashboard-dom-capture.mjs`。该测试挂载真实生产组件，覆盖 KPI、表格排序、首页/末页禁用按钮，并输出 1280 / 980 宽截图及布局 JSON。单元回归覆盖透明度、圆角、变造 recipe / 源像素 / 输出像素和编译后重放。

边界：CSV / Excel 导出工具栏外观及下载动作未纳入当前冻结表格合同；对象能力报告明确列为 deferred。筛选、排序、分页和行点击的运行时行为仍沿用现有 deferred 状态。复杂 CSS 组、任意多子元素组不在此切片内。上述浏览器截图证明真实组件捕获，不等同整个 Dashboard 的最终视觉验收或原生 GPU 画质对比。
