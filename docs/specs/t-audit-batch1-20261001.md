# 历史 T 全包剩余范围校准 · 第一批审计报告（T12/T14/T15/T16/T17/T18）

日期：2026-10-01。性质：**纯核查**，未改任何生产代码，未执行构建/测试；全部证据来自源码 grep、`git log/show`、实施报告与 `test-output/` 落盘。

权威依据：`docs/specs/remaining-tasks-estimates-20260930.md`"历史 T 全包的剩余范围校准"表。
**声明**：任务指定的 `docs/specs/remaining-tasks-20260930.md` **在仓库中不存在**（仅存在 estimates 一份），本报告以实际存在者为权威；未找到第二份文档的原因未深究，如后续补入需对本报告口径复核。

六组原核查工时合计 9–20h（1–2+2–4+2–4+2–4+1–2+2–4），本次全部执行完毕。结论统计：**已覆盖 12 项（可从待办删除）、仍缺 18 项（新拆任务行 18 条）、归属他项合并不重计 5 处**。

通用证据约定：09-28 之后落在 T12–T18 六组文件域上的后续提交，经逐文件 `git log --since=2026-09-28` 核对，**只有物理域（T18 归属的 F6/A3/A2）有大批覆盖提交**；六组自身的编辑器/引擎尾项文件均无后续覆盖提交（落库提交统一为 `7bdb73e0`"多线累积工作收口"）。

---

## 1. T12 再导入、依赖与几何处理（核查 1–2h，已完成）

**原尾项清单**（`docs/reports/deep-core/T12-implementation.md` + T12-geometry/T12-uv）：再导入协调器资源级 prepare/apply 无生产消费；编辑器无"覆盖保留/明确冲突"动线与修订提示 UI；资产包 provider 仅 STEP/IGES 接线；资产包存储无 GC；UV Atlas 重排与 LOD 链不在切片。估时表口径：L5 引用影响、稳定语义绑定、插件权限 E5。

**逐项核查证据**：

| 尾项 | 证据 | 结论 |
|---|---|---|
| L5 重命名/删除引用影响 | 纯路径重命名最小失效已实现（assetReimport 第二轮：仅改路径只发布该资源，`publishOrder`/`stageOrder` 定向证据见 T12 报告）；删除/重命名断链诊断含稳定构件 ID：`apps/web/src/viewer/modelReplacementCompatibility.ts:27`（"结构不兼容…N 处原引用断链"，列前 5 个具体 ID，原实例保留）；33+43 项 web 替换链测试 | **已覆盖**（核心语义）。独立"波及报告"用户面未见，属低优先 UI 增强，不单独立项 |
| 稳定语义绑定 | `apps/web/src/viewer/captureSceneModelState.ts` 写入 `assetRevisionSnapshot`；`apps/web/src/viewer/assetRevisionSnapshot.ts` 的 `detectStaleAssetRevisions` 已实现且有 3 项测试；**但全仓 grep 该函数零生产调用方**（仅定义与测试） | **仍缺**：编辑器加载后提示 + 一键更新动线未接 |
| 插件权限 E5 | 主计划 §9.2(b) 表明示 **E5 是 T22 子项**（"ConverterPluginManifest、插件 SDK"，S–M）；`packages/contracts/src/converter.ts:24` 已有 ConverterPluginManifest 合同（execution/capabilities/limits），隔离校验属 T22 域 | **归属他项**：归 T22，不重计 |
| 再导入协调器生产消费 | `DeepAssetReimportCoordinator` 生产代码仅 `packages/deep-engine/src/assetReimportCoordinator.ts`（定义）+测试；apps/web、apps/api 零命中 | **仍缺** |
| 资产包 provider 接线（JT/X_T/native GLB） | T12 报告明示仅 STEP/IGES 接线（`apps/api/src/conversion.ts:155` 调用 `publishModelDeepAssetPackage`） | **归属他项**：JT/X_T 归 T22 工业格式域核查，native GLB 归 N5-material-import 行，不重计 |
| 资产包存储 GC | blob 只增不删（T12 报告"剩余与边界"） | 观察项：有真实存储增长诉求时再立项（1–2h） |

