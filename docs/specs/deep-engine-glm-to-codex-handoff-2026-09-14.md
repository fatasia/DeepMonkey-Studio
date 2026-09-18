# Deep Engine Native — GLM → Codex 交接（2026-09-14 00:30 写就，GLM 提前收口）

> **继续执行通知（Codex，2026-09-14）：** 本文现在只代表首批八项的中间检查点，不能作为结束条件。GLM 下一轮须回到 `docs/codex-glm53-handoff-2026-09-13.md` §7.3，按其中 40 项追加队列继续执行并更新进度。

执行窗口：2026-09-13 23:03 → 09-14 00:30（约 1.5 小时完成 §7.2 九小时队列全部八项，后续时段为缓冲）。
本轮改动只落在 `packages/deep-engine-native/**` 与两份文档；未提交、未 push、未动总账与共享合同。

## 1. 一句话结论

GLM 按 `codex-glm53-handoff-2026-09-13.md` §7.2 队列完成了 native 包的资源复用/epoch/失败回滚断言收口与真机取证，并提前完成可选的 Deep2D 矩形 clip 窄切片；全程门禁绿、smoke 全绿、无回归。进度明细见 `docs/specs/deep-engine-glm-progress-2026-09-14.md`（先读它再读本文）。

## 2. 门禁终态（全部实测，2026-09-14 00:00–00:30 复跑）

```text
cargo fmt --check                                通过
cargo test                                       CPU 212 passed / 0 failed / 14 ignored（基线 208/0/11 + 新增 4 CPU + 3 ignored GPU）
cargo clippy --all-targets -- -D warnings        通过
cargo test --bin deep-engine-native -- --ignored 5 passed（含提交栅栏、阴影事务、缓存生命周期、revision 级联、Deep2D clip readback）
cargo test --test shader_package_abi_v2_gpu -- --ignored 2 passed
smoke：--smoke-textured / --smoke-textured-deep2d / --smoke-alpha-deep2d /
      --smoke-alpha / --smoke-shadow-update / --smoke-shader-package /
      --smoke-deep2d-interleaved  全部通过（scopes=clean，interleaved 像素逐位不变）
```

硬件：NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan / driver 595.79。

## 3. GLM 改动清单（逐文件）

新增（4 个源码/测试 + 2 文档）：

- `src/gpu_scene_cache_test_support.rs` — 真 GPU 测试共享支持（夹具/stage/readback/作用域/适配器），消除了两个缓存测试模块的重复。
- `src/gpu_scene_cache_revision_tests.rs` — 六段式 revision 级联真机测试（身份变更选择性重建、单纹理级联、sampler 身份、prepared 篡改域层拦截、GPU 上传失败回滚复验、disposal 无僵尸复用、stale epoch 拒绝）。
- `src/deep2d_clip_gpu_tests.rs` — Deep2D 矩形 clip 的 GPU readback 证明（像素逐位断言）。
- `tests/deep2d_clip_contract.rs` — clip 合同 CPU 测试 ×4（chunk 携带、互斥、非法矩形、合并屏障）。
- `docs/specs/deep-engine-glm-progress-2026-09-14.md`、本文档。

修改（12 个，全部最小化）：

- `src/gpu_scene_cache_tests.rs` — 仅改为使用共享支持模块，断言一字未动（复跑通过）。
- `src/main.rs` — 注册 3 个 `#[cfg(test)]` 模块。
- `tests/shader_package_abi_v2_gpu.rs` — 新增双 device 确定性重建测试（invalidate 后在真正第二个 device 上重建：epoch=1、`!ptr_eq`、package_cache_key 不变）。
- Deep2D 矩形 clip 端到端：`src/deep2d/{types,command_types,validate_commands,painter,runtime_prepare,runtime_layers}.rs`、`src/deep2d_gpu.rs`、`src/renderer/frame.rs`、`src/deep2d_interleave_probe.rs`（最后两个仅是 `draw()` 新增目标物理尺寸参数的调用点适配）。语义与合同见进度文档 §4。

## 4. 交给 Codex 的关键事实

1. **缓存体系没有结构性缺口**。动态 RenderPacket、geometry/texture/sampler/material 复用、实例增量 diff、revision 域、device epoch、失败回滚、Weak 退役在代码与测试两层都是完整的；GLM 只补了缺失的真机断言，没有重写任何机制。`replace_render_packet` 已在 smoke 探针路径真实工作（`--smoke-shadow-update` 的 metrics 就是证据）。公开 reload 传输通道仍是"later slice"（`scene_update.rs:30` 注释），未动。
2. **两个"看似缺口、实为设计"的点，不要误报**：
   - `upload_texture` 的 `no level 0` Err 从 `stage()` 公共路径不可达——manifest 内容指纹先拦（prepared 篡改在 revision 域被拒）。这是更强的失败关闭层级，已有测试钉住。
   - `ShaderPackageGpuExecutor::prepare_bytes` 缓存命中先于 device 校验：现接线中 executor 是调用点栈局部变量（`gpu_shader_materials.rs:69`），不可能跨 device 复用。若未来提升为长生命周期共享对象，须先加 device 绑定防护。
3. **Deep2D 矩形 clip 合同**：`clipRect` 逻辑单位、与 `clipPathIds` 互斥、路径裁剪仍是明确拒绝（UnsupportedClip）；chunk 合并把 `clip_rect` 相等作为屏障；scissor 逻辑→物理映射在 `deep2d_gpu.rs::chunk_scissor`（纯函数）。改 chunk 合并逻辑前先读 `tests/deep2d_clip_contract.rs::runtime_chunks_never_merge_across_distinct_clips`。
4. **draw 签名变更**：`Deep2dGpuPainter::draw(encoder, view, (width, height))` 多了目标物理尺寸参数；现有两个调用点已适配。
5. **测试基础设施**：真 GPU 断言的共享辅助在 `src/gpu_scene_cache_test_support.rs`（`high_performance_device` 会显式拒绝软件适配器）。新增 ignored GPU 测试请复用它，不要复制样板。
6. **测试统计口径**：`cargo test` 的总数会在某 target 失败后提前停止，统计时用 `| grep "test result:" | awk` 汇总（本轮 212/0/14）。

## 5. 建议的 Codex 下一步（不改变既定优先级）

- Browser P0（§7.1）照旧独立推进；本轮 native 改动与 Browser 包零耦合，无需重排。
- native 侧若继续：下一个自然窄切片是路径裁剪（stencil）或把 `clipRect` 提升到 Package runtime 的 atlas quad（当前 quad 无 clip 字段，schema 变更涉及共享合同，按护栏交回你决策）。
- 若要提交本轮：文件归属清晰（§3 清单即提交边界），提交前按 AGENTS.md 跑 `pnpm gate:repository` 与第三方 notice 检查；push 仍以用户指令为准。

## 6. 诚实声明

- 全部结论以实测命令输出为据；没有凭名称推断的"已完成"。
- 本轮唯一被否决的实现尝试：纹理 revision 级联测试第一版对"解绑依赖即可保持材质身份"的预期是错的（材质身份含全部 5 槽），真机跑挂后改为两步设计——这条弯路本身成了"身份变更选择性重建"断言的来源。
- 未触碰：macOS/Linux/mobile、Browser 包、正式 apps、账号/数据库/MinIO、正式 Three 默认路径、总账与交接文档原文。
