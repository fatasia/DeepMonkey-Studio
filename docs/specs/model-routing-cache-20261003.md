# AI 助手：模型路由 · prompt 缓存 · 上下文下压（2026-10-03）

> 对应升级方案 `upgrade-plan-ai-native-world-20261003.md` §3 阶段 2 第 3 点。
> 范围：**产品里的 AI 助手后端**（`apps/api/src/ai/*`、`apps/web/src/apiClients/aiApi.ts`、`AssistantModelControls`），不含 Agent 决策器（见"范围外"）。

## 1. 现状核查（动手前，六步结论）

### 1.1 已有（不重建）

| 能力 | 位置 | 说明 |
|---|---|---|
| 会话级模型/思考档位选择 | `assistantSessionOptions.ts`、`AssistantModelControls.tsx` | `model`+`reasoningEffort` 经 `/api/ai/assistant(/stream)` 请求体进入 `resolveAssistantSessionOptions`；模型必须在 `/models` 目录中。无"自动"。 |
| 主/备模型 failover | `aiFailoverPolicy.ts`、`assistantService.ts#streamOnce` | 额度/限流/5xx/超时/网络错误切备用；首个 delta 后不切换。 |
| 请求遥测 | `aiRequestTelemetry.ts`（环形 50 条） | 记录 model/latency/inputTokens/outputTokens，**无缓存命中、无路由信息**。 |
| 上下文交付回执 | `assistantContextDelivery.ts` + 前端 `AiContextDeliveryEvidence.tsx`（"实际发送来源"折叠行） | 逐来源 `sent/partial/omitted`，坐标系 = 序列化 JSON 前缀偏移。出域复核（K2）与逐条引用锚（T5）同坐标系。 |
| 记忆注入 | `assistantService.ts#loadMemoryDelivery` → `agentMemoryContext` | 守则/记忆/lessons/priorVerdicts，已受注入扫描。 |
| 注入扫描 + 有界克隆 | `aiReliabilityPolicy.ts#prepareAiInput` | 每个字符串算一个"来源"，**总来源数 256、总文本 120k 字符**，超出即替换为 `{truncated:true}`。 |
| 能力目录注入 | `assistantService.ts#withCapabilityCatalog` | 每轮把 `registry.listCapabilities()` 全量（含 `inputSchema`）追加到 context **末尾**。 |
| Agent 决策器上下文预算 | `agentContextBudget.ts`（`compressAgentContext` + `assertAgentContextBudget(80_000)`） | 超限直接抛错而不是裁剪；与聊天助手是两条独立路径。 |
| 思考档位映射 | `openAiCompatibleProvider.ts#reasoningParam` | responses→`reasoning.effort`，chat→`reasoning_effort`。 |

### 1.2 真实缺口

1. **`assistantPrompts.ts` 对序列化 context 做 `slice(0, 80_000)`**：纯字符前缀截断，可截在 JSON/schema 中间；被截掉的永远是排在末尾的能力目录与后到的字段，没有"优先级"概念，也没有"被裁掉了什么"的结构化说明。
2. **完全无利于缓存的前缀排序**：`userPrompt = 问题 + 上下文`，问题每轮不同且排在最前 → provider 自动前缀缓存（OpenAI/DeepSeek 等按最长公共前缀）几乎永远 miss；能力目录（静态）在 context 末尾被易变数据隔开。
3. **能力目录每轮全量重复注入**：真实注册表 14 个能力 = 24.3k 字符，其中 `inputSchema` 占 21.8k（90%）；每条还重复一份相同的 `decisionBoundary` 字符串。聊天助手是只读的（`writePolicy: "read-only"`），schema 对绝大多数问题无用。
4. **`prepareAiInput` 的 256 来源上限按客户端键顺序消耗**：Web 发送顺序 `workspace → platform → contextTrust → bimEvidence → recentConversation`，大体量 `platform` 吃光来源额度后，**最关键的 recentConversation / bimEvidence 反而被替换成 `{truncated:true}`**（统计脚本里 6 轮对话只剩 703 字符）。
5. **无模型路由**：所有请求都用同一个主模型；没有"小模型答简单问题"的路径，也不能看到实际选用模型的理由。
6. **provider 回执缺缓存指标**：`usage` 只解析 `input/output tokens`，`prompt_tokens_details.cached_tokens`（chat）、`input_tokens_details.cached_tokens`（responses）、`prompt_cache_hit_tokens`（DeepSeek）均未解析；chat 流式未请求 `include_usage`，流式 chat 通常拿不到 usage。
7. 预存的来源映射缺口（本次不动，列遗留）：`SOURCE_PATHS` 里 `workspace-scene` 等路径是顶层 `scene`，但 Web 实际发送 `workspace.scene`，所以 scene/selected 来源在回执里不出现。

