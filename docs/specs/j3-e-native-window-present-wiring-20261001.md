# J3-E Native 窗口事件与 present 实测接线（2026-10-01）

## 现状核查

1. 全仓 `RenderOutcome|WindowEventTimeline|device_loss_probe_tests|j3_window_events` 查询确认正常窗口恢复与两 fresh probe 已存在。未跟踪项是其他并行专线与四个保护保留项；本切片仅拥有 app 测试、CPU support 和 redraw 的 test-only hook。
2. `packages/contracts/src/rendererCapabilityManifest.ts` 有 renderer 能力合同；Rust `events.rs` 有 `RenderOutcome::Presented`，`recovery_retry.rs` 已有候选 id 与 presented 清预算语义。`tests/support/j3_window_events.rs` 已有 6 种事件、时间线与纯校验，保留为唯一 support，不建立产品协议。
3. `Cargo.toml` 已固定 winit 0.30.13、wgpu 30.0.1、serde_json 1.0.151、web-time 1.1.0；support 仅用 std，零依赖新增。
4. `window_events/redraw.rs` 唯一正常帧 `renderer.render()` 消费真实 outcome；`device_loss_probe_tests.rs` 现有 probe 通过 startup pending 变化确认首帧，未收集真实返回点计时。`gpu_shader_material_draw.rs` 已引用 support，窗口 probe 尚未引用。
5. 已有 actual-window-loss 与 retry 两 fresh probe，时间/HDR/selection/stale 守卫已验；support CPU 测仅 1 条组合负例，尚无实际 timeline/present duration 收据。本项不重复验证既有重建架构。
6. 已读 `j3-e-gpu-runner-prep-20261001.md`、`j3-gate-e-window-recovery-current-state-20260930.md`、handoff、remaining 与台账：J3-E 窗口计时是真实缺口；unknown、21 域全编辑器恢复、驱动 VRAM 仍为后继，不据此关闭整个 J3-E。

**已有（不重建）**：生产 recovery/retry、真实 device.destroy→wgpu callback、双 fresh 装配、窗口首帧发布与 HDR 对拍。

**真实缺口**：精确 Presented 返回点的 host 墙钟计时、生命周期事件实际收据、CPU 时间线拒绝错误顺序/id/漏候选的合同。

## 实现与口径

- 在 `renderer.render` 两侧加 Windows test-only observer，普通产品构建零代码/零计时开销。
- 支持模块由 probe 和原测试目标共同引用；thread-local 时间线仅具名新 probe 启用。
- `DeviceLostCallback` 在真实回调到达、归属检查完成后且同步生产重建之前记录；否则同步创建时间会被排除在恢复时长之外。`RecoveryCandidateCreated` 在生产 ready 后、首帧前记录。
- `presentDurationMs` 是 host monotonic `Renderer::render` span（含真实 surface present 返回）；GPU timestamp availability 明确 unavailable，原因是本 probe 未采 GPU query。HDR 读回在事件计时之后，不进入 present span。
- 新 probe 使用两 fresh + 一次实际 destroyed 对照和一次首候选失败重试；保持原 probe/输出兼容。

## 验证与真实遗留

`rustc --edition 2024 --test packages/deep-engine-native/tests/support/j3_window_events.rs -o test-output/j3-window-events-cpu-20261001/window-events-tests.exe` + 执行产物：**4/4 CPU 测通过**。覆盖正确事件/第一恢复时长、错误顺序/id/漏候选/空时间线/超时/禁止恢复 Present、present 事件与测量一一配对/正 span。`rustfmt --edition 2024 --config skip_children=true` 与限定文件 `git diff --check` 通过。

GPU 入口（主线程串行，过滤只命中新 probe，每个测试自己启动两 fresh）：

```powershell
$env:J3_WINDOW_NATIVE_OUTPUT = "D:/Documents/bim/bim-studio/test-output/j3-window-events-20261001/native"
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native --locked j3_gate_e_window_events_present -- --ignored --nocapture
```

输出 `events-round-{1,2}.json` 与 `events-retry-round-{1,2}.json`；旧入口/旧 `round-` 与 `retry-round-` 不变。`windowEvents.sourceHash` 冻结本 probe 装配、计时、redraw hook 与 support/validator 六源的 canonical JSON 摘要；全局 `sourceHash` 仍保留既有 WGSL 口径。记录 `windowEvents.records/presentSamples/recoveryDurationMs`，不设恢复/present 性能阈值，不冒充 paired 性能统计。

