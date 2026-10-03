# H-C7-P3 Native graph 几何 owner port 第一批

日期：2026-10-02，归属 H-C7-P3/C24（估时表剩余大块 24–48h 的首刀）。证据目录 `test-output/hc7p3-graph-owner-20261002/`，里程碑 `progress-01-survey.json` / `progress-02-implementation.json` / `progress-03-acceptance.json`。

## 现状核查（六步，详见 progress-01-survey.json）

1. 全仓检索：`SceneGraphTransactionDriver` 仅被 native CLI（`scripts/native-author-parent.mts`、deep-engine examples）与自测消费；`SceneMutationGateway` 仅认 `object.set-visibility/object.set-transform`，其余 `unsupported-command`（公开 dist 同样，20261001 receipt 保留）。浏览器主作者链 `editorSceneWriteDriver.ts` 为并行线路（混批删除 20261002 主线程片），未触碰。
2. 契约层：`object.create/delete-primitive` 在 scene-sdk protocol/commandValidationPrimitive 已定义并可解析；`PrimitiveState`（contracts scene.ts:484）与 `ModelTransform` 已有；`SceneCommandTransactionDriver` 接口 readRevision/apply/rollback 已有；graph 节点合同只有层级/TRS/bounds/hidden。
3. 依赖：零新增。deep-engine（scene + runtime-package）、scene-sdk、contracts、three@0.185.1（apps/web 已有）；tsx/vitest 根可用。
4. 消费方：`sceneSnapshotToRenderPacket` 在生产中被 `compileSceneRenderPacket` 与 `sceneViewerDynamicPlayback` 以 `{...scene, models: []}` 最小快照复用——证明最小快照骨架合法；`primitiveGeometry` 默认 box=BoxGeometry(2,2,2)。
5. 测试与证据：driver 旧 10 用例（parent/keep-world/原子性/取消/并发代守卫）；prior evidence `test-output/native-author-delete-primitive-20261001/native-graph-unsupported-receipt.json` 记录 create/delete 在公开 dist gateway 均 unsupported。
6. 规格：`native-author-delete-primitive-20261001.md`「Native graph后继只读核查」明示真实缺口=driver 到既有 PrimitiveState 与 RuntimePackage 几何/材质所有者的宿主 port，建议首刀=box 资源实例创建/删除+finalFlush 空间消费；`h-c7-p3-mixed-batch-delete-20261002.md` 明示该 port 仍开放。

**已有（不重建）**：graph create/removeSubtree/事务原子快照/flush/revision+generation CAS；SDK prepare/CAS/cancel/rollback 与 receipt；SpatialBridge+LooseOctreeIndex 空间删除；产品图元几何/材质编译路径；buildDeepRuntimePackage 校验/哈希。

**真实缺口（本批所接）**：driver 收到 create/delete-primitive 后如何消费 PrimitiveState 与 RuntimePackage 几何/材质所有者，及节点增删逆算子与资源释放。

## Port 接缝与最小 profile

- 接缝：`SceneGraphTransactionDriver` options 增可选 `primitiveOwner: ScenePrimitiveOwnerPort`（`apps/web/src/commands/ScenePrimitiveOwnerPort.ts`）。driver 保持宿主无关；缺省时 create/delete-primitive 显式拒绝，**fail-closed 不扩张**。
- 参考实现 `ScenePrimitiveOwner`：PrimitiveState 注册表 + 复用产品唯一编译路径 `sceneSnapshotToRenderPacket`（→`primitiveGeometry`/`primitiveMaterial`）+ `buildDeepRuntimePackage` v1（renderPacket + 内置默认 IBL，完整 Native 契约校验、资源内容哈希、包哈希）。
- create：scope 校验 → 图/注册表双重去重 → 命令投影为 PrimitiveState（modelId=objectId）→ 注册 → 以产品几何顶点 min/max 作 graph 节点 localBounds → `graph.create`，全部在 graph 原子事务内。
- delete：locked 拒绝 → DFS 捕获整树快照（parent/siblingIndex/TRS/hidden/localBounds）→ `owner.deletePrimitive`（资源释放）→ `graph.removeSubtree`。
- 逆算子：`InverseEntry` 扩为 update/create/delete。graph 事务失败时 port 变更逆序补偿；SDK cancel/rollback：创建→移除节点+释放资源，删除→恢复资源+整树重建（隐藏节点按捕获态补 update）。
- 触碰守卫：transform/visibility/parent 命令触碰 port 拥有的节点时 `markNodeDiverged`——批 1 不镜像这些投影，`compileRuntimePackage` 对已标记图元 fail-closed 拒绝（错误信息列出图元 id）；逆算子回滚时解除标记。这保证包投影永远不会与 graph 状态静默背离。