### 1.3 provider 适配层支持的缓存能力核查

仅有一个 provider 插件 `ai.openai-compatible`（`responses` / `chat-completions` 两协议）。
- **自动前缀缓存**（OpenAI、DeepSeek、Moonshot 等兼容服务端自动做）：只依赖"字节稳定的公共前缀"→ 本次重排即可受益，无需任何请求参数。
- **显式缓存断点**（Anthropic `cache_control`）：OpenAI 兼容协议没有此字段，网关各自扩展且严格网关会 400。**不支持 → 不硬做**。
- **`prompt_cache_key`**（OpenAI 官方路由提示）：非标准兼容服务可能拒绝未知字段 → 默认不发；仅在 `AI_PROMPT_CACHE_KEY=1` 显式开启时随请求发送（key 取"项目+模式"的稳定哈希）。

### 1.4 相关文件清单（动手前 grep 结论）

`apps/api/src/ai/`：`assistantPrompts.ts`（80k 前缀截断）· `assistantService.ts`（prepareRequest/withCapabilityCatalog）· `assistantContextDelivery.ts` · `assistantSessionOptions.ts` · `aiRuntimeSettings.ts` · `aiRequestTelemetry.ts` · `openAiCompatibleProvider.ts` · `agentContextBudget.ts`（Agent 路径，范围外）。
`apps/web/src/`：`components/AssistantModelControls.tsx`（chat 面板与 Agent 工作区共用 compact 模式）· `apiClients/aiApi.ts` · `components/AiExecutionDetails.tsx`（"模型与思考设置"折叠行）· `components/AiContextDeliveryEvidence.tsx`（"实际发送来源"折叠行）· `ai/assistantContextDelivery.ts`（回执校验）。
`assistantContextReadiness*` 文件并不存在（就绪度逻辑在 `ai/assistantReliability.ts` + `AiContextDisclosure.tsx`），无需改动。

### 1.5 基线统计（改造前）

`apps/api/scripts/measureAssistantPrompt.ts`：真实能力注册表（14 个能力）+ 按真实基数合成的典型"平台问答"快照（12 个模型、30 条视觉事件、12 个数据集×10 字段、6 轮对话）。

| 部分 | 字符 | 占完整 context |
|---|---:|---:|
| `availableCapabilities`（全量含 schema） | 24 307 | 22.3% |
| `platform.operations` | 32 091 | 29.4% |
| `platform.data` | 29 476 | 27.0% |
| `platform.vision` | 16 053 | 14.7% |
| `platform` 其余（battery/ppr/来源状态等） | 5 133 | 4.7% |
| `workspace`（项目/场景/选中/看板） | 1 133 | 1.0% |
| `recentConversation`（被来源上限压缩后） | 703 | 0.6% |
| 系统指令 + 问题 | 314 | 0.3% |
| **完整 context** | **109 204** | 100% |
| 实际发送（80k 前缀截断） | 80 000 | — |

结论：典型平台问答已越过 80k 上限；被截掉的是**末尾的能力目录 + platform 尾部**，且截断落在 JSON 中间；其间 `recentConversation` 又被上游来源上限压成 703 字符。

---
