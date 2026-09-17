# Deep2D X 包多 tick 执行

状态：本切片已实现；P2-01 整卡仍为本轮待办。

## 合同

`XContentScheduler::dispatch_tick` 接受冻结内容和宿主提供的 epoch、时间、随机种子、事件。重绑定前核验模板 SHA-256，仅替换四类宿主输入，再生成本次请求哈希；calls/resources 保持不变。超过 JSON 安全整数范围的输入拒绝。既有预算、取消、过期 epoch、LPAC、IPC 回执与发布校验继续生效，失败 tick 保留上次成功输出。

播放器新增 `--headless-x-package-ticks <v6.json> <count>`，次数限于 1～1024。诊断序列按 16 ms 推进逻辑时间，epoch/seed 每次递增，重复冻结事件；调度 API 可逐 tick 提供新事件。每次真实启动固定 LPAC worker，输出 request/output hash、消息和生产 Painter 摘要。所有 tick 成功后才更新包级 LKG。原单次入口保留原回执字段。

## 验证

- scheduler 6 项：时钟/事件消费、calls/resources 不变、损坏模板拒绝、安全整数边界、过期结果不覆盖 LKG，以及既有取消/预算/哈希门禁。
- 产品 CLI：TypeScript display golden 连续执行 3 次，epoch 9→11，请求哈希变化，静态输出哈希相同，末次 Painter 为 1 个 fill triangle；次数 0 拒绝。
- Native clippy 与 fmt 检查通过。

## 后续

此入口是确定性 headless 序列，不是实时 60 Hz 播放循环。每 tick 启动隔离进程的开销尚未作为实时性能验收；持续 worker 会话、窗口事件输入、GPU layer 合成和呈现、编辑器操作映射、正式发布服务路由仍需独立实现与测量。
