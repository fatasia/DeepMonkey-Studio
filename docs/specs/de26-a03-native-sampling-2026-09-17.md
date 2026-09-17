# DE26/A03 Native 同源采样接线（2026-09-17）

## 状态

Native 运行时已输出 `deep-engine.benchmark-sample-window` v1 同形窗口；A03 整卡仍待 Studio/Web 采集入口与跨宿主消费接线，不标记完成。

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

## 后续接线

1. Studio/Web 采集入口消费 Native `benchmark_sample_window`，用现有 TS `validateSampleWindow` fail-closed 校验。
2. 输入宿主提供事件时间戳并绑定实际呈现帧后，才能把 `input-latency` 从 unavailable 升级为 measured。
3. 若平台提供可验证的 compositor present feedback，再单独升级 `present`；`queue.submit` 或 `surface.present` 函数返回耗时不能替代它。
4. A04 只消费 measured 样本；unavailable 不进入中位数、置信区间或通过率分母。
