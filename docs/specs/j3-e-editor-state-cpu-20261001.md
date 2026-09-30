# J3-E 完整编辑器状态恢复 —— CPU 侧审计与播放头修复

日期：2026-10-01。本切片只做 CPU 可验部分：编辑器恢复域完整审计（覆盖矩阵）、未恢复域的协议扩展与修复（动画播放头）、聚焦测试。GPU/驱动语义不动；自动 unknown-loss、Native 窗口 present、驱动显存与帧时仍归 GPU 线。

## 现状核查（六步）

| 六步 | 已有（不重建） | 真实缺口 → 本切片交付 |
|---|---|---|
| 1. 源码与未跟踪 | 检索 `useScenePlayMode`/`applyScene`/`recover`/`rendererSnapshotRef`/`RendererRecoveryState`：恢复状态机（`deviceRecovery.ts` C13）、`DeviceSession` 会话内重建、`StudioDeepWebGpuBridge.replaceRecoveredBackend` 完整重建、`onRendererDeviceLost` 快照恢复链、T30 Play 隔离均已存在。本次新增文件与在途 B5/HDR/J3 纹理文件无交集。 | 渲染器重建恢复只按 SceneSnapshot 走，快照协议不含瞬时编辑器状态；无逐域覆盖审计。 |
| 2. 契约层 | `SceneSnapshot`（scene.ts:909）已含相机/模型/图元/测量/标注/环境/动画策略/选择等 30+ 可选域；`SceneAnimationState` 明确只含策略与关键帧，不含播放时刻；`RendererRecoveryState` 是会话内渲染器重建的恢复协议。 | 播放头无落点。本切片不改 contracts 持久化格式（避免污染已保存场景与旧快照逐位性），扩展会话内协议 `RendererRecoveryState.animationPlayheadSec`。 |
| 3. 依赖 | React/vitest/既有 transient channel 基建在用。 | 零新增依赖。 |
| 4. 消费方 | `applyScene`（scenePersistenceController:200）是撤销/重做/导入/路由/Play 退出/渲染器恢复的共同恢复路径；`rendererSnapshotRef` 三个 producer：设备丢失（useAppRuntimeEffects:364）、WebGPU 回收（scenePersistenceController:212）、返回编辑器（useAppNavigationController:131）；唯一 consumer 是 useAppRuntimeEffects 恢复 effect（:477）。 | 修改必须同族覆盖三个 producer 与一个 consumer，不得只修设备丢失一条。 |
| 5. 测试与证据 | `sceneWorkspaceSave.test.ts`（17 测）、`useScenePlayMode.test.ts`（14 测）、`useAppRuntimeEffects.rendererSwitch.test.ts`（7 测）、`useAppNavigationController.test.ts`（5 测）、Gate E 双端 destroy/lost/reopen 真机证据（window-recovery 规格）。既有证据只锁定 box 身份/相机数组/package hash，未锁播放头。 | 新增聚焦测试锁播放头三态（恢复/缺省归零/非法值忽略）；家族回归全绿。 |
| 6. 规格与台账 | `j3-gate-e-window-recovery-current-state-20260930.md` 把"完整编辑器状态"列为 Gate E 剩余项之一；remaining 估时表 J3-E-GPU 6–12h；T30 报告确立"播放态不入恢复语义"。 | 本规格回填该剩余项的 CPU 部分；矩阵中"不适用/未覆盖"逐项如实标注，不冒充完成。 |

**已有（不重建）**：双端真实 destroy/lost/reopen/首帧稳定、Gate E CPU 首刀（scope=production-host-components-cpu）、Native 恢复重试上限 3（aa6ade7d）、Web 非 recovery lost 一次性通知、`applyScene` 全量恢复路径与 C25 增量分支。

**真实缺口**：编辑器瞬时状态（播放头）在三类渲染器重建中静默归零；无域级覆盖矩阵。

## 编辑器状态域 × 恢复路径覆盖矩阵

