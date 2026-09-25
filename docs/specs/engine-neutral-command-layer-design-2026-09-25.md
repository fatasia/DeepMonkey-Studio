# 作者态单一事实源:引擎中立编辑命令层设计

- 日期:2026-09-25
- 定位:**八条 Three 权威路径的第 1 条**(调用图与替换顺序见 `docs/reports/deep-fair-comparison-2026-09-25.md` §3),Deep 纯编辑的地基。
- 性质:**只读设计文档**。本文档不修改任何源码;所有 file:line 为当日冻结基线(`978d9ef3`)上的实测锚点。
- 诚实声明:本文不承诺工期;第 8 节列出需要用户批准的公共合同变更清单,未获批准前对应切片不得实施。

---

## 0. 现状核查结论(2026-09-25,防重复建设)

按工作区核查六步执行(grep 全仓、读契约层、查依赖、找消费方、查测试与证据、查规格文档),结论如下。

### 已有(不重建)

| 资产 | 位置 | 与本设计的关系 |
| --- | --- | --- |
| `SceneSnapshot` 文档级快照合同 | `packages/contracts/src/scene.ts:721-771`(`schemaVersion:1`) | 单一事实源的**数据形状已经存在**,本设计不再发明新文档模型 |
| `SceneModelState`/`SceneLayerState`/`SceneMaterialState`/`SceneRigState`/`ScenePhysicsBodyState`/`SceneLightState` 等字段合同 | `packages/contracts/src/scene.ts:11-43,128-138,140-188,265-307,48-55,409-447` | 命令 patch 的字段口径直接复用 |
| `ScenePickingHit`/`ScenePickingQuery` 引擎中立拾取合同 | `packages/contracts/src/scene.ts:783-799`(提交 8bb19266/07872a31) | 命令 target 的身份来源 |
| deep-engine `SceneTransformGraph`(增量变换权威,自带 `stateRevision`) | `packages/deep-engine/src/scene/SceneTransformGraph.ts:37-67`、`types.ts:44,72-74` | 变换原语的引擎侧权威候选,不重建 |
| deep-engine `SceneChangeset` + `SceneMutationGateway`(CAS 事务边界) | `packages/deep-engine/src/scene/SceneChangeset.ts`、`SceneMutationGateway.ts`;规格 `docs/specs/scene-mutation-gateway-2026-09-17.md` | v1 已支持 `transform`/`hidden` 两类命令编译,**本设计是其向上(作者态)与向旁(材质/灯光/物理)的扩展,不是另起炉灶** |
| `SceneChangesetProjection`(changeset → Three 投影) | `packages/deep-engine/src/threeBridge/SceneChangesetProjection.ts` | "文档 → Three 派生视图"的现成模式 |
| `StudioDeepWasmAuthorHost` 引擎中立宿主缝 | `apps/web/src/viewer/StudioDeepWasmBridge.ts:31-43` | 命令层宿主接口的模板(路径 2 已验证) |
| `DeepCameraController` + `DeepCameraInputSession` + 视口手势接管 | `apps/web/src/viewer/deepCameraController.ts`、`deepCameraInputSession.ts`;接线见提交 63db52ce | "姿态写回单一事实源"的已验证先例(第 6 节) |
| Deep CPU 拾取 API | `packages/deep-engine/src/webgpu/picking.ts`(提交 07872a31) | 命令 target ↔ instanceId 映射的另一半 |
| WASM 整包编译缝 | `apps/web/src/viewer/studioWasmRuntimePackage.ts:9-32` + `StudioDeepWasmBridge.refresh():150-178` | 引擎中立消费端模板(第 4 节成本边界) |

### 真实缺口

1. **作者态没有引擎中立的编辑命令层**:全部编辑原语先写 THREE 对象,文档快照靠保存时从 Three 读出(`apps/web/src/viewer/captureSceneModelState.ts:12-38`、`apps/web/src/controllers/sceneSnapshotFactory.ts:33-113`)。
2. **`SceneSnapshot` 无单调 revision 字段**(第 1.4 节),自动保存/历史/Deep WASM 刷新全部以 React 计数器为代理。
3. deep-engine 变更网关 v1 只覆盖 transform/hidden 两类命令,材质/灯光/物理/动画无引擎中立权威(`docs/specs/scene-mutation-gateway-2026-09-17.md` §v1 明确列为 unsupported)。
4. Web 作者链(React UI → ViewerEngine)完全没有消费 `SceneTransformGraph`/`SceneMutationGateway`——同一规格 §Remaining integration 已指出。

---

## 1. 现状梳理:全部"写 Three 对象"的编辑入口

### 1.1 编辑入口清单(file:line 实测)

