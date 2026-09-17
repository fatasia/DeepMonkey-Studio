# P2-01：冻结 X 内容的 runtime package v6

v6 将单一封闭 X 资源纳入现有包 hash、资源索引和唯一引用校验，提供显式加载入口。普通 v1–v5 加载和渲染行为不变，X 调度仍默认关闭。

## 合同

- `schemaVersion: 6`，新增 `entrypoints.experimentalX` 非空资源 ID，资源 kind 为 `experimental-x`。v1–v5 禁止该字段（含 null）和资源种类。
- v6 基于 v2 静态入口形状，保留 renderPacket/environment、可选静态 deep2d、shaderPackages/materialBindings（允许空 bindings）；不继承 v3–v5 的扩展。camera/chart/chartSim/dashboard 字段即使为 null 也拒绝，对应 resource kind 即使未被引用也明确拒绝。本片不改变 v5 Dashboard 资源归属规则。
- X payload 为 `deep-engine.experimental-x-resource` v1，包含 id/revision 和已有 `XDynamicContent`。索引 hash 绑定整个 payload，冻结 hash 绑定 XRequest，顶层 hash 绑定整个包。
- `freeze_x_resource` 在作者冻结阶段校验封闭 IR、默认预算、资源引用和有限数，返回 typed index 与 JSON payload。它不启动进程、不接收源代码、路径、开关或自定预算；不会作为运行时失败后的求值回退。
- epoch、逻辑时间和随机种子限制在 JSON safe integer 范围，防止现有 binary64 canonical 域丢失整数精度。固定夹具请求 hash 为 `5c15e6f3d0475b2bdb9952ae31d7d9d9d41f148cd5e6d26656842cb996d3cf3b`，已用独立 Node 实现复核。

`parse_and_validate_x_runtime_package` 返回静态 base、X resource id/revision 和冻结内容；它只加载，不启用 X。旧 `parse_and_validate_runtime_package` 明确拒绝 v6，不能忽略动态资源并报告正常加载。调用方必须显式提供 `XContentScheduler` 配置，才能经包内固定 worker 和 LPAC 执行；失败保留旧结果。

## 证据

`tests/runtime_package_x.rs` 从已提交 v1 静态夹具和固定 XRequest 生成确定性的 v6 包，不复制大份静态资源。

- 6 项测试通过，另 1 个 child-only fixture 由真实纵向测试调起：冻结/索引/三层 hash；外层重算 hash 后内部内容或身份漂移拒绝；版本/缺失/错 kind/悬空引用拒绝；不精确整数和 NaN 拒绝；v3–v5 四类入口的 null/非空及未引用资源拒绝矩阵；作者冻结→v6 加载→默认关闭→真实 LPAC 成功→旧 epoch 拒绝并保留旧值。
- 旧 runtime package 10 组回归：52 通过、1 个既有真实 GPU surface 测试忽略。覆盖 bindings、camera、CLI、contract、dashboard、diff、JSON、LKG、IBL 和 startup recovery。
- compat_x 单测 15 通过；clippy `-D warnings` 和 fmt 通过。

```powershell
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_x --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib compat_x --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_contract --test runtime_package_bindings --test runtime_package_camera --test runtime_package_dashboard --test runtime_package_diff --test runtime_package_json --test runtime_package_prefiltered_ibl --test runtime_package_cli --test runtime_package_startup_recovery --test runtime_package_lkg_cli --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --lib --bin deep-engine-native --test runtime_package_x --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

## 本轮待办

作者 Web/TypeScript 编译器尚未调用 Rust 冻结 API；v6 尚未接普通 player 命令、UI 或绘制消费。当前提供的是可执行的独立版本 loader 与 LPAC 纵向链，不是全量动态 Dashboard 发布能力。冻结请求绑定作者快照 epoch/逻辑时刻，没有隐式重写 epoch 或持续 tick 重绑定。

默认关闭、N0 不进入 X、固定 worker、LPAC 权限矩阵与 last-known-good 边界沿用前两片。资源与包 hash 是完整性合同，不替代可信发行源或 worker 文件签名。无新增依赖，无共享总账/UI 修改。
