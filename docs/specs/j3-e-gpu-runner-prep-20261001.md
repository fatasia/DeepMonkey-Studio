# J3-E-GPU CPU 准备片：自动 unknown-loss、Native 窗口事件/present、完整编辑器状态 GPU 验证

日期：2026-10-01。本切片是估时表 `J3-E-GPU`（6–12h）的 **CPU 准备片**：六步核查、三件事的精确验证方案、
runner 骨架与 CPU 侧语义。不跑任何 GPU、不重建 WASM；GPU 实跑由主线按第 7 节预登记命令串行执行。

## 1. 现状核查（六步）

| 六步 | 已有（不重建） | 真实缺口 → 本切片交付 |
|---|---|---|
| 1. 源码与未跟踪 | Web：`packages/deep-engine/src/webgpu/deviceSession.ts`（observeDeviceLost/retryTimer/fatalLoss）、`deviceRecovery.ts`（classifyDeviceLost：destroyed 不可恢复/unknown 可恢复；DeviceRecoveryStateMachine maxAttempts+指数退避）、`StudioDeepWebGpuBridge.ts` 消费 DeviceRecoveryOptions；`viewer/rendererRecoveryState.ts`（animationPlayheadSec，e1261af7 刚收割，本切片不改）。Native：`src/app/recovery.rs`（正常窗口 DeviceLost→释放旧 Renderer→initialize_recovery_renderer）、`src/app/recovery_retry.rs`（预算 3 次、250<<n 退避、candidate id、Presented 才清预算）、`src/renderer/packet_present.rs`、`RenderOutcome::Presented`。grep 全仓无任何 unknown-loss 自动化 runner。 | unknown-loss 无矩阵化 runner；Native 窗口事件/present 无计时结构与计时口径；编辑器域无 GPU 断言契约。 |
| 2. 契约层 | `DeviceRecoveryOptions/Event/Snapshot`、`DeviceState`、Native `GpuEvent::DeviceLost`+renderer-id 过滤、`RenderOutcome::Presented`、`PlayerState`、`RendererRecoveryState.animationPlayheadSec`（会话内协议）。`benchmarkSampleSchema`（ChannelSample/SampleWindow，availability 纪律）与 `compareBenchmarkWindows`（成对 bootstrap）已在生产。 | 无 unknown-loss 注入矩阵/期望/证据的 runner 合同。本切片新增 `scripts/lib/j3UnknownLossMatrix.mjs`（纯 Node，不进 contracts 产品 API）。 |
| 3. 依赖 | node:test、esbuild 动态加载 TS（`j2CsmTimingParity` 先例）、wgpu/winit/pollster、`web_time`。 | 零新增依赖；Rust support 骨架只用 std。 |
| 4. 消费方 | `app/device_loss_probe_tests.rs` 两 fresh 子进程装配（DEEP_WINDOW_LOSS_CHILD/J3_WINDOW_NATIVE_OUTPUT）已消费 destroy 注入与真实 callback；`j3-window-recovery-suite.mjs` 消费窗口证据进 J5；`j3-gpu-process-memory-observation.mjs` 消费修复后的树采样器。 | 三者都没有 unknown 矩阵入口；本切片 runner 的 `--validate` 是它们的未来消费端（接线属 GPU 线）。 |
| 5. 测试与证据 | `deviceSession.recovery` 26 测（unknown/retry/retire/dispose/一次通知）；`scripts/lib/j3DeviceRecoveryParity.test.mjs`（5 测，excluded 列表即本切片四件事）；`j2DeviceMatrix.test.mjs` 10 测；证据 `test-output/interrupted-0930/{device-recovery,window-recovery,native-recovery-retry,driver-memory-observation,window-recovery-suite}/`。aa6ade7d（Native 重试 250/500ms）、fe963a04（Browser 分层恢复）、Gate E 双端 destroy/lost/reopen、e1261af7（播放头）均已验。 | 全部为 destroyed/合成 recreated 注入证据；`actualUnknownDriverFault=false` 一贯如实。无 unknown 矩阵×期望×负例的 CPU 门。 |
| 6. 规格与台账 | `j3-gate-e-device-recovery`（epoch 首刀，excluded=本切片四件事）、`j3-gate-e-window-recovery-current-state`（unknown 资源图风险：readonly pipelines 留旧 device；pbrRenderer 属 I-C26 专线锁）、`j3-gate-e-native-recovery-retry`（3 次/250/500ms/canonical-json-wgsl-source）、`j3-gate-e-driver-memory-observation`（树采样器修复，泄漏预算属后继）、`j3-gate-e-j5-window-suite`（13 对 26 腿）、`j3-e-editor-state-cpu-20261001`（21 域覆盖矩阵）、`remaining-tasks-estimates-20260930.md` J3-E-GPU 行、台账 2026-10-01 行（I-C23 在途）。 | 本规格回填 J3-E-GPU 的 CPU 准备子集；不关闭 Gate E 任何剩余项。 |