当前专线没有运行 Cargo/GPU；app 与 renderer 依赖链编译和真实窗口执行仍由主线程确认。计时明确只覆盖生产 app redraw 入口，HDR helper 的验证 render/后续读回不进入该计时序列；GPU timestamp 为 unavailable。实际 unknown 故障、驱动 VRAM、完整编辑器 21 域与其他恢复 profile 仍未验证，整个 J3-E 不据此关闭。

## 文件体量门复核与最终冻结

本仓同时有两道源体量门：通用 `scripts/check-source-size.mjs` 上限 800 行；本切片的实际强门是 `packages/deep-engine/scripts/sourceSizeGate.mjs`，WARNING_LINES=300、BLOCKING_LINES=301，只有 HEAD 已超限/显式 legacy 可豁免。此前新 support 497 行与 app probe 428 行没有 legacy 豁免，已按职责拆分，没有修改门限。

| 模块 | 行数 | 职责 |
|---|---:|---|
| `src/app/device_loss_probe_tests.rs` | 300 | 具名 probe、真实 NativeApp 状态/回调/HDR 验证 |
| `src/app/device_loss_probe_fresh.rs` | 56 | 两 fresh 子进程与既有 setup 装配 |
| `src/app/device_loss_window_timing.rs` | 103 | test-only observer、时间线收集与收据 JSON |
| `tests/support/j3_window_events.rs` | 170 | std 事件/测量类型与时间线 |
| `tests/support/j3_window_events_validation.rs` | 181 | 纯 CPU 时序/id/present 测量校验 |
| `tests/support/j3_window_events_cpu_tests.rs` | 153 | 原 4 条 CPU 测，路径名不变 |

`node packages/deep-engine/scripts/sourceSizeGate.mjs`：**files=2902、warnings=175、failures=0**（legacy warnings 不冒充零警告）。拆分后独立 `rustc --test` 再次 **4/4**，rustfmt/限定 diff-check 通过。通用 800 门仍因 20 个其他文件退出 1，未越权拆其他专线。

最终 SHA-256：

- app probe：`f7bf08d6d0a2c5654f048d271742a03de081fc042921b7fab82545814f0400b3`
- fresh：`72e927e41a509843548d4d8db02d47cc5c353a6262486408c9dbcab7744a5d3b`
- timing：`e3f290db1f3b3614f7e3a5c619e0e91832a5dc9b561272f15db2e602a35f98a1`
- redraw hook：`c47bbc72514c8303169a4a1594e9d1cb03339f9ae51912a707d8ec7624c2ffa5`
- support：`072b1bdb442407f87949318e898f7959087e46d67abd00523c5a9fb918e51d4a`
- validator：`8f34bbffa0984e76781e26c452026101447fdc1951dbc181a5771e65f45e20d6`
- CPU tests：`71d674f154dfb6a6b85c916fea4e0ffbca152d1c12cc8b6b4bdd48f240c22a21`

拆分没有改变真实窗口 render/present 时序语义。`windowEvents.sourceHash` 现在覆盖 app/fresh/timing/redraw/support/validator **6 个实际源**；CPU 测文件不进入 GPU probe 源摘要。具名入口/四份收据路径不变，当前源必须由主线重编重跑生成新收据；本专线没有运行 GPU/Cargo/WASM。

## root 真机结果

2026-10-01 RTX4060/Vulkan 具名两测通过，每测各启动两独立窗口子进程。4份 `events-{retry-}round-{1,2}.json` 的六源canonical摘要已独立重算并匹配，验证写入 `test-output/j3-window-events-20261001/native/root-validation.json`。普通两轮loss→首恢复present为1805.7442/1794.9283ms，首候选失败重试为2010.5988/2040.7143ms；8个真实host render/present span为4.9721–6.1321ms。每轮真实loss callback=1、stale拒绝=1、恢复HDR差0。原始日志 `test-output/jc-i-20261001-j3-window-present.log`。

以上是host观测值，无配对性能结论；GPU timestamp仍unavailable，实际unknown driver fault=false。完整编辑器21域、驱动显存与其他profile仍未验证，不关闭整个J3-E。
