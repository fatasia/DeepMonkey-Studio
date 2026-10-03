# 作者事务删除图元

日期：2026-10-01，归属AI P3/C24最小增量。13项正式源码已提升并冻结。

## 现状核查

1. 全仓检索 deletePrimitive/removeModel、SceneCommand、作者registry/主engine、历史/快照及未跟踪源。现有controller删除已清linked annotations、object interactions、data bindings和颜色cache；removeModel已释放材质、共享几何引用、物理/动画/音频/作者变换资源。
2. 读取contracts PrimitiveState/SceneSnapshot/selectionSets/assetBindings/rootLayerOrder、animation.modelId与simulationEntities引用，以及SDK command/transaction、SceneEditTransaction合同。没有SDK删除命令；SDK已有权限/CAS/取消/receipt。唯一历史事务已有before/commit/rollback，按原applyScene恢复完整作者快照。
3. package依赖沿既有React/Three/Vitest/TypeScript；不加库、renderer或协议。
4. 真实入口App已创建controller与persistence后调用useAppLifecycleEffects→useEditorPresence→SDK editor driver。可传现有deletePrimitive、flushSceneHistoryEdit.beginTransaction与applyScene。主作者engine错误选择预览的问题已另片正式修复并7测/类型通过。
5. 已读locked deletion test、sceneHistoryTransaction、SceneAuthoringHistory、创建实际Viewer fixture与snapshot/restore测试。旧删除测只证locked，不证SDK引用清理/取消/可撤销；本候选增加这些聚焦回归，不重跑创建16/22。
6. 已对照AI P3/P4、remaining、恢复台账、创建owner与本地handoff。完整作者API仍开放；原native graph暂无几何删除消费，保留unsupported。

**已有（不重建）**：真实删除controller、资源释放、作者React状态、SDK事务/准入、同步history commit、快照恢复/撤销。

**真实缺口**：删除命令与controller callback注入；SDK失败/取消需要恢复被清理的作者引用，raw removeModel无法承担。旧controller未消费selectionSets/rootLayerOrder/assetBindings、动画作者轨道/状态机、simulationEntities对象引用，首片准入拒绝。

## 最小profile

仅单条object.delete-primitive事务；目标必须同场景现存未锁primitive。现有annotations/interactions/data可删并恢复；上述未消费对象引用拒绝。busy、renderer切换、Play/行为/时间线运行、另一history事务或快照未ready时拒绝。沿既有SceneEditTransaction与SDK commit，成功才history.commit；失败/取消history.rollback返回before并由原applyScene(requireComplete=true)恢复。快照恢复前检查本次应用revision及目标当前仍不存在；较新作者变更或同ID替换返回rollback-failed并保留新对象。外部生命周期脚本效果不属于原子回滚。

证据目录：test-output/native-author-delete-primitive-20261001/。root按13项before/afterSHA提升，收据jc-i-20261001-author-delete-promotion.json；原manifest SHA 348d97e29afbccd7bd5a33c3bca960c3b2b2e0cfdc1638b780c34ac01c27fc17保留。

## 验证与用法

正式导入路径的7条聚焦CPU测试通过：命令合同/准入；真实controller清理标注、交互、数据和颜色缓存并由原applyScene撤销；SDK取消恢复；locked/未连接拒绝；混批及未消费引用拒绝；较新revision拒恢复；queueMicrotask同ID替换且SDK取消时保留替换对象。测试复用真实Viewer primitive/cache、原snapshot/persistence与SceneAuthoringHistory；renderer与UI状态适配在既有fixture隔离，不覆盖浏览器视觉。

提升前完整Web tsconfig通过21个精确源overlay检查，无package-export alias。原公开SDK dist删除命令拒绝证据保留before-public-dist.json。root正式SDKbuild与public-dist-after.json通过：按公开exports解析dist/index.js，实际validator/单条plan通过，mesh/未知force/capability/场景不匹配拒绝，4个dist消费SHA留存。正式Web四个受影响测试文件28/28，加旧driver必要5/5，共五文件33/33。最终完整Web类型检查与build均exit0；首屏301.4 KiB、gzip96.6 KiB，原按需边界保持。13项正式源SHA只读复核匹配冻结manifest，formal-source-verified.json留存。