**已有（不重建）**：双端真实 destroy/lost/reopen/首帧稳定、Native 有限重试、Web C13 会话内恢复与候选事务、
窗口 suite 进 J5、树采样器、21 域 CPU 矩阵与播放头修复。

**真实缺口**：①unknown 无自动化触发矩阵与证据门；②Native 窗口事件/present 无计时结构与口径；
③21 域矩阵未转成 GPU 恢复逐域断言契约；④驱动显存/上传/帧时口径散落五份规格，未成 runner 契约。

## 2. 方案 A：自动 unknown-loss 全自动触发矩阵

**触发语义**：无真实 unknown 驱动故障来源（一贯口径），全部注入为**合成刺激**——Web 在 `device.lost`
Promise 到达时以 `reason="unknown"` 走 `classifyDeviceLost`；Native 以合成 `GpuEvent::DeviceLost{reason:"unknown"}`
进入 `app::recovery::handle` 正常窗口路径。schema 强制每条 receipt `actualDriverFault:false`，报 true 即拒绝。

**宿主 × 注入行**（`scripts/lib/j3UnknownLossMatrix.mjs` 为唯一声明源）：

| rowId | 注入 | 宿主 | lossCallbacks | attempts | 恢复后 Present | HDR 门 |
|---|---|---|---|---|---|---|
| single-unknown-mid-run | 1 次 unknown | 双端 | 1 | 1 | 必须 | relative ≤1e-6 |
| unknown-retry-backoff | unknown + 首次创建注入失败→退避后第 2 次成功 | 双端 | 1 | 2 | 必须 | relative ≤1e-6 |
| unknown-pre-present-loss | 候选创建成功、Present 前再丢，预算不清零 | 双端 | 2 | 2 | 必须 | relative ≤1e-6 |
| unknown-exhaustion-fatal | 连续 3 次创建失败→恰好停止 | 双端 | 1 | 3 | 禁止（报 present 即拒绝） | none |
| destroyed-strategy-split | destroyed 对照（锁定两端不统一为假恢复） | 双端 | 1 | web 0 / native 1 | 必须 | web digest / native relative |
| web-unknown-full-host-replacement | unknown→完整宿主替换，无旧资源图 rehydrate | 仅 web | 1 | 1 | 必须 | relative ≤1e-6 |

每端策略（写死进矩阵，receipt 报别的策略即 invalid）：

- web unknown 恢复行 → `c13-auto-recovery-full-host-replacement`；exhaustion → `recovery-exhausted-fatal-fallback-once`；
  destroyed → `destroyed-fatal-webgl-fallback-once`（late loss/dispose 不复活）。
- native unknown 恢复行 → `window-retry-auto-rebuild`；exhaustion → `retry-budget-exhausted-manual-r-preserved`；
  destroyed → `actual-destroyed-auto-rebuild`（已验语义，对照行）。

**逐 cell 证据校验（纯 CPU）**：status/身份（identityBefore≠identityAfter，renderer-id 或 device-epoch）、
lossCallbacks 精确匹配、attempts 区间、presentedAfterRecovery 布尔、`relativeHdrDrift≤1e-6`（digest 行改摘要相等）、
`staleEventsRejected=true`（恢复完成后旧 id lost/error 合成事件被拒，沿既有 probe 负例口径）、exhaustion 行必须
`terminalState`（web=作者 WebGL Canvas 恢复且仅一次；native=失败诊断+手动 R 保留）与 `lateLossDidNotRevive=true`、
web 替换行必须 `fullHostReplacement:{pipelineIdentityChanged:true, staleCacheRehydration:false}`（对 window-recovery
规格点名的 readonly pipelines 留旧 device 风险收口）、editorDomains 逐域 tier（第 4 节）、可选 timing/driverVram 按第 5 节。

**负例（测试锁定，`scripts/lib/j3UnknownLossMatrix.test.mjs`）**：空 receipts 必须 `matrixComplete=false`；
策略不匹配/少报 callback/renderer id 未变/报 present（exhaustion）/漂移超阈/stale 未拒/T1 域漏验/豁免域报 verified/
`actualDriverFault=true`/伪 VRAM（0 或账本字节冒充）/重复 receipt/未知宿主 全部拒绝；构造合法全量 receipts 才放行。

## 3. 方案 B：Native 窗口事件/present 计时口径

