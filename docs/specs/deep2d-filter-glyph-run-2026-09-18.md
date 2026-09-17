# P0-01 收官切片：筛选选项文字经字形运行进 Native 呈现（2026-09-18）

P0-01 的最后一块：filter 组件选项文字从"等待字形图集通道(P1-18)"deferred 状态转为真实编译与 GPU 呈现。

## 度量来源（与渲染同引擎）

新增 Native 子命令 `--measure-glyph-run`（`platform_text/raster/measure.rs` + `measure_atlas.rs`，wire 于 `raster_wire.rs`，CLI 接线 `text_raster_cli.rs`）：复用 `FrozenTextRasterizer`（cosmic-text 整形 + swash 光栅 + sha256 冻结校验）打包确定性 r8unorm 图集并导出 `BakedGlyphPlacement` 同构 placements。选择理由：与 Native 渲染同一引擎（读回像素即真实文字效果）、仓库无 node 侧字体解析依赖、零新 npm 包。两次重建 coverage SHA 逐字节一致（确定性实证）。

## 编译链

- `compileDashboardContent.ts` 增第三参 `optionGlyphs`（按 nodeId 注入 `FilterGlyphBundle`，字体资源先登记再传入 `lowerDashboardWidget`）。
- 新桥 `dashboardFilterGlyphs.ts`：wire → `FilterOptionGlyphMetrics` 结构校验，deny-unknown fail-closed。
- 未注入度量的筛选保持既有 deferred；零字形行（纯空白）退回 deferred；`widget.options.text` 仅在实测可用时进 compiledFields——能力口径不变。

## 端到端证据（test-output/filter-glyph-run-20260918/）

真实冻结 NotoSansCJKsc（SIL OFL，SHA 登记）→ Native 度量（华东/华南/华北/西南）→ TS 编译显示列表（validateDeep2dDisplayList 通过）→ GPU 读回消融对照（同列表去 text 命令）在 RTX 4060 实测四行各 51/58/51/69 像素差。溯源链 evidence-summary.json 全程可查。

关键修复：swash `placement.top` 是基线向上为正的排版约定，首版少取负导致字形落行框外——经布局探针实证后修正为 `-top`，单测加行框约束防回归。

## 门禁与边界

native lib 328 + bins 126 绿、clippy `-D warnings --all-targets --all-features` 绿、fmt 干净；web delivery 聚焦 593 绿（含新增 22+1 用例）；deep-engine 显示列表 24 绿；两包 typecheck 干净。

遗留：多筛选节点共享 atlasId 需显式去重（bridge 文档已声明）；`setFilter` 交互消费与图集上传归 G01 宿主；Web 浏览器像素证据归 P0-08 矩阵。deep-engine 包级 source-size gate 仍被并行会话既有超大文件阻断（与本片无关）。

**P0-01 状态：全组件内容 lowering（容器/形状/文字/图片/KPI/表格/图表/筛选/背景/轴/图例）已全部有真实编译与 Native 呈现证据；剩余 deferred 项均为显式登记的运行时行为与动画类。**
