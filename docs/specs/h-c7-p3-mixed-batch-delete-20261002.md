# H-C7-P3 混批图元删除(2026-10-02,主线程切片)

## 现状核查

1. `native-author-delete-primitive-20261001.md` 首片为单条 `object.delete-primitive` 事务,混批被 driver 硬拒(`editorSceneWriteDriver.ts` 旧第 91 行 `commands.length !== 1`);SDK 事务层(`prepareSceneCommandTransaction`)本就支持任意命令混批,拒绝只在宿主 driver。
2. SDK `commitSceneCommandTransaction`:apply 抛错/结果含失败命令 → `rollbackAfterFailure` → driver.rollback,CAS revision 冲突前置。失败命令传导链已核实(不存在对象 → port `unsupported` → executor `success:false`)。
3. 消费方:`editorPrimitiveCreation/Deletion/SceneWriteDriver/SceneRuntimeOwner` 四个测试文件为同族;App 经 `runEditorSceneTransaction` 消费。

## 实现(apps/web/src/studio/editorSceneWriteDriver.ts)

- **apply**:删除可与创建/变换/材质/可见性同事务;每事务最多一条删除(多删除撤销序无合同,fail-closed,抛错发生在 `authoring.begin` 之前,零变更);`host.authoring` 缺失仍拒绝(fail-closed 不变)。
- **rollback 双层化**:含删除时先 `replayInverseOperations()`(逆算子倒序重放,移除本事务创建的对象、恢复变换/材质/可见性/选区/相机),再 `rollbackDeletion()`(作者快照恢复删除;快照 begin 于事务开始,覆盖两者);revision 守卫保持(逆算子重放不 bump,rollbackDeletion 内部 bump)。单条删除路径逆算子栈为空,行为与旧实现逐位等价。

## 验收(实测)

- `editorPrimitiveDeletion.test.ts` **11/11**:原 7 用例(单条删除/取消/locked/同ID微任务替换/引用拒绝/revision 守卫)不回归;"混批拒绝"用例按新语义同族更新为 4 个新用例:
  1. `[create mixed-box, delete victim]` → committed,两效果正确,restore 未调用;
  2. `[create, delete, set-transform ghost]` → rolled-back,**双层回滚证明**:mixed-box 被逆算子移除、victim 由作者快照恢复(存在+颜色 #1683ff+标注/交互恢复);
  3. `[delete, set-visibility 同对象]` → rolled-back,restore 被调用(删除真实发生后的快照恢复);
  4. 双删除 → rolled-back,零变更。
  未消费引用(selectionSets/动画轨道/仿真实体)拒绝**原样保留**。
- 同族回归 `editorPrimitiveCreation/SceneWriteDriver/SceneRuntimeOwner` 3 文件 **21/21**;apps/web `tsc --noEmit` exit 0。

## 如实边界

- 恢复语义沿既有合同:作者快照 restore 经 applyScene 重建,恢复对象为新 JS 引用(uuid 变化),断言按"存在+属性"而非引用相等(与既有取消/undo 用例一致);测试初稿断言过强已修正。
- 每事务一条删除是声明边界(非任意批合同);Native graph 几何 owner port、材质/相机命令、未消费引用的消费(而非拒绝)仍开放,P3 整行未闭。