## 验证（实测）

- 聚焦测试 `apps/web/src/commands/SceneGraphTransactionDriver.test.ts` **17/17**：旧 10 用例不回归；新增 6 用例——真实 box 几何进 RuntimePackage v1（instances/geometries/materials、144 顶点、±1 bounds）+ finalFlush 空间消费；删除释放所有权+空间清空+无关图元无损；混批失败原子补偿且不发布 flush；SDK 取消后创建移除+删除子树/资源恢复+rollback 幂等；locked/异主图元/缺 port 拒绝；unsupported 域（material.set 仍拒）与触碰锁定编译。
- 同族回归：apps/web `src/commands` 4 文件 **68/68**；deep-engine `src/scene` 7 文件 **58/58**；scene-sdk **109/109**。
- 类型：scene-sdk `tsc --noEmit` 通过；deep-engine 三配置（主/lab/examples，后者把 apps/web 侧 driver/port 编入类型图）通过；apps/web 全量 tsc 剩 5 处错误全部位于并行在途文件（BehaviorPanelHeader.tsx、SceneBehaviorPanel.tsx），本线路文件零错误。
- CLI 真跑（`scripts/native-author-primitive-owner.mts`，沿 native-author-parent.mts 形态）：创建 new-box（committed，rev 0→1）→ octree `queryAabb([-2..2]³)`=[new-box] → RuntimePackage v1（render-packet+ibl-environment，instances=[new-box]，geometries=[primitive:box]）→ 删除（committed，rev 1→2，removedNodeIds=[new-box]）→ 查询=[]（清空）→ 重编译包空、包哈希变化（resourcesReleased=true）。receipt：`test-output/hc7p3-graph-owner-20261002/cli-receipt.json`。

## 如实边界

- 批 1 只承担 create/delete 的宿主几何所有权；transform/visibility/parent 对 port 图元的 RuntimePackage 投影是下一批（现以触碰锁定 fail-closed，不静默产出旧投影）。
- RuntimePackage v1 仅 renderPacket+内置 IBL；相机/环境/动态通道不在本批。
- 禁 cargo：Native 端（Rust）消费该包未复验，列为后继缺口。
- 浏览器 App 主作者链不经此 driver；UI 接线不在本批。
- 全量 web tsc 因并行线路在途文件非绿，未代为修复（非本线路文件）。

## H-C7-P3 剩余(第一批末)

port 的 transform/visibility/parent 投影镜像与触碰解锁；材质（material.set）与相机命令消费；未消费引用（selectionSets/rootLayerOrder/assetBindings、动画轨道/状态机、simulationEntities）的消费化；保存重开与撤销语义对齐；Native 端消费复验；CLI 多命令编排与文档化入口。行仍未闭，本批闭掉「graph 几何 owner port 首刀：box 创建/删除+空间消费+RuntimePackage 真实打包」。

## 第二批(2026-10-02 同日续作):触碰解锁 / material.set 消费 / CLI 多命令编排

证据目录同上;里程碑 `progress-04-survey.json` / `progress-05-implementation.json` / `progress-06-acceptance.json`。

### 解锁语义(port 投影镜像)