**建议任务行**：
1. `T12-reimport-editor-link`：资产包再导入协调器接编辑器替换链（prepare/apply 贯通 CAS、覆盖保留/冲突动线）。文件：`apps/web/src/viewer/viewerEngineLoading.ts`、`useSceneModelInstances.ts`、`packages/deep-engine/src/assetReimportCoordinator.ts`。**4–8h，中信心**。依赖：无。
2. `T12-asset-revision-ui`：修订快照消费动线（加载后陈旧提示+一键更新）。文件：`assetRevisionSnapshot.ts` 消费方（AppStudioViewport/素材库面板）。**2–4h，高信心**。依赖：任务 1（或独立做只读提示版）。

---

## 2. T14 动画混合、导入与骨骼性能（核查 2–4h，已完成）

**原尾项清单**（T14 报告"剩余层"三节 + "未完成子项"）：根运动旋转应用、UI 开关、Native/WASM/TS 统一播放链、父链动画、多 clip、100/1000 GPU 骨骼成本、导入版本验证、圈修正根运动。估时表口径：TS 根运动与 pose 优化已有。

**逐项核查证据**：

| 尾项 | 证据 | 结论 |
|---|---|---|
| TS 根运动（平移）+事件合同+Rust 镜像 | `renderAnimationEvents.ts`/`renderAnimationPlaybackClock.ts`/`renderAnimationRootMotion.ts`；Rust `native_animation_events/playback_clock/root_motion.rs` 三文件跨端向量逐项一致（594 passed）；编辑器平移应用 `viewerEngineRootMotion.ts`（15 边界测试） | **已覆盖**（估时表口径确认） |
| 根运动**旋转**应用到实例 | `apps/web/src/viewer/viewerEngineRootMotion.ts:25`："旋转增量本切片只记录不应用(实例侧应用需同步抽除根骨骼旋转,留待下一切片)"；合同层旋转记录已有；09-28 后无覆盖提交 | **仍缺** |
| UI 开关 | `setModelRootMotion`/`setModelAnimationEventActions` 全仓无 .tsx 消费 | **仍缺** |
| Native/WASM 统一播放链 | `GltfRenderAnimationRuntime` 在 apps/web 与 deep-engine-wasm 零生产命中；WASM 仅包校验透传（events 随包可用）；`e1261af7`（10-01）只补编辑器 playhead 恢复，属 J3-E 域，不覆盖统一帧链 | **仍缺**（大项） |
| 父链动画/多 clip | 文件头注释明示"父链静态假设（标准角色层级成立）""多 clip 叠加语义未定义" | **仍缺**（父链动态为窄缺口，多 clip 为语义定义+镜像扩列） |
| 100/1000 GPU 骨骼成本 | CPU 投影全套已有：assets/ 下 4 份 Chrome JSON（100×24/1000×24/1000×64 + LOD 配对，最新 P95 97.3ms LOD-on）；GPU 仅单顶点读回（≤1e-4）；`gpuSkinning.ts`/`StudioDeepWebGpuBridge.ts` grep 无 palette 上传/绘制遥测 | **仍缺**：GPU 上传/绘制 P50/P95、端到端帧时、真实资产对拍 |
| 导入版本验证（asset hash/schema/bind pose 读回） | 全仓 grep 无实现；T14 报告未完成子项 4 | **仍缺** |
| 圈修正根运动（合同层） | 合同层如实记录回绕不连续量；编辑器层已用段采样回绕校正解决实际位移 | **已覆盖**（编辑器策略层）；合同层 cycle-corrected 为可选增强，不单独立项 |

**建议任务行**：
1. `T14-root-rotation-apply`：根运动旋转应用到实例（同步抽除根骨骼旋转防双转）。文件：`viewerEngineRootMotion.ts`。**2–4h，中信心**。
2. `T14-rootmotion-ui`：根运动/事件动作 UI 开关（模型动画面板或属性页）。**2–4h，高信心**。可与任务 1 同切片。
3. `T14-gpu-skin-cost`：GPU palette 上传/compute/draw P50/P95 + 端到端帧时 + 真实 64 关节资产。与 pose LOD 下一刀（包络供给、65k 节点遍历优化）合并执行。**4–8h，低信心**。
4. `T14-import-version`：压缩/重导入 asset hash+schema+bind pose 读回校验。**2–4h，中信心**。
5. `T14-unified-playchain`：Native/WASM/TS 统一播放帧链（宿主驱动 NativeAnimationPlaybackClock + WASM 事件查询 ABI + 编辑器可选消费）。**8–16h，低信心**（跨三端合同，建议排在 J/C 后继之后）。