恢复路径：**P1** Web 会话内设备重建（DeviceSession 恢复 → 桥 `replaceRecoveredBackend` 完整重建 WebGPU 后端；React/Three 作者状态不卸载）；**P2** Web fatal→WebGL 回退（`onRendererDeviceLost` → rendererGeneration 重建 viewer → `rendererSnapshotRef` → `applyScene`）；**P3** Native 窗口重建（NativeApp recovery，last-good package/view）；**P4** 崩溃恢复草稿（IndexedDB 草稿 → 重启 `applyScene`；与 P2 同一快照协议，纳入审计）。

| 状态域 | 捕获/恢复载体 | P1 | P2 | P3 | P4 |
|---|---|---|---|---|---|
| 相机位姿/模式/头像可见 | snapshot.camera + applyCamera | 已保留（常驻） | 已恢复 | 已验（author view） | 已恢复 |
| 相机约束/导航设置 | snapshot ✓ applyScene ✓ | 已保留 | 已恢复 | 不适用（Native 协议） | 已恢复 |
| 相机视图/默认视图 | snapshot.cameraViews ✓ | 已保留 | 已恢复 | 不适用 | 已恢复 |
| 模型/图元位姿与作者材质参数 | captureSceneModelState（含 material override）✓ | 已保留 | 已恢复 | 已验（package hash） | 已恢复 |
| 选择（模型/图层/标注） | snapshot.selected* ✓ applyScene 重选 ✓ | 已保留 | 已恢复 | 已验（selection） | 已恢复 |
| 测量/标注 | snapshot ✓ | 已保留 | 已恢复 | 不适用 | 已恢复 |
| 环境/灯光/天气/楼层/后处理/物理/剖切/坐标系 | snapshot ✓ | 已保留 | 已恢复 | 已验（package 环境） | 已恢复 |
| 动画策略（时长/循环/关键帧/状态机） | snapshot.animation ✓ | 已保留 | 已恢复 | 不适用 | 已恢复 |
| **动画播放头（瞬时）** | **快照协议不含 → 本切片：RendererRecoveryState.animationPlayheadSec + applyScene 第 9 参** | 已保留（引擎常驻，不经快照） | **已修复（本切片）** | 不适用 | 未恢复（草稿=上次保存事实，播放头不落盘；如实保留） |
| 撤销栈 | React 内存（sceneHistoryRef） | 已保留 | 已保留（重建 viewer 不清栈） | 不适用 | 不适用（设计豁免：栈不持久化，T27 单一会话序） |
| 组织面板选择（selectedSpace/organizationSelection） | applyScene 显式清空、快照无域 | 已保留 | 未恢复（UI 轻微，如实声明） | 不适用 | 未恢复（同左） |
| 面板/工具态（变换工具/捕捉/网格等 UI 会话态） | 不入场景快照（设计豁免） | 已保留 | 不适用 | 不适用 | 不适用 |
| 数据绑定运行时缓存 | transient，设计豁免 | 重建 | 不适用（重连重建） | 不适用 | 不适用 |
| 交互脚本/数据绑定/资产绑定/selectionSets/rootLayerOrder | snapshot ✓ | 已保留 | 已恢复 | 不适用 | 已恢复 |
| 发布元数据/thumbnail/simulationEntities | snapshot + setActiveScene 全量接管 ✓ | 已保留 | 已恢复 | 不适用 | 已恢复 |
| dashboard/工程分析 | snapshot ✓ | 已保留 | 已恢复 | 不适用 | 已恢复 |
| 场景名/项目归属 | snapshot ✓ | 已保留 | 已恢复 | 已验 | 已恢复 |
| Deep 专属显示态（HDR/性能源/质量遥测会话） | 随 Deep 会话生命周期 | 重建后按当前作者状态重建 | 设计豁免（回退=释放 Deep 态） | 不适用 | 不适用 |
| Play 模式活跃态 | T30：恢复语义=编辑态 | 未覆盖（Play×Recovery 交叉，如实声明） | 未覆盖（同左） | 不适用 | 不适用 |
| 行为图/脚本编辑草稿 | pendingBehaviorDraftRef 常驻；openDocs 先 flush 落库 | 已保留 | 已保留 | 不适用 | 已恢复（草稿持久化） |
| Native UI 域（面板/停靠等） | Native 线协议 | 不适用 | 不适用 | 已验范围仅 view/selection/package，其余 Native 线另证 | 不适用 |

