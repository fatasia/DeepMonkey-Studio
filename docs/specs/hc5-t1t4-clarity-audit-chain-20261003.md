# H-C5-T1/T4：澄清候选服务端透传 / 审计档案浏览链路复核（2026-10-03）

行定义（`docs/specs/remaining-tasks-estimates-20260930.md:157`）：「澄清候选服务端透传/审计档案浏览端点，
复核已完成 carrier 后的实际链路」（4–8h）。依赖：既有 needs-input / provenance.trace。

## 现状核查（六步前置，2026-10-03 执行）

### 1. 全仓 grep（apps/api/src、apps/web/src，含未跟踪）

- `needs-input`：服务端命中 `industrialCapabilities.ts`、`mcpCapabilityAdapter.ts`、`ai/alarmRcaPlugin.ts`、
  `ai/registerDataQueryAiPlugin.ts`、`ai/registerParametricAiPlugin.ts`；web 命中 `ai/runAssistantRequest.ts`、
  `ai/sceneScriptDraft.ts`、`components/VisionTaskDependencyFlow.tsx`。
- `clarification/澄清`：web 命中 `ai/runAssistantRequest.ts`、`components/AiAssistantMessages.tsx`、
  `components/AiClarificationCard.tsx`、`components/AiBimClarificationCard.tsx`；**服务端 apps/api 与
  packages/contracts 均 0 命中**（无 clarification/candidates 字段产出）。
- `provenance.trace`：`apps/api/src/ai/provenanceRoutes.ts`、`provenanceTracePlugin.ts`、
  `industrialAgentToolGateway.ts`、`web/apiClients/provenanceApi.ts`。
- `runArchives`：`apps/api/src/ai/agentMemoryRoutes.ts`、`web/apiClients/industrialAgentApi.ts`、
  `web/components/AgentRunHistoryPanel.tsx`。

### 2. 契约层

- `packages/contracts/src/askData.ts`：`AskDataQueryPlanningResult = { status: "ready"|"needs-input"; plan?; issues }`
  ——**无候选字段**；`AskDataQueryDraftResult = { planning, model, providerId }`。
- `packages/contracts` 无任何 clarification 定义；web 的 `AssistantClarification` 是 `runAssistantRequest.ts`
  里的本地类型。

### 3. 依赖

无新外部依赖需求：整条链复用既有 `@bim-studio/contracts`、`@bim-studio/data-query-plugin`、
`PluginRegistry.invokeCapability`、web `api.listDatasets`。

### 4. 消费方（实际链路）

**澄清链（T1/T2 域）——服务端不透传，web 自拼：**

1. 服务端 `registerDataQueryAiPlugin.ts`（capability `data.query.draft`）：第 54–56 行**手里已有完整数据集
   目录** `datasets`/`catalog`；模型选出不存在 datasetId 时 `createDataQueryPlan` 返回
   `needs-input` + `dataset-not-found`，但 `output.planning` **不带候选**。
2. web `runAssistantRequest.ts`（T2 已完成）：`needs-input` 时被迫**再发一次** `client.listDatasets(projectId)`
   自行过滤拼 `options`；目录读取失败则降级硬错误。
3. web 渲染载体已就位：`useAssistantChatRun.ts` 把 `result.clarification` 挂到会话条目，
   `AiAssistantMessages.tsx` 按 T1 注释渲染 `AiClarificationCard`（选项点选即重发提问）。

**provenance 档案浏览链（T4 复核对象）——已闭环：**

- 服务端 `provenanceRoutes.ts`：`GET /api/projects/:id/ai/provenance`（列表+integrity）与
  `GET .../ai/provenance/trace`（resultFingerprint/proposalFingerprint/since/until/limit 三跳查询），均为只读。
- web `provenanceApi.ts`（`listProvenanceChains`/`traceProvenance`）→ `AiProvenancePanel` /
  `AiProvenanceTraceView`，挂载于 `IndustrialAgentWorkspace.tsx`、`AiAssistantPanel.tsx`。

**memory-action 审计链（T4 复核对象）——已闭环：**

