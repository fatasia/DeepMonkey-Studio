# X 包文件热同步

日期：2026-09-17。状态：显式 X 文件热同步切片已完成；P2/P3 整卡仍待验收。

## 入口与边界

`deep-engine-native --x-package-live <runtime-package-v6.json>` 打开显式 X 窗口并以既有 500 ms 文件监听更新；普通 `--package-live` 继续拒绝 X。live 模式固定命令行源，不接受拖放换源；`--x-package` 原拖放行为保留。

候选使用同一份受限读取字节完成身份/哈希/资源修订检查和 LPAC 求值；相同哈希跳过求值，跨 packageId、普通包、坏 JSON 拒绝。热更新不读取恢复缓存替代坏候选。启动恢复与首次呈现后检查点保持原合同。

复用现有 generation mailbox、资源差异、GPU stage/publish 和 WatchThread 取消回收。仅 X/Deep2D 条目变化复用 renderer，更新 Deep2D 层；其他资源变化沿用原发布分支。后台解析/求值不持有发布锁，UI 应用时基于当前快照重算差异，避免使用过时 diff。X tick 在新内容呈现后换会话，旧模板 receipt 不接受。

## 实证

- bin：117 passed / 39 ignored；clippy `-D warnings`、build、fmt 通过。
- 显式执行 `app::x_drop_tests -- --ignored --nocapture`：两项 GPU 测试通过。RTX 4060/Vulkan、960×540 同窗两次文件改写，renderer ID 不变，两次检查点均在呈现后写入；合成固定几何的 vertex-buffer hits 从 1 增到 2。
- 普通加载器拒绝 X，X decoder 拒绝普通包/坏 JSON，身份变化拒绝、同哈希 noop 均通过；后两项在启动 worker 前完成。
- `bun scripts/verify-zrender-x-native.mts`：实际 ECharts 三柱初帧、单柱更新、删柱三包的 headless receipt 与作者 display list 完全相同，GPU 6/6/4 三角；同窗拖放和文件热同步两种路径均通过。
- repository gate 与本片 diff-check 通过。

此处的坏包验证包含 decoder 负向测试和拖放拒绝；尚未覆盖 X 文件监听“坏文件→有效文件”的定时窗口故障注入。自动监听沿用 metadata 修改时间/大小检测，不保证检测到同时保持二者不变的外部改写。完整浏览器/窗口视觉、任意 JS 适配器、远程同步与冲突处理未由本片证明。
