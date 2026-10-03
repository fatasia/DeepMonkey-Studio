# Scene commands 域:Native graph 事务驱动与宿主 port

`SceneGraphTransactionDriver` 是 scene-sdk 命令事务在 Native graph(`SceneTransformGraph`)上的
执行方:SDK 持有 prepare/CAS/取消/receipt 编排,driver 只消费命令并把逆算子留给回滚。
driver 宿主无关——宿主能力经 **port 注入**,缺省时对应命令 fail-closed 拒绝(不扩张)。

## Port 注入

| options 键 | 类型/文件 | 消费的命令 | 缺省行为 |
| --- | --- | --- | --- |
| `primitiveOwner` | `ScenePrimitiveOwnerPort`(`ScenePrimitiveOwnerPort.ts`;参考实现 `ScenePrimitiveOwner`) | `object.create-primitive` / `object.delete-primitive` / `material.set` | 拒绝(fail-closed) |
| `cameraPort` | `SceneCameraPort`(`SceneCameraPort.ts`;参考实现 `SceneCameraOwner`) | `camera.set` / `camera.fly-to` | 拒绝(fail-closed) |
| `referenceCleanup` | `SceneReferenceCleanupPort`(`SceneReferenceCleanupPort.ts`;参考实现 `SceneReferenceRegistry`) | `object.delete-primitive` 的引用清理 | 维持批 1 语义(引用容器不可见) |

参考实现均为最小注册表 sink:图元所有权走产品唯一编译路径
(`sceneSnapshotToRenderPacket` → `primitiveGeometry`/`primitiveMaterial` → `buildDeepRuntimePackage`),
不发明第二套几何/材质;持久化经 `snapshotScene()` / `restoreSceneFromSnapshot()`(schemaVersion 1)。

## 命令支持域

| 命令 | 消费方式 | 备注 |
| --- | --- | --- |
| `object.set-transform` / `object.set-visibility` | `SceneMutationGateway`(仅支持这两类) | port 拥有的节点投影回 `PrimitiveState`(见触碰守卫) |
| `object.set-parent` | driver 直连 graph 层级 | keepWorld 重算的本地 TRS 同步投影回 port |
| `object.create-primitive` | port 注册 `PrimitiveState` + graph 原子建节点 | localBounds=同一编译路径顶点 min/max |
| `object.delete-primitive` | 捕获整树快照 → 引用清理 → port 释放 → `removeSubtree` | locked/异主拒绝;绑定引用整批拒绝并列出绑定 id(见删除的引用消费语义) |
| `material.set` | port `syncMaterial` | 支持键=color/emissive/emissiveIntensity/roughness/metalness/doubleSided;中性值键 no-op;其余键整批原子拒绝 |
| `camera.set` | cameraPort 整 pose 写入 | graph 不被触碰(flush 无节点变更) |
| `camera.fly-to` | driver 解析目标为几何事实({position}→look-at/object→focus-object/scene→fit-scene) | **`durationMs>0` 如实拒绝**——时长缓动属宿主相机 Tween 播放层,事务只消费即时终点态 |
| 其他命令 | gateway `unsupported-command` | 不静默扩张 |

## 触碰守卫语义

- **投影解锁**(默认):transform/visibility/parent 命令触碰 port 图元时,graph 权威态
  (本地 TRS/matrix、hidden)镜像进 `PrimitiveState`(`syncTransform`/`syncVisibility`),
  图元保持可编译;matrix kind 按 T*R*S 精确分解并带重组守卫,skew/奇异如实拒绝。
- **宿主级防御**:`markNodeDiverged` 标记的图元使 `compileRuntimePackage` fail-closed 拒绝
  (保留给宿主标注驱动无法投影的触碰,驱动主流程不再调用)。
- **原子性**:graph 事务失败时 port 变更逆序补偿;SDK 取消/失败走 `rollback()`
  (update/create/delete/primitive/camera 五类逆算子,批 1–3 合同)。

## 撤销栈(宿主 Ctrl+Z 链)

`SceneGraphHistoryBridge`(`SceneGraphHistoryBridge.ts`)把 graph 线事务接进宿主
`SceneAuthoringHistory`(浏览器 Ctrl+Z 同一实现)。事务形态与浏览器删除第一批
(`editorSceneWriteDriver` + `SceneEditTransaction`)同构:

```ts
const bridge = new SceneGraphHistoryBridge({ sceneId, owner, graph, references }, { sceneId });
const outcome = await bridge.edit("创建图元", () => commitSceneCommandTransaction(plan, driver));
// committed → 事务窗口内全部变更落一条撤销条目;rolled-back/rejected/failed → 无条目。
const undone = bridge.undo();   // 重水合恢复 before 快照(图元/引用容器),返回重水合 flush
const redone = bridge.redo();   // 恢复 after 快照
```

- 条目的逆算子载体 = before/after `SceneSnapshot` 对;恢复路径复用第三批重开链
  `restoreSceneFromSnapshot`(不建第二套恢复机制),撤销/重做后宿主以返回的
  `flush` 重建空间投影,引用容器回写既有注册表。