| 类别 | 入口(文件:行) | 写点 |
| --- | --- | --- |
| **变换** | `apps/web/src/viewer/viewerEngineObjects.ts:327-341` `applySelectionTransform` | `applyTransform(object, transform)`(`sceneObjectUtils.ts:17`)+ `updateCollisions`/`rebuildPhysicsBody` 连带 |
| | `apps/web/src/viewer/viewerEngineRuntimeSupport.ts:182-200` `setModelTransform` | 直接 `model.object.position/rotation/scale.fromArray`;`:29-42` 动态运行时回放也走这里 |
| | `apps/web/src/viewer/viewerEngineObjects.ts:255` `applyLayerStates` | `applyTransform(object, state.transform)`(快照恢复路径) |
| | `apps/web/src/viewer/viewerEngineCore.ts:449-476` TransformControls `objectChange` | 拖拽中 Three 已被 TransformControls 改写,再 `updateLayerState(..., { transform: objectTransform(object) })` **从 Three 读回** |
| | `apps/web/src/controllers/sceneEditorController.ts:495-512` | 编组批量 `setModelTransform` / 单选 `applySelectionTransform` |
| | `apps/web/src/viewer/viewerEngineTimelineRuntime.ts:10-42` `applySceneAnimationFrame` | 时间线采样每帧 `applyTransform(model.object, ...)` |
| **材质** | `apps/web/src/viewer/viewerEngineRig.ts:253-273` `setSelectionMaterial` | `applyMaterialState`(`viewerEngineObjectState.ts:137`,直接改 `MeshStandardMaterial` 字段/贴图/UV)+ `modelMaterialOverrides`/`layerStates` 旁账 |
| | `apps/web/src/viewer/viewerEngineRig.ts:282-293` `setModelMaterial` | 同上 |
| | `apps/web/src/viewer/viewerEngineObjects.ts:105-131` `setSelectionColor` | `fragmentModel.setColor` / `setObjectColor` |
| | `apps/web/src/viewer/viewerEngineObjects.ts:301-321` `setSelectionOpacity` | `fragmentModel.setOpacity` / `setObjectOpacity` |
| | `apps/web/src/viewer/viewerEngineRig.ts:297-317` `setModelEffects` | `modelEffects` 旁账 + `rebuildModelEffects`(重建 Three 材质/图层) |
| | `apps/web/src/controllers/sceneAppearanceCommands.ts:166-177,188-199,239` | UI 批量入口 |
| **骨骼/IK** | `apps/web/src/viewer/viewerEngineRig.ts:57-69` `setBoneRotation` | `bone.rotation.set` + `modelRigStates` 旁账 |
| | `apps/web/src/viewer/viewerEngineRig.ts:70-83` `resetBonePose` | `bone.quaternion.copy(rest)` |
| | `apps/web/src/viewer/viewerEngineRig.ts:88-100` `setModelRigState`;`101-129` `createIKConstraint`/`updateIKConstraint`/`removeIKConstraint` | 旁账 + 逐帧灌回(`viewerEngineTimelineRuntime.ts:87-109` `updateModelRig`) |
| | UI:`apps/web/src/components/ModelRigControl.tsx:40,45,86,96,115` | |
| **灯光** | `apps/web/src/viewer/viewerEngineRig.ts:173-188` `setGlobalLighting` | 归一化 `lightingState` 旁账 → `syncSceneLights()`(`viewerEngineEnvironment.ts:189`)整组重建 Three 灯 |
| | `apps/web/src/viewer/viewerEngineCore.ts:451-462` 灯光 gizmo 回写 | `objectChange` 中 `state.position = toValue(light.position)`(Three → 旁账,方向反写) |
| | UI:`apps/web/src/controllers/sceneAppearanceCommands.ts:80` | |
| **可见性** | `apps/web/src/viewer/viewerEngineObjects.ts:205-226` `setLayerVisible` | `setTreeVisibility` + `fragmentModel.setVisible` / `object.visible`;连带 `updateCollisions`/`markShadowMapDirty` |
| | `apps/web/src/viewer/viewerEngineObjects.ts:290-300` `setSelectionVisible` | 同上分发 |
| | `apps/web/src/viewer/viewerEngineRuntimeSupport.ts:35-38` | 发布回放 `applyVisibility` 写 `setVisible` |
| **图层/锁定/删除/改名** | `apps/web/src/viewer/viewerEngineObjects.ts:18-24` `setModelLocked`;`40-54` `setLayerLocked` | `userData.modelLocked/layerLocked` + fragment 树 |
| | `apps/web/src/viewer/viewerEngineObjects.ts:342-369` `deleteSelectedLayer` | `userData.layerDeleted = true` + 隐藏 |
| | `apps/web/src/viewer/viewerEngineObjects.ts:270-289` `renameSelection` | `object.name` / `entry.node.name` |
| **环境/天气/后处理** | `apps/web/src/viewer/viewerEngineRig.ts:133-150` `setWeather`;`154-169` `setSceneEnvironment` | `scene.fog`、天空盒、网格可见性 |
| | `apps/web/src/viewer/viewerEngineRendering.ts:108-119` `setPostProcessing` | 管线重建,自带 `postProcessingRevision` 过期防护 |
| | UI:`apps/web/src/controllers/sceneAppearanceCommands.ts:60-92` | |
| **物理** | `apps/web/src/viewer/viewerEngineSimulation.ts:49` `setPhysicsBodyState`;`245` `rebuildPhysicsBody` | 旁账 + Rapier 刚体重建;变换/可见性编辑均连带(`viewerEngineObjects.ts:337-339`) |
| | UI:`apps/web/src/controllers/sceneAppearanceCommands.ts:112` | |
| **动画** | `apps/web/src/viewer/viewerEngineRig.ts:21-35` `setAnimationEnabled` | `mixer.timeScale` |
| | `apps/web/src/viewer/viewerEngineSimulation.ts:355` `setSceneAnimation` + `viewerEngineTimelineRuntime.ts:44-59` `applyTimelineModelAnimation` | `mixer.setTime` |
| **相机** | `apps/web/src/viewer/viewerEngineNavigationTools.ts:62` `applyViewportCameraPose`(提交 63db52ce) | 写回 `viewer.camera`+`orbit.target`——**当前唯一已引擎中立化的姿态写回** |
| **机器人** | `apps/web/src/viewer/viewerEngineRobot.ts:9` `setRobotPose` | 关节值 → 骨骼 |
| **图元创建** | `apps/web/src/viewer/viewerEngineLoading.ts:277` `createPrimitive`;`viewerEnginePointer.ts:349` 视口放置 | 新建 Three 对象(`onPrimitivePlaced`,消费于 `useAppRuntimeEffects.ts:276-282`) |
| **行为脚本直写** | `apps/web/src/behavior/ViewerSceneCommandPort.ts:19,39` | 脚本经宿主口直接调 `setLayerVisible`/`setModelMaterial` |

