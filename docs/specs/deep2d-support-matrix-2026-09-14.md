# Deep2D 支持矩阵冻结（D01，2026-09-14）

本文件冻结 Deep2D 显示列表合同 v1 的当前支持状态，作为 TS/Rust 跨语言 golden 的裁决依据。
状态只有三档：`支持`（合法输入可执行）、`拒绝`（合法输入显式拒绝，带结构化 issue）、`校验拒绝`
（非法输入在 validator 层拒绝）。任何行为变化必须先改本文件再改代码。

## 1. 命令级支持矩阵

| 能力 | 状态 | 实现位置 | 证据 |
|---|---|---|---|
| path fill（单/多闭合子路径） | 支持 | `painter_geometry::append_fill` | `deep2d_painter::supports_concave_fills…` |
| path fill 规则 nonzero/evenodd + 孔洞 | 支持 | `painter_geometry` + `painter_polygon_bridge::bridge_hole` | `deep2d_hole_contract` 3/3 |
| 开放路径 stroke（butt/square cap、miter/bevel join、miterLimit） | 支持 | `painter_stroke::stroke_outline` | 既有 painter 测试 |
| **round cap / round join** | **支持（本轮 D02）** | `stroke_caps`（凸扇形展开，公差驱动 3..64 顶点） | `deep2d_adversarial::round_caps_and_joins_expand…`、`closed_subpaths_stroke…` |
| **闭合子路径 stroke（seam join）** | **支持（本轮 D02）** | `painter_stroke::closed_stroke_outline`（闭合点按 join 处理，无 cap） | 同上 |
| dash / dashOffset（含奇数 pattern、极大 offset、负 offset 归一化） | 支持 | `painter_dash`（仅作用于描边；fill+dash 组合有保护分支） | `deep2d_painter::supports_path_clips_and_dash…` |
| 曲线 quadratic/cubic 扁平化（0.25 物理像素公差） | 支持 | `painter_path::flatten_*` | `deep2d_tessellation` |
| 多子路径（自交/跨子路径相交失败关闭） | 支持 | `painter_path_intersections` | `deep2d_multisubpath_contract` |
| 矩形 clip（scissor，外扩取整） | 支持 | `deep2d_scissor` | `deep2d_clip_gpu_tests`（真 GPU） |
| path clip（三角形裁剪，嵌套交集，有界预算） | 支持 | `painter_clip::clip_vertices` | `deep2d_path_clip_gpu_tests`（真 GPU） |
| image（atlasId + source rect，UV/角点断言） | 支持 | `painter_atlas::prepare_image` | `deep2d_image_contract` |
| text（host 预烘焙 bakedGlyphs + glyph atlas） | 支持 | `painter_atlas::prepare_text` | `deep2d_text_gpu_tests`（真 GPU） |
| text/image 无 atlasId 或无 bakedGlyphs | 拒绝（unsupported-command） | validator + painter 双层 | `deep2d_painter::rejects_text_and_image…` |
| **动态字体 shaping / 中文 fallback / bidi** | **未实现（D05，本轮待办）** | — | 见 §4 |
| z-order / opacity / 稳定平局序 | 支持 | `painter::prepare_display_list`（(z, index) 稳定排序） | 既有测试 |
| **命中索引（fill/stroke/image/text + 变换 + z-order）** | **支持（本轮 D07，clip 约束未实现）** | `deep2d/hit_index.rs` | `hit_index` 3/3；clip 约束列入剩余 |
| pointer-events / pointer capture | 未实现（U 线 retained UI 承接） | — | — |

## 2. 错误码合同（跨语言）

| Rust issue code | TS issue code | 语义 |
|---|---|---|
| `InvalidDisplayList` | validator 层拦截 | 结构/schema 不合法，不进入 painter |
| `UnsupportedCommand` | `unsupported` | 合同内但 painter 不执行（text/image 无烘焙数据） |
| `UnsupportedStyle` | — | （本轮移除 round 拒绝后暂无产生点；保留供未来曲线管线） |
| `UnsupportedGeometry` | `invalid-path`/`invalid-value` | 零长段、180° 回折、自交、闭合 stroke 点不足 |
| `TessellationBudgetExceeded` | `budget-exceeded` | 扁平化/裁剪/dash/扇形预算超限（2048 段、2M 顶点等） |
| `UnsupportedDash` | — | dash 无 stroke、pattern 非正 |

