# Dashboard 内容 lowering(P0-01)——第一批:容器铬层与几何内容

日期:2026-09-16 凌晨。本切片是 [作者形状内容](deep2d-dashboard-content-2026-09-15.md) 的扩展:从「仅限定形状」推进到「每个组件都编译容器铬层 + 按类型登记内容边界」。

## 已编译(本批)

- **容器背景(全部 data-widget)**:整框矩形填充,颜色/透明度语义与 Web 运行时 `widgetBackground` 逐值一致(默认 `#172126`,默认透明度 `0.86`,hex alpha 与 opacity 相乘)。CSS 变量/渐变显式拒绝并登记原因,不猜颜色。
- **形状内容(shape)**:既有内容框几何(矩形/圆角/椭圆)保留;`borderWidth>0` 且 `borderColor` 可解析时,在同一内容框路径上以内描边编译(CSS 内描语义);缺色/不可解析只跳过描边像素并登记,不阻断整个对象。
- **场景视口(scene-viewport)**:节点保持 blocked(三维通道),但原因与字段登记完整。

## 显式未编译(逐对象登记,不静默)

- 文字/数值类(text/value/digital-flip/liquid-fill/progress/status/gauge):等 TextDocument/字体编译通道(P1-18/P1-08)。
- 图表类(line/area/bar/combo/pie/scatter/radar/funnel/sankey/sunburst/treemap/graph/map/wordcloud/boxplot):等 ChartIR 动态通道与 Dashboard 组合接线(P0-06 语义)。
- 装饰(decoration)CSS 效果、媒体/Unity/拓扑类型、数据绑定与 sampleData 冻结快照、阴影、动画与运行时行为。
- 以上全部进入对象级 `reasons` 与字段级 `deferredFields`;没有布尔 approved 概括。

## 报告与合同

- 对象报告新增 `contentCompiled`(内容像素 vs 仅铬层);`capabilityReport` 新增 `contentCompiled`/`chromeOnly` 计数。status 语义:`degraded`=产出了受支持像素(至少铬层),`blocked`=零受支持像素。
- 编译 pass 升版:`dashboard-widget-content` v2(pass 参数含铬层默认值),三种 hash(source/compile/target)语义不变。
- `publicationReady` 仍为 false:文字、图表组合与行为未关闭前不得放行。

## 验证(2026-09-16 02:00)

- `compileDashboardContent.test.ts` 12 项通过:golden 逐字段再生对照(新包哈希 `603511a131c2178d317684e7b5989e4f31427797c1a7253d441d5851507692cf`)、铬层默认色/透明度逐通道断言、内描边命令、hidden 零像素、无部分绘制的 blocked 边界、场景视口 blocked、内容框塌缩。
- Web tsc 通过;Native `dashboard_content_golden` 断言同步为 6 命令(contentCompiled=3)。
- 篡改回归:路径顶点改动必须使包校验失败(测试保留)。

## 剩余(本任务未关闭部分)

容器边框的全组件语义、阴影、页面级外观、文字/图表内容编译、`publicationReady` 放行条件,按任务表 P0-01/P0-03~P0-08 与 P1-18 继续推进。
