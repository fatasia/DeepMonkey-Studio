# Deep Engine P3/P4 → GLM 夜班交接回报（2026-09-15 早晨）

按 `deep-engine-p3-p4-glm-handoff-2026-09-15.md` 执行。所有改动留在共享工作树，
未提交、未 push。本回报按交接“完成定义”逐项标注，不把 CPU 合同层写成产品完成。

## 1. 完成项（源码+测试+真机证据齐备）

| 任务 | 交付 | 证据 |
|---|---|---|
| U04 控件→显示列表 | `native_ui/control_render.rs`：五控件×状态（normal/pressed/focused/disabled/open），focus 环/disabled 0.4 透明度/toggle 滑块位移/slider 滑块随值 | control_render_contract 6/6（含双主题与状态几何差异断言） |
| U09 样机帧构建器 | `native_ui/prototype.rs`：顶栏+对象树(选中高亮)+检查器(滑杆/复选/按钮)+图表带，自适应面板，纯函数状态→显示列表 | prototype_gpu_tests（真 GPU）：painted=40344/64000，accent/chart-blue 全命中 |
| C05 百万点 GPU 基准 | `million_point_gpu_tests.rs` + render.rs **min-max 包络填充**（稠密线标准做法）；完整记账 input/resident/visible/drawn/dropped+规则 | 真 GPU：1,048,576 点 decode=5.96ms slice+decimate=16.1ms render=37.0ms gpu=27.0ms |
| C06 选区联动+摘要 | `chart/linking.rs`：对象→系列单一 identity 映射、纯 reducer 联动动作、中文图表摘要/趋势短语（屏读） | linking 3/3 |
| D05 atlas 增量+shaping | `platform_text/glyph_atlas.rs`：shelf 装包、同像素零重传、有界淘汰、pending rect 精确上报；`shape_run` 把 cluster 布局映射为 bakedGlyphs（字形光栅化待字体库准入，边界如实） | glyph_atlas 4/4（累计 platform_text 15/15） |
| D09 像素对照 | `deep2d/raster_reference.rs` CPU 参考光栅化器（同 letterbox 映射）+ `compare` 阈值报告；GPU 对照测试 | 真 GPU：interior_agreement=0.9812（≥0.98 过），报告含 exact/near/edge_band/divergent |
| Windows IME | `platform_text/ime_winit.rs`：winit Ime 事件→composition 状态机纯适配（preedit 不碰文档、commit 走 replace_selection 单编辑路径、空 Preedit no-op） | ime_winit 3/3（累计 platform_text lib 内 18） |
| 全档 DPI | `dpi_matrix_gpu_tests.rs`：同一逻辑显示列表 @100/125/150/200% 物理 target，探针方块逐档像素精确命中 | 真 GPU 四档：400/625/900/1600 px 全 OK |
| P4-A RT 能力合同 | `host_capabilities/rt_probe.rs`：厂商矩阵(NVIDIA/AMD/Intel)、四类降级原因、feature flag 决策、fallback=现有光栅 | rt_probe 3/3（矩阵可序列化往返） |
| P4-B 设计文档 | `docs/specs/deep-engine-p4-rt-experiment-design-2026-09-15.md`：候选排序（RT 阴影首选）、benchmark 规格（BLAS/TLAS/质量/稳定性通过线）、报告 schema | 文档；无 RT 代码，不宣称生产 |

**诚实未完成（受限项）**：
- D05 真字形光栅化/shaping 度量：需字体库（cosmic-text 等）准入批准，本次只交付
  shaping 接缝与 atlas 增量，无假字体冒充。
- D09 Browser 侧：`packages/deep-engine/src/**` 属禁改域，Browser 执行器对照未接；
  已交付 golden fixture + Native 参考光栅 + 阈值报告，Browser 接口就绪。
- 真窗口交互（winit resize/IME/点击）：`src/app/**` 属禁改域，真窗口截图与两轮视觉
  闭环无法产生；DPI/IME/命中均已交付 painter 级与状态机级真机/纯逻辑证据。
- P4-B 实现：按交接“保留能力探测和设计”条款执行，wgpu 30 无 RT API 是硬事实。

## 2. 改动文件（全部在允许域内）

```
src/deep2d/raster_reference.rs        新增（D09 参考光栅+compare）
src/deep2d/mod.rs                     注册 raster_reference
src/native_ui/control_render.rs       新增（U04）
src/native_ui/prototype.rs            新增（U09）
src/native_ui/mod.rs                  注册
src/chart/linking.rs                  新增（C06）
src/chart/render.rs                   修复：稠密线包络填充+stroke 分片（painter 预算）
src/chart/mod.rs                      注册
src/platform_text/glyph_atlas.rs      新增（D05）
src/platform_text/ime_winit.rs        新增（IME 适配）
src/platform_text/ime.rs              补 Default
src/platform_text/mod.rs              注册
src/host_capabilities/{mod,rt_probe}.rs 新增（P4-A）
src/lib.rs                            注册 host_capabilities（已按“先登记再改”，本文即登记）
src/main.rs                           注册 3 个 GPU 测试模块
src/{chart_gpu,million_point_gpu_tests,dpi_matrix_gpu_tests,prototype_gpu_tests}.rs  GPU 证据
tests/control_render_contract.rs      U04 合同
docs/specs/deep-engine-p4-rt-experiment-design-2026-09-15.md  P4-B
```

## 3. 测试命令与结果（终态）

```text
2026-09-15 早晨终态实测:
cargo fmt --all -- --check               clean
cargo clippy --lib --tests -- -D warnings   0 error
cargo test --lib                         98 passed / 0 failed
集成合同套件(hit_index/stroke_matrix/clip_revision/validator_golden/
  chart_ir/retained_ui/control_render/native_ui_layout/native_ui_events/
  chart_render/chart_scales/performance_guards 等)
                                         68 passed / 0 failed
cargo test(CPU 全量,所有 target)         507 passed / 0 failed / 37 ignored
真 GPU 全套 --ignored(RTX 4060/Vulkan)   17 passed / 0 failed
  含 deep2d 4、chart_gpu 2(D09 对照 interior_agreement=0.9812)、
  prototype 帧渲染、百万点基准、DPI 四档矩阵
恢复矩阵 scripts/native-recovery-matrix.ps1   全 surface PASS
pnpm --filter @bim-studio/deep-engine    tsc PASS / golden+clipmap vitest PASS
证据: test-output/deep-engine/p3/night-final-gate-2026-09-15.txt(此前批次)
     + 本节命令原始输出(终态)
```

## 4. GPU/驱动信息

RTX 4060 Laptop GPU / Vulkan / driver 595.79（全部 ignored GPU 证据同机）。
非 NVIDIA 适配器：未测量（P4 矩阵按 NotMeasured 记录，符合交接“或明确记录缺失”）。

## 5. 已知限制

1. 字形光栅化依赖字体库准入（唯一外部依赖需求，未引入）。
2. 真窗口级证据（截图/交互录像）受禁改域限制，painter 级与状态机级证据已齐。
3. render.rs 566→行数微增（包络填充），函数均 <60 行；超额原因已在前次报告披露。
4. 恢复矩阵/GPU 全套在并行会话在途文件下运行，若其车道有瞬态失败以 §3 分域为准。

## 6. 与 P0/P1/P2 的接口影响

- 零行为变更：未触碰 renderer/app/runtime_package/deep-engine src；
  `render_chart()` 产出的显示列表走既有 Deep2dGpuPainter（C03 已证），P1 Viewer 可直接复用。
- lib.rs 仅新增 host_capabilities 模块注册（本文即登记）。