- 触碰守卫语义升级:driver 对 port 拥有节点的 transform/visibility/parent 命令不再 `markNodeDiverged` 锁编译,改为**同步投影**:graph.update/reparent 后把节点权威本地变换与 hidden 镜像进 PrimitiveState(`syncTransform`/`syncVisibility`),图元保持可编译。投影后包实例矩阵与 graph 权威矩阵逐项一致(实测最大漂移 5.56e-8,f32 存储量级)。
- 投影数学:四元数→XYZ Euler(three.js `setFromQuaternion` "XYZ" 算法,与 deep-engine `eulerXyzQuaternion`/`sceneModelMatrixValues` 精确互逆)。TRS 直接镜像;**matrix kind 本地变换**(keepWorld reparent 的产物)按 T*R*S 精确分解(three.js decompose 约定:列长=|scale|、det<0 翻 x、Shepperd 四元数),并带**重组守卫**——重建矩阵与源逐项比对(1e-9×量级),含 skew/奇异缩放如实拒绝,不做静默近似。
- parent 走 graph 层级:图元归属子树随父移动,几何/材质资源不变;keepWorld 重算的本地 TRS 经同一投影回 port,世界矩阵保持。**投影语义边界:包投影=图元本地变换镜像**(与产品扁平包路径 `sceneSnapshotToRenderPacket` 一致),层级世界组合由 graph 权威;父节点自身被移动时子图元包投影保持本地值,属定义语义。
- 逆算子精确化:`InverseEntry.update` 增 owner 快照 `{primitive, diverged}`;material.set 新增 primitive 条目;rollback 经 `applyPrimitiveState` 精确恢复 before 态与触碰锁位。`markNodeDiverged`/`clearNodeDiverged` 保留为宿主级防御(驱动主流程不再调用,测试覆盖编译拒绝路径)。

### material.set 消费

- driver 在 gateway 前拦截 `material.set`:scope 校验 → 缺 port 或目标非 port 拥有则 fail-closed 拒绝(不扩张)→ 逆算子捕获 → `port.syncMaterial(patch)`。
- 支持域 = `SceneMaterialCommandPatch` ∩ 产品编译路径 `primitiveMaterial` 支持集,逐键核对:**color / emissive / emissiveIntensity / roughness / metalness / doubleSided**;中性值键(`isNeutralMaterialField`:normalScale=1、wireframe=false、textureRepeat*=1、textureOffset*=0 等)按编译路径域放行为 no-op;其余键(normalScale/textureRepeat*/textureOffset*/textureRotation/wireframe 的非中性值)**如实 unsupported——列出键名整批原子拒绝,不部分写入**,避免写入后编译路径后置抛错。

### CLI 多命令编排

`scripts/native-author-primitive-mixed-batch.mts`(单会话):seed 创建 → **原子守卫批** [create guard-box + material.set {wireframe:true}] rolled-back(flush 未发布、状态零变化)→ **单事务四命令混批** [create mix-box → set-transform(pos/rot/scale) → material.set(color/metalness/roughness) → delete seed-box] committed(rev 1→2),finalFlush 单次发布 `changedNodeIds=[mix-box]`+`removedNodeIds=[seed-box]`;投影断言、octree 近区=[mix-box]/种子区清空、重编译包实例=[mix-box]、材质 metallic=0.8/roughness=0.25、包哈希变化;`atomicityProven=true`、`finalFlushSinglePublish=true`。receipt:`test-output/hc7p3-graph-owner-20261002/cli-mixed-batch-receipt.json`。

### 第二批验证(实测)

- 聚焦测试 `apps/web/src/commands/SceneGraphTransactionDriver.test.ts` **20/20**:批 1 全部用例不回归(其中「unsupported domains」1 用例按消费语义改写);新增 3 用例——touch-unlock(旋转+非均匀缩放投影、包矩阵==世界矩阵 1e-6、hide/show 编译、keepWorld reparent 分解投影)、material 消费与原子拒绝、取消后 PrimitiveState 精确恢复 + port 宿主级防御。
- 同族回归:apps/web `src/commands` 4 文件 **71/71**;deep-engine `src/scene` 7 文件 **58/58**;scene-sdk **109/109**。
- 类型:scene-sdk tsc 通过;deep-engine 三配置(主/lab/examples)通过;**apps/web 全量 tsc 0 错误**(批 1 时并行在途文件的 5 处错误已由其线路清零)。

### 第二批如实边界

