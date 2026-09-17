# Deep2D P2-01 单次子进程与 IPC

日期：2026-09-17。状态：封闭 X ABI 的真实子进程切片通过；P2-01 整体仍待 Windows 进程树资源治理与产品接线。

后续进展：Windows 进程树、资源限额与继承管道回收已由 [Job Object 切片](deep2d-p2-01-windows-job-2026-09-17.md) 补齐；本报告下方限制保留初次切片状态，文件/网络权限与产品接线仍未完成。

## 实现

- `compat_x/process.rs`：可信宿主指定 worker，一次 JSON 请求与回执，双向各 4 MiB 上限；清空继承环境、标准错误关闭，Windows 隐藏窗口。协议版本与既有 X schema v1 一致。
- 请求继续是封闭 `XCall`，子进程复用现有求值与预算检查，不执行 JavaScript。主进程复核 request/output hash、epoch、起始时间和消息预算，返回候选后仍须调用 `publish`。
- 子进程 stdin/stdout 并发处理；轮询同时检查退出、回执、取消、epoch 与单调时钟。异常退出、损坏回执、超限、取消、超时均无候选，宿主保留上次成功发布的消息与 hash。
- `examples/x_compat_worker.rs` 是真实 worker 入口；尚未加入正式安装包或原生播放器启动调度。未新增依赖。

## 实测

在 Windows 本机离线构建与运行：

```powershell
cargo build --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_process --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib compat_x --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --lib --test compat_x_process --example x_compat_worker --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml -- --check
```

集成 **7 通过**；5 个 ignored 项是被测试父进程按名称单独启动的故障注入入口，不是遗漏的验证。库聚焦 **8 通过**；clippy 与格式检查通过。

真实子进程双跑复现已冻结 request hash `3949234e2c2c9f208af935a277dff1bd2f0dd4de504c147d5368ba1b0d480853` 和 output hash `05dde4e6e1f84655ff6662dde75e43b04059cebea550d00aa95d16c06db31437`。覆盖正常发布、N0/关闭/预取消不启动、未知 schema、消息预算、请求尺寸与调用深度、异常退出、损坏回执、在途取消与 epoch 变化、发布前 CAS、实际超时。库测试另覆盖 trailing JSON、未知 envelope 字段、错误版本、负零及回执 hash/epoch 篡改。

审查发现退出成功后等待管道 EOF 可能越过 deadline：worker 衍生子进程继承 stdout 后退出即可触发。已改为非阻塞回执轮询与不阻塞的线程收尾；真实测试让衍生进程持有管道 800 ms，宿主以 100 ms deadline 返回超时。

## 尚未完成

- 当前是可信封闭 worker 的故障隔离，不是 Windows OS 权限沙箱。尚无 restricted token、Job Object 进程树终止、OS 内存/CPU 资源上限与文件/网络能力限制。
- 非可信 worker 若派生进程继承管道，主调用按 deadline 返回，但衍生进程和阻塞 I/O 线程可能存活到管道关闭。当前只回收直接子进程，不声明总资源强隔离；开放真实脚本前必须补齐该项。
- `Command` 只能由可信宿主指向随包交付 worker，不能来自脚本或用户数据；example 尚未接正式产品调度、安装包和更新回滚。
- 本片无 GPU/视觉变更，不证明 ECharts/Painter、Windows IME 或完整 P2 认证完成；不据此推算渲染性能。
