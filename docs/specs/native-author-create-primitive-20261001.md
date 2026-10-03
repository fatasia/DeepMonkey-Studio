# 作者事务创建图元

日期：2026-10-01。归属 AI P3/C24 的最小增量；完整 P3/P4 保持开放。

## 现状核查

1. 检索 packages/apps 的 createPrimitive、deletePrimitive、SceneCommand、snapshot 与 registerObject，检查未跟踪源。已有作者图元创建、恢复、几何/材质缓存与删除资源释放；其他路 PT/I23/F6 源保留。
2. 读取 contracts/scene.ts 的 PrimitiveKind/PrimitiveState/SceneSnapshot 与 scene-sdk 的 protocol/validator/transaction。七种图元已经定义；命令尚无创建，已有 object.set-transform/material.set 可以在同批设置新对象。
3. scene-sdk 运行依赖只有 contracts；Web 已用 Three 0.185.1、Vitest、TypeScript。不增加库或渲染器。
4. 真实消费是 API editor bridge → runEditorSceneTransaction → SceneCommandExecutor → ViewerSceneCommandPort。ViewerEngine.createPrimitive 使用已有共享缓存/registerObject/select；makeSceneSnapshot 从 listModels/primitiveState 读取真实颜色与作者坐标，不需要新增 React 场景存储。
5. 读取 SDK validator/transaction、editorSceneWriteDriver、modelInstanceEngineTestFixture、restored author transform 的测试与现有正式93 SDK/19 Web证据。新片只增加创建安全边界、真实 Viewer 几何/快照和失败/取消回滚回归。
6. 校准 ai-native-3d-upgrade-plan、remaining、native-author-api-three-migration-audit、恢复台账与10-01交接。parent CLI/Three 迁移例已正式可用；本片不重建其 driver，也不关闭完整作者 API/生态行。

**已有（不重建）**：七图元、共享几何/材质、作者变换权威、保存/恢复、SceneCommand 安全解析、权限/CAS/取消/回滚、API写事务消费。

**真实缺口**：object.create-primitive 合同及现有 Viewer 端口映射；新建对象在失败/取消时的身份受控逆操作。原生 graph driver 没有几何创建 consumer，仍明确 unsupported。

## 最小范围

命令要求 object target、name、既有 PrimitiveKind、#RRGGBB color；初始位置沿已有放地语义，变换/材质沿同一事务中的既有命令。重复ID拒绝，场景不匹配/未授权/CAS不匹配在既有事务门拒绝。首片创建端口限定同步 SceneCommandPortOutcome，可选端口让旧宿主明确 unsupported；其他既有端口保留异步能力。

编辑器 driver 只记录本批新建对象的实际身份和旧选择；倒序回滚使用已有 removeModel 并恢复选择。已换成同ID另一对象时拒绝删除。创建后快照沿原 PrimitiveState 保存，不建立第二场景状态。

已有 deletePrimitive 会清理标注和交互，原始 removeModel 无这些外部作者引用；已有对象删除接线是后继，本片的删除逆操作仅针对本批新建图元。GPU/视觉与完整撤销历史不在本片验收范围。

createPrimitive 沿已有微任务派发 load 生命周期，脚本可能在后继失败或取消前触发；本片恢复对象、资源与选择，外部脚本效果不属于原子回滚。

## 正式验证与入口

新增 SDK16/16，最终新增 Web9/9加受影响旧合同13/13共22/22；SDK tsc emit、Web完整tsc通过。真实 ViewerEngine.prototype 创建/registerObject、缓存几何/标准材质、author transform、makeSceneSnapshot、applyModelState 与 removeModel 均进入测试消费。重复ID、同批后继失败、注册后抛错、SDK取消、幂等回滚、同ID替换拒删、迟到CAS和旧端口unsupported均覆盖。

根路审查发现 await 后捕获身份可能把 load 微任务中的同ID替换归为本批新建，已以独立 load-identity-amendment 修复：同步调用后同一栈 finally 捕获原对象，后续微任务替换不会改变记录。真实微任务替换加后继失败回归确认用户替换仍保留，SDK报告 rollback-failed。最终四文件22测试为 web-load-identity-tests.log；此时旧同族mock仍为async，tsc失败日志保留。sync-port-mock-amendment 单独修其返回型，两受影响文件14/14与最终 web-sync-port-typecheck.log 通过；该amendment纠正前一manifest过早写入的typecheck字段。初批21测试/manifest保留为历史。

before-receipt.json 保留旧正式dist公开validator拒创建；public-dist-after.json 从 Web 正式工作区按公开 `@bim-studio/scene-sdk` exports 解析dist/index.js，验证创建与studio.object事务计划通过，没有源码alias。证据目录 test-output/native-author-create-primitive-20261001/。

全仓 source-size 门实际列出19个既有超800叶，路径与原始行数在 source-size.log；本片没有修改这些叶。12项正式源冻结清单为 formal-manifest.json；新增4叶均低于300行，本片最大现有叶 commandValidation.ts 为340行。

可通过既有作者写事务发送：

```json
{"id":"create-box","type":"object.create-primitive","target":{"kind":"object","sceneId":"当前场景ID","objectId":"new-box"},"name":"箱体","kind":"box","color":"#1683ff"}
```

同批后续 object.set-transform/material.set 沿既有命令设置坐标与材质。正式代码已可用；完整撤销历史、旧对象删除引用清理、Native graph几何创建和P3/P4整项仍为后继。无新增GPU/Cargo/视觉结果。

## 主作者写事务入口核查

删除后继核查发现旧 useEditorPresence 的 runtime registry 只由 SceneViewportPreview 注册，主作者 Viewer 由 useAppRuntimeEffects 设置 state.engine。旧轮询不能据此可靠找到主作者实例，同ID嵌入预览还可能成为写目标。

再次核查六步：检索全仓 registry 注册/读取与未跟踪源；读取 AppState 的 activeScene/engine、Viewer/SDK host合同；依赖沿现有React/Three/Vitest；定位 App→useAppLifecycleEffects→useEditorPresence→runEditorSceneTransaction 真实消费及预览其他 registry 消费；读取主作者创建/快照测试与正式dist证据；校准本owner与P3计划。已有主作者engine、ref、场景身份和预览registry不重建；缺口仅为轮询host选错来源及effect闭包的过期实例。

最小修复：stable latest ref 读取本次 activeSceneId、state.engine、busy、rendererSwitching；场景ID必须匹配且不处于忙碌/渲染器切换，最后调用已有 engine.isSceneSnapshotReady(sceneId) 核实实际快照恢复、模型加载与dispose状态。activeSceneId更新本身不代表加载完成。预览registry原用途保持。

正式入口新7测试和Web完整tsc通过，消费实际Viewer原型与实际 ViewerSnapshotReadiness：主作者写入、已注册sameIDpreview不写、captured polling host使用最新engine、旧场景拒绝、未就绪拒绝、busy/renderer切换拒绝、实际未完成snapshot恢复拒绝。冻结3项入口源的 editor-owner-amendment.json 与 editor-owner-ready-final-tests.log / editor-owner-ready-typecheck.log 留存。根路最终Webbuild exit0（jc-i-20261001-author-main-owner-final-build.log），独立3叶SHA全匹配，jc-i-20261001-author-main-owner-root-verified.json留存。仅新增入口回归，未重跑原16/22矩阵。
