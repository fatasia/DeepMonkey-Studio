# DE26/A03 Native 同源采样接线（2026-09-17）

## 状态

Native 已复用 `deep-engine.benchmark-sample-window` v1；Web recorder 与原始 GPU 样本读取已完成。
Studio 通过现有 `PresentationPerformanceSource` 的消费接线已在共享工作树验证，但该宿主文件组尚未跟踪，
必须随其归属提交，不由本切片吸收外来文件。A03 整卡保持本轮待办。

## 输出位置与边界

- `deep-engine.native-telemetry` v1 报告新增 `benchmark_sample_window`。
- 窗口边界统一为 telemetry reset 后的 `host-monotonic` 时间：`windowStartMs = 0`，`windowEndMs = elapsed`。
- 通道 `clockId` 表示样本耗时来源，不改变窗口边界的宿主时钟：CPU 与帧间隔为 `host-monotonic`，GPU 为 `gpu-timestamp`。
- `reset_telemetry` 同时切换 run id、窗口原点、CPU/GPU 环与上一成功呈现时间，旧窗口样本不能进入新窗口。

## 通道口径

| 通道 | Native 状态 | 采样口径或不可用原因 |
|---|---|---|
| `authoring-bridge` | unavailable | Native runtime 没有 authoring bridge 边界 |
| `scene-update` | unavailable | 当前资源准备段混合 culling/LOD encode，未冒充独立 scene update |
| `upload` | unavailable | 当前未建立独立 upload 时间边界 |
| `cpu-submit` | measured / unavailable | `encoder.finish + queue.submit` 的真实 host-monotonic 耗时；空窗口显式不可用 |
| `gpu-timestamp` | measured / unavailable | GPU frame query 的原始毫秒样本；feature 缺失、readback 失败或空结果保留明确原因 |
| `present` | unavailable | `wgpu` surface present 不提供 compositor completion timestamp |
| `frame-interval` | measured / unavailable | 相邻成功呈现帧完成点的 host-monotonic 间隔；少于两帧显式不可用 |
| `input-latency` | unavailable | 输入事件时间戳尚未连接 FrameTelemetry |

所有 unavailable 通道固定 `samplesMs: []`、`sampleCount: 0`、非空 `unavailableReason`；不会以 0 冒充观测。measured 通道的 `sampleCount` 由原始样本数组长度直接生成。

## Studio/Web 消费与反馈边界

- `StudioDeepPerformance` 从真实 `FrameMetrics.cpuSubmitMs` 保存 CPU 原始样本；`EnginePerformanceTelemetry.samples("gpu-frame")` 按帧序读取 GPU timestamp 原始值，不从 P50/P95 反推样本。
- 同一现有展示性能源通过 `getPresentationBenchmarkSampleWindow(owner, runId)` 输出固定八通道窗口。诊断、后续 A04 与当前 Viewer 共享该源，不新增采样 runtime 或第二条渲染时钟。
- 活跃 Deep 展示期间，捕获浏览器输入事件的 `performance.now()`；下一次已提交 Deep 帧的 `requestAnimationFrame` 反馈生成 input-latency、submit→feedback 与相邻 feedback interval 原始样本。多次 GPU submit 在同一反馈周期只生成一个 `present` 样本。
- `present` 的 Web 口径是浏览器 presentation callback feedback，不冒充 OS compositor scan-out completion。Native `wgpu` 没有该反馈，继续明确 unavailable。
- 失焦、不可见、按需渲染暂停与 reset 会切断待处理输入、提交和帧间隔；GPU timestamp 不支持、没有反馈或没有输入时均输出 unavailable，不写零值。

上述 Studio 三处精确接线为：`StudioDeepPerformance` 创建一个 recorder，在可见 Deep frame 提交时调用
`recordSubmission`、唯一 rAF 回调调用 `recordPresentationFeedback`、窗口输入 capture 调用 `recordInput`；
`PresentationPerformanceSource` 只增加可选 `sampleWindow(runId)`，绑定层增加读取 helper。接线不改 UI、
不新增 runtime；当前共享树 focused 11 项及双包 typecheck 已通过。

## 验证证据

```text
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native telemetry::
  5 passed
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native telemetry_gpu::
  2 passed
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --lib
  288 passed; 0 failed; 1 ignored
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml -- --check
  passed
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --locked --all-targets -- -D warnings
  passed
```

测试覆盖 TS v1 字段形状、固定八通道、无伪零、GPU/CPU/帧间隔 measured 分支、GPU 动态 readback 原因透传，以及同一时钟 tick 内失败报告的严格正窗口。

```text
pnpm --filter @bim-studio/web exec vitest run \
  src/viewer/StudioDeepSampleWindow.test.ts src/viewer/StudioDeepPerformance.test.ts
  2 files, 11 passed
pnpm --filter @bim-studio/web typecheck
  passed
pnpm --filter @bim-studio/deep-engine typecheck
  passed
pnpm --filter @bim-studio/deep-engine test
  373 files, 3042 passed, 41 skipped; runtime purity passed
  final source-size gate remains red on 14 pre-existing oversized files
```

## 后续接线

1. 若浏览器或平台提供可验证的 compositor completion feedback，可新增更强的 present 证据口径；当前 callback feedback 不扩大为 scan-out。
2. A04 只消费 measured 样本；unavailable 不进入中位数、置信区间或通过率分母。