---

## 3. T15 Rig、IK、重定向与姿态搜索（核查 2–4h，已完成）

**原尾项清单**（T15 报告 §4）：Native/WASM/GPU IK、脚滑、大库姿态索引/过渡混合、A5 骨架命名。估时表口径：52 测数学层不重做。

**逐项核查证据**：

| 尾项 | 证据 | 结论 |
|---|---|---|
| TS 纯数学层 | `ikSkeleton.ts`(561 行,15 测)/`ikPoseSearch.ts`(248,7 测)/`ikRetarget.ts`(238,12 测)，35 用例全绿；且有生产消费方 `robotSweepCollision.ts:10`（import skeletonFK，N10 机器人扫掠在用） | **已覆盖**（不重做） |
| Native/WASM/GPU IK | deep-engine-native/wasm 全量 grep 零 IK 命中；GPU 顶点路径无 IK | **仍缺** |
| 脚滑 | T16 已做 `SlidingDownSlope` 状态判定（接地法线探针）；"站滑平移加速度"与"步行动画闭环脚滑验收"未做 | **归属他项**：归 T16 角色物理行（见 §5），不重计 |
| 大库姿态索引/过渡混合 | `ikPoseSearch` 是种子网格+IK 精修+小库暴力对拍；无大库索引结构、无过渡混合 | **仍缺** |
| A5 骨架命名（Mixamo 类） | 全仓 grep mixamo/骨架命名兼容零命中；主计划 §9.2(b)：A5 是 T15 子项，S，P2 | **仍缺** |
| 跨端对拍 | 无 | 并入"Native/WASM IK"行 |

**建议任务行**：
1. `T15-a5-skeleton-naming`：Mixamo 类开源骨骼命名约定兼容（映射表进 `ikRetarget` 三档体系+1 个样例资产）。**2–4h，中信心**。
2. `T15-pose-library`：大库姿态索引（特征向量+近邻检索）与过渡混合。**6–12h，低信心**（主计划验收"大库质量/延迟报告"需实测）。
3. `T15-ik-crosshost`：Native/WASM IK 镜像与 GPU 姿态消费（低优先；无工业消费方前可挂起）。**6–12h，低信心**。

---

## 4. T16 角色、面部与运行镜头（核查 2–4h，已完成）

**原尾项清单**（T16 报告两节"剩余子项"）：编辑器消费未接、滑行平移、镜头轨道/阻挡、面部 morph、WASM 端口、查询 BVH 成本。估时表口径：角色状态核心已有。

**逐项核查证据**：

| 尾项 | 证据 | 结论 |
|---|---|---|
| 角色状态机/固定仿真确定性 | `native_character_motion.rs`（Grounded/Sliding/Airborne+事件）；golden 轨迹 `test-output/t16-character/golden-trajectory.json`（FNV 位级复现）；四渲染率 f32 位级一致 | **已覆盖**（估时表口径确认） |
| 角色根运动与编辑器（动画→物理接线） | `queue_character_root_motion` 在 apps/web 与 deep-engine-wasm **零命中**；`viewerEngineSimulation.moveCharacter`（:114）存在但无动画源调用方；`player_content` 动画采样循环与固定时钟接线未做 | **仍缺**（T16 最核心剩余） |
| 滑坡判定 | 接地法线探针判坡角已做（含探针缺失回落） | **已覆盖** |
| 站滑平移加速度 | T16 报告明示待后续切片 | **仍缺**（小项） |
| 查询 BVH 每 tick 全量重建 O(N) | `needs_broad_phase_update` 差集优化未做 | **仍缺**（性能小项，与站滑合并） |
| 镜头（第三人称跟随+阻挡） | `runtimeFollowCamera.ts` 已交付（17/17 测；真实网格墙正反例）；报告如实声明**未过浏览器视觉闭环**，留主会话实测 | **已覆盖**（实现）；视觉验收挂 E2/Z4 深色截图批 |
| 多机位编排/混合/Impulse | 主计划 §9.2(b)：**A4 是候补项**（"机位编排 T16 子项 S–M"）；估时表"R1/R5、A2/A4、U1"行已列每族 1–2h 核查 | **归属他项**：归 A4 候补，不重计 |
| 离线 morph（面部） | 导入解码已有（`decodeMorphGlb.ts`/`decodeAnimatedMorphSkinnedGlb.ts`）；Deep WebGPU morph GPU target 已有（renderAnimationRuntime）；**编辑器侧 morph 参数/关键帧驱动消费零命中**（无 UI、无 setMorphWeight） | **仍缺** |
| WASM 角色阶段/事件暴露 | `deep-engine-wasm/src/lib.rs` 零 character 命中 | **仍缺**（小项，依赖 WASM 播放消费路径） |

