# H-C6-S1 多模块热插交互合同（2026-10-03，主线程）

## 行剩余与本刀范围

H-C6-S1 行剩余两项：Monaco 常态自动化验收（需浏览器，与在跑三路冲突，留后续）/ **多模块热插**（本刀）。

## 现状核查

- Manager 已按 entryId 多宿主并存（`hosts: Map<entryId, {module, host, sceneId}>`），`hotSwap(entryId, module)` 直通对应 Host.updateModule——**产品机制已存在，本刀=交互合同钉死**（同 10-02 快照×热插件模式，无产品源改动）。
- 关键机制事实（写测试时实证）：①`behavior.result` 协议 `commands` 必填（protocol.ts:162），缺失会在账本循环 `for...of value.commands` 处炸；②Host.dispose 两段式（发 dispose 消息→回执或 executionBudget 超时→finishDispose→terminate）；③scheduler tick 为 floor 累计语义（16ms@60hz 两次 advance 仅 1 tick），invoke 连续性计数属 scheduler 域（既有 Manager 测试覆盖），不属本合同面。

## 交付

`apps/web/src/behavior/SceneBehaviorManager.hotSwapMulti.test.ts` 4 用例：

1. 同场景双模块：热插 A 全程 B 的 worker 结构零变化（initialize 计数不变、零 dispose）、B 状态保持 running、热插后 B 仍推进。
2. 热插 A 初始化超时回滚（hostOptions.initializationTimeoutMs+fake timers）：B 全程无波及，A 回滚恢复旧模块 running。
3. Manager 暂停态热插：ready 后保持 paused 不发新 onStart，其余宿主同 paused，resume 恢复。
4. 跨场景 reconcile 拆除旧宿主（dispose 两段式推进超时后 terminate 恰一次），新场景热插按 entryId 精确命中，已拆宿主零二次消息。

夹具：FakeWorker 按协议自动回执 invoke（微任务时序，同步回执会在调度器 tick 内重入），回执带必填 commands/events。

## 验证

- 本文件 4/4；behavior 域 26 文件 118/118 零回归；apps/web tsc 0（并行线两文件既有登记除外）。

## 结论与边界

- **无产品缺陷**：多宿主热插隔离、回滚边界、暂停/跨场景语义全部按合同工作，本刀纯合同钉死。
- H-C6-S1 行剩余仅 Monaco 常态自动化（浏览器窗口空出后做）。