- 写：`agentMemoryRoutes.ts` 全部写操作 `emitMemoryAction` → `emitAiAudit` →
  `createMetadataAiAuditSink`（`metadataAiAuditSink.ts`）→ `MetadataStore.addAuditLog` 持久化，
  action 形如 `ai.memory-action.<outcome>`、detail 为事件 JSON（不含原文）。
- 读：`/api/admin/audit`（system.ts，`store.listAuditLogs`）→ web `api.listAuditLogs` →
  SystemCenter「审计与日志」`SystemLogPanel`。

**K13 runArchives 链——已闭环：**

- 服务端 `GET /api/projects/:id/ai/memory` 返回 `runArchives`（slice 0..10）+ `runArchiveCount`
  （agentMemoryRoutes.ts:31–44，hc6s2 交付）。
- web `industrialAgentApi.ts` `AgentMemoryView.runArchives` → `AgentRunHistoryPanel` 合并本地运行历史
  渲染终态语义，挂载于 `IndustrialAgentWorkspace.tsx`。

### 5. 测试与证据

- 服务端：`registerDataQueryAiPlugin.test.ts`（4 用例，本次基线 4/4 绿）、`agentMemoryRoutes.test.ts`、
  `provenanceTraceMcp.test.ts`。
- web：`runAssistantRequest.test.ts` T2 回归两用例（目录自拼/无候选硬错误）、
  `AiClarificationCard.test.tsx`、`AiBimClarificationCard.test.tsx`。
- 规格：`hc5-k10-k11-k13-agent-run-history-20261002.md`（K13）、`hc6s2-memory-pipeline-20261002.md`
  （第 87 行自认剩余：「lessons/runArchives 的 web 面板展示与 memory-action 审计浏览端点(H-C5-T4 相邻)」——
  其中 runArchives web 面板已由 K13 闭合；memory-action 审计浏览经复核已闭环（见上）；仅 lessons 的
  web 面板展示仍为 hc6s2 自认增量项，不属于本行「审计档案浏览端点」口径，见「范围边界」）。

### 6. 核查结论：已有（不重建） vs 真实缺口

**已有（不重建）：**

- T4 两侧链路均实际闭环：provenance 档案浏览（服务端只读双端点 + web client + 面板）与
  memory-action 审计（持久化 + admin 浏览端点 + SystemCenter 面板）。**不再新建任何端点**。
- 澄清卡的 web 渲染载体与 T2 兜底自拼路径（K9/T2 既有测试护航）。

**真实缺口（T1，本行唯一动手面）：**

服务端在 `needs-input`（`dataset-not-found`）时**不透传候选**——明明 `datasets` 目录在手，
却让 web 多打一次 `listDatasets` 自拼。后果：①多余一次网络往返；②web 端拼装逻辑与服务端目录
可能漂移（web 还要自己按 projectId 过滤）；③目录读取失败时用户拿到硬错误，而服务端其实能给出候选。

修复口径（缺哪段补哪段，全链四段）：

1. 契约：`AskDataQueryPlanningResult` 增加可选 `candidates?: AskDataQueryDatasetCandidate[]`（加法演进）。
2. 服务端：`registerDataQueryAiPlugin` 在 `dataset-not-found` 歧义时把目录候选（id/name/updatedAt，≤8 条）
   随 `output.planning.candidates` 透传；`ready`/非数据集歧义不携带。
3. web：`runAssistantRequest` needs-input 分支**优先消费服务端候选**；服务端未透传时才回退
   T2 的 `listDatasets` 自拼（兼容旧服务端），目录不可用保持原硬错误路径。
4. 测试：服务端产候选断言 + web 消费透传断言（不再调用 listDatasets）+ 既有 T2 回归保持绿。

### 范围边界（诚实声明）

- T4 结论=「复核后确认已闭环」，零代码改动，如实回报不硬做。
- lessons（提炼经验）的 web 面板展示是 hc6s2 自认的相邻增量项，非本行「审计档案浏览端点」口径，
  不在本刀展开（避免与记忆面板所属线路冲突）。
- `data.query.plan`（零 SQL 校验 provider）不附候选：其 needs-input 是显式 datasetId 下的计划校验失败，
  语义是"计划要修"而非"选哪个数据集"，候选会造成误导。
- 模型输出未过合同校验（parse 失败）路径无结构化 planning，不附候选，维持原警告路径。