**计时结构**：`packages/deep-engine-native/tests/support/j3_window_events.rs`（本切片，纯 CPU 结构，未接线）。
`WindowEventTimeline` 以 probe 起点（resumed、窗口创建前）为 0，记录：

| 事件 | 记录点 | 判定语义 |
|---|---|---|
| WindowCreated | `create_window` 返回后 | renderer 初始 id |
| Presented | `Renderer::render` 返回 `RenderOutcome::Presented` 后 | 真实 surface present 完成；**不是**提交、**不是** HDR 读回时刻 |
| DeviceLostCallback | `app::recovery::handle` 消费 `GpuEvent::DeviceLost` 后 | wgpu 真实回调到达，含 reason 与旧 renderer-id |
| RecoveryCandidateCreated | `recovery_retry::ready(id)` 同步点 | 新候选 renderer id |
| RecoveryPresented | 恢复候选的 Presented | 恢复完成 |
| StaleEventRejected | 旧 id 合成事件被生产过滤拒绝 | 负例入证据 |

**口径纪律**：全部为 host-monotonic 墙钟毫秒（测试侧 `std::time::Instant`，生产接线侧用 `web_time::Instant` 同源）；
**禁止**写成 GPU timestamp——GPU timestamp 通道只在 `timestamp-query` 实测可用时记录，否则
`availability:"unavailable"+原因`（`benchmarkSampleSchema` 纪律）；HDR 读回时刻单独记录，不得冒充 present；
恢复时长 `recoveryDurationMs = RecoveryPresented − DeviceLostCallback` 只报告不设阈值，首跑标定后回填本规格。

**接线点（GPU 线，本切片只留标注）**：`src/app/device_loss_probe_tests.rs` 家族新增
`j3_gate_e_window_events_present` probe，复用既有子进程装配与 `J3_WINDOW_NATIVE_OUTPUT` 证据环境；
support 文件头部注释已写明四个接线点。

## 4. 方案 C：完整编辑器状态 GPU 恢复逐域断言清单（复用 21 域矩阵）

tier 语义：**observable**=GPU 帧或引擎通道可测（hdr-readback / screenshot-diff / engine-channel-readback，必须 verified=true）；
**structural**=宿主结构可查询（React ref / engine 状态 / 证据 JSON 字段，必须 verified=true）；
**exempt**=设计豁免或未裁决（**禁止报 verified=true**；可缺席或带 `{verified:false,note}`）。
GPU runner 不得用截图/读回冒充 structural 域，也不得把 exempt 域写成功。

| # | 域（对齐 j3-e-editor-state-cpu） | web(P1 unknown 恢复) | native(P3 窗口重建) |
|---|---|---|---|
| 1 | camera-pose-mode-avatar | observable | observable（author view） |
| 2 | camera-constraints-navigation | structural | exempt（Native 协议不含） |
| 3 | camera-views-default-views | structural | exempt |
| 4 | model-primitive-pose-author-material | observable | observable（package hash+HDR） |
| 5 | selection-model-layer-annotation | structural | structural |
| 6 | measurements-annotations | structural | exempt |
| 7 | environment-lights-weather-floors-postfx-physics-section-axis | observable（雾/profile 可辨） | observable（package 环境） |
| 8 | animation-policy | structural | exempt |
| 9 | animation-playhead | observable（seek 序列+engine 通道；e1261af7 协议） | exempt（P3 不适用，CPU 矩阵已声明） |
| 10 | undo-stack | structural | exempt |
| 11 | organization-panel-selection | exempt（未恢复，如实） | exempt |
| 12 | panel-tool-ui-state | exempt（设计豁免） | exempt |
| 13 | data-binding-runtime-cache | exempt（transient 重建） | exempt |
| 14 | interaction-scripts-bindings-selectionSets-rootLayerOrder | structural | exempt |
| 15 | publication-metadata-thumbnail-simulationEntities | structural | exempt |
| 16 | dashboard-engineering-analysis | structural | exempt |
| 17 | scene-name-project | structural | structural |
| 18 | deep-display-state | exempt（P1 按作者状态重建；P2 豁免） | exempt |
| 19 | play-mode-active | exempt（Play×Recovery 未裁决） | exempt |
| 20 | behavior-graph-draft | structural | exempt |
| 21 | native-ui-domains | exempt（n/a） | structural（已验范围仅 view/selection/package，其余 Native 线另证） |

destroyed-strategy-split 的 web 腿按 window-recovery 已验口径只验 box 身份/相机数组/WebGL 摘要（digest），不升格为 21 域全验。

## 5. 驱动显存 / 上传 / 帧时：采集口径与统计门