- 作者域 = port 所有权内的图元 + 引用容器(selectionSets/rootLayerOrder 及只读域透传);
  非 port 图元的 graph-only 编辑指纹不变、不落条目。**相机不进作者栈**(相机浏览不是
  作者编辑,与浏览器规则一致;相机由 driver 级逆算子在 SDK rollback 内自管)。
- fail-closed:事务窗口开启时 undo/redo 拒绝;SDK rolled-back 后事实快照与 before
  指纹背离(逆算子被绕过)时抛错,不静默续栈。

## 删除的引用消费语义

| 引用域 | 删除流语义 | 说明 |
| --- | --- | --- |
| `selectionSets` | 摘 objectId,集合保留(可空) | 第一子集清理(自动) |
| `rootLayerOrder` | 过滤对象根行,组行保留 | 第一子集清理(自动) |
| `assetBindings` | **整批拒绝,错误列出全部命中绑定 id** | 第二子集(第五批):与浏览器拒绝清单同形,不自动摘绑定 |
| 动画(models 时间线+状态机+clip 事件) | **消费**:摘命中对象的关键帧、状态机状态(连同触及转移与被删对象 clip 的事件标记) | 第三子集(第六批);初始/活动状态锚在被消费状态上时整批拒绝(`STATE_MACHINE_ANCHOR_CONSUMED`)——不静默改锚 |
| `simulationEntities` | **消费**:移除引用命中对象(flowNode/path 的 target、flowLink 的 from/to、collisionPair 的 a/b)的实体 | 第三子集(第六批);未知形状的实体如实拒绝(`SIMULATION_ENTITY_TYPE_MISMATCH`),不静默跳过 |

删除消费**先检查后执行**:任何拒绝(绑定引用、锚被消费、未知仿真实体形状)发生在
任何变更之前,零部分清理;回滚/取消经 before 快照精确恢复容器。

**加载解析门**:`restoreSceneFromSnapshot` 对快照携带的 animation/simulationEntities 逐条
解析到运行时资源(图元注册表)——对象引用悬空(`ANIMATION_REF_DANGLING` /
`SIMULATION_REF_DANGLING`)、状态机内部引用悬空(`STATE_MACHINE_STATE_REF_DANGLING`)、
clip 事件标记 clipId 悬空(`ANIMATION_CLIP_REF_DANGLING`)、实体形状不可识别
(`SIMULATION_ENTITY_TYPE_MISMATCH`)都以 `SceneReferenceResolutionError` 拒绝重开,
不静默丢弃;状态机环形转移是合法语义,解析遍历带 visited 集防护。导入 clipId(clip
活在模型资产里)不属文档级引用,其运行时解析在播放层(引擎 `controlAnimation` 对
缺失 clip 返回 false,fail-closed)。

assetBindings 的清理路是**宿主显式解绑**:`SceneReferenceRegistry.removeAssetBindingsFor(objectId)`
移除并按原序返回该对象的全部绑定深拷贝——对应浏览器『请先移除该引用』;driver 删除流不调用它。
解绑后删除照常走引用消费与既有逆算子(删除被回滚时引用容器恢复到事务 before 态)。

## 相机 Tween 播放层(宿主装配示例)

`durationMs>0` 的飞行在 driver 侧如实拒绝;时长活在宿主 Tween 层(`SceneCameraFlyTween.ts`,
非生产接线,不建通用 Tween 系统):

```ts
const tween = assembleCameraFlyTween(from, to, { durationMs: 250 }); // 端点精确、easeInOutCubic
playCameraFlyTween(cameraPort, tween); // 同步示例循环:逐帧 cameraPort.setCamera(sample(elapsed))
// 真实宿主:循环体换成 rAF;每帧仍是 setCamera(tween.sample(elapsed)),终点帧精确落位;
// 只驱动 cameraPort,从不向事务驱动发 durationMs>0 的 fly-to(会被如实拒绝)。
```

取景策略(距离/fov 逼近)与曲线族不在示例内;终点权威态可再经 `camera.set` 事务落库。

## CLI 入口(scripts/)

| 脚本 | 轮次 |
| --- | --- |
| `native-author-primitive-owner.mts` | 创建/删除 + octree 空间消费 + RuntimePackage v1 |
| `native-author-primitive-mixed-batch.mts` | 原子守卫批 + 单事务四命令混批 |
| `native-author-primitive-save-reopen.mts` | 快照导出/重开水合/重开后续作者 |
| `native-author-primitive-undo-redo.mts` | 撤销轮:create→undo(资源释放)→redo(哈希逐字节一致)+ 引用删除撤销轮 |
| `native-author-primitive-asset-binding.mts` | assetBindings 拒绝路(列出全部绑定 id)/宿主解绑清理路 |
| `native-author-primitive-reference-consumption.mts` | 动画/仿真引用消费删除轮 + 重开解析门 + 悬空引用拒绝 |
