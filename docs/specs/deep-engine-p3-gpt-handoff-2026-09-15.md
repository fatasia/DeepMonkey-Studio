# Deep Engine P3 → GPT 交接(2026-09-15 08:00 收口版)

> 面向接手会话(GPT/Codex)。本文件是 P3 夜班(2026-09-14 晚 → 09-15 早)的完整交接:
> 交付了什么、怎么验证、还剩什么、文件域边界。所有改动留在共享工作树,未提交未 push。
> 上一个交接:`deep-engine-p3-glm-handoff-2026-09-14.md`(任务定义)、
> `deep-engine-p3-glm-progress-2026-09-14.md`(第一批进度)、
> `deep2d-support-matrix-2026-09-14.md`(合同冻结)。

## 1. 接手必读顺序

1. `bim-studio/AGENTS.md`(工程纪律)+ 本文件。
2. `docs/specs/deep2d-support-matrix-2026-09-14.md` — Deep2D 行为合同,已冻结,改行为先改它。
3. `docs/specs/deep-engine-p3-glm-progress-2026-09-14.md` 与本文件 §3 完成清单。
4. `git log --oneline -5` + `git status --short packages/deep-engine-native` — 以实际工作树为准。
5. 运行 §5 健康检查确认起点绿。

## 2. 一句话现状

P3 的 D 线(Deep2D)已按合同冻结并全量测试;U 线(retained UI/文本/令牌/无障碍)与
C 线(ChartIR/标度/交互/数据通道)的**纯 CPU 合同与算法层**已落地 Rust;
**未做**:真窗口 UI 运行时(控件绘制/IME/UIA 桥)、六类图表 GPU 绘制接线、Browser 像素对照、
动态字体 shaping(依赖未批准)。详见 §4 剩余清单。

## 3. 本夜完成清单(全部带测试+证据)

### D 线(Deep2D)
| 项 | 交付 | 证据 |
|---|---|---|
| D01 | 支持矩阵冻结文档;round/闭合 stroke 由拒绝变支持;错误码合同 | matrix 文档 + adversarial 5/5 |
| D02 | round cap/join 凸扇形展开(公差驱动 3..64 顶点);闭合子路径 seam join;负缩放/非均匀/45°旋转/DPI 1.0-2.0 单调/奇数 dash+负 offset+round 组合矩阵 | stroke_matrix 4/4 |
| D03 | 三层嵌套 clip 链、旋转/镜像/非均匀 clip 矩阵 | clip_revision_matrix 2/2 |
| D04 | atlas revision/数据哈希语义冻结;坏 payload(非 canonical base64/字节数短)fail-closed | 同上 3/3 |
| D06 | frame uniform+bind group 进 Deep2dGpuAssetCache(logical size 键控);真机 creates=1/hits=2/指针同一 | GPU cache 测试(RTX 4060) |
| D07 | 命中索引:fill even-odd/stroke 半宽带/quad 逆变换/z-order;**clip 约束**(clipPathIds 环 + clipRect,与 painter 同语义,失败关闭) | hit_index 3/3 + contract 5/5 |
| D08 | WGSL logical→physical 等比 letterbox(shader+scissor 同映射);resize 零重建(draw 时 uniform 写入) | 真 GPU 4/4 |

### U 线(原生 GUI,纯 CPU 层)
| 项 | 交付 | 证据 |
|---|---|---|
| U01 | retained_ui.rs reader/validator(deny_unknown_fields/结构校验/色环 DFS/可达性);测试拆集成 | retained_ui 3/3 + contract 3/3 |
| U02 | layout.rs 布局求解(absolute/stack/flex-row/flex-column/grow/align/min-max/padding/gap) | native_ui_layout(子代理交付) |
| U03 | events.rs 命中+capture/target/bubble 传播状态机 | native_ui_events |
| U04 | controls.rs 按钮开关滑杆等纯状态机(disabled/focus/钳制) | 同文件测试 |
| U06 | virtual_list.rs 视口窗口计算(10 万条目活跃节点有界) | 同文件测试 |
| U07 | 设计令牌快照:scripts/export-design-tokens.mjs(base.css 唯一来源→JSON,color-mix/transparent 解析)+ design_tokens.rs reader(双主题/语义色/reduced-motion 校验) | design_tokens 3/3(含真实导出文件解析) |
| U08 | accessibility.rs 语义树(role 回退/UIA 动作→同一事件系统 a11y:* 事件) | accessibility 3/3 |
| U02-U06 挂载 | layout/events/controls/virtual_list 四模块已挂进 native_ui/mod.rs 并全绿 | native_ui_layout 12 + native_ui_events 12 |
| U05(部分) | platform_text/layout.rs:字素簇(emoji flag+combining+ZWJ)/光标按 cluster 不按 UTF-16/简化 UAX#14 断行(CJK 逐字/拉丁词界)/定宽组装 | layout 4/4 |