**驱动显存**：复用修复后的 `j3-gpu-process-memory-observation.mjs` 树采样器——样本只接受一次完整读取
（全部活进程 × LUID 实例），否则 `null`+原始错误；`counterIdentity`（`pid_<id>_luid_..._phys_<n>`）必须入证据；
恢复前/后各 ≥1 完整样本，进程树峰值单列。schema 层拒绝三类作弊：伪 0、availability=unavailable 无原因、
把 Web 所有权账本字节（`DeviceResourceMemory`/ledger）写进 driverVram——**账本不是驱动显存**。
泄漏差值阈值不凭空设定：GPU 首跑标定基线后回填本规格，此前只报告差值。

**上传/提交/帧时**：证据用 `benchmarkSampleSchema` 的 `SampleWindow`（channels：upload / cpu-submit /
gpu-timestamp / present / frame-interval），≥5 成对轮、runId 唯一、measured 样本全部有限且 >0、
unavailable 必须带原因。统计门**复用 `compareBenchmarkWindows`**（经 esbuild 从 TS 源动态加载，
`scripts/lib/j2CsmTimingParity.mjs` 同法，不复制实现）：每通道 p95-median 差 + 成对 bootstrap 95% CI。
回归旗标（非裁决）：`delta95IntervalMs` 两端同号且 `|deltaMeanMs|/max(refP95,1e-9) > 0.10` →
`regressionSuspected=true`；性能裁决仍需身份+保真门同过（沿用其 descriptive 纪律）。
墙钟（命令时长、恢复时长）一律不入帧时通道。

## 6. CPU 交付物（本切片）

| 文件 | 内容 |
|---|---|
| `scripts/lib/j3UnknownLossMatrix.mjs` | 矩阵声明+展开+证据校验（含 21 域 tier、负例规则、timing/driverVram 门），对齐 j2DeviceMatrix 模式 |
| `scripts/j3-unknown-loss-runner.mjs` | 入口：默认展开+空证据自检→expansion.json；`--validate <receipts.json>`→validation.json，不完整退出码 1 |
| `scripts/lib/j3UnknownLossMatrix.test.mjs` | node:test 负例全族 + 合法全量放行 |
| `packages/deep-engine-native/tests/support/j3_window_events.rs` | 窗口事件/present 计时结构+纯校验（只写结构与待接线标注） |
| `packages/deep-engine-native/tests/gpu_shader_material_draw.rs` | 仅追加 `#[path = "support/j3_window_events.rs"] mod j3_window_events;` 使 support 进编译 |

## 7. GPU 命令（预登记，主线串行；接线前运行只会得到空证据/未实现，属预期）

```text
# ① Native 窗口事件/present probe（support 接线到 src/app probe 后新增具名测试）
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native j3_gate_e_window_events -- --ignored --nocapture

# ② unknown-loss 双端 receipts 产出后，CPU 证据门（不通过即退出码 1）
node scripts/j3-unknown-loss-runner.mjs --validate test-output/interrupted-0930/unknown-loss/receipts.json

# ③ 驱动显存观测（恢复前/后各一次，证据并入 receipts.driverVram）
node scripts/j3-gpu-process-memory-observation.mjs

# ④ Web unknown 恢复腿：复用 Chrome 两 fresh 装配（GPU 线新增 runner 脚本），receipts 落 ② 的路径
```

前置条件（GPU 线，非本切片）：`web-unknown-full-host-replacement` 需先取 `pbrRenderer` I-C26 专线锁并落实
完整宿主替换（复用候选创建/验证/发布事务，停止旧资源图局部 rehydrate）；Native 侧在
`device_loss_probe_tests.rs` 家族按第 3 节接线。GPU 首跑若证明 web 替换路径存在合法非确定性
（HDR 阈值、timing 噪声底），先回填本规格再放宽，禁止先放宽再跑。

## 8. 本切片验证与诚实声明

```text
node --test scripts/lib/j3UnknownLossMatrix.test.mjs    # 负例全绿
node scripts/j3-unknown-loss-runner.mjs                 # 展开+空证据自检，matrixComplete=false 是事实
cargo check --tests --manifest-path packages/deep-engine-native/Cargo.toml   # 与 I-C23 等锁
```

未做（如实）：未运行任何 GPU/Cargo 测试实例；未接线任何生产恢复代码（`src/**` 属 I-C23 在途不动，
pbrRenderer 属 I-C26 锁）；本切片零 TS 改动，故无相关 tsc 增量；unknown 全部为合成注入，
真实驱动故障不在任何一版的认证范围；播放头在 P3/P4、组织面板选择、Play×Recovery 交叉保持 CPU 矩阵的
未恢复/未裁决结论，GPU 线不得翻案；泄漏预算阈值、恢复时长阈值留待首跑标定回填。
