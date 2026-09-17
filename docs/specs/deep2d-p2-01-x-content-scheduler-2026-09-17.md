# P2-01：X 动态内容调度门禁

本片为 Windows 原生宿主增加默认关闭的 `XContentScheduler`，并将包内 `--verify-x-worker` 接到该调度链。它只处理现有封闭 `XCall`，不是 JavaScript 引擎。

## 合同与发布

- 内容为 `XDynamicContent { schemaVersion, lane, request, contentHash }`，复用 `XRequest` 与 `RuntimeContentHash`；拒绝未知字段，嵌套 request/resource/event/call 同样拒绝未知字段。内容不能配置路径、脚本、开关或预算。
- 配置复用 `XProcessConfig`，默认 `enabled=false`；只有可信宿主显式开启。内容 lane 或宿主 lane 为 N0 都拒绝。
- 校验内容与请求 schema、当前 epoch/取消/时间、调用深度/数量、4 MiB 编码上限和请求 canonical SHA-256，再启动固定 worker。内容 hash 绑定 request，不提供来源认证；固定 lane/schema 单独校验。
- 只解析当前 EXE 同目录 `deep2d-x-worker.exe`，拒绝非普通文件和 reparse point，无任意路径参数、PATH 查找或普通进程回退。沿用 LPAC 的 Job、零 capability、IPC 请求/输出 hash 和求值预算。
- LPAC 返回候选后再执行宿主 `publish` 校验。仅成功后替换 `last_known_good`；任何错误都保留先前 epoch、消息和 hash。返回错误与保留旧结果是两个明确状态。

调度是同步单实例 `&mut self` 边界，无并发发布；运行期间的 epoch 与取消由可信宿主 context 提供。测试专用执行器只在私有调度函数内注入，生产公开入口固定走 LPAC。

## 可运行入口

```powershell
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_scheduler_cli --offline
```

集成测试创建独占临时包，复制真实 player 与固定静态 CRT worker；执行 `--verify-x-worker`，验证缺文件、非 PE、成功及额外路径参数拒绝。成功输出保留既有 portable smoke 格式。正常 portable 发布仍使用既有 worker 打包流程。

## 门禁

- 调度单测 5 项：默认关闭/N0/schema/hash 预拒绝；失败和最终 epoch 变化保留旧值；未知路径/脚本/开关/预算字段拒绝；取消和消息预算保留旧值；超大/深层输入在启动前拒绝。
- compat_x 单测合计 15 项通过。
- 真实 CLI 集成 1 项通过；真实 IPC 7 项通过，5 个 child-only fixture 由父测试调起。
- 既有 LPAC 4 项、Windows Job 4 项通过（5 个 child-only fixture 忽略）；clippy `-D warnings` 与 fmt 通过。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib compat_x --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_scheduler_cli --test compat_x_process --test compat_x_lpac --test compat_x_windows_job --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --lib --bin deep-engine-native --test compat_x_scheduler_cli --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

LPAC 负向 probe 复跑前也需按上一片报告构建静态 CRT 的 `x_lpac_probe`。

## 本轮待办

现有 runtime package 的严格资源枚举尚无 X 动态资源类型，因此本片没有改 manifest 版本或让静态资源自动进入 X。作者内容→冻结 XRequest 的编译、manifest 内容索引接线、消息到绘制层消费、跨重启旧结果恢复仍待实现。本片的产品接线止于真实包内验证命令，不是完整编辑器动态内容发布链。

包目录由可信部署管理；运行时未新增 worker 签名/哈希 pin 或防同权限本机攻击者替换文件的原子打开机制。旧版低层 process API 仍供已有测试使用，产品调度器不调用其普通进程入口。LPAC 网络、对象与文件权限的未覆盖矩阵沿用上一片报告，不扩大能力声明。

工程约束：新增调度和测试按职责独立；复用已有有界编码器，编码失败不会先分配无限 JSON 缓冲。未增加依赖、未改 UI、N0、共享总账和许可证文件。
