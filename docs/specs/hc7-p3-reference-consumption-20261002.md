# H-C7-P3 第六批:动画/仿真引用消费化(2026-10-02,主线程切片)

归属 H-C7-P3 行剩余项「动画轨道/状态机/simulationEntities 引用消费化」。证据目录
`test-output/hc7p3-graph-owner-20261002/`,里程碑 `progress-16-survey.json` /
`progress-17-implementation.json` / `progress-18-acceptance.json`,CLI receipt
`cli-reference-consumption-receipt.json`。root 账本 `jc-i-continuation-20261001.md` 只读未改。

## 现状核查(六步,详见 progress-16-survey.json)

1. **全仓 grep**(`referenceConsumption|引用消费|animationRef|simulationRef|timelineRef`,apps/web/src、packages/*/src、docs/specs):仅 commands 域(README/SceneReferenceCleanupPort 注释)、deep-engine `DeepWebGpuBackend`(注释)与既有规格文档命中——**不存在已建而未接的引用消费实现,无重复建设风险**。
2. **契约层**:`SceneAnimationState`(scene.ts:795)的引用以对象 ID 内联(models[].modelId、stateMachine.states[].modelId/clipId、transitions 端点、events[].clipId);`SimulationEntityState` 判别联合(flowNode/path.targetModelId、flowLink.from/to、collisionPair.a/b)。`SimulationPlan`/独立 `AnimationClip` 资源类型全仓**不存在**——任务书「若以引用字符串/ID 形式存在」的真实形态 = 容器对对象 ID 的文档级引用 + 状态机/事件对 clipId 的容器内引用。本批零合同改动。
3. **依赖**:零新增。
4. **消费方**:clipId 的**运行时**消费已在播放层 fail-closed(`viewerEngineAnimation.controlAnimation` 对缺失 clip 返回 false;`sceneViewerDynamicPlayback` 对不可用活动片段抛错);bridge 已把动画/仿真容器 structuredClone 穿越 undo/redo(批 4);driver 删除流的 snapshot→prune→逆算子合同(批 3)对消费语义升级透明。**消费端已存在,入口未接线 = registry 的动画/仿真域仍为整批拒绝 + 重开链零解析**。
5. **测试与证据**:批 3 用例「unconsumed reference domains refuse deletion」把两域列为拒绝变体;重开链无任何引用解析用例;CLI 六脚本均不携带动画/仿真容器。
6. **规格**:`hc7p3-graph-owner-port-20261002.md` 第五批末剩余清单明示本项;第三批登记「动画域未接、仿真属仿线」。

**已有(不重建)**:播放层 clipId 解析与 fail-closed;删除流先检查后清理合同与引用逆算子;bridge 容器穿越;sceneImportRebinding 动画/仿真 modelId 重绑(浏览器域,零触碰)。

**真实缺口(本批所接)**:①删除流动画/仿真域仅整批拒绝,容器序列化携带悬空 ID;②重开链(`restoreSceneFromSnapshot`)对快照携带的 animation/simulationEntities 不做引用解析(悬空对象引用/状态机内部悬空/事件 clipId 悬空全部静默通过);③未知形状仿真实体在删除流引用检查中被静默跳过;④无循环转移解析防护。

## 实现

### 删除流消费(第三子集)

- `SceneReferenceContainers.animation/simulationEntities` 由 readonly 透传升为可变第一类域(批 5 assetBindings 同路径);`SceneReferencePruneResult` 增五域消费计数。
- `pruneDeletedObjectReferences` 先检查后消费两段式:检查段全量算定消费计划,**任何拒绝发生在任何变更之前**;消费段按计划就地变异,回滚由既有 before 快照深恢复(driver 零改动)。
- 动画域:摘命中对象的时间线关键帧;状态机摘命中状态(连同触及转移与被删对象名下 clip——被消费状态 clipId ∪ 被摘帧 `animation.clipId`——的事件标记);**锚守卫**:初始/活动状态锚在被消费状态上时整批拒绝(`STATE_MACHINE_ANCHOR_CONSUMED`),不静默改锚。
- 仿真域:命中实体(flowNode/path target、flowLink from/to、collisionPair a/b)移除;**未知判别形状如实拒绝**(`SIMULATION_ENTITY_TYPE_MISMATCH`),不静默跳过。
- assetBindings 拒绝语义与 `removeAssetBindingsFor` 解绑清理路原样保留。

### 加载解析门(引用→运行时资源)

- `resolveSceneReferenceIntegrity` + `SceneReferenceResolutionError`(六错误码:`ANIMATION_REF_DANGLING` / `ANIMATION_CLIP_REF_DANGLING` / `STATE_MACHINE_STATE_REF_DANGLING` / `STATE_MACHINE_ANCHOR_CONSUMED` / `SIMULATION_REF_DANGLING` / `SIMULATION_ENTITY_TYPE_MISMATCH`)。
- `restoreSceneFromSnapshot` 接线:快照携带 animation/simulationEntities 时水合后逐条解析到 port 图元注册表,失败显式错误码拒绝重开,不静默丢弃;未携带时行为逐位不变(批 3/4 用例与六份 CLI 脚本零影响)。
- 解析域:对象引用(帧/状态/仿真实体)→注册表;状态机内部引用(锚/转移端点)→已声明状态集;事件标记 clipId→容器内已授权 clip 集。**循环引用防护**:从初始状态的转移可达性遍历带 visited 集,环形转移(A→B→A)是状态机合法语义,解析终止不挂死。
- 边界:导入 clipId(clip 活在模型资产)不属文档级引用,其运行时解析留在播放层(已 fail-closed),不重复建设。

## 验证(实测)

- 聚焦 `apps/web/src/commands/SceneGraphTransactionDriver.test.ts` **43/43**:批 1–5 全部 36 用例不回归;同族收窄 1 用例(拒绝清单收窄为 assetBindings);新增 7 用例——删除消费+SDK 取消深恢复 / 引用缺失零消费(缺省容器+旁观图元) / 锚拒绝零变更 / 重开解析门+两类对象悬空码 / 类型不匹配双路拒绝 / 循环转移终止+三类内部悬空码 / 序列化往返+bridge undo/redo 穿越解析门。
- 同族回归:apps/web `src/commands` **94/94**(87+7)+ 浏览器主链删除家族 36/36(合并 130/130);deep-engine `src/scene` **58/58**;scene-sdk **112/112**(包目录口径;批 5 记 109 为并行线路增量,本线零触碰)。
- 类型:apps/web 全量 tsc **0 错误**;scene-sdk tsc 通过;deep-engine 三配置(主/lab/examples)通过。
- CLI:新脚本 `scripts/native-author-primitive-reference-consumption.mts` exit 0,`referenceConsumptionProven/reopenGateProven/danglingRefusedProven` 全 true;批 1–5 五份 receipt 脚本复跑 exit 0 原地刷新。
- 过程自纠三处:夹具锚位(initial 锚 victim 状态触发锚守卫)→锚参数化;SDK commit 把 driver apply 抛错折叠为 rolled-back(不外抛)→错误码经 driver 直连 apply 验证、原子性经 SDK 验证;`SceneGraphTransactionDriver.apply` 为同步方法→`assert.rejects` 回调包 async。

## 如实边界

- 浏览器主作者链(`editorSceneWriteDriver`/`editorPrimitiveDeleteAuthoring`)的删除拒绝清单未同步消费化——该链的动画/仿真消费语义属浏览器域,本批仅 driver 线;其既有拒绝语义原样保留。
- 删除流不做预先存在的全局完整性校验(悬空锚/悬空转移端点不阻止无关删除)——预存在完整性归加载解析门管,删除流只校验本事务消费触及的语义。
- 状态机锚被消费时宿主侧无「迁移锚」编程口(类比 `removeAssetBindingsFor` 的宿主决策面),登记后继。
- `TimelineDocument`(application.ts)的 trackIds 为展示层元数据、无运行时消费链,未纳入;`SimulationPlan` 类型不存在,仿真消费落在 `SimulationEntityState` 真实形态。
- 禁 cargo:Native 端(Rust)消费复验仍开放;SceneTimelinePanel 及 hooks/playTraceStore、BehaviorTraceReplay 域零触碰;帧时测量未做;不 commit 不 push。

## H-C7-P3 剩余(第六批后)

相机 Tween 生产接线(rAF 循环/取消/中断恢复)与取景策略;状态机锚迁移宿主编程口;浏览器主作者链的引用消费语义对齐;Native 端消费复验;浏览器 App UI 接线(driver 已具备全部 port+撤销桥+引用消费,装配即用)。本批闭掉「动画轨道/状态机/simulationEntities 引用消费化(删除流消费+加载解析门)」——五域引用容器在 driver 线全部具备明确消费语义(三域摘引用消费、一域拒绝+宿主解绑、一域消费+锚守卫)。
