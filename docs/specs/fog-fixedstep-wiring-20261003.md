# 体积雾 / FixedStepClock 宿主接线(2026-10-03)

任务来源:`upgrade-plan-ai-native-world-20261003.md` 第 15、61 行与 `omission-audit-20261004.md` #19 把"体积雾""FixedStepClock"同列为"零生产消费"。本文先核查再动手。

## 现状核查

### A. 体积雾 —— 审计结论已过期:核心消费早已接通

**已有(不重建)**

| 层 | 位置 | 事实 |
|---|---|---|
| 引擎 pass | `deep-engine/src/fog/volumetricFog*.ts`、`pbrPostProcessChain.ts:112-124`(`VolumetricFogPass`/`VolumetricFogCompositePass` 实例化)、`pbrFrameGraph.ts`/`pbrFramePlanExecutor.ts` 的 `volumetric-fog-march/composite` | 半分辨率 march + HDR 合成,opt-in |
| 引擎 profile | `webgpu/pbrPostProcessOverrides.ts:24` `DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE`(`{baseExtinction .006, scaleHeight 64, anisotropy .3, albedo .82}`) | 完整 `VolumetricMedium` 含 albedo |
| 契约 | `contracts/scene.ts` `ScenePostProcessingState.volumetricFog/Steps/Density/Height/Anisotropy/GodRays*`,`sceneValidation.ts` 范围校验 | 作者面已持久化 |
| 作者 UI | `ScenePostProcessingEditor.tsx` 体积雾开关 + 步数/密度/高度尺度/各向异性 + 体积光强度 | 已在"环境与灯光"面板 |
| 宿主桥 | `viewer/studioDeepColorEffects.ts:readStudioDeepPostProcess` → `RenderView.postProcess.volumetricFogProfile`;`viewerEngineRig.ts` 白名单(Z1 修复) | Deep WebGPU 完整消费 |
| Native / Three | `delivery/compileSceneEnvironment.ts`(`kind:"volumetric"` 8 步积分)、`scenePublicationCompatibility.ts`(Three 降级作者雾) | 已有降级语义 |
| 作者雾对账 | `scene.fog`(`FogExp2`)与 `j3-author-fog-parity.mjs`/`j3-fog-profile-parity.mjs` | **作者雾 ≠ 体积雾**:前者是表面指数雾(Three/Deep 一致性已有),后者是 opt-in 参与介质;`volumetricFog` 开启时替换表面雾 |
| 测试证据 | `volumetricFog*.test.ts`、`pbrVolumetricFogIntegration.test.ts`、`studioDeepColorEffects.test.ts`、`gate-god-rays-editor.mjs` | 已覆盖 |

**真实缺口**:引擎 `VolumetricMedium.albedo`(单次散射比)一路到 GPU uniform(`volumetricFogPass.ts:204`),但作者面无字段,宿主永远写默认 0.82——"散射强度/散射色"类参数里唯一引擎已支持而宿主缺席的一项。
**非缺口(引擎不支持,本任务不做)**:RGB 散射色/雾色。介质无色参数,散射颜色由主光 radiance 决定;加色需改 `volumetricFogPassWgsl.ts` 与字节校验夹具,且 `pbrRendererFeatures.ts` 在禁区。

### B. FixedStepClock —— 引擎有、宿主未用;宿主另有两套各自的累加器

| 位置 | 现状 |
|---|---|
| `deep-engine/src/physics/fixedStepDriver.ts` | `FixedStepClock`(round 量化 + 余量结转 + `maxCatchUpTicks`)+ `stepSimSeconds`;生产消费 = 0(仅 `fixedStepRateParity.test.ts` 对拍) |
| `apps/web/src/viewer/physicsWorldHost.ts` | **宿主物理帧循环的唯一入口**(`viewerEngineSimulation.updatePhysics` → `physicsHost.advance(delta)` → Rapier `world.step`),原为手写 floor 累加器(0.2s 上限,超限静默吞掉) |
| `scene-sdk/src/behaviorScheduler.ts` | **行为脚本已是确定性固定步长**:`onUpdate` 每帧 + `onFixedUpdate` 1/60 s 累加器,`maxFixedStepsPerFrame=5`,溢出计入 `droppedFixedSteps`;`SceneBehaviorHost.advance` 消费。已有 3 条单测 |
| 行为驱动环 | `useAppRuntimeEffects.ts:761`(React 侧 RAF)——与物理(viewer `animate`)是**两条独立 RAF 环** |
| 手动步进 | `viewerEngineSimulation.stepPhysicsFrames`(调试面板,固定 1/60,不经 host 时钟) |

**真实缺口**:物理宿主未使用引擎规范时钟(floor 累加器在 59.9/60.1 Hz 抖动下会出 0/2 步卡顿,且丢弃的追赶量无统计);无权威 tick 轴可供 World `step()` 引用。
**非缺口**:行为 `onFixedUpdate` 的固定步长/追赶上限本已存在,不重做;只补变帧率确定性单测。

## 实施