- material.set 的 ior/customShader 不在 SceneMaterialCommandPatch 内;相机/环境/动态通道、未消费引用(selectionSets/rootLayerOrder/assetBindings、动画轨道/状态机、simulationEntities)、保存重开与撤销语义对齐仍在 H-C7-P3 剩余。
- 禁 cargo:Native 端消费复验仍开放。浏览器 App 主作者链不经此 driver;UI 接线不在本批;hooks/playTraceStore 与 BehaviorTraceReplay 域未触碰;jc-i-continuation 未改。
- `scripts/native-author-parent.mts` 需 --nodes/--request 文件参数,本轮以 commands 家族回归覆盖其 parent 语义,未代跑。

## H-C7-P3 剩余(第二批后)

相机命令消费;未消费引用(selectionSets/rootLayerOrder/assetBindings、动画轨道/状态机、simulationEntities)的消费化;保存重开与撤销语义对齐;Native 端消费复验;driver 文档化入口与 UI 接线。本批闭掉「触碰解锁投影镜像、material.set 消费、CLI 多命令编排」。

## 第三批(2026-10-02 同日续作):相机消费 / 引用清理第一子集 / 保存重开对齐

证据目录同上;里程碑 `progress-07-survey.json` / `progress-08-implementation.json` / `progress-09-acceptance.json`。

### 相机命令消费(cameraPort)

- 相机属宿主状态(graph 是对象层级,不含相机):driver options 增可选 `cameraPort`(`SceneCameraPort`:`setCamera(pose)`/`flyTo(intent)`/`snapshot()`/`restore()`),参考实现 `SceneCameraOwner` 为宿主相机权威态 sink。缺省时 camera.set/fly-to fail-closed 拒绝(不扩张)。
- `camera.set` 消费完整 pose(position/target/near/far/fov);`camera.fly-to` 的 **durationMs>0 在 driver 侧如实拒绝**——时长缓动属宿主相机 Tween 播放层,事务驱动只消费即时终点态,不伪装已执行(与 `ViewerSceneCommandPort.flyCamera` 的 unsupported 语义同形)。
- fly-to 目标由 driver 解析成几何事实(driver 持有 graph):`{position}`→look-at;object 引用→focus-object(graph 世界矩阵平移,节点不存在拒绝);scene 引用→fit-scene(全节点世界包围盒并集中心,无 bounds 节点拒绝)。取景策略(距离/fov 逼近)不在 driver,属宿主。
- 逆算子:`InverseEntry` 增 `{kind:"camera"}` 捕获 before pose,回滚经 `port.restore` 精确恢复;相机命令不触碰 graph(flush 无节点变更)。

### 未消费引用消费化(第一子集)

- driver options 增可选 `referenceCleanup`(`SceneReferenceCleanupPort`),参考实现 `SceneReferenceRegistry` 持有与 SceneSnapshot 对应的五域容器。`applyDelete`:先 `snapshotReferences` 捕获 before 态 → `pruneDeletedObjectReferences` → 清理成功才 `owner.deletePrimitive`;清理进 portUndo(graph 事务失败逆序恢复)与 delete 逆算子条目(`references` 字段,回滚恢复)。
- **第一子集消费=selectionSets+rootLayerOrder**:选择集摘除 objectId(保留空集,不静默删用户命名集合);rootLayerOrder 过滤对象根行(组行保留,组内顺序由 selectionSets.objectIds 承载)。
- **未消费域拒绝对齐**:assetBindings(sceneObjectId)/动画(models.modelId+stateMachine.states.modelId)/simulationEntities(targetModelId/flowLink from-to/collisionPair a-b)存在引用时先检查后清理、整批如实拒绝——错误语义与浏览器端 `primitiveDeletionReferenceError` 拒绝清单同形;拒绝发生在任何变更之前,零部分清理。三域消费化登记后续(动画域未接、仿真属仿线)。未注入 referenceCleanup 的宿主维持批 1 删除语义。浏览器主作者链未触碰,其拒绝语义原样保留。

### 保存重开对齐