**建议任务行**：
1. `T16-rootmotion-editor-physics`：编辑器动画源→根运动水印协议→`queue_character_root_motion` 逐 tick 投递（含 player_content 采样循环与固定时钟接线）。文件：`viewerEngineSimulation.ts`、`runtime_package/player_content.rs`。**4–8h，中信心**。依赖：无。
2. `T16-character-polish`：站滑平移加速度 + 查询 BVH 差集重建 + WASM 角色 phase/event 最小暴露。**4–8h，中信心**。
3. `T16-facial-morph`：离线面部 morph 关键帧/参数驱动到编辑器消费（复用既有 morph 解码+GPU target，补编辑器驱动与 UI）。**6–12h，低信心**（有真实面部资产/需求时提级）。

---

## 5. T17 刚体、碰撞与机构约束（核查 1–2h，已完成）

**原尾项清单**（T17 报告"整包最终剩余"）：跨端通用容差冻结、位置马达/几何齿轮、collider 来源选择器 UI、凹体凸分解、B-Rep 直读。估时表口径：CAD→collider 已有，查剩余。

**逐项核查证据**：

| 尾项 | 证据 | 结论 |
|---|---|---|
| CAD→collider 来源规范 | `apps/api/src/physicsColliderSource.ts`（quickhull+精度标记）+ 三端贯通 + golden `test-output/t17-collider/golden-machine-hull.json` + Native `native_physics_collider_tests.rs`（23 通过）；`cast_ray` 生产查询 | **已覆盖**（可从估时表删除该疑虑项） |
| 四黄金核心（CCD/堆叠/铰链/机构）+ 面板视觉验收 | `rapierPhysics*Golden.test.ts` 五文件 17+8 项；机构跨端配对 ≤5mm 全过（`t17-mechanism/`）；面板两轮浏览器视觉验收 10 维全 ≥9（`t17-panel-visual/`） | **已覆盖** |
| WASM 黄金 | CCD 浏览器实测 `t17-wasm-ccd/browser-e2e.json`（fixedStep=15、x=-0.519、errors=[]）；collider golden 的 WASM 端未单独跑（物理模块与 Native 同源，cargo check 过） | **已覆盖**（CCD）；collider golden WASM 端为低风险余项（<1h，随下次 WASM 重跑顺手补） |
| 跨端通用数值容差冻结 | 堆叠+机构两场景实测 ≤5mm/≤0.02rad；**未冻结为通用容差**（T17 报告明示需多场景定标） | **仍缺**（小项） |
| collider 来源选择器 UI | `ScenePhysicsPanel.tsx` 只有显示/隐藏线框；无来源选择；作者侧入口仅合同字段+生成 API | **仍缺**（小项） |
| 凹体凸分解 | `physicsColliderSource.ts:16`"凸分解(凹体多凸)不在本切片"；`sdfCollisionBridge.ts:4`"Web Rapier 0.19.3 无 convexDecomposition、无 VHACD 入口"。注意 A2 已交付 SDF 凹体碰撞 profile（opt-in，`13eb2187`）作为碰撞感知替代路径 | **仍缺**（凸分解 collider 本体；依赖 compat 升级或自研分解；与 A2-next 行"凹体消费 profile 接缝核查"相邻，合并核查） |
| B-Rep 直读 | 无实现 | **归属他项**：T22 工业格式域（主计划"凹体凸分解/B-Rep 直读按需立项"），不重计 |
| 位置马达/几何齿轮约束 | 合同未含；导轨往复已由曲柄驱动覆盖；C5 已有独立 Bullet 齿轮 oracle（`a1a405fe`，`t17-motor-gear/`）；D2 可微标定有独立行 | **归属他项/条件项**：真实往复导轨需求出现再立项，不重计 |