矩阵判定：P2 的相机/选择/环境等 16 个作者域走同一 `applyScene` 路径，恢复事实与撤销/重做同源；P1 的编辑器域不经过快照（React/Three 常驻），其"已保留"是结构性事实，已验样例域（box/相机，window-recovery 规格）为证据下限而非全域证明——如实声明。

## 本切片修复：渲染器重建保留动画播放头

**缺陷**：`applyScene` 恢复一律 `seekSceneAnimation(0)`；P2（设备丢失→WebGL 重建）播放头静默归零。同族三个 producer 共用 `rendererSnapshotRef`，按同族条款一并修复：

1. **协议扩展** `apps/web/src/viewer/rendererRecoveryState.ts`：新增 `animationPlayheadSec?: number | undefined`（会话内协议，不入持久化 SceneSnapshot，旧快照/已保存场景逐位不变）。
2. **读取** `apps/web/src/viewer/animationPlayheadReader.ts`（新增）：与 App 播放宿主 `readAnimationPlayhead`、`sceneAnimationCommands` 同源读引擎 transient "animation" 通道；通道缺失/抛错/非正有限值一律 undefined（=归零语义）。
3. **三个 producer**：设备丢失（useAppRuntimeEffects，从存活 viewer 读）、WebGPU 回收（scenePersistenceController，从 engine 读）、返回编辑器（useAppNavigationController，从 engine 读）。
4. **恢复** `applyScene` 第 9 参 `restoreAnimationPlayheadSec`：归零重放基线之后 `seekSceneAnimation(playhead)` + `setAnimationTime(playhead)`（clamp 归引擎）；缺省/0/负/非有限值忽略。consumer（useAppRuntimeEffects 恢复 effect）透传 `pending.animationPlayheadSec`。
5. **不动 GPU 语义**：恢复仍先停播放态（`setAnimationPlaying(false)`），播放头只回位不自动播放。

### 测试（`apps/web/src/controllers/sceneRendererRecoveryPlayhead.test.ts`，7 项全绿）

- helper：正常值/undefined 通道/0/负/NaN/通道抛错。
- applyScene 第 9 参 12.5 → seek 序列 `[0, 12.5]`、`setAnimationTime(12.5)`、`setAnimationPlaying(false)`、恢复代际完成。
- 缺省第 9 参 → seek 仅 `[0]`（撤销/导入/路由路径逐位不变保证）。
- 0/负/NaN/+Inf → 等价 undefined。
- WebGPU 回收 producer → `rendererSnapshotRef.animationPlayheadSec = 7.25` 随快照落位。

### 家族回归（全绿）

```text
src/controllers/sceneWorkspaceSave.test.ts           17 passed
src/controllers/sceneRendererRecoveryPlayhead.test.ts 7 passed
src/controllers/{playSessionRestore,playSessionRestoreTiming,sceneAnimationCommands,sceneFileTransferReadiness}.test.ts  23 passed
src/hooks/useScenePlayMode.test.ts                   14 passed
src/hooks/{useAppRuntimeEffects.rendererSwitch,useAppNavigationController}.test.ts  12 passed
```

## 范围与诚实声明

- 本切片未修：P4 草稿路径播放头（草稿语义=上次保存事实）、组织面板选择/selectedSpace（UI 轻微，无恢复诉求证据）、Play×Recovery 交叉（T30 恢复语义未定义播放中设备丢失，需先裁决再动）。
- 未触 GPU：自动 unknown-loss 完整宿主替换（`pbrRenderer` 属 I-C26 专线锁）、Native 窗口 present、驱动显存/上传/帧时，仍归 GPU 线（window-recovery-current-state 规格口径不变）。
- `tsc --noEmit` 本切片文件零错误；仓内存在其他并行任务组未跟踪文件的既有类型错误（`src/viewer/robotSweepCollision.ts`、`src/viewer/__rapierDebug.test.ts`，均 `??` 未跟踪），非本切片引入、按铁律不碰。
- P1"已保留"是结构事实+样例证据；全域级 GPU 帧级证明仍归完整 Gate E J5 验收。
