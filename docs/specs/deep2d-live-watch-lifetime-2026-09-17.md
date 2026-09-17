# Native 热同步监听线程生命周期

日期：2026-09-17。状态：本片已完成，X 自动热同步仍待接入。

RenderPacket 与 RuntimePackage 原监听线程在文件不变时持续轮询，窗口 transport 不持有回收句柄。现在共用 `WatchThread`：transport 持有取消端与 JoinHandle，销毁时断开通道，立即唤醒轮询等待并 join；事件循环退出后也显式释放两种 transport。

读取、解析完成后检查取消，丢弃已取消的候选。容量受限读取、候选校验、最后正确帧、generation 和 GPU 发布路径不变。取消不强行中断文件系统读取或解析，join 需等待当前操作返回；不承诺慢磁盘读取的硬实时退出上限。

## 验证

- `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --offline --bin deep-engine-native app:: -- --nocapture`：32 passed，5 ignored。新增三项覆盖长轮询唤醒、读中取消不发布、已结束线程回收。
- 同目标 build、clippy `-D warnings`、fmt 通过。
- RTX 4060 / Vulkan 实跑 `--smoke-packet-live`：generation 1，scene 1→2，两次呈现，GPU scopes 无错误，正常退出。
- 同机实跑 `--smoke-package-live packages/deep-engine-native/tests/fixtures/runtime-package-v1.json`：坏 JSON 保留 scene 1，随后有效包更新到 scene 2，两次呈现，GPU scopes 无错误，正常退出。smoke 修改临时副本。
- `pnpm gate:repository` 通过。

本片无视觉样式变化，不将 GPU smoke 计为完整视觉验收。后续 X 包自动监听复用该生命周期。