**建议任务行**：
1. `T17-collider-source-ui`：ScenePhysicsPanel 增 collider 来源选择器（render-bounds/convex-hull/simplified-mesh/primitive 四态+精度标记展示，复用既有令牌）。**2–4h，高信心**。
2. `T17-tolerance-freeze`：跨端通用容差冻结（增 CCD+铰链+组合机构场景配对定标，产出冻结容差文档与断言）。**2–4h，中信心**。
3. `T17-concave-decomposition`：凹体凸分解（评估 compat 升级带 convexDecomposition 或自研 VHACD；与 A2-next 凹体消费接缝合并核查）。**4–8h，低信心**。

---

## 6. T18 布料、毛发、软体、破碎与车辆（核查 2–4h，已完成）

**原尾项清单**（T18 报告"剩余子任务"+A3-t18-gpu 报告）：碰撞与自碰撞、Rapier 接线、渲染消费、破碎求解、车辆、宿主接线。估时表口径：赛车级轮胎/动态断裂已排除；F6/A3 归属他行。

**逐项核查证据**：

| 尾项 | 证据 | 结论 |
|---|---|---|
| CPU 参考五族求解器 + 50 测 | `packages/deep-engine/src/physics/`（cloth/softBody/hairChain/fracture/vehicleReference + fixedStepDriver），整包 543 文件全绿 | **已覆盖** |
| 布料/软体 GPU + 生产接线 | **F6/A3 已大幅覆盖**：`3206952f`（A3 并行核+constraint coloring+真机 WebGPU 读回 9.0e-3m 内）、`b06d8086`（F6 生产换核 dispatchClothStepAuto+遥测）、`d03d8c60`（F6 生产会话+预算护栏）、`a51904e2`（J3 跨端指纹 4 场景逐位） | **归属他项**：归 F6/T18-collision 行（估时表 F 系列 12–24h），合并不重计 |
| SDF 凹体碰撞 | `13eb2187`（A2 WGSL SDF 碰撞 profile opt-in+凸包真值双端对照） | **归属他项**：归 A2-next 行，合并不重计 |
| 毛发（毛囊分布/头皮、接线、渲染） | `hairChainSolver.ts` 仅 CPU 参考；全仓无毛囊分布/头皮/渲染消费 | **仍缺**（独立小任务） |
| 破碎（冲击求解/碎块刚体化） | `fractureReference.ts` 只有预破碎数据结构+能量簿记；**"动态断裂"在估时表明确不做清单**；预破碎按需消费 | **归属他项**：动态断裂=排除项；预破碎消费挂条件触发，不重计 |
| 车辆（轮胎接触/raycast vehicle/整车四轮） | 1/4 车静态悬挂解析参考+固定步长对照已有（误差 0.006%/0.008%）；RayCastVehicle/raycastVehicle 全仓零命中；"赛车级轮胎"已排除 | **仍缺**：非赛车级 raycast vehicle 整车四轮（窄任务，低优先） |
| 自碰撞 | 未开始 | **仍缺**（估时表已注明"自碰撞仍独立子项"，保留观察，无消费方前不排） |
| FixedStepClock 宿主接线 | grep 仅 `physics/fixedStepDriver.ts` 自身；编辑器/帧循环无消费（Native 侧角色/物理已有独立固定时钟） | **仍缺**（小项） |

**建议任务行**：
1. `T18-hair-minimal`：毛发最小闭环（毛囊分布+1 条生产消费路径或可视化）。**4–8h，低信心**（有毛发展示需求时提级）。
2. `T18-vehicle-integral`：Rapier raycast vehicle 整车四轮（非赛车级；复用 1/4 悬挂参考校准）。**6–12h，低信心**。
3. `T18-fixedstep-host`：`FixedStepClock` 接宿主帧循环 + 跨帧率渲染无关测试。**1–2h，高信心**（与 T19 时钟同族，执行时合并验证）。

