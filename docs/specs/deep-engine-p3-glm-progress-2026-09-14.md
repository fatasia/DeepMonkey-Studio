# Deep Engine P3 GLM 第一批交付（2026-09-14）

按 `deep-engine-p3-glm-handoff-2026-09-14.md` §9“第一批任务”执行：优先 D01/D06/D08，
随后 D02/D07 主体与 U/C 线合同基础。所有改动留在共享工作树，未提交、未 push（由 Codex
统一门禁、提交）。支持矩阵冻结见 `deep2d-support-matrix-2026-09-14.md`。

```text
任务 ID / 状态：
  D02 闭合stroke/round cap/join — 已完成（代码+CPU测试+组合边界）
  D06 frame 资源跨帧复用 — 已完成（真机 GPU 计数+指针同一）
  D08 logical/physical 等比 letterbox 统一 — 已完成（WGSL+scissor 同映射；resize 无重建）
  D07 命中索引 — 部分完成（fill/stroke-band/quad + 变换 + z-order；
       clip_path_ids/clip_rect 约束命中未实现，为 D07 剩余缺口）
  D01 支持矩阵冻结 — 已完成（文档+golden 断言；动态字体 shaping 明确未实现）
  U01 retainedUi Rust reader/validator — 已完成（合同层；layout/paint 事件运行时未开始）
  C01 ChartIR Rust reader/validator — 已完成（合同层；标度/渲染/交互未开始）

实际改动与文件：
  新增 src/deep2d/stroke_caps.rs（173）、src/deep2d/hit_index.rs（440）、
       src/native_ui/{mod.rs,retained_ui.rs}、src/chart/{mod.rs,chart_ir.rs}、
       tests/{chart_ir_contract.rs,retained_ui_contract.rs}（124/126）
  修改 src/deep2d/{mod.rs,painter_prepare.rs,painter_geometry.rs,painter_stroke.rs}、
       src/deep2d_gpu.rs、src/deep2d_gpu_cache.rs、
       assets/shaders/native_deep2d_v1.wgsl、native_deep2d_atlas_v1.wgsl、
       src/lib.rs（仅注册 chart/native_ui 两个模块行）、src/deep2d_gpu_cache_tests.rs、
       tests/{deep2d_adversarial.rs,headless_cli.rs}
  文档 docs/specs/{deep2d-support-matrix-2026-09-14.md, 本文件}

复用组件及新增依赖：
  复用 LinearPath/painter_polygon ear-clipper/bridge_hole/Deep2dGpuAssetCache/帧调度。
  零新增 crate 依赖（serde/wgpu/bytemuck/pollster 均既有）；cosmic-text/AccessKit
  仍为候选未批准，未引入。

测试命令 / 结果 / ignored：
  cargo test（CPU 全量）        372 passed / 0 failed（改动前基线 300；净增 +72）
  cargo test --lib              51 passed（新增 stroke_caps 3、hit_index 3）
  --test chart_ir_contract      3 passed   --test retained_ui_contract 3 passed
  --test deep2d_adversarial     5 passed（含本轮 2 个新用例）
  --test headless_cli           5 passed（v1 夹具拒绝点更新为 text/image 无烘焙数据）
  ignored（真 GPU，--ignored 单独执行）：
  cargo test --bin deep-engine-native deep2d -- --ignored → 4 passed / 0 failed
    （cache 复用、path-clip 像素、高 DPI image clip、text 更新失败保旧帧）
  每个 ignored 的原因：需要真实 GPU adapter（Vulkan/RTX 4060 Laptop），CI/无 GPU 环境跳过。
  并行会话在途（非本批）：--bin 全量 ignored 中 package_drop_probe_tests 1 失败、
  clippy --all-targets 中 runtime_lkg_retirement/environment_update 2 错——均为
  runtime_package/app 车道 23:07-23:11 新写入文件，本轮未触碰；本批文件域 clippy 0 错。

Native GPU / 窗口 / 输入 / DPI 证据路径：
  test-output/deep-engine/p3/d-line-evidence-2026-09-14.txt
    --headless-deep2d: contract/painter OK（fill=4 stroke=2 vertices=18）
    --smoke-deep2d: 64x64 窗口首帧 presented，scopes=clean
    --smoke-deep2d-interleaved: Vulkan readback 像素序 path-image-path-glyph 全对
  scripts/native-recovery-matrix.ps1: 7/7 PASS
  注意：本轮为 CPU/首帧/DPI 断言证据；真正可见窗口的交互/输入验收仍属后续批次
  （Browser 截图不能替代 Native 交互验收——本轮未产生新 UI 画面，无需视觉闭环）。

性能与资源回落：
  D06 复用证据：同一 display list 三次重建，frame buffer/bind group creates=1、hits=2，
  Arc 指针同一；静止 draw 尺寸未变时跳过 uniform 上传。
  未跑分段遥测基线（telemetry 属并行会话车道，冲突仲裁让渡中）。

公共合同变化及 Codex 接线点：
  1. WGSL PainterFrame.reserved → physical_size（两份 shader 同步）；frame uniform
     现为 [logical_w, logical_h, physical_w, physical_h]，16 字节布局不变。
  2. Deep2dGpuAssetCache 新增 frame_resources/frame_buffer_creates/hits 计数；
     Deep2dGpuPainter::draw 语义不变（签名未变，renderer/frame.rs 无需改动——已验证）。
  3. lib.rs 新增 pub mod chart; pub mod native_ui;（根导出登记）。
  4. 行为变化：round cap/join、闭合 stroke 由拒绝变支持；logical→物理由拉伸变 letterbox。
     若 Browser 执行器有像素对照 golden，需同步 letterbox 语义（见矩阵 §4）。

剩余问题 / 下一批（按交接 §9 检查点）：
  D07 补课：命中索引接入 clip 约束（clip_path_ids 逐层 inside + clip_rect 盒），
       并补“重叠节点/透明节点/捕获目标删除”行为测试；
  D03 深层嵌套 clip/旋转镜像矩阵复核；D04 资源 revision 故障矩阵系统化；
  D05 动态字体 shaping（等待 cosmic-text 准入批准，先做纯布局层）；
  D09 Browser/Native 同 fixture 像素对照；U02 布局/dock、U03 事件、U04 基础控件；
  C02 标度系统、C03 六类 renderer；真窗口交互/DPI 实机验收（100/125/150/200% 全档）。
```
