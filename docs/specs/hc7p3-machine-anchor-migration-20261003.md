# H-C7-P3 行切片：状态机锚迁移宿主编程口（animation.set-anchor）— 2026-10-03

刀口：`apps/web/src/commands/SceneReferenceCleanupPort.ts:153-156` 删除流 fail-closed 语境——
删除被状态机初始/活动锚引用的对象时整批拒绝，错误文案"请先迁移状态机锚再删除（fail-closed）"，
但宿主没有任何迁移锚的编程口，用户被引导到一个不存在的操作。本刀补该口：`animation.set-anchor`
命令（scene 级、可撤销、零新增 UI），面板按钮属后续。

## 现状核查（六步，2026-10-03 完成）

1. **全仓 grep**（`initialStateId|activeStateId|stateMachine`，含未跟踪面）：
   - `animation.set-anchor` 全仓 0 命中——无重复建设，真实缺口成立。
   - 消费面全景：contracts 契约、deep-engine runtime 校验、web 的删除流/状态机编辑器/
     交付编译/运行时播放/导入重绑/引擎序列化。
2. **契约层**：`packages/contracts/src/scene.ts:775-787` `SceneAnimationStateMachineState`
   `{ enabled, initialStateId, activeStateId, transitionDuration, states, parameters?, transitions?, events? }`
   已存在——**contracts 零改**。命令形状进 scene-sdk protocol（与 lighting.set 同层），不进 contracts。
3. **依赖**：scene-sdk 自带 `commandValidationFields` 全套 helpers（`parseRequiredIdentifier` /
   `parseOptionalIdentifier` / `rejectUnknownProperties`，空串已在 `parseIdentifier` 拒绝）；
   无新增依赖。
4. **消费方与权威态持有者**（关键考古结论）：
   - **引擎权威态**：`apps/web/src/viewer/viewerEngineSimulation.ts` `getSceneAnimation()`
     （structuredClone 只读出）/ `setSceneAnimation()`（structuredClone 写入 + 规范化）。
     stateMachine 随整份 SceneAnimationState 进出；`viewerEngineSimulation.ts:617` 序列化带上它。
   - **React draft 态**：`apps/web/src/hooks/useAppState.ts:205` `sceneAnimation`/`setSceneAnimation`；
     UI 面板 `SceneAnimationStateMachineEditor.tsx` 编辑 draft 后经 `sceneAnimationCommands.ts:18-19`
     `setSceneAnimation(next); engine?.setSceneAnimation(next)` 全量推引擎——**双份状态，
     命令只改引擎会被下次 UI 编辑的 draft 全量覆盖**，与 H-C7-P4 B5 lighting 同构问题。
   - **保存链路**：`sceneSnapshotFactory.ts:93` `animation: engine.getSceneAnimation()`（引擎侧）；
     但 UI 编辑覆盖路径使 draft 回写仍是必需（B5 模式：useEditorPresence committed 后合并 draft）。
   - **删除流**：`SceneReferenceCleanupPort.ts:153-155` 锚守卫拒绝（保留）；容器由
     `SceneGraphTransactionDriver.ts:207-211` 在删除前 snapshot/prune/restore。
5. **测试与证据**：三层模板齐备——scene-sdk `commandValidation.test.ts:182`（lighting.set 校验）、
   `sceneCommandTransaction.test.ts`（capability/scene-mismatch）；web `ViewerSceneCommandPort.test.ts`
   / `SceneCommandExecutor.test.ts` / `editorSceneWriteDriver.test.ts:172`（B5 capturing 透传与
   fail-closed 回滚）/ `SceneReferenceCleanupFamily.test.ts`（引用消费族）。
6. **规格文档**：`docs/specs/jc-i-continuation-20261001.md` 只读；本文件为本刀产出。

**结论：已有（不重建）**——状态机契约、引擎读写面、删除流拒绝路、B5 场景级命令三段模板
（protocol/validation/transaction + executor/port + capturing/replay + draft 回写）。
**真实缺口**——`animation.set-anchor` 命令全链（合同→校验→executor→port→逆算子→draft 回写）
与"拒绝→迁移→删除"闭环用例。

## 设计（对齐既有模式，不建第二系统）

