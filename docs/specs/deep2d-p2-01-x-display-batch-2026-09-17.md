# P2-01：X typed display batch → Deep2D painter

X 封闭 ABI 新增 `emit-display-list`。一次 epoch 最多发布一个完整、自包含的 `Deep2dDisplayList` layer；IPC 仍是一条批量消息，不允许逐 draw call 穿越进程边界，也不允许 X 直接持有 GPU、窗口或 N0 可变状态。

## 合同与原子性

- TypeScript 作者冻结先执行现有 `validateDeep2dDisplayList`，随后把完整 layer 纳入 request/resource/package 三层 hash 与既有 CPU/内存/消息/IPC 预算。
- Native worker 在求值前后再次校验同一 display-list 合同；receipt 验证和 scheduler 提升 LKG 前再做防御性校验。坏资源引用、非有限数、超预算或同一 epoch 多个 display list 均不产生候选、不替换 LKG。
- 产品 `--headless-x-package` 从已发布 typed message 取出 layer，送入生产 `prepare_display_list`。回执记录 commands、segments、fill/stroke triangles 与 vertices，证明消费的是实际 Deep2D painter 数据，不是只把 JSON 原样打印。
- layer 自包含，不能引用 N0/base scene 的资源 ID；后续 GPU 合成只需把它作为隔离层命名空间化，避免 X 与 N0 共享可变资源表。

## 跨语言纵向证据

`experimental-x-display-runtime-v6.json` 是 TypeScript builder 的逐字节 golden：320×180、单三角 path、单批次输出。正式播放器加载该包，经固定同目录静态 worker、LPAC、IPC、scheduler 后，Native painter 产出 1 command / 1 fill triangle。普通 v6 golden 的 `Number(42)`、跨重启 LKG 与默认 loader 拒绝仍保持。

```powershell
pnpm --filter @bim-studio/deep-engine exec vitest run src/runtimePackage
pnpm --filter @bim-studio/deep-engine run typecheck
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib compat_x --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_x --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_scheduler_cli --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --lib --bin deep-engine-native --test compat_x_scheduler_cli --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

结果：TypeScript runtime package 26 文件 / 314 项、Native compat_x 16 项、v6 package 7 项（另 1 child-only 实际调起）、产品 CLI 纵向 1 项通过；typecheck、clippy、fmt 通过。真实 GPU layer 合成、持续 tick、编辑器操作映射和正式发布服务路由仍待办。