- 导出:`ScenePrimitiveOwner.snapshotScene()` 把注册表投影成 SceneSnapshot 骨架(schemaVersion 1,primitives 深克隆;models 空、相机零位 orbit——相机/引用宿主状态由宿主补充,CameraState 合同无 near/far/fov)。
- 重开:`restoreSceneFromSnapshot({snapshot,sceneId})` 水合新 owner+graph:schemaVersion 非 1 如实拒绝;逐图元 `createPrimitive(structuredClone)`+graph 节点重建(localTransform=`sceneLocalFromModelTransform`,localBounds=同一编译路径 `owner.localBounds(kind)`,hidden=!visible 补 update)→flush;返回 `{owner,graph,snapshot}`——引用容器随快照持久化,重开链据此接回清理 port。
- 数学共享:`eulerXyzToQuaternion` 从 `assertMatrixRoundTrip` 内联重组式抽出导出(XYZ 约定,deep-engine `eulerXyzQuaternion` 同式),与既有 `modelTransformFromSceneLocal` 同一约定互逆——未新建第二套旋转约定。

### CLI 保存重开轮

`scripts/native-author-primitive-save-reopen.mts`(单会话四阶段):author 单事务八命令(三图元 create+set-transform+material.set+隐藏+camera.set+fly-to)committed → snapshot 导出(相机/引用容器随宿主补充,1205 字节 JSON 真实序列化往返)→ reopen 水合(3 图元/3 节点,**同 revision 编译输入下包哈希与保存前逐字节相等**,隐藏态/材质/引用容器恢复)→ post-reopen 混批 [set-transform+delete 引用图元+fly-to] committed(removedNodeIds=[victim-box]、selectionSet 摘除、rootLayerOrder 过滤、包实例=[re-box]、实例矩阵 x=9、包哈希变化、重开相机终点=[9,1,0]);`roundtripProven=true`、`referenceCleanupProven=true`、`cameraConsumedProven=true`。receipt:`test-output/hc7p3-graph-owner-20261002/cli-save-reopen-receipt.json`。

### 第三批验证(实测)

- 聚焦测试 `apps/web/src/commands/SceneGraphTransactionDriver.test.ts` **27/27**:批 1/2 全部 20 用例不回归;新增 7 用例(相机消费+缺 port fail-closed+回滚恢复 pose;fly-to scene/position 解析+时长如实拒绝+缺失目标拒绝;删除引用清理+空集保留+包跟随;SDK 取消后引用精确恢复;未消费三域整批拒绝;保存重开 JSON 往返+包哈希相等+重开可继续作者+schemaVersion 拒绝;重开场景接回引用容器继续消费删除)。
- 同族回归:apps/web `src/commands` 4 文件 **78/78**;deep-engine `src/scene` 6 文件 **53/53**(批 2 记录 7 文件 58,为并行在途线路文件漂移,本线零触碰);scene-sdk **109/109**(首跑以 `packages/` 路径过滤误吸 test-output 历史导出树的 9 个架构测试失败,系运行方式伪影,改从包目录运行后与批 2 口径一致)。
- 类型:scene-sdk tsc 通过;deep-engine 三配置(主/lab/examples)通过;apps/web 全量 tsc 0 错误。
- CLI:批 1/2 receipt 脚本复跑 exit 0(第三批 driver 变更下批 1/2 语义不变)。

### 第三批如实边界

- 相机消费只落事务内的权威终点态;durationMs>0 缓动与取景策略属宿主 Tween 播放层(如实拒绝),相机 Tween 公开端口仍是产品后继。
- 引用消费化第一子集仅 selectionSets/rootLayerOrder;assetBindings/动画轨道/状态机/simulationEntities 为拒绝对齐,消费化登记后续;未消费引用的「消费」以宿主注入 port 为前提。
- 重开链只恢复 port 所有权内的图元;模型等宿主域节点、快照相机字段映射(CameraState 无 near/far/fov)由宿主持有。
- 禁 cargo:Native 端(Rust)消费复验仍开放;浏览器 App 主作者链不经此 driver,UI 接线不在本批;hooks/playTraceStore 与 BehaviorTraceReplay 域未触碰;jc-i-continuation 未改;四项用户资产未触。

## H-C7-P3 剩余(第三批后)

撤销(undo 栈)语义与宿主 history 接线对齐;assetBindings/动画轨道/状态机/simulationEntities 引用消费化(依赖动画域/仿线);相机 Tween 播放层与取景策略;Native 端消费复验;driver 文档化入口与 UI 接线。本批闭掉「相机命令消费(cameraPort)、引用清理第一子集、保存重开对齐+CLI 保存重开轮」。

