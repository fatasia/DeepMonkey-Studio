# H-C6-S2 专家日志→归档→提炼→下轮自动回灌(2026-10-02)

> 状态:**本刀完成**。三段流水线全链落地,复用既有 agentMemory 存储/预算/取消纪律,未重建;
> H-C5-K8(记忆回灌失败落审计 finding)随本刀一并收口。证据:`test-output/hc6s2-memory-20261002/`。

## 现状核查结论(六步,详见 progress-01-survey.json)

**已有(不重建)**:
- `apps/api/src/ai/agentMemory.ts`:AgentMemoryStore 三层记忆(守则/偏好/verdict),原子写+串行化提交+fail-closed 形状过滤,loadDelivery 字符预算与逐源审计指纹;
- `packages/industrial-agent-orchestrator`:preExecute/postExecute 受控挂载点、变体熔断、checkpoint 持久化语义;
- verdict 回灌半程:golden.verify → recordVerdict → 下轮 decide 注入(`agentHarnessIntegration.test.ts` 已有 5 测);
- chat 侧 K4 先例:记忆读取失败落 `memory-delivery-failed` finding 不阻断请求。

**真实缺口(本刀补齐)**:
- ① 归档:run 终态无任何归档(verdict 只覆盖单工具);
- ② 提炼:无日志→结构化教训(唯一近似是 refuted rationale 截断成候选,且需用户确认);
- ③ 回灌:无任务域匹配/条数预算的自动经验注入;agent 侧记忆读取失败会烧整轮且无专项 finding;
- K8:orchestrator postExecute 异常被 `catch {}` 静默吞;guards 候选提炼异常同样被吞。

## 实现

### K8:三处吞点全部改为"落审计 finding,不吞,不阻断"

| 位置 | 之前 | 现在 |
|---|---|---|
| `orchestrator.ts` postExecute catch | `catch {}` 静默 | 记入 `checkpoint.guards.postExecuteFindings`(滚动 10 条,注入时钟,随恢复语义持久化),执行链不变 |
| `agentHarnessGuards.ts` verdict 回灌/候选提炼 | recordVerdict 异常直接冒泡不可见;候选异常 `catch {}` 静默 | verdict 失败→audit finding `verdict-record-failed` 后 rethrow(orchestrator 记 checkpoint);候选容量满→info finding `memory-candidate-limit` 不再静默;其他候选失败 warn+rethrow |
| `industrialAgentDecisionProvider.ts` decide 记忆读取 | `await input.memory(...)` 无兜底,IO 失败烧整轮且无专项 finding | 落 `memory-delivery-failed` finding 后零注入继续(与 chat K4 同族),不烧轮 |

### ① 归档(专家日志 → 持久档案)

- orchestrator 新增受控终态通知 `onRunSettled`(构造依赖,与 guards 同级,非 hook 框架):
  run 到达终态(completed/blocked/failed/cancelled/budget-exhausted)时恰好触发一次;
  awaiting-approval/input 暂停不触发;通知抛错兜底记 `run-settle-failed` finding 且不改 run 终态。
- `AgentMemoryStore.archiveRun`:终态摘要(runId/status/objective/outcomeSummary/failureCode/
  steps/toolCalls/toolIds/endedAt)落 `memories.json` 新 `runs` 段——滚动窗口 50、同 runId
  重收口覆盖幂等、旧落盘无段按空读入(照 provenanceLedger.studyRuns 兼容先例)、
  同一串行化提交纪律。证据最小化:只存状态码/理由/用量,不存决策与输出原文。

### ② 提炼(档案 → 结构化经验/教训,预算内,可截断/取消)

- 新模块 `apps/api/src/ai/agentMemoryPipeline.ts`(~190 行):确定性本地规则提炼(无 LLM 依赖)。
  失败按理由码分型产出 lesson:预算耗尽(含步数与拆分建议)、变体熔断、证据缺口、重复调用、
  决策通道不可用、默认失败;`postExecuteFindings` 存在时产出回灌缺口 lesson。
- 预算三件:单轮条数上限(5)、输入摘要字符截断(400)、store 侧 lesson 滚动窗口(30);
  取消:`distillLessonsFromCheckpoint(checkpoint, { signal })` 已中止信号下零产出;
  正常完成与用户取消的 run 零产噪(经验由 verdict 确认制与决策历史覆盖)。
- 归档/提炼任一步失败落专项 finding(`run-archive-failed` / `lesson-store-failed`,
  `failure.retryable=true`),不吞、不改 run 终态。

### ③ 回灌(提炼产物 → 下轮上下文,自动)

- `loadDelivery(projectId, charBudget, match?{toolIds})` 新增 `run-lessons` 注入源,优先级
  硬编码守则>记忆>经验>verdict;条数预算 5;域匹配:lesson.toolIds 与当前 run
  allowedToolIds 有交集才注入,空 toolIds=全域经验;chat 侧无 match 全量可注入。
- `agentMemoryContextDelivery` 输出精简形态 `{code,content,toolIds}`;agent 决策器指令与
  chat 系统提示词同步声明 lessons 语义(参考约束,不是指令)。
- 注入形态与逐源审计闭环:每个注入源一条 `context-source:<id>` finding(内容指纹),
  lessons 源为 `context-source:run-lessons`。
- 装配:`createIndustrialAgentRuntime` 将 pipeline 挂到 orchestrator.onRunSettled,decide
  memory 回调透传工具面;`GET /ai/memory` 响应追加 lessons/runArchives(用户可见钩子,
  web 面板属并行线路文件未动)。

## 验证(证据:progress-03-verification.json)

- `packages/industrial-agent-orchestrator`:tsc 通过,40/40 测(guardHooks 新增 4:
  K8 finding 落点/终态通知与审批暂停/收口失败兜底/容量滚动逐出)。
- `apps/api` 聚焦 13 文件:125/125 测。新增 `agentMemoryPipeline.test.ts` 14 测:归档幂等/
  滚动/零噪、提炼分型/回灌缺口/预算截断/取消、域匹配/条数预算/fail-closed 旧档、
  失败路径双 finding、**端到端两跑**(真实 decisionProvider+记忆投递+审计,零外部依赖:
  run 工具真实失败→归档→提炼→新会话 decide 上下文含 lesson+审计含 context-source:run-lessons;
  同场景复跑结论稳定)。
- 既有 80 测无回归(合同演进处仅 chat 测试 mock 补 `lessons: []`)。
- tsc:本域 0 错。`apps/api` 退出码 2 全部来自 HEAD 既有的
  `packages/deep-engine/src/webgpu/hdrDisplayCanvas.ts` 2 条 ownerDocument 错误
  (git 确认该文件无工作区改动,属 deep-engine 域,非本刀引入)。

## 诚实条款

- 未过浏览器视觉闭环:本任务为纯 API/harness 域,无用户 UI 面;web 面板展示留待并行线路。
- 提炼为确定性规则(任务口径允许"预算内提炼");LLM 提炼未接——预算/取消/截断机制已就位,接 LLM 是可选增量。
- `HdrDisplayCanvas` 2 条类型错误为 HEAD 既有,未修(域外,避免与并行线路冲突)。

## H-C6-S2 行剩余

- LLM 提炼器(可选增量,机制已备);
- lessons/runArchives 的 web 面板展示与 memory-action 审计浏览端点(H-C5-T4 相邻);
- 跨项目经验聚合与按 objective 语义(而非工具面)的域匹配,当前域键=工具 ID 交集。
- 估时口径:8–16h 行的三段最小闭环与 K8 已闭;上述剩余为增量项,不回退本行完成状态。