### 1. FixedStepClock 接物理宿主
- `FixedStepClock`(增量、向后兼容):`droppedTicks`(追赶截断统计)、`discardRemainder()`(暂停/恢复/attach 边界只清亚 tick 余量,保留 tick 与统计);`reset()` 同步清零 dropped。
- `PhysicsWorldHost` 用 `FixedStepClock{hz:60,maxCatchUpTicks:12}` 替换手写累加器,新增只读 `fixedTick`/`droppedTicks`。步长仍恒为 1/60,上限仍是 0.2 s 等价(12 步)。全程只写普通字段,**不触碰 React state**。
- **语义差异(如实登记)**:floor → round 量化。固定 60 fps 下恒 1 步/帧不变;亚 tick 帧(如 120 Hz)的"相位"由 0,1,0,1 变为 1,0,1,0;59.9/60.1 Hz 抖动不再出 0/2 步卡顿。`physicsWorldHost.test.ts` 两处断言由 `1/120` 改为 `1/180`(消除 .5 边界歧义),语义未退化。
- 渲染插值:本期**不做** alpha 位姿插值(需逐刚体保留上一步位姿,成本/收益不成比例);保证"不丢步"——仅在超过 12 步追赶预算时丢弃,且计入 `droppedTicks`。

### 2. 体积雾 albedo 接入(最有价值子集)
`volumetricFogAlbedo?: number [0,1]`(默认 0.82,与引擎默认同值)贯通:`contracts/scene.ts` + `sceneValidation.ts`(类型 + 范围)→ `appDefaults.ts` → `viewerEngineRig.ts`(钳制白名单)→ `studioDeepColorEffects.ts`(写入 `medium.albedo`)→ 编辑器"散射反照率"滑块(沿用 `EffectRange` 既有令牌样式,无新增颜色)。关闭体积雾时零开销:字段不进入 `postProcess`(`volumetricFogProfile` 仍仅在开启时生成),pass 不实例化的既有行为不变。

### 3. 体积
不新增依赖。esbuild 对 `import { FixedStepClock } from "deep-engine/physics"` 做 tree-shaking + minify 实测 **1.1 KB**(整个 physics 桶不会进 viewer 包)。albedo 仅增 1 个数值字段与 1 个滑块。

## 验证

| 项 | 结果 |
|---|---|
| `deep-engine` `tsc --noEmit` | 无错 |
| `apps/web` `tsc --noEmit -p .` | 本任务文件无错;唯一报错 `ParticleCurveEditor.tsx(127) onBackgroundDoubleClick`(他人未完成,未触碰) |
| `deep-engine` `fixedStepDriver.test.ts` | 10/10(含 droppedTicks/discardRemainder 2 条新增) |
| `apps/web` `physicsWorldHost.test.ts` + `studioDeepColorEffects` + `ScenePostProcessingEditor` + `fixedStepRateParity` | 38/38 |
| `apps/web` 相关集(physics/postProcess/appDefaults/compileSceneEnvironment/viewerEngineRig/Simulation) | 174/175;唯一失败 `compileSceneEnvironment.test.ts:55` 期望缺 `displayProfile:"three-aces-r185"`——他人 displayContract 进行中,与本任务无关 |
| `contracts` 全量 | 473/473 |
| `scene-sdk` `behaviorScheduler.test.ts` | 5/5(新增变帧率确定性 1 条) |

**确定性单测**(`physicsWorldHost.test.ts` 新增 4 条):① 同 seed 抖动帧序列 ⇒ 逐帧步数序列与逐 tick 状态逐位相同;② 30/59.94/60/75/120/144 fps 与抖动流 ⇒ 总 tick 差 ≤ 1,且按 tick 索引的轨迹互为前缀(逐位相等);③ 3600 帧 1/60 s 恰 3600 tick、每帧 1 步;④ 真实 Rapier 刚体(含碰撞/回弹)在稳态与抖动帧划分下同 tick 轨迹逐位相等。

**GPU 截图(深色 1920x1080,Deep WebGPU,Chrome/RTX 4060)**:`apps/web/scripts/gate-volumetric-fog-albedo.mjs` 通过——滑块默认 0.82 → Home=0 保存回读 0 → End=1 保存回读 1 → 重载回显 1;Deep 画布左侧 700×840 区域 albedo 0 与 1 字节差异 99.3%(0:仅消光暗化;1:强散射泛白),证明参数真实进入 GPU march。证据:`test-output/runs/2026-09-05/fog-albedo-MREtH4/{fog-albedo-*.png,report.json}`(`BIM_FOG_WEB_ROOT` 需指向含最新 src 的 `vite build --mode development` 产物,因 `deep-engine/dist` 滞后于他人在做的 particles 导出)。

## 遗留
1. **跨环统一 tick**:行为(React RAF)与物理(viewer RAF)仍是两条独立时钟,脚本 `onFixedUpdate` 与物理步 1:1 对齐需要把 `host.fixedTick` 下发给 `SceneBehaviorScheduler`(scene-sdk 不依赖 deep-engine,需注入式 `advanceFixedTicks(n)`);属 World API `step()` 的前置,单独立项。
2. `viewerEngineSimulation.physicsFixedStepCount` 与 `host.fixedTick` 并存(前者含手动步进),后续统一到 host 轴时需决定手动步进是否计入。
3. `updatePhysics` 内既有的 160 ms 节流 `onModelChange`(React 回调)在渲染循环里,属存量,未动。
4. RGB 散射色/雾色需引擎 WGSL 扩展(禁区文件),未做;Deep Native 8 步积分不消费 albedo(沿用默认),编辑器提示文案已声明 Native 为受限积分。
5. 未做物理渲染 alpha 插值(见上)。
6. `omission-audit-20261004.md` #19 与 `upgrade-plan…` 第 15/61 行"体积雾零消费/FixedStepClock 未接"现已过期,待文档所有者勾销(本任务未改他人文档)。