## 第四批(2026-10-02 同日续作):撤销栈对齐 / CLI 撤销轮 / 文档化入口

证据目录同上;里程碑 `progress-10-survey.json` / `progress-11-implementation.json` / `progress-12-acceptance.json`。

### 撤销栈对齐(SceneGraphHistoryBridge)

- 新 `apps/web/src/commands/SceneGraphHistoryBridge.ts`:graph 线事务接进宿主 `SceneAuthoringHistory`(studio 浏览器 Ctrl+Z 同一实现,可注入/缺省自建)。事务形态沿浏览器端删除第一批(`editorSceneWriteDriver` + `SceneEditTransaction`):`begin` 捕获 before → `commit` 把事务窗口内全部变更合并为**一条**撤销条目 → `rollback` 返回 before 交调用方、窗口关闭不落条目;`edit()` 胶水=committed 才 commit,rolled-back/rejected/failed 或抛错都关窗。
- **逆算子载体=before/after SceneSnapshot 对**:撤销恢复 before、重做恢复 after,恢复路径复用第三批重开链 `restoreSceneFromSnapshot`(不建第二套恢复机制)——撤销/重做整体换装 owner+graph,引用容器经 `restoreReferences` 回写既有注册表(实例不变,宿主句柄持续有效),并返回重水合 flush 供宿主重建空间投影(`SceneReopenResult` 增向后兼容 `flush` 字段,撤销轮与保存重开共用同一重开 delta)。
- 作者域=port 所有权内的图元(`snapshotScene`)+引用容器五域(selectionSets/rootLayerOrder 可变消费,assetBindings/animation/simulationEntities 只读透传);**相机不进作者栈**(浏览器同规:相机浏览不是作者编辑,driver 级逆算子在 SDK rollback 内自管,测试断言作者撤销不触相机 pose、相机事务不产生新条目)。
- fail-closed 两道:事务窗口开启时 undo/redo 拒绝;rolled-back 后事实快照与 before 指纹背离(测试用伪 driver 绕过逆算子构造漂移)即抛错不静默续栈。指纹对图元按多重集比对(注册表插入序是删除复原伪影——restorePrimitive 重插尾部),引用容器保持数组序(序是语义)。
- 语义边界:非 port 图元的 graph-only 编辑指纹不变、不落条目;撤销/重做是重水合恢复而非逐节点逆放(与浏览器 applyScene 快照恢复同形),宿主每轮事务前经 `bridge.runtime` 取当前 owner/graph。

### CLI 撤销轮

`scripts/native-author-primitive-undo-redo.mts`(单会话四阶段):create(桥事务窗口内 create+set-transform+material.set committed,恰落一条「创建图元」条目)→ undo(注册表/graph 清空=资源释放,重水合 flush 重建 octree 查询空,包投影零实例)→ redo(变换 x=3/金属度 0.8 恢复,空间索引命中 undo-box,**包哈希与撤销前逐字节一致**)→ delete 轮(引用清理删除→undo 恢复图元+selectionSets/rootLayerOrder→redo 再删再摘,终态注册表空)。receipt:`test-output/hc7p3-graph-owner-20261002/cli-undo-redo-receipt.json`,`undoRedoProven=true`;批 1/2/3 三份 receipt 脚本复跑 exit 0 原地刷新。

### 文档化入口

`apps/web/src/commands/README.md`(新,简明小节形态,不建独立大文档):port 注入表(缺省 fail-closed)/命令支持域表(set-transform·set-visibility·set-parent·create·delete·material.set·camera.set·fly-to 逐条消费方式,`durationMs>0` 如实拒绝)/触碰守卫语义(投影解锁、宿主级 diverged 防御、原子性)/撤销栈小节(桥用法代码例+作者域边界+相机排除+fail-closed)/CLI 入口四脚本索引。

### 第四批验证(实测)