- 命令：`{ id, type: "animation.set-anchor", sceneId, anchor: { initialStateId?, activeStateId? } }`
  —— scene 级（同 lighting.set 携 sceneId），anchor 至少一项；id 非空字符串由
  `parseOptionalIdentifier`（空串在 parseIdentifier 拒绝）保证。
- capability：`["studio.animation"]`（同 animation.control）。
- 执行链：SceneCommandExecutor sceneScopeError（sceneId 名单）+ `port.setAnimationAnchor?`
  分发（缺省 unsupported）→ ViewerSceneCommandPort 校验目标状态存在于引擎权威态
  `stateMachine.states`，未知状态 fail-closed 人话错误；写经 `setSceneAnimation` 全量回写
  （引擎规范化口径，不旁路）。
- 可撤销：`EditorSceneStateReader` 增 `getSceneAnimation?()`；capturing 捕获旧锚
  （`InverseOperation` 增 kind `"animation-anchor"`，绝对值逆算子、幂等重放——与
  lighting/environment 同构；无状态机时不捕获，port 会拒绝写入）；draft 回写
  `sceneMetadataDraftPatch` 增 `animationAnchorPatch`，useEditorPresence committed 后合并。
- 删除流拒绝文案保持不动（现在宿主真有了迁移口）；补"拒绝→迁移→删除成功"顺序用例。

## 实现（分层落点）

| 层 | 文件 | 改动 |
|---|---|---|
| scene-sdk | `src/protocol.ts` | SceneCommand 联合增 `animation.set-anchor` |
| scene-sdk | `src/commandValidation.ts` | COMMAND_TYPES + `case "animation.set-anchor"` 校验 |
| scene-sdk | `src/sceneCommandTransaction.ts` | commandSceneMismatch 名单 + requiredCapabilities |
| web | `src/behavior/SceneCommandExecutor.ts` | Port 接口 + sceneScopeError + commandTargets + dispatch |
| web | `src/behavior/sceneCommandPolicy.ts` | requiredCapability → studio.animation |
| web | `src/behavior/ViewerSceneCommandPort.ts` | setAnimationAnchor 消费（fail-closed 校验） |
| web | `src/studio/editorSceneWriteDriver.ts` | 逆算子捕获/重放 + animationAnchorPatch |
| web | `src/hooks/useEditorPresence.ts` | committed 后 draft 回写 |

## 证据（2026-10-03 实测）

### 分层落点（全部对齐既有模式，无第二系统）

- scene-sdk：`protocol.ts` SceneCommand 联合增 `animation.set-anchor`（scene 级 anchor）；`commandValidation.ts`
  COMMAND_TYPES + 专用 case（`rejectUnknownProperties` 只认 `initialStateId/activeStateId`，复用
  `parseOptionalIdentifier`——空串/非串在 `parseIdentifier` 拒绝，空 anchor 报
  "Expected at least one anchor field"）；`sceneCommandTransaction.ts` sceneId 名单 +
  `requiredCapabilities → ["studio.animation"]`。
- web 执行链：`SceneCommandExecutor.ts` Port 接口 `setAnimationAnchor?` + sceneScopeError 名单 +
  commandTargets 空表 + dispatch（端口缺省 unsupported "当前宿主尚未连接状态机锚迁移。"）；
  `sceneCommandPolicy.ts` requiredCapability 同映射。
- web 消费：`ViewerSceneCommandPort.setAnimationAnchor` 读引擎权威态 `getSceneAnimation()`，
  无状态机 / 未知状态 fail-closed 人话拒绝（列出已声明状态），写经 `setSceneAnimation` 全量回写
  （引擎规范化口径：clamp/排序/structuredClone 全部复用，不旁路）。
- 可撤销：`editorSceneWriteDriver.ts` `InverseOperation` 增 `{ kind: "animation-anchor", initialStateId, activeStateId }`
  （绝对值逆算子、幂等重放，与 lighting/environment 同构）；`EditorSceneStateReader` 增
  `getSceneAnimation?()`（缺省 fail-closed "无法捕获可恢复的状态机锚，未执行修改"）；
  重放仅在状态机仍在时回写旧锚。`sceneMetadataDraftPatch` 增 `animationAnchorPatch` 合并面。
