# Deep Engine P3 → GLM 完整交接

日期：2026-09-14。用户最终决定：**P3 全部交给 GLM；P0、P1、P2、P4 由 Codex 主线推进。** 本文替代误建的 P2 交接，任务清单只列剩余工作。

P3 的交付是 Windows 原生 Deep2D、GUI 与图表：在同一个 wgpu device/queue 和帧调度中，与 3D 视口共同运行，支持中文输入、可操作控件、停靠布局、虚拟列表和增量图表。

## 1. 可直接发给 GLM 的指令

> 接手本文件全部 P3，以“多路并行、全力推进”为主旨。先读项目 AGENTS.md、恢复总账、本交接与原生 GUI 架构，再审查 git status/log/diff。保留现有改动，复用已有 Deep2D painter、atlas/cache、retained UI 和 ChartIR。先完成 Deep2D 的正确性、文字、命中、DPI 与缓存，再并行实现原生 GUI 和图表，并在 Native Player 同一 device/queue 上合流。每个切片交付代码、边界/失败测试、实机证据和明确剩余项。前 48 小时检查点不代表全部 P3 完成。P0 切换/作者状态、P2 高级渲染由 Codex 负责；公共合同和 renderer/app 集成文件先约定所有权。遵守仓库对 GLM 的新增依赖、公共合同重大变更事前批准规则，不 push。

## 2. 权威资料与当前基线

工作目录：`<repository-root>`。编写本交接时 HEAD 为 `cd9850b`，工作树有大量未提交改动；仅拉取该提交不能获得当前基线。接手前记录实际 HEAD、相关文件 diff/hash、依赖版本和测试结果。

按以下顺序读取：

1. `AGENTS.md`、`docs/active-task-recovery-ledger.md`。
2. `docs/specs/deep-engine-webgpu-remaining-plan-2026-09-14.md`：P3 范围和总体优先级。
3. `docs/specs/deep-engine-native-gui-migration-2026-09-12.md`：原生架构；平台范围以当前 Windows 限定为准。
4. `docs/specs/deep-engine-glm-final-handoff-2026-09-14.md` 和 `deep-engine-consolidated-audit-2026-09-14.md`：历史实现与复核边界。
5. `C:/Users/rain/.agents/skills/design-taste-digitaltwin/SKILL.md`：视觉验收流程。

以下仅为复用入口，不计入剩余任务的完成数量：

| 领域 | 当前可复用代码 | 接手时须确认的缺口 |
|---|---|---|
| 2D 合同 | `packages/deep-engine/src/deep2dDisplayList.ts`；Native `src/deep2d/types.rs`、`command_types.rs`、`validate*` | 合同接受与 painter 可执行能力是否一致；TS/Rust 错误码、预算、未知字段处理 |
| 路径 | Native `src/deep2d/painter_path*`、`painter_polygon*`、`painter_stroke.rs`、`painter_dash.rs`、`painter_clip.rs` | 曲线、多子路径/孔洞、路径 clip 已有实现；闭合 stroke、round cap/join、dash 与嵌套 clip 的完整组合仍须复核 |
| 图像/文字 | Native `painter_atlas.rs`、`runtime_quad.rs`、`runtime_prepare.rs`、`deep2d_atlas_gpu.rs` | 已有 atlas/image/glyph 路径；预制 glyph 不等于动态文字 shaping、字体 fallback 或中文输入 |
| GPU 缓存 | Native `deep2d_gpu.rs`、`deep2d_gpu_cache.rs`、`deep2d_gpu_cache_tests.rs` | pipeline/atlas/vertex 已缓存；frame buffer/bind group 仍在 painter 构造中创建，须核对复用、预算和 epoch 隔离 |
| Retained UI | `packages/deep-engine/src/retainedUi/{types,validation,layout,incremental}.ts`、`retainedUi.test.ts` | 现有布局为 absolute/stack/flex-row/flex-column，命中为矩形；尚非原生控件/事件/文本编辑运行时 |
| 图表 | `packages/deep-engine/src/chartIr.ts`、`echartsOptionCompat.ts` 及测试 | 有六类图表合同与有限 option/action 编译；尚需原生 layout、绘制与交互；当前单 dataset 上限 500,000 行 |
| 同帧合成 | Native `deep2d_gpu.rs`、`renderer/frame.rs`、`deep2d_interleave_probe.rs` | 已有 3D 后置 2D pass；须扩为可交互、多面板、高 DPI、稳定资源生命周期的产品路径 |