- 聚焦测试 `apps/web/src/commands/SceneGraphTransactionDriver.test.ts` **32/32**:批 1/2/3 全部 27 用例不回归;新增 5 用例——port 创建撤销释放资源+重做哈希逐字节一致;删除撤销恢复图元+被摘引用、重做再删再摘;rolled-back 不落条目+窗口重入与开启期 undo 拒绝+回滚漂移 fail-closed+守卫后栈可用;撤销后新提交清除重做分支+双层栈逐级退空;单窗口合并多域条目+相机命令去重不进作者栈+作者撤销不触相机。
- 同族回归:apps/web `src/commands` 4 文件 **83/83**;deep-engine `src/scene` 7 文件 **58/58**(批 3 记录 6 文件 53 为并行在途线路漂移回摆,本线零触碰);scene-sdk **109/109**(包目录口径)。
- 类型:scene-sdk tsc 通过;deep-engine 三配置(主/lab/examples——examples 把 apps/web 侧 port 编入类型图,`SceneReopenResult.flush` 的 import 已随之补全)通过;apps/web 全量 tsc 0 错误。

### 第四批如实边界

- 撤销域=port 所有权内的图元+引用容器;非 port 图元的 graph-only 编辑不进该栈(宿主模型域属浏览器主作者链,本线不做);撤销/重做不恢复模型等宿主域节点(同批 3 重开边界)。
- 宿主接线纪律:撤销/重做换装后必须以返回 flush 重建空间投影并以 `bridge.runtime` 取新 owner/graph(README 已写明)。
- 禁 cargo:Native 端(Rust)消费复验仍开放;相机 Tween 播放层与取景策略、assetBindings/动画轨道/状态机/simulationEntities 引用消费化(依赖动画域/仿线)、浏览器 App UI 接线仍开放;hooks/playTraceStore 与 BehaviorTraceReplay 域未触碰;jc-i-continuation 未改;四项用户资产未触。

## H-C7-P3 剩余(第四批后)

assetBindings/动画轨道/状态机/simulationEntities 引用消费化(依赖动画域/仿线);相机 Tween 播放层与取景策略;Native 端消费复验;浏览器 App UI 接线(driver 已具备宿主全部 port+撤销桥,接线即用)。本批闭掉「撤销栈对齐(SceneAuthoringHistory 接线)、CLI 撤销轮、driver 文档化入口」。

## 第五批(2026-10-02 同日续作):assetBindings 消费化 / 相机 Tween 装配示例

证据目录同上;里程碑 `progress-13-survey.json` / `progress-14-implementation.json` / `progress-15-acceptance.json`。

### 引用第二子集:assetBindings 消费化(拒绝列出 + 宿主解绑清理路)

- **语义对齐选择:沿浏览器端 `primitiveDeletionReferenceError` 的 assetBindings 分支——有绑定引用=拒绝删除并列出**。assetBindings 是显式建立的设备资产绑定事实,与 selectionSets 的「摘引用保留」不同源:删除流对绑定引用只有拒绝一路,不自动摘绑定。driver 零改动(第三批先检查后清理合同已承载拒绝位),消费化落在 registry。
- `SceneReferenceCleanupPort.ts`:`pruneDeletedObjectReferences` 的 assetBindings 分支由「只列第一个命中」升级为**收集全部命中绑定 id 按容器序拼入错误**(『对象 X 的设备资产引用(a、b)尚未接入删除,请先移除该引用。』),检查仍居首(选择集零摘除);`SceneReferenceContainers.assetBindings` 由 readonly 透传升为可变第一类域(仅经显式解绑 API 变异,删除流不改写它)。
- **清理路=宿主显式解绑**(浏览器『请先移除该引用』的可编程形):`SceneReferenceRegistry.removeAssetBindingsFor(objectId)` 移除该对象全部绑定并按原序返回深拷贝(宿主记账),其余绑定不动、空操作返回 [];只存在于参考实现,`SceneReferenceCleanupPort` 接口不扩(driver 不消费,合同不逼自定义实现跟进)。解绑后删除照常走 selectionSets 摘引用+既有逆算子;删除被回滚时引用容器恢复到事务 before 态(=解绑后状态——解绑是事务外的宿主决定,不在删除事务回滚域内,测试如实断言)。

### 相机 Tween 播放层(最小装配示例)

