# 助手"计划→执行→验证"闭环(场景改动)— 2026-10-03

> Design Read:对标 Cursor 的"改动可审阅/可回滚"+ Unity AI 的"应用后自检"+ 西门子式状态三重编码;深色工程语言,全部令牌来自 `apps/web/src/styles/base.css`,强调色派生自 `--accent`。

## 现状核查

### 已有(不重建)

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 场景命令 IR(19 类)+ 严格校验 | `packages/scene-sdk/src/protocol.ts`、`commandValidation*.ts` | `validateSceneCommand` 逐条校验未知输入 |
| **命令事务**(prepare / CAS / 取消 / 失败整批回滚 / receipt) | `packages/scene-sdk/src/sceneCommandTransaction.ts` | `prepareSceneCommandTransaction` 产出 `plan.diff`(仅 `type → target` 摘要,**无前后值**);`commitSceneCommandTransaction` 原子提交,driver 异常/部分失败/取消一律 `rollback` |
| 浏览器 driver(逆算子栈,倒序回滚) | `apps/web/src/studio/editorSceneWriteDriver.ts`(`runEditorSceneTransaction`、`sceneMetadataDraftPatch`) | 执行走 `ViewerSceneCommandPort`+`SceneCommandExecutor`;不可逆项(动画控制/数据推送)已声明 |
| 撤销栈与单撤销单元 | `SceneAuthoringHistory`(`studio/sceneAuthoringHistory.ts`)、`SceneEditTransaction`(`hooks/useSceneHistoryState.ts`:`flush.beginTransaction(label)` → `commit()` 合并为一条)、`useSceneHistoryActions.undoSceneEdit` | 事务窗口内 `onModelChange` 散记全部吸收;删除链已用该事务 |
| 编辑器 presence + MCP 写事务桥 | `apps/api/src/mcpEditorSceneTransactionBridge.ts`、`hooks/useEditorPresence.ts` | **外部 MCP 客户端**经轮询桥驱动浏览器 driver;不是应用内助手通道;MCP 写入未进撤销栈(仅删除进) |
| 视口取帧 | `studio/sceneThumbnailCapture.ts`(同步重绘+`toDataURL`)、`editorSnapshotFetchBridge.ts`(PBR readback 拉取) | 缩略图口径 480px;MCP 视觉循环用 frame readback |
| 引擎只读口 | `ViewerEngine.listModels/getModelTransform/getModelMaterialState/getCameraState/getGlobalLighting/getSceneEnvironment/getWeather/getSelected` | 前后值读取面齐全 |
| 助手对话与"执行任务"编排 | `apps/api/src/ai/assistantService.ts`(`scene` 模式,**纯文本**)、`industrialAgentToolGateway.ts`(20 精选**工业**工具,无场景编辑工具)、`@bim-studio/industrial-agent-orchestrator`(plan/confirm/autonomous、审批、`verificationEvidence`) | 编排器的写类工具已强制"事后独立验证证据",但全部是**服务端工具**,无法触达浏览器视口 |
| 审计链 | `createMetadataAiAuditSink`;`api.askAssistant` 每次模型调用已审计(input-assessment/model-completion);`provenanceLedger` 是**假设/研究运行**链(report/study-run),且浏览器只读 | 场景改动不属于该账本的节点类型 |
| 行为脚本沙箱 | `SceneBehaviorPanel`、`behavior/*`、`sceneBehavior.worker`、Play 模式(退出整体恢复) | 脚本是另一条链路;Play 态一切编辑吸收 |
| World API(`world-api-v1-20261003.md`) | **未落盘** | 只依赖现有命令 IR;其契约落盘后以 `SceneCommand` 兼容层对接 |

### 真实缺口

1. 应用内"执行任务"页没有任何通道让模型提出**场景命令批**并在浏览器内应用(编排器是服务端、工具网关无场景编辑工具;MCP 桥是外部客户端用)。
2. `plan.diff` 只有一句摘要——**没有前后值**,无法"可审阅"。
3. 批量命令在撤销栈里**不是一个单元**(非删除命令只靠防抖散记)。
4. 应用后**没有观测回喂/自检**:无视口取帧到 UI、无"期望 vs 实际"确定性比对、无"达成/未达成+修正"循环、无轮次上限。
5. 模型通道**纯文本**(`assistantService` 无图片入参):截图不能直接喂模型,只能喂数值化观测。
6. 场景改动回执没有写入审计链的路径(provenance 账本类型不匹配)。

## 方案

**浏览器内闭环**(复用 `commitSceneCommandTransaction` + `EditorSceneWriteDriver` + `SceneEditTransaction`;模型走既有 `api.askAssistant("scene")`,每次调用已被审计):

- `ai/sceneEditState.ts` — 可序列化场景状态快照 + 命令仿真 + **前后值差异**(新增/修改/删除、字段级前后值、不可撤销标注、目标不存在即阻断)+ 期望-实际确定性核对。
- `ai/sceneEditProtocol.ts` — 提议/裁决提示词(合同:严格 JSON、弧度、≤12 条命令)与响应解析。
- `ai/sceneEditSession.ts` — 会话状态机:`plan` 只出计划 / `confirm` 每轮需确认 / `autonomous` 自动循环,**修正轮次上限(默认 2,可配 0–3)**,可取消、可撤销。
- `ai/sceneViewportObservation.ts` — 视口截图(JPEG,≤1280 宽)+ 数值观测(平均亮度、非背景占比、3×3 亮度网格、指纹)。
- `hooks/useSceneEditPort.ts` — 把引擎/撤销栈/driver 包成端口:原子应用+单撤销单元、截图、撤销并校验还原。
- `components/SceneEditLoopCard.tsx` — 仅在"执行任务"页出现:差异 / 应用 / 验证 / 撤销;无新增常驻区域。

审计:两次模型调用走既有审计;应用与撤销回执(plan 指纹、receipt、观测指纹、裁决)以 `AiSceneEditRecord` 保存在会话内并展示;**后端落账需要新的写路由,记为遗留**(见实施结果)。

## 实施结果

(随实施追加)