README 的 Deep2D 支持清单存在早于当前实现的描述。以源码、测试和真机为准，随切片修正文档；不要按旧 README 重做 image、dash、holes 和 clip。

## 3. 分工和集成边界

| 工作线 | GLM 文件域 | 交付给下一线 |
|---|---|---|
| D：Deep2D | Native `deep2d/`、`deep2d_*`、相关 WGSL/测试；TS 显示列表合同 | 可执行显示列表、文字布局、命中、缓存、DPI 与错误合同 |
| U：原生 GUI | 建议新增 `native_ui/`、`platform_text/` 等职责模块；复用 retained UI 合同 | 控件、事件、焦点、停靠、虚拟列表、IME、无障碍 |
| C：原生 Chart | 建议新增 `chart/`；TS ChartIR/compat 及跨语言 golden | 六类图表、坐标系、数据增量、交互和语义树 |
| GLM 合流线 | P3 测试/文档、共享合同；与 Codex 协调 Native app/renderer 接点 | 一个可启动、可操作、可复现验收的原生样机 |

`renderer.rs`、`renderer/frame.rs`、`renderer/init.rs`、`app.rs`、`app/window_events.rs`、Runtime Package、`Cargo.toml` 和根导出属于共享文件。编辑前在总账或交接记录中登记具体修改点，避免两个会话同时重写。优先把逻辑放入 P3 自有模块，共享文件只接窄接口。

P1 提供窗口、项目包、基础 HostCapabilities。GLM 实现 P3 所需的 TextIme、Clipboard、Accessibility、Window 输入适配，与 P1 复用同一 authority。P1 未就绪时可通过可注入端口先开发；集成缺口继续记录为待办。

## 4. D 线：Deep2D 完整路径（12–18 人日）

| ID | 本轮待办 | 验收证据 |
|---|---|---|
| D01 | 冻结支持矩阵；核对 TS/Rust validator 与 painter；统一 unsupported/invalid/budget 错误 | 每项合法输入可执行或明确拒绝；坏命令不会发布部分画面；跨语言 golden |
| D02 | 补齐闭合 stroke、round cap/join、miterLimit、dash/offset；复核曲线/孔洞边界 | 零长段、尖角、奇数 dash、极大 offset、负缩放、非均匀缩放和 DPI 组合测试 |
| D03 | 完整 path clip 与嵌套交集，覆盖 path/text/image；稳定 z-order 和 opacity | 像素 readback；空 clip、深层 clip、旋转/镜像及透明叠加；绘制与命中一致 |
| D04 | Text/Image 直接命令可靠执行：资源 revision、UV/source rect、缺失资源策略 | 重载/取消/坏 atlas 不污染旧帧；图像颜色与 alpha 正确；字符簇与 glyph 位置可追踪 |
| D05 | 动态字体 shaping/layout：中文/拉丁混排、fallback、换行、字距、基线、组合字符和 bidi 策略 | 字体与许可可追溯；缺字有诊断；选择/光标按 grapheme/cluster，不能按 UTF-16 单位硬切 |
| D06 | Glyph atlas 增量分配、驱逐和失效；几何、atlas、frame uniform/binding 跨帧复用 | 静止不重建/上传；尺寸变化只更新必要资源；device epoch 隔离；预算/命中/峰值可见 |
| D07 | path/stroke/image/text 的命中索引，支持变换、clip、z-order、pointer-events | 点在边界、孔洞、透明/禁用节点、重叠节点、捕获目标删除的行为测试 |
| D08 | DPI/resize 原子重建；logical/physical 坐标统一；提交完成后释放旧资源 | 100/125/150/200% DPI、跨屏、最小化/恢复；失败保持旧 painter；无错位和泄漏 |
| D09 | Browser/Native 同 fixture 合同和像素对照、2D/3D 同帧集成 | UI 位于 HDR/tone mapping 之后；渲染输入不反向持有业务状态；故障矩阵通过 |

字体与平台库先按项目规则评估准入：固定版本、最小 features、许可证、传递依赖和包体增量。历史方案中的 cosmic-text/AccessKit 是候选，不能视作已批准依赖；完整 GUI 框架不进入核心。

## 5. U 线：原生 GUI（20–32 人日）