## 实现（四段全链，2026-10-03）

1. **契约**（`packages/contracts/src/askData.ts`）：新增 `AskDataQueryDatasetCandidate { id; name; updatedAt }`；
   `AskDataQueryPlanningResult` 增加可选 `candidates?`。加法演进：MCP 信封
   （`mcpCapabilityAdapter.ts:260` `output: descriptor.outputSchema`，draft 的 outputSchema 为
   `additionalProperties: true`）自动透传，零改动。
2. **服务端**（`apps/api/src/ai/registerDataQueryAiPlugin.ts`）：`createDataQueryPlan` 之后，
   仅当 `!planning.plan` 且 issues 含 `dataset-not-found` 时，把同函数早前已取的 `datasets` 目录
   （≤8 条，`{id,name,updatedAt}` 最小集）以 `{ ...planning, candidates }` 随 `output.planning` 透传；
   `ready` 与字段/窗口类歧义不携带（后者语义是"修计划"非"选数据集"）；模型草案未过合同校验的
   needs-input 无结构化 planning，维持原警告路径。**候选只来自真实目录，不虚构。**
3. **web**（`apps/web/src/ai/runAssistantRequest.ts` needs-input 分支）：优先消费
   `planning.candidates` 映射为澄清卡 options；服务端未透传（旧服务端/空候选）时回退既有
   T2 `listDatasets` 自拼（含 projectId 过滤），目录不可用保持原硬错误路径。T2 行为完全保留。
4. **测试**：
   - 服务端 `registerDataQueryAiPlugin.test.ts` 新增 2 用例：draft 选错数据集 →
     `output.planning.candidates` 等于目录候选；`ready` 与 `field-not-found` 歧义 → 无 `candidates` 键。
   - web `runAssistantRequest.test.ts` 新增 2 用例：服务端透传候选 → clarification.options 来自候选且
     **不调用** `listDatasets`（多余往返消除）；无透传 → 回退本地目录（旧服务端兼容）。
   - 既有 T2 回归两用例（自拼/硬错误）不改一字、保持绿。

## 证据（2026-10-03 实测）

| 门 | 结果 |
|---|---|
| `packages/contracts` build（dist 供 NodeNext types 条件） | 通过 |
| apps/api `tsc --noEmit` | 0 错误（exit 0） |
| apps/api ai 域全量 `vitest run src/ai/` | 49 文件 / **357 passed** / 0 failed |
| `registerDataQueryAiPlugin.test.ts`（含新增 T1 两用例） | 6/6 |
| `packages/data-query-plugin` 全量 | 4 文件 / **12 passed** |
| `industrialCapabilities.test.ts`（相邻消费方） | 7/7 |
| apps/web `tsc --noEmit` | 0 错误（exit 0） |
| web ai 域 + 三张澄清/消息卡测试 | 24 文件 / **145 passed** |
| `runAssistantRequest.test.ts`（含新增 T1 两用例 + T2 回归） | 17/17 |

同族排查结论：`sceneScriptDraft.ts`、`VisionTaskDependencyFlow.tsx` 的 needs-input 属场景脚本/视觉任务
家族，非数据集澄清家族，不动；`data.query.plan`（零 SQL 校验 provider）刻意不附候选（语义不同，
见「范围边界」），`queryEngine`/`createDataQueryPlan` 零改动。

## 诚实条款

- T4 结论=复核后确认已闭环，**零代码改动**：provenance 档案浏览（只读双端点+web client+面板挂载）
  与 memory-action 审计（持久化+`/api/admin/audit`+SystemCenter 面板）两侧均有端到端消费方。
- 未跑 apps/web 全量 5491 测试套件（本刀 web 侧仅改 `runAssistantRequest.ts` 一个文件；
  已覆盖其直测 17/17 + ai 域 145/145 + tsc 0），如需全量可后补。
- 未过浏览器视觉闭环：本刀无 UI 面改动（澄清卡 T2 已有载体与样式，候选来源变更不改变渲染形态）。
- contracts 已按 NodeNext types 条件重建 dist（工作区共享产物，未提交）。
- 未 commit/push（硬约束遵守）；禁 cargo/禁帧时测量不适用（本刀无 Rust/无渲染帧路径）。