正式7测命令：`pnpm --filter @bim-studio/web exec vitest run src/studio/editorPrimitiveDeletion.test.ts`。公开SDK检验：`node test-output/native-author-delete-primitive-20261001/public-dist-check.mjs test-output/native-author-delete-primitive-20261001/public-dist-after.json`。正式日志jc-i-20261001-author-delete-formal-tests.log / jc-i-20261001-author-delete-sdk-build.log；候选历史日志保留。新增3叶23/88/63行；App既有大文件只接约13行现有controller/history callback，既有source-size失败不计为新增叶失败。完整P3/P4和多命令/导入模型删除仍开放。

最短组合：从现有MCP active-editor资源读取projectId/sessionId/targetId/draftRevision→提交创建+变换+材质的既有editor.scene-transaction→committed后重读revision→独立提交单条删除。删除命令如下，sceneId/objectId替换为实际值：

```json
{"id":"delete-box","type":"object.delete-primitive","target":{"kind":"object","sceneId":"当前场景ID","objectId":"new-box"}}
```

完整tools/call短例留在证据目录author-create-delete-usage.md，沿原API bridge与真实主作者状态；不是Native graph parent CLI的几何能力。

保存、恢复沿既有产品入口，最短操作：

1. 创建事务committed后点主作者顶栏“保存项目”，等待已保存提示；该按钮执行saveScene→makeSnapshot→saveApplicationWorkspace，原应用与场景一起保存。
2. 重新打开同一 `/studio/<projectId>/applications/<applicationId>/scenes/<sceneId>`。原useAppSceneSyncEffects读取保存场景/应用，经applyScene→createPrimitive/applyModelState恢复图元、颜色、变换和材质；等待完整载入后再读active-editor资源。
3. 用新revision提交单条delete。要撤回本次删除，在同一主作者页面按Ctrl+Z（焦点不在输入框）；原history通过applyScene恢复删除前快照。Ctrl+Y重做。
4. 要保留删除结果，点“保存项目”后重开同一场景，场景资源中该objectId应不存在。未保存的本地恢复副本提示按实际需要恢复或丢弃；它与服务器保存版本分别处理。

这里没有新增SDK save/restore命令；保存与恢复消费沿原产品链。CPU已消费真实snapshot/applyScene与删除撤销；本片未新增浏览器保存/重开视觉验收。

## Native graph后继只读核查

六步复核：检索packages/apps的create/delete/primitive与未跟踪源；读取SceneTransformNodeInput/Snapshot、PrimitiveState与SDK协议；读取Deep/SDK依赖和exports；跟踪scripts/native-author-parent→SceneGraphTransactionDriver→SceneMutationGateway与SpatialBridge；读取已有graph create/removeSubtree/事务/空间桥测试并实际运行公开dist gateway；对照本owner与native-author-api-three-migration-audit规格。

现有graph create/removeSubtree、原子transaction、revision/generation、flush与空间索引删除不重建。CLI的graph.create只用于初始化输入nodes；driver仅专门消费set-parent，其他命令进入仅支持transform/visibility的gateway。节点合同只有层级/TRS/bounds/hidden，没有图元kind、颜色、geometry/material所有权。EngineTransformAuthoring是按需变换校验通道，不能当常驻作者层级。

实际公开dist解析create/delete成功，gateway均返回unsupported-command，graph revision/generation及原节点完全不变；native-graph-unsupported-receipt.json留存。当前Native graph几何创建/删除仍unsupported，不等同于浏览器主作者刚完成的能力。

下一最小缺口是driver到既有PrimitiveState与RuntimePackage几何/材质所有者的宿主port。应先接一个真实box资源实例的创建/删除及finalFlush空间消费，复用原事务与图元几何；只有graph节点增删无法承担该命令语义。本轮只核查，不新增协议或资源状态。
