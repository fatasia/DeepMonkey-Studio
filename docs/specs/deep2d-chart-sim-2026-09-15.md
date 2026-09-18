# Chart sim v1：离线固定时钟数据源

Native 图表现在可以从版本化夹具持续读取数据，供离线演示和确定性回放使用。TS 与 Native 共用消息和完整 ChartIR 回放结果。

## 使用

从仓库根目录执行：

```powershell
cargo run --manifest-path packages/deep-engine-native/Cargo.toml -- --chart-sim packages/deep-engine/fixtures/chart-ir-v1.json packages/deep-engine/fixtures/chart-sim-v1.json
```

`--smoke-chart-sim` 在真实 GPU 窗口中验证三次数据提交、呈现与取消后自动退出。该模式使用注入的固定时钟；普通入口使用单调时钟和事件循环定时唤醒。

## 合同与提交

- `deep-engine.chart-sim` / `schemaVersion: 1`：图表与数据集 ID、精确 dimensions、非空 rows、uint32 seed、1–86400000ms interval、JS 安全整数 startTimeMs、1–500000 maxRows。
- 每个 tick 读取一行，索引为 `(seed % 行数 + tick % 行数) % 行数`。时间戳为 `startTimeMs + tick * intervalMs`，与实际唤醒延迟无关。这里是行夹具循环播放；API 的 `sim://telemetry` 程序生成器保持原语义，尚未连接。
- prepare 生成 `ChartDataUpdate v1` 的 append-window 消息，不推进时钟。宿主完成图表/GPU 候选提交后，才确认对应 revision；失败重试同一 tick。
- 帧绑定生产源实例。旧源、伪造帧、重复帧、未提交版本和取消后的帧均拒绝；换包销毁所属 source 和时钟，没有后台回调继续修改新内容。
- 普通宿主每次唤醒至多处理一帧；积压逐帧追赶，间隔至少10ms。失败至少100ms后重试，相同错误只输出一次。无 sim 或已取消时回到事件等待。

构造时校验全部输入行，包括首个窗口会丢弃的行。入口限制16MiB和既有JSON预算。TS冻结发出的消息；Native通过不可变借用读取帧。

## 验证

- TS sim20项、消息19项；Native sim9项、消息5项、数据更新7项通过。包含延迟唤醒、不丢样本、失败候选、源替换、取消、重复提交、预算与时钟耗尽。
- `generateChartSimGolden.mjs` 执行真实TS生产器与数据协调器，生成 `chart-sim-replay-v1.json`；Native逐帧比较消息、时间戳、dataRevision和完整ChartIR。
- RTX4060 Laptop / Vulkan：64×64窗口实际完成初始帧及3次sim数据帧，GPU scopes/callbacks clean。普通 `--smoke-chart` 的消息入口、缩放、选择、tooltip也通过。

## 剩余工作

尚无包内动态 ChartIR/sim 入口、HTTP连接状态机、全局Epoch、列块共享和逐系列GPU增量。普通入口定时调度已接线，其正常尺寸窗口与故障恢复长流程待验证。GPU拒绝的sim游标回退目前有CPU候选测试，尚未注入真实设备故障。

可见数据更新仍复制 ChartIR，后续已加入[按系列几何与命中索引复用](deep2d-chart-series-incremental-2026-09-15.md)。本片不提供帧率、总显存或吞吐量提升结论。64×64程序探针不代表完整视觉验收或可信正式发布证据。
