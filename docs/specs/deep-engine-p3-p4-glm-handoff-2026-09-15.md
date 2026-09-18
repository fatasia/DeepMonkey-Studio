# Deep Engine P3 / P4 → GLM 交接

日期：2026-09-15  
负责人：GLM  
主线边界：Codex 继续负责 P0/P1/P2；GLM 只负责本文 P3、P4。

## 目标

完成 P3 原生交互层和 P4 可选硬件光追前置/实验路径。所有实现必须进入正式 Native 产品结构，不能以 Lab、静态计划或 mock 作为完成证明。

## P3 任务

### P3-A：Deep2D 产品收口

- D05：动态字体 shaping、字形回退、glyph atlas 增量更新。
- D09：Browser/Native 同 fixture 像素对照与阈值报告。
- Windows IME：winit composition start/update/commit/cancel，复用现有文本编辑状态机。

### P3-B：原生 GUI 与图表

- U04：控件状态机 → Deep2D display list，覆盖按钮、开关、滑杆、disabled/focus。
- U09：最小可操作原生样机：窗口、布局、事件、控件、图表、3D 同帧。
- C06：图表与对象选择、tooltip、legend、屏幕阅读器摘要联动。
- C05：百万点真数据 GPU 基准、readback、性能门禁与遥测报告。
- 全档 DPI：100/125/150/200% 真窗口布局和交互矩阵。
- 两轮视觉闭环：真实窗口截图、运动/缩放/输入回归。

## P4 任务

P4 是可选能力，不得成为 P0/P1/P2 的必需依赖。先完成能力探测和实验后端，再决定生产实现。

### P4-A：能力与降级合同

- 扩展 `HostCapabilities`：RT feature、加速结构、硬件/驱动限制、预算。
- 定义 capability matrix：NVIDIA/AMD/Intel，支持/不支持/驱动不足/预算不足。
- 定义 feature flag、默认关闭、失败回退到现有光栅路径。
- 记录降级原因，不得静默改变材质或光照语义。

### P4-B：实验性 RT 路径

- 实现 RT 阴影、反射或 GI 中最有价值的一项；先做可复现 benchmark。
- 不修改现有 Deep Lights、Deep GI Lite 主路径；不把 RT 作为其依赖。
- 使用真实项目与真实 GPU 验证，至少覆盖 NVIDIA 及一个非 NVIDIA 适配器或明确记录缺失。
- 若无真实项目收益，保留能力探测和设计，不宣称生产完成。

## 允许修改的文件域

- `packages/deep-engine-native/src/deep2d/**`
- `packages/deep-engine-native/src/native_ui/**`
- `packages/deep-engine-native/src/chart/**`
- `packages/deep-engine-native/src/platform_text/**`
- `packages/deep-engine-native/src/host_capabilities/**`（若不存在可新建）
- `packages/deep-engine-native/src/rt/**`（仅 P4 实验路径）
- 对应 `tests/**`、GPU fixtures、P3/P4 专项文档
- `src/lib.rs` 只允许增加必要模块注册，先登记再改。

## 禁止触碰

- P0/P1/P2 正式实现：`packages/deep-engine/src/**`、`src/runtime_package/**`、`src/app/**`、`src/renderer/**`。
- 不修改统一 RenderPacket、驻留预算、candidate 原子发布、Meshlet/Nanite Lite、Deep Lights、Deep GI Lite 的行为合同。
- 不引入未经批准的依赖；尤其是字体 shaping、UIA/AccessKit、RT 依赖必须先提交方案和依赖理由。
- 不修改账号、鉴权、`.env`、存储拓扑或默认管理员配置。
- 不重打、覆盖或替换已冻结的 Windows P1 包。

## 验收命令

```powershell
cd packages/deep-engine-native
cargo test --lib
cargo test --test deep2d_hit_index_contract --test deep2d_stroke_matrix --test deep2d_clip_revision_matrix --test chart_ir_contract --test retained_ui_contract
cargo fmt --all -- --check
cargo clippy --lib --tests -- -D warnings
cargo run -- --headless-deep2d
cargo run -- --smoke-deep2d-interleaved
powershell -File scripts/native-recovery-matrix.ps1
cd ../deep-engine
pnpm exec tsc --noEmit
pnpm exec vitest run src/lighting/probeClipmapPlan.test.ts
```

P3 真窗口、GPU、IME、DPI 和像素对照必须另存证据；P4 必须记录 adapter、driver、backend、feature、预算、asset hash 和降级原因。

## 完成定义

每个任务必须同时具备：源码、类型/编译、测试、真实运行证据、失败/取消/资源回落处理、文档更新。测试全绿但缺真实窗口或真实 GPU 证据，只算部分完成。

交接时请回报：完成项、未完成项、改动文件、测试命令及原始结果、GPU/驱动信息、已知限制、与 P0/P1/P2 的接口影响。不要把“CPU 合同层完成”写成“产品完成”。