- draft 回写：`useEditorPresence.ts` committed 后 `state.setSceneAnimation` 合并锚（draft 无状态机时不动）；
  rejected 路径不触碰 draft（与 B5 同规）。
- 删除流：`SceneReferenceCleanupPort.ts` **零改**——拒绝文案保持，现在宿主真有了迁移口。

### 测试证据

| 层 | 文件 | 结果 |
|---|---|---|
| scene-sdk | `pnpm build` + `pnpm typecheck` | 通过 |
| scene-sdk | `commandValidation.test.ts` 增 3 it（合法锚三形态 / 非法锚五形态 / capability+场景不匹配） | 包内 126/126 绿 |
| contracts | `pnpm build` + `pnpm typecheck`（零改动，回归验证） | 通过 |
| web | `tsc --noEmit` | 通过 |
| web | `SceneCommandExecutor.test.ts` 增 1 it（分发/跨场景/端口缺省） | 4 文件 29/29 |
| web | `ViewerSceneCommandPort.test.ts` 增 2 it（单锚/双锚全量回写+未给锚不触碰；未知状态/无状态机 fail-closed） | 同上 |
| web | `editorSceneWriteDriver.test.ts` 增 2 it（capturing 透传+draft 拆分；批次失败旧锚回退；端口缺实装/无捕获面 fail-closed） | 同上 |
| web | `SceneReferenceCleanupFamily.test.ts` 增 1 it（拒绝→迁移→删除成功 顺序用例） | 同上 |
| web | behavior+studio+commands 三族全测 | 57 文件 / 383 测试全绿 |
| web | 全量 `vitest run` | 5543 过 / 3 失败 / 3 skip（失败归属见下） |

### 对抗式自查记录

- 初版三个测试失败，逐一根因修复（非放水）：
  1. `mock.calls[1]` 解构取了参数数组第 2 个元素（调用仅 1 参）——测试解构错误；
  2. 组合用例迁移后 `resolveSceneReferenceIntegrity` 的 `isKnownObject` 未把"删除前仍在场的
     victim"算作已知对象——测试口径错误（真实语义：迁移发生在删除之前，victim 帧仍可解析）;
  3. fail-closed 无捕获面用例复用了被前一事务 bump 过的 revision，baseRevision 过期走了
     rejected 而非 rolled-back——改为独立 harness。

## 诚实声明

- **web 全量 3 失败均非本刀归属**（git 佐证）：
  - `architecture.test.ts` 违规两文件 `sceneRendererRecoveryFullDomains.test.ts` /
    `pathTraceAuthorSession.test.ts` 均为 `??` 未跟踪（他线今日新建文件，本刀从未触碰）；
  - `StudioDeepWebGpuBridge.test.ts` 两例（WebGL handover settle / TAA finite settle，帧计数断言）
    该文件无任何本地改动（git status 干净），属帧时序敏感的既有失败——本刀未触碰 viewer 渲染域，
    且任务明令禁帧时测量，不在此修复。
  - 本刀触碰的四个测试文件（executor/port/driver/cleanupFamily）29/29、behavior+studio+commands
    三族 57 文件 383 测试、scene-sdk 126/126 全绿。
- 边界：`SceneGraphTransactionDriver`（native graph 事务链）未接入 `animation.set-anchor`——该链
  对 lighting/environment 同样未接入，属另一条宿主链的既有边界，本刀不扩面。
- `apps/web/src/ai/sceneScriptDraft.ts` 的 AI 脚本草稿未加该命令（今日他线产出域禁改，且任务定义
  UI/AI 面零新增）；同族排查确认其余 command.type 消费方（unityScriptCommandHost /
  ApplicationPlaybackSession / virtualCommissioningTestDesigner）均按类型增量处理，无需扩面。
- 未做浏览器视觉闭环（本刀纯编程口+命令面，无 UI 变更；浏览器由 E2/Z4 独占，任务明令不占）。
- 未 commit/push（硬约束）。
- 硬约束遵守：禁 cargo（零 Rust 触碰）、禁帧时测量、jc-i-continuation-20261001.md 只读、
  禁改域（physics/ai/rendererCapabilityUserFace/editorSnapshotFetchBridge/SceneCameraFlyTween*）零触碰。