### 1.2 归类:七个编辑原语

上述入口可无损归并为七个原语(命名对齐 `scene-mutation-gateway-2026-09-17.md` 的 command 风格,纯示意、不进 contracts):

1. **SetTransform** —— `applySelectionTransform`/`setModelTransform`/编组批量/图层 transform;含拖拽流(时间线采样是同一原语的播放期重放)。
2. **SetAppearance** —— 材质 patch、颜色、透明度、模型效果(`setSelectionMaterial`/`setModelMaterial`/`setSelectionColor`/`setSelectionOpacity`/`setModelEffects`)。
3. **SetLightProp** —— `setGlobalLighting`(对象级灯光数组是其子集)+ 灯光 gizmo 回写。
4. **SetVisibility** —— `setLayerVisible`/`setSelectionVisible`/`setLayerLocked`/`setModelLocked`/`deleteSelectedLayer`/`renameSelection`(图层属性族)。
5. **SetSceneEnv** —— `setWeather`/`setSceneEnvironment`/`setPostProcessing`(场景级,无对象 target)。
6. **SetPhysics** —— `setPhysicsBodyState`/碰撞开关/爆炸因子(`SceneModelState.physics`/`collisionEnabled`/`explosionFactor` 字段)。
7. **SetRigPose** —— `setBoneRotation`/`setModelRigState`/IK 增删改/`setRobotPose`(骨骼/IK/机器人同属"关节位姿"权威)。

`createPrimitive`/删除模型等结构变更是第八类 **Add/RemoveObject**(结构命令),数量少、频率低,放最后一批。
时间线关键帧本身已存在 React 文档态(`SceneAnimationState`,`packages/contracts/src/scene.ts:605-624`),引擎只是重放器——不需要新原语,只需要把"捕获关键帧"(读当前 transform/camera)改为读文档而非读 Three。

### 1.3 SceneSnapshot 与原语的字段对应

保存链:`makeSceneSnapshot`(`sceneSnapshotFactory.ts:33-113`)对每个模型调用 `captureSceneModelState`(`captureSceneModelState.ts:12-38`),**从引擎 getter 读出**(getter 内部读 Three 对象/旁账):

