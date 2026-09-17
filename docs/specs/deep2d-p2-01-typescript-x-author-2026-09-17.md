# P2-01：TypeScript 作者冻结 X 内容

新增显式作者 API，将封闭 XRequest 编译成 runtime package v6；复用现有静态包 builder、JSON 快照、canonical hash、索引排序和序列化。普通场景编译与 player 不启用 X。

## 入口

- `freezeExperimentalXResource`：严格检查现有 X schema、safe integer、资源/事件引用、有限数、深度/CPU/内存/消息/IPC 预算，生成请求 hash、payload 和 typed index。只做编译检查，不计算时钟/随机值、不执行消息，也没有 TS 求值运行时。
- `buildExperimentalXRuntimePackage`：复用 `buildDeepRuntimePackage` 生成静态部分，加入唯一 experimentalX 资源和完整包 hash。v6 类型独立，不扩展普通 `DeepRuntimePackage` union/parser。
- Web `compileExperimentalXRuntimePackage`：返回包、序列化 JSON 和 recipe/resource/package hash 证据，激活状态固定 `disabled-by-default`。这是显式编译 API，没有 UI、普通场景编译或发布路由自动接线。

入口不接受 camera/chart/chartSim/dashboard、workerPath、脚本文本、enabled 或 budget。顶层与 X wrapper 拒绝 getter/hidden/symbol 字段，请求使用现有无访问器 JSON 快照。注入资源身份与 Native 相同：1–128 位 ASCII 字母数字及 `._:-`，不能使用路径分隔符；包资源 ID 继续使用现有 package 规则。

## 跨语言证据

`packages/deep-engine/fixtures/experimental-x-runtime-v6.json` 为 TS builder 实际输出，空静态场景与 `EmitNumber(42)` 封闭请求。TS 测试逐字节比较 golden；Rust v6 loader 验证其完整包/索引/请求 hash，真实 LPAC 子进程消费同一包并发布 `Number(42)`，后续旧 epoch 请求拒绝且保留旧结果。

请求 SHA-256：`5c15e6f3d0475b2bdb9952ae31d7d9d9d41f148cd5e6d26656842cb996d3cf3b`，与先前 Rust 固定证据一致。未增加任何运行依赖或第三方包。

## 验证

- TypeScript runtimePackage：25 文件 / 312 测试通过；新增作者测试 4 项涵盖确定性、hash、普通 parser 拒绝、mutation 快照、禁用字段、全部封闭调用形状与引用、非有限值、不精确整数、cycle、消息上限及 accessor 零执行。
- Web 显式编译入口：1 项通过；Web `tsc --noEmit` 通过。
- Rust v6：7 项通过，1 个 child-only fixture 由真实 LPAC 测试运行。
- deep-engine build、typecheck（含 lab）、Native clippy `-D warnings`、fmt 通过。

```powershell
pnpm --filter @bim-studio/deep-engine run build
pnpm --filter @bim-studio/deep-engine run typecheck
pnpm --filter @bim-studio/deep-engine exec vitest run src/runtimePackage
pnpm --filter @bim-studio/web exec vitest run src/delivery/compileExperimentalXRuntimePackage.test.ts
pnpm --filter @bim-studio/web exec tsc --noEmit
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_x --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_x --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

## 剩余

可视编辑器到封闭 IR 的操作映射、正式发布路由、X 输出绘制消费和持续 tick 重绑定未接线。v6 保持独立实验入口，不支持把 v5 Dashboard 或 v3 camera 混合进来。无普通进程降级；worker 信任、LPAC 权限矩阵和跨重启旧结果边界沿用前序报告。