| ID | 本轮待办 | 验收证据 |
|---|---|---|
| U01 | Rust retained tree/runtime；复用 stable ID、revision、style/layout/paint/hit/a11y 分离合同 | TS/Rust golden；reparent/delete/stale revision/cycle；只更新受影响子树 |
| U02 | 完善 flex/grid/absolute、滚动、dock/splitter/tab、多面板布局与持久化 | min/max、溢出、隐藏、缩放、拖拽及恢复；非法布局保留上次正确值 |
| U03 | capture/target/bubble 事件、pointer capture、hover/focus、键盘导航与快捷键 | 点击、双击、拖拽、滚轮、Tab/Shift-Tab、Esc；禁用/隐藏不接收动作；无重复执行 |
| U04 | 基础控件：button、toggle/checkbox、select、slider、text/number input、menu、tooltip、dialog、tabs | loading/empty/error/disabled/focus 完整；输入验证、确认/取消、异步反馈逐个实测 |
| U05 | 原生文本编辑与 Windows IME：composition、candidate caret rect、选择、撤销/重做、剪贴板 | 中文输入/候选确认/取消、跨行选择、组合字符、焦点切换、DPI 移动无丢字/重复字 |
| U06 | 10 万条数据虚拟列表/树/属性表；稳定选区、滚动锚点、增量更新 | 活跃节点与视口规模相关；插入/删除/过滤后选区正确；不把全部行创建为控件 |
| U07 | 设计令牌快照导出与原生消费；双主题、语义色、字体/间距/动效统一 | 唯一来源 `apps/web/src/styles/base.css`；原生不读取 CSSOM；品牌覆盖和 reduced motion 可验证 |
| U08 | Windows UI Automation 语义树与动作桥 | 角色、标签、值、焦点、列表虚拟化、键盘操作；辅助技术动作进入同一事件系统 |
| U09 | 原生可操作样机：对象树 + 3D 视口 + 属性面板 + 图表 + 诊断；布局保存恢复 | 打开包、选择对象、编辑允许属性、过滤树、切主题、调布局、恢复；不新建第二份项目权威 |

样机用于交付 P3 的控件和运行时，不要求复制整个现有 Studio 编辑器，也不包含完整 Monaco、节点编辑器和任意 React 组件兼容。

## 6. C 线：原生 GUI 图表（13–20 人日）

| ID | 本轮待办 | 验收证据 |
|---|---|---|
| C01 | Rust ChartIR reader/validator、版本迁移与 TS golden；有限 ECharts option/action 支持矩阵 | 未知字段、function/formatter、引用、超限、非有限值明确拒绝；原生不执行 ECharts JS |
| C02 | linear/log/category/time 标度、刻度、单位/小数位、标签避让和布局 | 负数、零跨度、log 非正值、极值、时区、长中文标签；图例/坐标不裁切 |
| C03 | line/bar/scatter/pie/heatmap/gauge 六类原生 renderer，输出 Deep2D 或受管 GPU 批次 | 六类均有真实数据与像素对照；透明、clip、主题、DPI 一致；空/坏数据状态可操作 |
| C04 | tooltip、legend toggle、highlight/select、dataZoom、平移与缩放事件 | 点击实际改变状态；series/data identity 稳定；tooltip 值/单位正确、边缘不溢出 |
| C05 | 百万点增量数据通道、分块/列式存储、抽样/聚合、局部 GPU 上传、背压和取消 | 不能直接放宽 500k JSON 行预算；保留峰值和选中点；缩放可恢复细节；有界内存 |
| C06 | 原生 GUI 集成、图表可访问性、刷新与恢复 | 图表与对象选区联动；旧 revision 不覆盖新数据；关闭取消任务；屏幕阅读器有摘要/数据入口 |

百万点指输入数据规模；每帧绘制点数可按像素预算抽样，但必须报告输入、驻留、可见、绘制和丢弃数量及抽样规则。

## 7. 公共验收与证据

所有任务状态只使用：`已完成`、`本轮待办`、`明确排除`、`项目级后验收`。只有通过对应完整验收的任务才改为已完成。固定 glyph/CPU layout/ChartIR 编译/隐藏窗口首帧各有自己的验证范围，不能据此宣称完整 GUI 可用。

| 矩阵 | 必须覆盖 |
|---|---|
| 正确性 | 合同、绘制、命中和事件一致；clip/z-order/alpha；中文/混排；六类图表 |
| 故障 | 空/损坏/超限资源，取消/超时/迟到，OOM/device loss，重建失败保留旧帧，关闭释放 |
| 窗口 | 1920×1080、1280×720、980 窄窗、4K；100/125/150/200% DPI，跨屏、最小化恢复 |
| 性能 | 静止 UI 无持续全量 layout/paint/upload；10 万行虚拟列表、百万点增量图表、中文编辑、3D 同帧 |
| 视觉 | 深浅主题、品牌令牌、无裁切遮挡、完整交互状态；至少两轮截图与操作录像复核 |