| SceneSnapshot 字段 | 来源原语 | 读出点 |
| --- | --- | --- |
| `models[].transform` | SetTransform | `engine.getModelTransform` → `objectTransform(object)`(`sceneObjectUtils.ts:9`) |
| `models[].visible/locked/opacity` | SetVisibility | `item.visible` + `isModelLocked`(`viewerEngineObjects.ts:15-17`,读 `userData.modelLocked`) |
| `models[].colorOverride/material` | SetAppearance | `getModelColorOverride`/`getModelMaterialOverride`(旁账 `modelMaterialOverrides`) |
| `models[].layers[]` | SetVisibility + SetAppearance | `getLayerStates`(`viewerEngineObjects.ts:227-231`,读 `layerStates` 旁账) |
| `models[].rig` | SetRigPose | `getModelRigState`(旁账 `modelRigStates`,`viewerEngineRig.ts:84-87`) |
| `models[].physics/collisionEnabled/explosionFactor/Mode` | SetPhysics | `getPhysicsBodyState` 等 |
| `models[].effects` | SetAppearance | `getModelEffects`(旁账 `modelEffects`) |
| `primitives[]` | Add/RemoveObject + SetAppearance | `engine.primitiveState`(`sceneSnapshotFactory.ts:77-82`) |
| `lighting` | SetLightProp | `engine.getGlobalLighting`(`viewerEngineRig.ts:170-172`) |
| `environment/weather/postProcessing` | SetSceneEnv | 对应 getter(旁账) |
| `physics` | SetPhysics | `engine.getPhysicsState` |
| `animation` | (已在文档态) | `engine.getSceneAnimation` |
| `camera` | 相机原语 | `engine.getCameraState` |
| `measurements/annotations/interactions/selectionSets/dashboard/dataBindings` | 非引擎 | React 状态直出(`sceneSnapshotFactory.ts:83,94-98`) |

结论:**快照 = 原语的累积投影**。只要原语先落文档,快照即可由文档直接合成,`captureSceneModelState` 降级为兼容读路径。

### 1.4 revision 现状(关键事实)

- `revision` 是 **React `useState` 计数器**:`apps/web/src/hooks/useAppState.ts:116`。
- 编辑回调驱动累加:`useAppRuntimeEffects.ts:231-238`(`requestRevision`,rAF 合帧),挂接 `onModelChange`(:261-264)、`onLightingChange`(:265-269)、测量(:329)等。
- 消费方:
  - **Deep WASM 整包刷新**:`useAppRuntimeEffects.ts:511-526`——revision 变化即 `bridge.refresh()` → `compileStudioWasmRuntimePackage` 全量重编译(`StudioDeepWasmBridge.ts:150-178` → `studioWasmRuntimePackage.ts:9-32`)。
  - **撤销历史**:`useSceneHistoryState.ts:47-68`——220ms 防抖后整快照入栈 `SceneAuthoringHistory`(`studio/sceneAuthoringHistory.ts:24`),undo/redo 以整快照恢复。
- deep-engine `SceneTransformGraph` 有真单调 `stateRevision`(`types.ts:44`)与 per-node `lastChangedRevision`(`types.ts:72-74`),但 **Web 作者链未消费**(规格 `scene-mutation-gateway-2026-09-17.md` §Remaining integration)。
- 结论:当前"版本化"是 UI 层代理信号,不是文档属性;换渲染器、换宿主(桌面/远端)后语义不保真。

### 1.5 双端消费现状

- **Deep WebGPU**:`StudioDeepWebGpuBridge.ts:332-390`——相机变化帧只画不 sync;静止后 80ms 尾随**全量 sync**(`projectionRoot()` = `viewer.getDeepProjectionRoot()`,`viewerEngineInteraction.ts:81`,重投影整棵 Three 树);手势期用 200ms TTL 场景字段缓存(`StudioDeepRenderView.ts:85-92`)。
- **Deep WASM**:revision 驱动整包重编译(§1.4),`update_scene_viewer` 整包替换(`StudioDeepWasmBridge.ts:164`)。
- 两条链的输入都是 **Three 场景图**,不是文档。

---

## 2. 目标架构

### 2.1 数据流

```
UI/脚本/gizmo/手势
      │  (唯一入口)
      ▼
引擎中立编辑命令 SceneEditCommand (target = modelId/layerId/lightId/scene)
      │  dispatch
      ▼
文档快照单一事实源 AuthoringDocument (SceneSnapshot + 单调 revision + 命令日志)
      │  订阅: 派生 applier / 增量消费者
      ├──────────────► Three 作者树重建 (WebGL 作者视图 = 派生视图)
      ├──────────────► Deep WebGPU: 文档投影 → 增量 sync (替代整树重投影)
      └──────────────► Deep WASM: 文档 → runtime package 增量编译 (替代整包重编译)
```

核心不变式:

1. **任何时刻 Three 作者树都是文档的派生**;删除重建 Three 树不丢编辑状态。
2. **命令是唯一写路径**:UI 面板、gizmo 拖拽、行为脚本(`ViewerSceneCommandPort.ts`)、时间线捕获全部发命令,禁止旁路直写 Three(`viewerEngineCore.ts:451-462` 的 gizmo 反写方向被反转:gizmo 输出命令,applier 再写 Three)。
3. **文档 revision 单调递增**,命令携带 `baseRevision` 支持乐观并发与增量消费。

### 2.2 Three 树降级为派生视图

- 写路径:`command → document.apply() → ThreeApplier`(本质是现有 `applyLayerStates`/`applyMaterialState`/`syncSceneLights` 等函数的反转:由文档驱动,而非由 UI 散点驱动)。
- 读路径:`captureSceneModelState`(`captureSceneModelState.ts:12-38`)退化为**过渡期的兼容投影**,最终被"文档直出快照"替换;`sceneSnapshotFactory.ts:33-113` 只需拼 React 侧非引擎字段。
- 收益:撤销从"整快照克隆入栈"(`studio/sceneAuthoringHistory.ts`)可演进为命令逆放,内存与恢复成本大幅下降;自动保存从"每 220ms 全量投影"(`useSceneHistoryState.ts:55-61`)变为"revision 脏标记 + 文档直出"。

### 2.3 与 deep-engine 场景层的关系

- `SceneTransformGraph`(增量变换权威)+ `SceneChangeset`(CAS)+ `SceneMutationGateway`(编译器)是**引擎侧已验收的地基**(`SceneChangeset.test.ts`/`SceneTransformGraph.test.ts` 回归在册)。
- 本设计把网关的命令面从 v1 的 `transform`/`hidden` 扩到 §1.2 七原语;作者态文档(applier 之前)与 graph 双向同步策略在分批中按批决定:批 1-2 直接以 graph 为权威、作者文档为投影;批 3+ 先作者文档为权威、按需下沉。
- `SceneChangesetProjection`(threeBridge)证明"changeset → Three"方向已通,ThreeApplier 复用其模式。

---

## 3. 命令合同草案(纯示意 TS,不进 contracts)

> 以下类型仅表达设计意图,落地位置与命名需按分批评审后另立合同切片;不承诺与本草案逐字一致。

```ts
/** 命令身份:单调分配,撤销/重放/日志共用。 */
interface SceneEditCommandBase {
  readonly id: string;              // UUID v7 或 (sessionId, seq) 复合,日志去重与幂等键
  readonly baseRevision: number;    // 发出时所见文档 revision;过期命令显式拒绝,不静默合并
  readonly label: string;           // 撤销菜单文案(复用现有 recordSceneEdit 文案:"编辑三维对象"等)
}

interface SetTransformCommand extends SceneEditCommandBase {
  readonly kind: "setTransform";
  readonly target: { readonly modelId: string; readonly layerId?: string };
  /** TRS 部分 patch:未指定字段保持不变(语义同 scene-mutation-gateway v1)。 */
  readonly transform: Partial<{ position: Vec3; rotation: Vec3; scale: Vec3 }>;
}

interface SetAppearanceCommand extends SceneEditCommandBase {
  readonly kind: "setAppearance";
  readonly target: { readonly modelId: string; readonly layerId?: string };
  readonly material?: Partial<SceneMaterialState>;   // 字段口径 = contracts scene.ts:140-188
  readonly effects?: Partial<SceneModelEffectsState>;
  readonly opacity?: number;
}

interface SetLightPropCommand extends SceneEditCommandBase {
  readonly kind: "setLightProp";
  readonly target: { readonly lightId: string };     // lighting.lights[].id
  readonly patch: Partial<SceneLightState>;          // contracts scene.ts:411-432
}

interface SetVisibilityCommand extends SceneEditCommandBase {
  readonly kind: "setLayerState";
  readonly target: { readonly modelId: string; readonly layerId?: string };
  readonly patch: Partial<Omit<SceneLayerState, "nodeId">>; // visible/locked/name/opacity/color/deleted
}

interface SetSceneEnvCommand extends SceneEditCommandBase {
  readonly kind: "setSceneEnv";
  readonly scope: "weather" | "environment" | "postProcessing";
  readonly patch: WeatherMode | Partial<SceneEnvironmentState> | Partial<ScenePostProcessingState>;
}

interface SetPhysicsCommand extends SceneEditCommandBase {
  readonly kind: "setPhysics";
  readonly target: { readonly modelId: string };
  readonly patch: Partial<ScenePhysicsBodyState> | { collisionEnabled?: boolean; explosionFactor?: number; explosionMode?: ExplosionMode };
}

interface SetRigPoseCommand extends SceneEditCommandBase {
  readonly kind: "setRigPose";
  readonly target: { readonly modelId: string };
  readonly bones?: readonly SceneBonePoseState[];    // 覆盖式或按 bonePath 合并,分批定
  readonly ik?: { readonly upsert?: SceneIKConstraintState[]; readonly removeIds?: string[] };
  readonly robotPose?: Record<string, number>;
}

type SceneEditCommand =
  | SetTransformCommand | SetAppearanceCommand | SetLightPropCommand
  | SetVisibilityCommand | SetSceneEnvCommand | SetPhysicsCommand | SetRigPoseCommand;
```