- `SceneCameraFlyTween.ts`(新,非生产接线,不建通用 Tween 系统):`assembleCameraFlyTween(from,to,{durationMs,easing?,frameMs?})`→`{sample(elapsedMs)}`——durationMs 非有限/≤0 如实拒绝(时长只活在本层);端点精确返回、elapsed 越界截断、position/target lerp,near/far/fov 两侧同有才插值(单侧恒定持有,不静默补默认);缓动进度额外截断 [0,1](异常缓动不推出起终点包围盒,fail-safe)。缓动只带 `sceneCameraEaseInOutCubic` 一族;取景策略/曲线库/中断恢复登记后续。
- `playCameraFlyTween(port,tween)`:同步装配循环——sample(0) 起帧→逐帧 `cameraPort.setCamera(sample(elapsed))`→终点帧 `setCamera(to)` 精确落位;**只驱动 cameraPort,从不向事务驱动发 durationMs>0 的 fly-to**(driver 会如实拒绝,时长唯一通道=Tween 层)。真实宿主把循环体换 rAF,轨迹合同不变;终点权威态可再经 camera.set 事务落库。
- driver 的 durationMs>0 如实拒绝语义保持原样(测试内集成断言:播放后 fly-to durationMs=250 仍 rolled-back、pose 不变)。README 新增「删除的引用消费语义」表(五域逐行)与「相机 Tween 播放层」小节+CLI 入口第五行。

### CLI receipt 轮

`scripts/native-author-primitive-asset-binding.mts`(单会话五阶段):author(双图元+3 绑定 committed)→reject(错误列出 asset-pump-1、asset-pump-2,零变更 proven)→unbind(深拷贝×2)→cleanup-delete(committed,selectionSets/rootLayerOrder 摘引用,valve 绑定保持,包实例=[valve-box],octree 命中)→bound-bystander-reject(asset-valve-1 列出,零变更)。receipt:`test-output/hc7p3-graph-owner-20261002/cli-asset-binding-receipt.json`,`assetBindingRejectProven=true`、`assetBindingCleanupProven=true`;批 1/2/3/4 四份 receipt 脚本复跑 exit 0 原地刷新。

### 第五批验证(实测)

- 聚焦测试 `apps/web/src/commands/SceneGraphTransactionDriver.test.ts` **36/36**:批 1–4 全部 32 用例不回归;新增 4 用例——assetBindings 拒绝列出全部 id+零变更;宿主解绑清理路+SDK 回滚恢复+正常提交;bridge undo/redo 绑定域完整穿越+旁观者绑定保持;Tween 端点精确/缓动有界/播放只驱动 port/driver 仍拒时长。
- 同族回归:apps/web `src/commands` 4 文件 **87/87**(83+本批 4);deep-engine `src/scene` 7 文件 **58/58**;scene-sdk **109/109**(包目录口径)。
- 类型:scene-sdk tsc 通过;deep-engine 三配置(主/lab/examples)通过;apps/web 全量 tsc 0 错误。

### 第五批如实边界

- 解绑不在删除事务回滚域内(回滚恢复事务 before 态=解绑后);绑定级撤销恢复走 bridge 快照域。
- 清理路 API 只在参考实现上,port 接口未扩;Tween 为同步示例循环,无 rAF/取消/中断恢复;缓动一族;取景策略不在内。
- 动画轨道/状态机/simulationEntities 引用消费化仍未接(依赖动画域/仿线);禁 cargo:Native 端(Rust)消费复验仍开放;浏览器 App UI 接线仍开放;hooks/playTraceStore 与 BehaviorTraceReplay 域未触碰;jc-i-continuation 未改;四项用户资产未触。

## H-C7-P3 剩余(第五批后)

动画轨道/状态机/simulationEntities 引用消费化(依赖动画域/仿线);Tween 生产接线(rAF 循环/取消/中断恢复)与取景策略;Native 端消费复验;浏览器 App UI 接线(driver 已具备宿主全部 port+撤销桥+Tween 装配示例,接线即用)。本批闭掉「assetBindings 引用消费化(拒绝列出+宿主解绑清理路)、相机 Tween 最小装配示例+CLI receipt 轮」。