性能报告记录 build/asset/font hash、adapter/backend、release/debug、分辨率/DPI、预热/采样窗、实际样本/跳样数、P50/P95/P99、CPU/GPU/缓存峰值与回落。首轮建议冻结 60 帧预热 + 600 帧采样，并提供相同场景的静止/更新/交互对照；不使用 GPU 不支持时的估算数代替时间戳。

建议初始交互门槛：操作 ≤100ms 出现反馈；虚拟列表活跃节点和 GPU 上传随视口有界；同构建重复运行 20 次载入/关闭后资源无持续增长。硬件和质量相关帧时阈值在第一批基线后冻结，后续不得为通过测试私自降低画质。

视觉按 digitaltwin skill：Design Read → 令牌 → 实现 → 至少两轮截图 → 十维评分 → 同族排查 → 报告。对标西门子的密度/状态语义和 FVS 图表纪律。Browser 对照按 skill 跑实际页面；Native 另交可见窗口截图、输入和 DPI 实机证据，Browser 截图不能替代 Native 验收。未实测维度标记未验收，不凭代码给分。

## 8. 可执行检查入口

在仓库根执行现有命令；GLM 新增 GUI/Chart 专项命令后必须补充这里的用法。

```powershell
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine gate:runtime-purity
pnpm --filter @bim-studio/deep-engine gate:source-size
cargo test --manifest-path packages/deep-engine-native/Cargo.toml
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --all -- --check
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --all-targets --all-features -- -D warnings
cargo run --manifest-path packages/deep-engine-native/Cargo.toml -- --headless-deep2d
cargo run --manifest-path packages/deep-engine-native/Cargo.toml -- --smoke-deep2d
cargo run --manifest-path packages/deep-engine-native/Cargo.toml -- --smoke-deep2d-interleaved
pnpm quality:source-size
pnpm gate:repository
git diff --check
```

先跑聚焦测试再跑全量。普通 cargo test 中 ignored GPU 测试必须列出并单独执行；每个 ignored/skip 都说明原因。现有 smoke 为 64×64 窗口首帧检查，另需真正可见窗口的交互验收。

原始输出放 `test-output/deep-engine/p3/`，摘要与可再分发 golden 放测试目录/`docs/specs/`。不提交客户数据、凭据和原始会话日志。证据摘要须带命令、退出码、构建身份和未覆盖项。

## 9. 工期与第一批任务

总投入 **45–70 人日**：Deep2D 12–18，GUI 20–32，Chart 13–20。依赖冻结后 U/C 并行，规划窗口沿用 **2–4 个月**；这是工程估算，按每个检查点实测更新，不是模型会话耗时承诺。

| 检查点 | 要交付的可审查结果 |
|---|---|
| 首 0.5–1 人日 | 源码/测试支持矩阵、dirty 工作树清单、共享文件所有权、字体/平台依赖候选 |
| 首 2–3 人日 | 优先修 D01/D06/D08：合同差异、frame binding/cache、DPI 原子更新；回归与 GPU 证据 |
| 约第 2–4 周 | Deep2D 完整路径、文字/命中接口冻结；U/C 进入正式并行 |
| 约第 5–8 周 | 基础控件/中文输入、六类图表、同帧可操作样机 |
| 后续检查点 | dock/虚拟列表/UIA、百万点增量、跨 DPI/故障/资源回落，完成全部剩余项 |

第一批不重写 painter。先检查已有实现，选择真实失败用例；每个修复必须给修复前失败与修复后通过的对应证据。文字库准入等待期间可以并行推进纯布局、命中、图表合同和缓存，不阻塞全部工作线。

## 10. 每批交接格式

```text
任务 ID / 状态：
实际改动与文件：
复用组件及新增依赖：
测试命令 / 结果 / ignored：
Native GPU / 窗口 / 输入 / DPI 证据路径：
性能与资源回落：
公共合同变化及 Codex 接线点：
剩余问题 / 下一批：
```

交付完成需同时具备：代码、跨语言合同、实际 Native 执行、交互、失败恢复、性能和视觉证据。P3 的最终验收由 Codex 按上述矩阵复核；GLM 的自报完成数只作为核验入口。