### 3.1 撤销与合并(拖拽流)

- **合并键**:`(sessionId, commandKind, targetKey)`。拖拽/滑杆流中同一目标的同 kind 命令在**提交边界**前合并为一条(gizmo 拖拽边界已有现成信号:`transformDragging`,`viewerEngineNavigationTools.ts:38`;滑杆类以 pointerup/blur 为边界)。
- 合并策略对齐既有网关经验:"同节点同 kind 折叠为最后一条,final no-op 删除"(`scene-mutation-gateway-2026-09-17.md` §Transaction)。
- **撤销实现分两档**:
  - 过渡期(批 0-2):维持整快照撤销(`SceneAuthoringHistory`),命令日志仅作持久化信号——零回归风险;
  - 目标态(批 3+):每条命令携带逆命令(inverse),`undo = document.apply(inverse)`;整快照仅作 checkpoint(每 N 条或结构变更时)。
- 撤销后 revision **必须继续单调**(撤销是新命令,不是回滚 revision)——这是 WASM 增量消费的前提。

### 3.2 文档 revision 与命令日志

- `AuthoringDocument.revision: number` 每次成功 apply +1(含 undo/redo);`updatedAt` 仅在持久化时落盘,两者不混用。
- 命令日志(内存环形 + 可选持久化)是增量消费的候选源;即使日志不持久化,revision 差值也足以驱动"脏区重投影"。

---

## 4. revision 增量与 WASM 整包重编译的成本边界

现状:revision 每次编辑变化 → `bridge.refresh()` → `compileSceneRuntimePackage` **全量编译**(含 `loadModel` 资产缓冲拉取、GLB Draco 归一化,`studioWasmRuntimePackage.ts:14-31`),再 `update_scene_viewer` 整包替换(`StudioDeepWasmBridge.ts:164`)。大场景下这是秒级动作,也是"WASM 模式下编辑"的真实成本上限。

边界划分(诚实口径,不宣称数值):

| 编辑原语 | 对 WASM 包的影响 | 成本量级(定性) |
| --- | --- | --- |
| SetTransform / SetVisibility / SetLightProp / SetRigPose / SetSceneEnv | 只改包内 JSON 场景描述(节点矩阵/可见性/灯/关节),**几何与纹理资源字节不变** | 编译器纯 JSON 通道;理想形态是包内 payload 原位更新 |
| SetAppearance(仅参数) | 材质字段,资源不变 | 同上 |
| SetAppearance(换贴图) / Add/RemoveObject | 资源清单变化,需新增资源物化 | 整包重编译不可避免的第一阶段 |
| 相机 | 不入包(独立 `set_viewer_camera` 通道,`StudioDeepWasmBridge.ts:267-289`) | 已解耦,保持 |

增量策略分两档,按批推进:

1. **批内快路径(不破坏包格式)**:按原语类别对 refresh 做去抖与合帧(现 revision 已 rAF 合帧,`useAppRuntimeEffects.ts:231-238`;可再加命令队列 100-200ms 合并窗),并跳过与包无关的 revision 变化(选择/相机不触发 refresh——现状已按 revision 全触发,需修正)。
2. **包格式增量(需用户批准第 8 节 #4)**:RuntimePackage 引入 `sceneRevision` 与可分片更新段(场景描述 JSON vs 资源段),`update_scene_viewer` 支持段级替换。以"旧包 fail-closed"为兼容纪律(先例:拾取 objectBindings 透传的兼容策略,ledger 2026-09-25 并行批次 4)。

Deep WebGPU 侧同理:文档投影替代整树重投影后,尾随 sync 的输入从"Three 遍历出的 `ThreeObjectSource` 全量"变为"自 baseRevision 以来的命令折叠结果",`StudioDeepWebGpuBridge.ts:357-386` 的 sync 编排不变、负载变小。

---

## 5. 迁移策略

### 5.1 分批顺序(按原语,依赖驱动)

| 批 | 内容 | 理由 | 验收合同(每批必须全过) |
| --- | --- | --- | --- |
| **0** | 命令总线 + `AuthoringDocument` 骨架:七原语命令类型、dispatch、revision、命令日志;**所有 applier 先原样调用现有引擎 setter**(行为零变化) | 打地基不改行为,风险最低 | ①全量测试绿;②任何编辑后 `captureSceneModelState` 读出与批前逐字段一致;③revision 单调且 undo 后仍单调 |
| **1** | **SetTransform**:UI 面板/gizmo/编组批量全部改发命令;对接 `SceneTransformGraph` 为变换权威,Three 树经 applier 重建;拖拽流合并(边界=`transformDragging`) | 变换权威在 deep-engine 已存在,且是时间线/物理连带(`updateCollisions`/`rebuildPhysicsBody`)的根因源 | ①拖拽结束态与批前像素一致(WebGL 自身 SSIM 守卫);②undo 等价(恢复前值,`updateCollisions`/物理体重建触发点等价);③时间线播放期变换不被命令层拦截(播放是重放不是编辑);④WASM refresh 后场景描述字段一致 |
| **2** | **SetVisibility**(visible/locked/deleted/rename):fragment 树写点(`setTreeVisibility` 等)收编为 applier;`hidden` 对接 graph | 与批 1 共用 graph 权威;字段已在 `SceneLayerState` | ①图层树 UI 状态等价;②渲染可见性与碰撞参与等价;③undo 等价 |
| **3** | **SetAppearance**:材质/颜色/透明度/效果命令化;`modelMaterialOverrides`/`layerStates` 旁账收敛为文档投影 | 旁账(`viewerEngineRig.ts:263-268`)是当前漂移风险最大处 | ①材质面板往返(改→保存→重载)字段一致;②多材质槽(slotOverrides)行为不变;③undo 等价 |
| **4** | **SetLightProp + SetSceneEnv**:灯光 gizmo 反转(输出命令);`syncSceneLights` 变 applier;weather/environment/postProcessing 文档化 | 场景级原语,Three 重建成本高(`syncSceneLights` 整组重建),先文档化收益立现 | ①灯光 gizmo 拖动后 `lightingState` 与文档一致;②Deep WebGPU 灯光/雾/环境帧内容等价(桥测试族口径);③undo 等价 |
| **5** | **SetPhysics + SetRigPose**:物理体与骨骼/IK/机器人命令化 | 依赖批 1(变换连带重建)与批 3(效果重建顺序)先行 | ①物理行为不变(rebuild 触发点等价);②IK 解算结果等价;③undo 等价 |
| **6** | 结构命令 Add/RemoveObject + 快照直出:`makeSceneSnapshot` 切换为文档直出,`captureSceneModelState` 降级为恢复路径 | 结构命令频低;直出是最终收敛点 | ①保存→重载往返全字段一致;②发布/WASM 编译输入与批前等价 |

每批独立可交付、可回退(第 7 节);批内出现回归即回退该批 applier 开关,命令层保留。

### 5.2 与并行会话工作树的共存约束

ledger 记录当前存在多路并行在途(GPU 计时专项 `packages/deep-engine/src/webgpu/{pbrRenderer,gpuTimer}.ts` 为明确禁触区;拾取映射透传代理在途)。约束:

1. **批 0/1 只新增文件 + 最小 hook 化修改**:`AuthoringDocument`、命令类型、dispatch 全部新文件;对 `viewerEngineObjects.ts`/`viewerEngineRig.ts` 的改动推迟到各原语批次,且每批触碰文件清单在开工前对照 `git status` 声明,避免与并行未提交文件交叉(先例:许可证尾段只做 hunk 修正,ledger 0925 凌晨批次)。
2. **contracts 变更一律追加式**(新增导出、可选字段),不动既有字段语义;破坏性变更走第 8 节批准。
3. **不触碰** `pbrRenderer/gpuTimer`(碰撞纪律);WebGPU 桥(`StudioDeepWebGpuBridge.ts`)的 sync 编排在批 4 前不动。
4. 每批落地后按 ledger 纪律登记"已完成/未完成/不宣称"。

---

## 6. 与已落地件的关系

- **输入接管(63db52ce)**:`applyViewportCameraPose`(`viewerEngineNavigationTools.ts:62`)把引擎中立控制器姿态写回 `viewer.camera`+`orbit.target`——"外部意图 → 单一事实源写回"的模式已被 e2e 合同(输入持有者=当前后端画布)验证。命令层把同一模式从相机扩展到对象编辑:**gizmo/手势输出意图,文档写回,Three 树跟随**。批 1 的 gizmo 反转直接复用该先例。
- **拾取(07872a31 + 8bb19266)**:`ScenePickingHit.objectId` 是命令 target 的天然 id(Three 侧路径 id ↔ Deep 侧 instanceId);在途的 objectBindings→nodeId 透传完成后,Deep 内拾取命中可直接映射到 `modelId/layerId` 发命令——Deep 纯编辑闭环(拾取→命令→文档→三端)的最后一段。
- **手势缓存(200ms TTL,`StudioDeepRenderView.ts:85-92`)**:缓存存在的根因是"场景编辑何时发生不可知,只能用时间兜底"。命令层落成后,失效信号从 TTL 猜测升级为 **文档 revision 比较**(revision 未变即缓存有效),TTL 降为兜底;批 0 即可受益,无需等原语迁移。
- **每帧环境读取(路径 6)**:`StudioDeepRenderView.ts` 的灯光/雾/环境读取在批 4 后可改为读文档,消除每帧 Three 遍历——但那是路径 6 的专项,本文只保证接口兼容(文档字段 = contracts 快照字段)。

---

## 7. 风险与回退

| 风险 | 说明 | 缓解/回退 |
| --- | --- | --- |
| 行为漂移 | 现有写点隐含顺序依赖(如 SetTransform 连带 `updateCollisions`/`rebuildPhysicsBody`/`syncFragmentsTransformState`,`viewerEngineObjects.ts:337-340`;SetAppearance 先 `restoreModelEffectMaterials` 再 merge) | applier 必须按现有函数原样编排(批 0 形态);每批验收含"连带触发点等价"断言 |
| 性能:全量重编译 | WASM 侧批 4 前仍是整包;命令层初期反而多一层 | §4 两档增量;批内去抖合帧;**诚实声明:批 0-3 不承诺 WASM 编辑性能提升,只保证不劣化** |
| 性能:文档↔graph 双权威同步 | 批 1-2 若 graph 为权威、作者文档为投影,undo/日志需跨两套 revision | 每批评审时二选一并写明;不同时维护两份可写状态 |
| 并行会话冲突 | 大文件(`viewerEngineRig.ts` 595 行、`viewerEngineCore.ts` 593 行)多批修改 | §5.2 文件清单纪律;每批小提交 |
| 回退开关 | 各批 applier 以 feature 开关注入(dispatch 后走旧写路径 vs 新 applier) | 回退 = 关开关,命令日志保留不丢数据;批 6(快照直出)回退时恢复 `captureSceneModelState` 读路径 |

---

## 8. 诚实边界与需用户批准的合同变更

### 8.1 不承诺事项

- **不承诺工期**:第 5.1 节批次是依赖顺序,不是排期;每批为独立专项,按用户优先级逐批立项。
- 本文档未验证任何运行时数值;所有"等价/一致"以各批验收实测为准,不以本文推断为准。
- Deep 纯编辑在八条路径全部替换前**不宣称达成**(ledger 0925 终态快照口径延续)。

### 8.2 需用户批准的公共合同变更清单

以下任何一项实施前必须获得用户明确批准(追加式新增除外):

1. **`SceneSnapshot` 新增文档级单调 `revision` 字段**(`packages/contracts/src/scene.ts:721-771`)。追加式、旧快照缺省 0 兼容;但它是"单一事实源版本化"的公共合同面,涉及所有持久化/发布路径,需批准。
2. **contracts 新增命令原语类型包**(`SceneEditCommand` 联合及其成员)。纯新增导出;因进入公共合同面(scene-sdk/Deep/Native 消费),需批准。
3. **WASM RuntimePackage 格式扩展**(§4 增量第二档):`sceneRevision`、可分片更新段、`update_scene_viewer` 段级替换语义;旧包 fail-closed 兼容纪律不变。涉及 `runtime-package` 编译器与 Native 消费端,需批准。
4. **保存/自动保存协议变更**:若引入命令日志持久化或 `baseRevision`+delta 提交(替代全量快照 PUT),涉及 API 存储格式(`apps/api` 场景路由),需批准。
5. **`SceneModelState` 字段口径收敛**(如 `opacity/color` 与 `material` 重叠语义的显式化):当前通过合并函数(`mergeMaterialPatch`)隐式处理;若在命令化过程中需要显式化或去重,**任何破坏性字段变更需批准**,追加可选字段不需。

### 8.3 边界重申

- 本文为路径 1 的设计;路径 4(gizmo 原生化)、5(overlay 自绘)、6(文档驱动环境)、7(帧循环)、8(收尾依赖)各有专项,本文只在接口上为其留缝。
- 全部 UI/行为在迁移期保持 WebGL 作者视图为用户所见表面;Deep 双后端保持"同一作者状态的独立输出表面"(`useAppRuntimeEffects.ts:240-242` 注释口径)不变。