### C 线(原生图表,纯 CPU 层)
| 项 | 交付 | 证据 |
|---|---|---|
| C01 | chart_ir.rs IR reader/validator(预算/重复 id/维度引用/标度语义/gauge min<max) | chart_ir 3/3 + contract 3/3 |
| C02 | scales.rs(linear/log/category/time,nice ticks,零跨度/非正值/极值 fail-closed) | chart_scales(子代理) |
| C03 | render.rs 六类图表 → Deep2D 显示列表(自校验通过)+ layout.rs 画布分区 | chart_render(子代理) |
| C04 | interaction.rs tooltip/legend/highlight/select/dataZoom 状态机(隐藏 series 拒绝交互/zoom 校验/幂等 select) | interaction 3/3 |
| C05 | data_window.rs 列式分块(8192/chunk)/1M 驻留预算 fail-closed/等距抽样保首尾/驱逐+记账报告(输入/驻留/可见/绘制/丢弃);with_chunk_size 公开构造器 | data_window 4/4 |
| 性能守卫 | tests/performance_guards.rs:万节点布局/命中索引/5 万点渲染/百万点管线四道回归 tripwire + 渲染确定性断言 | performance_guards 5/5 |
| **C03 GPU 接线(夜班加做)** | `src/chart_gpu_tests.rs`:render_chart 输出 → **生产 Deep2dGpuPainter** → Vulkan 真机 readback;line 系列 228 painted 像素且出现系列蓝;空系列零像素且合同有效 | chart_gpu_tests 2/2(真 GPU,--ignored) |
| golden 修复 | 跨语言 golden 抓到 Rust validator 缺口(strokeWidth 无 stroke),核对后确认 TS 合同(权威)允许两者均接受——golden 以 TS 为准对齐 | validator_golden 双端一致 |

## 4. 明确未做(不许冒充完成)

| 项 | 为什么 | 建议接法 |
|---|---|---|
| D05 动态字体 shaping(真字形) | cosmic-text 准入未批准(GLM 无权引依赖);platform_text 已交付 cluster/断行地基 | 批准后接 cosmic-text 做 shaping,本模块负责 cluster/断行 |
| D09 Browser/Native 像素对照 | 需 Browser Lab fixture 生成器与 Native readback 对齐跑 | 同 fixture JSON 双端渲染+像素 diff 阈值 |
| U05 Windows IME | 真窗口+composition 事件,需 winit IME 集成 | 先 platform_text 光标/选区(已有)+ winit Ime 事件接线 |
| U04 控件 GPU 绘制 | 状态机已有,绘制待控件→Deep2D 显示列表生成器 | controls.rs 状态 → Deep2D 命令(参照 chart/render.rs 模式) |
| U09 可操作样机 | 依赖以上全部 | 窗口+布局+事件+控件渲染+图表合流 |
| C06 图表集成(与对象选区联动/屏幕阅读器摘要) | 语义钩子在 accessibility.rs,联动逻辑待 U09 样机 | 图表已可上 GPU(见 C03),余下是产品接线 |
| C05 百万点真数据 GPU 基准 | 通道已就绪,缺冻结基准+遥测 | 100 万点生成器+perf gate(参照 §5 命令) |
| 全档 DPI 真窗口矩阵(100/125/150/200%) | 需真实可见窗口交互 | winit 窗口+人工/自动化截图矩阵 |
| 两轮视觉闭环(截图) | 本夜无新 UI 画面(CPU 层为主),不适用 | U09 样机后按 digitaltwin skill 补 |

## 5. 健康检查与门禁命令

```powershell
cd packages/deep-engine-native
cargo test --lib                     # 全部单元测试(收口时 70+)
cargo test --test deep2d_hit_index_contract --test deep2d_stroke_matrix `
  --test deep2d_clip_revision_matrix --test chart_ir_contract `
  --test retained_ui_contract        # 新增集成合同
cargo test --bin deep-engine-native deep2d -- --ignored   # 真 GPU(RTX 4060/Vulkan)
cargo fmt --all -- --check
cargo clippy --lib --tests -- -D warnings     # 注意:并行会话在途文件可能有自己的错
cargo run -- --headless-deep2d       # CPU 合同+painter 冒烟
cargo run -- --smoke-deep2d-interleaved                   # Vulkan 真机 readback
powershell -File scripts/native-recovery-matrix.ps1       # 7 surface
# 仓库侧
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
node scripts/export-design-tokens.mjs <repo-root>         # 重导出令牌快照(base.css 变更后必须)
```

收口实测(2026-09-15 早晨回填):见 §7。

## 6. 文件域边界(多会话协作)

**本夜 GLM 触碰**(D/U/C 车道):`src/deep2d/**`、`src/deep2d*.rs`、`src/native_ui/**`、
`src/chart/**`、`src/platform_text/**`、`assets/shaders/native_deep2d*.wgsl`、
`tests/deep2d_*.rs`、`tests/chart_*`、`tests/native_ui_*`、`tests/retained_ui_*`、
`fixtures/design-tokens-v1.json`、`scripts/export-design-tokens.mjs`、
`src/lib.rs`(仅 4 行模块注册:chart/native_ui/platform_text + duplicate_mod allow)。

