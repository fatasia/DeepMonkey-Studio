# P2-01：X runtime package 跨重启 LKG

`--headless-x-package` 现在按源路径维护内容寻址检查点。只有 v6 包完成校验、固定 worker 的 LPAC 求值以及 scheduler 原子发布后，才写入快照与 active index；解析、worker、LPAC 或发布任一步失败都不提升 LKG。

## 设计

- 复用现有 source-scoped `runtime_lkg::Store`、锁、原子 rename、容量预算和旧版本回收，不新增第二套文件事务。
- store 增加普通包与 experimental X 两种显式校验档位。普通快照必须通过普通 parser，X 快照必须通过 v6 X parser；同一文件不能跨档位提交或恢复。
- 源文件损坏或缺失时，新进程只从同一规范化源路径的 active index 恢复，重新做整包/index/payload/request hash 与 X schema 校验，再重新通过 LPAC 求值。恢复失败不继续运行。
- cache 不可写不会撤销已经成功发布的 typed messages；stderr 给出可操作诊断，回执的 `active` 与 `primaryRejection` 说明当前使用 primary 还是 last-known-good。

## 证据

产品纵向测试在隔离 `LOCALAPPDATA` 中复制正式播放器、静态 worker 与 TypeScript v6 golden：第一次执行得到 `Number(42)` 并提交检查点；破坏源文件后启动新进程，恢复相同 typed messages 且 `active=last-known-good`。同一测试继续证明普通 loader 拒绝原始 v6 包。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native runtime_lkg --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_scheduler_cli --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test runtime_package_lkg_cli --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native --test compat_x_scheduler_cli --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

结果：LKG 单元 6 项、X 产品纵向 1 项、普通 LKG CLI 1 项通过（另 1 项需真实 GPU surface，保持 ignore）；clippy 与 fmt 通过。持续 tick、X typed message 到 Deep2D 绘制批次、正式发布服务路由仍待办。
