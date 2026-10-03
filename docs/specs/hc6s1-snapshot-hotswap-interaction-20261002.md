# H-C6-S1 快照恢复×热插交互验证（2026-10-02，主线程）

## 现状核查（六步）

1. 热插链（此前批已验）：`SceneBehaviorHost.updateModule` 旧 onStop → 新 initialize → ready 恢复，失败自动回滚，`reloadRollbackAttempts` 防循环；UI 四层接线+连续热插误报修复已交付。
2. 快照恢复消费点：`scenePersistenceController.applyScene` 不直接触行为宿主；行为经 `SceneBehaviorManager.reconcile(modules, sceneFor)` 以"挂载键+模块 JSON+sceneId"三元组保活/退役——同场景同模块零重建。
3. 契约：host 状态机 idle→initializing→running/paused→disposing→disposed；manager.reconcile 对 initializing 热插中的宿主同样按三元组裁决（dispose 吞 init 超时）。
4. 消费方：useAppRuntimeEffects 持 behaviorManagerRef，快照恢复后经既有 reconcile 面同步模块集。
5. 测试：hotSwap 族 7 例+Manager 族 6 例已有；无 dispose×initializing 与 reconcile 保活/换 worker 交互用例。
6. 规格：本文件；root 账本只读。

## 结果

- **dispose×initializing 热插**：快照恢复 reconcile 拆掉正在 initializing 热插的宿主后，init 超时不产生回滚幽灵（无 error、无回滚 onStop、无新 onStart），dispose 走正常 onStop 清理——**既有实现正确，无缺陷**，交互合同由新用例钉死防回归。
- **reconcile 保活语义锁定**：同场景同模块零 worker 重建（调度时钟延续）；同场景换模块或跨场景才退役+新建（3 workers 断言）。
- 快照恢复×热插交互切片完成 **13/13**（hotSwap 8 + Manager 5，含既有族零回归）。
- H-C6-S1 行剩余不变：Monaco 常态自动化/多模块热插（后续刀）；本切片为验证+合同钉死，无产品源改动、无新增 UI。
- 禁 cargo/帧时/GPU；不 commit/push。
