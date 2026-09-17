# Deep2D P2-02：ChartIR 冻结 ZRender 6.1.0 动态 bar rect 子集认证

日期：2026-09-18。状态：受限认证 lane（`apps/web/src/experiments/zrenderChartIrBarRectCertification.ts`）；不进入 N0，不是兼容层。

## 子集界定（frozen profile `chartir-bar-rect-v1`）

输入是**已编译 ChartIR**（封闭 schema，函数/图片/未知字段在编译层拒绝），不是 ECharts option。认证面：

- 恰好一个 bar 系列、类目 x 轴、线性 y 轴；`legend.visible=false`（图例文本/图标是非 rect 元素）。
- 期望 rect 集合由仓库自有 Native 同构几何推导（`chartPlot`/`cartesian`/`zoomDomain`，即 chart-web-geometry golden 同一参照）：`rect = {x: 中心-0.4·band, y: baseline, w: 0.8·band, h: y顶-baseline}`，fill/zOrder 用 lane 冻结常量（`#5070dd`，z=2/z2=1 → 2000001；ChartIR v1 无系列颜色字段）。
- 动态通道：同一 ECharts 6.1.0 SSR 实例上的同形状数据替换（类目数跨帧不变）、类目对齐 x 窗口、数值 y 窗口（zoomDomain 插值域直接写入 yAxis）。
- 零值 bar 保留为零高度 rect（ZRender 子集合同；与静态路径剔除零高度的规则不同，两侧各自锁定，不互相冒充）。

## 窗口语义的关键实测发现

- ECharts 类目 dataZoom 组件按 `(count-1)` 取整且端点包含（实测 percent 25–75 与 20–80 同结果；`startValue/endValue` 又是第三种语义），与 Native 连续行带公式不一致。
- 因此 lane 的窗口语义由**期望映射侧承担**（Native 公式），投影为确定性布局基元（窗口后类目子集 + 显式 barWidth + 显式值域）喂给 ECharts；组件语义整体 blocked。
- 连续行带偏移（非对齐窗口 first=start·count 非整数）无法投影为等分基元 → 非对齐窗口整体拒绝（实测对拍失败复现后改为 fail-closed 守卫）。
- ECharts bar 默认把超出 grid 的值裁剪在绘图区内，Native 公式连续映射（静态路径靠 clipPath）→ 值越出显式域的帧整体拒绝。

## 对拍结果（容差 = golden 同口径 `1e-9·max(1,|expected|)`）

4 帧序列（initial / data-replace / x-window-aligned 20–80 / y-window-interpolated 25–75）全部逐值 matched；每帧期望与实际 rect 的 x/y/w/h/fill/zOrder 逐值一致。跨实例双跑（3 实例 × 3 帧）outputHash 流完全一致。证据：`test-output/p02-zrender-20260918/certification-evidence.json`（含每帧期望/实际 rect 全量、inputHash/outputHash、computeMs、blocked 登记）。

## blocked 清单（全部有测试证据，不静默）

| 能力 | 证据 |
|---|---|
| formatter | ChartSpec v1 JSON 层拒绝函数（invalid-json/unknown-field 诊断）；lane 输入只收 ChartIR |
| image | ChartSpec v1 无 image 字段（unknown-field 拒绝）；lane 无资源通道 |
| tooltip | tooltip 仅纯数据 `{enabled,trigger}`；测试证明 enabled=true 的 rect 集合与 hash 逐值不变；交互/DOM 不在认证面 |
| animation | option 固定 `animation:false`；重复帧提取逐值一致；调度器/中间帧未捕获 |
| non-rect 系列 | line/scatter（笛卡尔字段合法）被子集层 blocked-capability 拒绝；pie/heatmap/gauge 被封闭 schema invalid-input 拒绝；均不产出部分 rect |
| legend-and-text | legend.visible=true → blocked-capability |
| category-resize | 跨帧类目签名变化 → blocked-capability，保留上一 epoch/hash |
| echarts-datazoom-window-semantics | 组件语义实测不一致（见上）；对齐窗口走 lane 重投影 |
| clipped-out-of-domain-bars | 值越出显式域 → blocked-capability |

失败帧不推进 epoch、不替换 outputHash（沿既有 P2-02 纪律）；预算 bars≤256、输入≤64KiB、computeMs≤250。

## 版本锁定与诚实边界

- 认证绑定 ECharts/ZRender `6.1.0`（仓库实际解析版本，与任务定义一致）；lane 构造器核对 `echarts.version`，升级即失效，须按本测试全量重认证。
- 认证产物是「对冻结子集的确定性描述 + 逐值对拍」，不是通用 ZRender/ECharts 桥；不运行任意 JS，未认证完整 Painter/ECharts 生态。
- 未覆盖（如实声明）：非 SVG 渲染器、canvas 像素证据、多 bar 系列并列带宽分配、time/log 轴、真实浏览器 rAF 通道——均不在本切片认证面。
