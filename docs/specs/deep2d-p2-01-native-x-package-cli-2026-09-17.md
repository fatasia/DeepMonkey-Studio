# P2-01：Native 显式 X 包执行入口

正式 `deep-engine-native.exe` 新增 `--headless-x-package <runtime-package-v6.json>`。入口读取并完整校验 runtime package v6，随后只从当前播放器同目录加载固定名称 `deep2d-x-worker.exe`，通过既有零 capability LPAC、Windows Job、封闭 IPC 与 `XContentScheduler` 求值，成功后输出单行 JSON 回执。

## 边界

- 只有显式命令启用 X；普通 `--package` / `--headless-package` 继续拒绝 v6，默认播放器和无参数启动不进入 X。
- 包只能携带冻结 X IR。worker 路径、启用开关、预算、sandbox 和宿主上下文均不从内容读取；缺 worker、非 PE、reparse point、损坏包、hash 不一致或 LPAC 失败均直接拒绝，不降级普通进程。
- 回执包含 package/resource identity、revision、epoch、request/output hash 与完整 typed messages，便于发布服务或门禁机读核验。
- 当前入口是一次性 headless 执行，不消费绘制命令、不做持续 tick，也不把内存中的 LKG 写入跨重启存储。它关闭“正式播放器只能验证 worker、不能执行作者 v6 包”的缺口，不代表完整动态 Dashboard 发布链完成。

## 真实纵向证据

测试复制正式播放器到隔离目录，先验证缺 worker 与伪 PE 均失败，再放入静态 CRT `x_compat_worker.exe`。同一 TypeScript golden `experimental-x-runtime-v6.json` 经产品 CLI → v6 loader → 固定同目录 worker → LPAC → scheduler，返回 `Number(42)`；随后同一包交给普通 `--headless-package` 仍失败。

```powershell
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_x --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_scheduler_cli --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_scheduler_cli --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

结果：v6 包 7 项通过、1 个 child-only fixture 由父测试实际调起；产品 CLI 纵向 1 项通过；clippy 与 fmt 通过。