坏命令不发布部分画面：painter 逐命令收集 issue，任一存在即整体 `Err`，不上传任何 GPU 资源。

## 3. 本轮（D02/D06/D07/D08）行为变化

1. **round cap/join 由拒绝变支持**：`LineCap::Round`、`LineJoin::Round` 经 `stroke_caps`
   凸扇形展开；扇形顶点数由半径与物理公差（`DEEP2D_CURVE_TOLERANCE=0.25px`，按命令
   transform 换算逻辑公差）驱动，上限 64。旧断言已更新：`deep2d_adversarial`（拒绝→扩展断言）、
   `headless_cli`（v1 夹具拒绝点移至 text/image 无烘焙数据）。
2. **闭合子路径 stroke 由拒绝变支持**：seam 处按 join 处理；round join 在 seam 同样展开扇形。
3. **frame uniform 携带物理尺寸**（D08）：WGSL `PainterFrame.reserved → physical_size`；
   逻辑→物理映射统一为 **等比 letterbox（min 比例 + 居中）**，与 Browser canvas 行为一致；
   `chunk_scissor` 与 shader 使用同一映射。窗口 resize 无需重建 painter（draw 时 16 字节
   uniform 写入，尺寸未变时跳过上传）。
4. **frame uniform buffer + bind group 进缓存**（D06）：按 logical size 键控，跨
   `stage_update` 复用；真机证据 `creates=1 hits=2` 且跨更新指针同一
   （`deep2d_gpu_cache_tests`，RTX 4060 Laptop / Vulkan）。
5. **命中索引**（D07）：`build_hit_index` 复用 painter 同一 `LinearPath` 管线；fill 按
   even-odd 射线、stroke 按“点-折线距离 ≤ 半宽”、quad 按逆变换局部盒；(z, index) 逆序取最顶层。

## 4. 明确未实现（不冒充完成）

- D03 复核项：深层嵌套 clip（>2 层）与旋转/镜像组合的像素级对照未跑全矩阵（现有 path clip
  GPU 测试覆盖单层+高 DPI）。
- D04 复核项：资源 revision 级联失效（atlas 数据变化 → 纹理重建）已有缓存哈希路径，但
  “重载/取消/坏 atlas 不污染旧帧”的故障矩阵未系统化。
- D05：动态字体 shaping（cosmic-text 候选）未开始——**依赖准入未批准，候选仅记录不引入**。
- D09：Browser/Native 同 fixture 像素对照未做（Native 侧 readback 已有，Browser 侧对照 fixture 待建）。

## 5. 验证锚点（2026-09-14 本轮）

```text
cargo test（CPU 全量）                    372 passed / 0 failed（基线 300，净增 +72）
cargo test --bin deep-engine-native deep2d -- --ignored
                                          4 passed（RTX 4060 Laptop / Vulkan / driver 595.79）
cargo clippy --lib --tests -- -D warnings 0 error（本轮文件域）
cargo fmt --all -- --check               通过
--headless-deep2d / --smoke-deep2d / --smoke-deep2d-interleaved   全部 PASS（readback 像素序正确）
scripts/native-recovery-matrix.ps1       7/7 PASS
pnpm --filter @bim-studio/deep-engine typecheck / test / build    通过（2645 tests）
证据归档：test-output/deep-engine/p3/d-line-evidence-2026-09-14.txt
```

source-size 门禁本轮失败项仅 `apps/web` 两个文件（810/832 行）——并行会话在途改动，
本轮未触碰 apps/web；本轮新增文件均已按 500 行预警纪律拆分（chart_ir 431、retained_ui 413）。
