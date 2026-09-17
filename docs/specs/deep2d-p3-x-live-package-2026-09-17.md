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

## 文件故障与首轮监听补验

同一真实窗口、同一个被监听文件依次执行：有效 frame 2 → 坏 JSON → 普通包 → 有效 frame 3。
测试记录实际 decoder 的拒绝回执，不用固定等待时长推断拒绝；每次拒绝后核验活动显示、renderer ID、磁盘 X LKG 包哈希不变。最后恢复有效 X 包并成功呈现、更新检查点。合成显示与真实 ECharts 三包都通过该路径。

同族排查修复 RuntimePackage/RenderPacket 首轮监听：不再将线程启动时的 metadata 当成已读取内容，防止初始加载与线程启动间的改写漏检；源暂时缺失也不再终止监听。首次轮询做内容校验，随后仍按 metadata 跳过未变文件。两项回归覆盖首次内容差异、缺失、恢复、相同内容与未变 metadata。

补验结果：bin 119 passed / 39 ignored，clippy/build/fmt 通过；`verify-zrender-x-native.mts` 同时断言两个 GPU 同窗测试及坏写恢复见证，repository gate 通过。自动监听仍不保证检测到同时保持修改时间与大小不变的外部改写。完整浏览器/窗口视觉、任意 JS 适配器、远程同步与冲突处理未由本片证明。