**并行会话车道(勿动)**:`src/runtime_package/**`(23:07 prefiltered_ibl)、
`src/app/**`(package_drop)、`src/telemetry*`、`src/renderer/**`(遥测/IBL)、
`src/shader_disk_cache/**`。它们当时有在途错误(clippy 2 处/GPU 测试 1 处),属其车道。

**共享文件接线点**(已做,变更需登记):`src/lib.rs` 模块注册;`renderer/frame.rs` 无需改
(Deep2dGpuPainter::draw 签名未变)。

## 7. 收口门禁快照(2026-09-15 05:00 实测)

```text
cargo test(CPU 全量,所有 target)     485 passed / 0 failed / 33 ignored
                                      (夜班起点 300/0/21 → 净增 +185 测试;+2 ignored 为 chart GPU 用例)
cargo clippy --lib --tests -- -D warnings   0 error
cargo fmt --all -- --check            clean
真 GPU debug(RTX 4060/Vulkan)         deep2d 4/4 + chart_gpu 2/2 passed
真 GPU release                        deep2d 4/4 passed
(chart GPU 证据:painted_pixels=228/8192,系列色命中,空系列零像素)
性能守卫 tests/performance_guards.rs   5/5(release 全套 0.04s;debug 0.50s)
  - layout_tree 10,000 节点 < 2s(debug)
  - hit_index 2,000 entry 构建 + 5,000 查询 < 2s(debug)
  - render_chart 50,000 点 line < 3s(debug)
  - ChunkedSeries 100 万点 append+slice+decimate < 10s(debug)
  - render_chart 确定性:同 IR 两次渲染 JSON 字节一致
真 GPU 全套 --ignored                 13 passed / 0 failed(含并行会话 surface 全绿)
--headless-deep2d / --smoke-deep2d / --smoke-deep2d-interleaved  全 PASS(readback 像素序正确)
scripts/native-recovery-matrix.ps1    7/7 PASS
pnpm --filter @bim-studio/deep-engine typecheck/test/build  2697 tests PASS(含跨语言 golden)
跨语言 golden:fixtures/deep2d_validator_golden_v1.json 13 case,TS+Rust 双端判定一致
证据归档:test-output/deep-engine/p3/night-final-gate-2026-09-15.txt
```

## 8. 对标差距(Unity/UE5/Godot 口径,诚实评估)

| 维度 | 当前 P3 状态 | 与一线引擎差距 | 追平路径 |
|---|---|---|---|
| 2D 矢量渲染 | CPU tessellation+GPU fill;曲线/圆角/dash/clip/命中齐 | 距 Vello/Fluent 有 GPU 曲线细分与抗锯齿质量差 | analytic curve 管线(wgpu compute) |
| 文本 | cluster/断行合同层;无 shaping/字形 | 距 Unity TextMeshPro/UE Slate 差整代(无 shaping/回退/纹理图集) | cosmic-text 准入→shaping→glyph atlas 增量 |
| UI 控件 | 纯状态机合同层 | 距 Unity UI 工具包/UE UMG 差运行时(绘制/动画/模板) | 控件→显示列表生成器+retained paint cache |
| 图表 | IR/标度/交互/抽样合同层+CPU 几何 | 距 ECharts 交互完备度差 tooltip 渲染/动画 | render.rs→painter 接线+tooltip pass |
| 输入/IME | 事件传播状态机 | 无真窗口 IME/触控/手柄 | winit 事件接线 |
| 无障碍 | 语义树合同层 | 无真 UIA 桥 | AccessKit 准入或自写 UIA adapter |

## 9. 下一步建议序(给 GPT)

1. 跑 §5 健康检查,确认工作树状态(夜班终态全绿;若看到并行车道新错误,先分域)。
2. **C03 GPU 接线已完成(夜班)**——参照 `src/chart_gpu_tests.rs` 的包装方式即可把任意
   ChartIR 渲染到屏幕;剩余工作是把它接进 PlayerContent 加载路径与 U09 样机。
3. U04 控件→显示列表生成器(controls.rs 状态机已就绪,参照 render.rs 的 builder 模式,2-3 人日)
   → U09 最小样机(winit 窗口 + retained 布局 + 控件 + 图表 + 3D 同帧)。
4. 若 cosmic-text 准入获批:接 D05 shaping(1-2 人日),platform_text 的 cluster/断行/编辑状态机/IME
   状态机直接复用(text_edit.rs + ime.rs 已按"composition 外挂、commit 走 replace_selection"设计)。
5. winit 真窗口 + IME 事件 + 100/125/150/200% DPI 矩阵 + 两轮视觉闭环(digitaltwin skill)。
6. 每步保持支持矩阵文档同步;行为变化先改矩阵再改代码。新依赖仍需事前批准。