---

## 7. 汇总与估时表更新建议

### 三选一统计

| 组 | 已覆盖（可删） | 仍缺（新拆行） | 归属他项（不重计） |
|---|---|---|---|
| T12 | L5 核心语义（最小失效+断链诊断） | 2 行 | E5→T22；JT/X_T provider→T22；native GLB→N5 |
| T14 | TS 平移根运动+事件合同+Rust 镜像+编辑器回绕校正；合同层圈修正（策略层已覆盖） | 5 行 | playhead 恢复已在 J3-E（e1261af7） |
| T15 | TS 数学层（35 测+N10 消费中） | 3 行 | 脚滑→T16 |
| T16 | 角色状态机+golden+跨帧率确定性；滑坡判定；第三人称镜头实现 | 3 行 | 多机位/Impulse→A4 候补 |
| T17 | CAD→collider；四黄金核心；面板视觉验收；WASM CCD 黄金 | 3 行 | B-Rep→T22；位置马达/齿轮→条件项+C5/D2 已有口径 |
| T18 | CPU 五族参考+50 测 | 3 行 | 布料/软体 GPU+生产接线→F6/A3；SDF 凹体→A2-next；动态断裂→排除项 |

**合计：已覆盖 12 项 / 仍缺 18 项 / 新拆任务行 19 条（上表 2+5+3+3+3+3=19）/ 归属他项 5 处。**

### 新拆任务行净投入合计

- 高信心（可近期排）：T12-asset-revision-ui 2–4h、T14-rootmotion-ui 2–4h、T17-collider-source-ui 2–4h、T18-fixedstep-host 1–2h = **7–14h**
- 中信心：T12-reimport-editor-link 4–8h、T14-root-rotation-apply 2–4h、T14-import-version 2–4h、T15-a5-skeleton-naming 2–4h、T16-rootmotion-editor-physics 4–8h、T16-character-polish 4–8h、T17-tolerance-freeze 2–4h = **20–40h**
- 低信心/低优先（按需提级）：T14-gpu-skin-cost 4–8h、T14-unified-playchain 8–16h、T15-pose-library 6–12h、T15-ik-crosshost 6–12h、T16-facial-morph 6–12h、T17-concave-decomposition 4–8h、T18-hair-minimal 4–8h、T18-vehicle-integral 6–12h = **44–88h**

**新拆净投入合计 71–142h**（不含已归属 F6/A3/A2/T22/A4 的范围）。

### 估时表操作建议

1. "历史 T 全包的剩余范围校准"表中 T12/T14/T15/T16/T17/T18 六行：核查工时**已消耗**，从"21 组旧 T 尾项核查 27–54h"池中扣除对应 9–20h；每行改注"已核查，见 t-audit-batch1-20261001.md"。
2. 上表 19 条新行按优先级插入执行表：高信心 4 行可随当前 J/C 收尾批次顺带；中信心 7 行进"其他"域；低信心 8 行保持挂起，出现真实消费方/需求再提级（与"观察、条件触发"表同策略）。
3. 明确"合并不重计"5 处照录，防止后续重复立项。

### 诚实条款

- 本审计为静态核查：未运行任何测试/构建；所有"通过"结论均引用既有报告与 `test-output/` 落盘证据，未复跑。
- "仍缺"判定依据是"源码 grep 无命中 + 对应文件域 09-28 后无覆盖提交"；未排除未跟踪工作树中存在草稿的可能（`git status --short` 快照未逐文件复核未跟踪目录内容，风险低——六组尾项文件的未跟踪状态在报告写作时已确认为报告自身）。
- T16 镜头、T17 面板等实现虽标记"已覆盖"，其浏览器视觉闭环状态以原报告声明为准（T16 镜头明示未过视觉闭环，已挂 E2/Z4 批次）。
- `docs/specs/remaining-tasks-20260930.md` 不存在，若用户另有此文档，需对齐后复核本报告。
