# Deep2D X 持续 worker 会话

状态：持续进程与 headless 产品链切片已完成；P2-01 整卡仍为本轮待办。

## 实现

播放器的多 tick 调度复用同一个零 capability LPAC worker。`XSF1` 协议使用 4 字节小端长度前缀，每帧最多 4 MiB、每会话最多 1024 次请求；旧单次 JSON 协议保留。reader/writer 各自使用容量为 1 的通道，一次仅一个在途请求。帧头超限在分配消息体前拒绝。

`Session` 复用既有 LPAC token 核验、Job 资源限额与回收实现。每 tick 独立核对宿主取消/epoch、实际 wall-clock、请求与回执哈希、输出预算；Job CPU 限额按整个会话累计，不随 tick 清零。取消、超时、退出、错误回执、worker 拒绝和会话次数耗尽均关闭会话，禁止继续使用。显式 close 在终止进程树后回收两条管道线程与 profile，成功路径也检查清理结果。

`XContentScheduler` 在首次有效 tick 才启动固定包内 worker，后续复用；失败不覆盖已发布输出。产品回执包含实际 worker PID，用于确认复用。所有 tick 与会话清理成功后才提升包级 LKG。整段诊断回执另限制为 4 MiB，防止每帧有界而总量随 1024 次累积失控。无新依赖，故障 worker 仅为测试 example，不进入 portable 包。

## 真实验证

- compat_x 库：19 项通过，包括帧截断、空帧、超大长度与既有内容/预算/哈希边界。
- 持续 LPAC：5 项通过。8 次请求与本地求值逐个相同、PID 一致且进程存活；取消、实际超时、拒绝、强制崩溃、坏回执、超大帧头之后检查真实进程句柄已退出及临时 profile 目录已清理；第 1025 次明确拒绝。关闭幂等，关闭后请求拒绝。
- 原 LPAC 4、原 IPC 7、Windows Job 4、v6 包 7、产品 CLI 1 项通过。11 个 child-only fixture 由父测试实际调用；性能测试默认 ignore，已单独执行。
- 产品 CLI 连续 3 tick 的 PID 一致，request hash 变化、静态输出 hash 保持，末次生产 Painter 为 1 fill triangle。回执聚合预算另有 1 项测试。
- clippy `-D warnings`、fmt 与 repository gate 通过。

构建和测试入口：

```powershell
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_session_fault_worker --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_lpac_session --test compat_x_scheduler_cli --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_lpac_session measure_same_requests --offline -- --ignored --nocapture
```

## 本机性能证据

同一组 16 个请求逐个核对完整 candidate；debug 宿主与 static CRT worker。单次进程路径总计 2308.7599 ms；持续会话含启动/清理 129.5648 ms，其中创建会话 38.4896 ms，首 tick 53.68 ms，其余 tick 1.3834～1.7524 ms。约 17.8 倍是本机这组轻量请求的进程开销改善，不能推算 GPU 帧率、复杂图表或其他机器性能。可复跑测试输出全部原始 tick 时间。

## 剩余

持续 worker 不等于实时窗口已接入：GPU layer 合成、真实输入与呈现、编辑器操作映射、正式发布服务、完整权限矩阵继续待办。累计 CPU 或次数预算耗尽时需由宿主显式重建会话；本片未实现无界长期运行或任意 JavaScript。

工程自评：理解/方案/复用/实现/边界/错误处理/验证/性能/维护/汇报均 9/10；真实窗口与 GPU 证据不属于本片完成声明。
