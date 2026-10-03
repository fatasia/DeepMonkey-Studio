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

## 2. 设计与实施结果（2026-10-03）

### 2.1 数值依据：为什么默认 24k

- 典型平台问答（§1.5 样本）完整 context 109k；**真正承载"当前问题所需"的 focus（选中/场景/对话/BIM 证据）通常 1–6k**，项目记忆 0–6k，能力索引 ≈1.5k，其余是平台批量数据（operations/vision/data 各 16–32k）。
- 预算 24k = 固定开销(系统指令+问题+包装 ≈0.6k) + 静态头(索引/边界/provider ≈1.7k) + 记忆(≤6k) + focus(预留 ≥15%≈3.4k，按实际取大) + 平台数据(余量 ≈10–16k) + 裁剪说明预留 0.9k。平台数据按"公平水位"分摊，每个来源仍保留 1.5–5k 的真实记录。
- `AI_CONTEXT_BUDGET_CHARS` 可调（夹在 8k–120k，非法回落 24k）；Agent 决策器仍是 80k 断言（范围外）。

### 2.2 上下文预算器（`assistantContextBudget.ts`）

- **优先级**（保留顺序）：系统指令 > 当前问题 > focus（选中/场景/对话/BIM 证据）> 记忆 > 实验档案与平台数据（`platform` 及其他客户端字段）> 能力目录。
- **裁剪顺序**（与保留相反）：①按需 schema 超限先压缩 → ②档案/平台数据按"公平水位"缩减 → ③记忆缩减（`rules/priority/delivery` 受保护）→ ④丢弃能力索引（体积仅 ≈1.5k 且属缓存前缀，故晚于记忆）→ ⑤丢弃剩余 schema，缩减 focus（对话从最旧一轮丢起）→ ⑥极端兜底：不可缩减的结构仍超限时才回退为"前缀截断"，并沿用原有"上下文已截断"披露。
- **语义安全**：只在 JSON 值层面缩减——字符串带 `…[已截断，原N字符]` 标记且按码点切；数组按**整项**保留；对象永不删键；输出始终是合法 JSON，不会切在 JSON/工具 schema 中间。数组留下的未用额度按"仍被缩减的项"再分配（最多三轮）。
- **可解释**：`reliability.contextDelivery.budget = {budgetChars, originalChars, usedChars, trimmed:[{id, action: compacted|shrunk|omitted, fromChars, toChars, reason}]}`；模型侧同步得到一个 `contextBudget` 说明（≤8 项），被缩减的来源不会被误认为"不存在"；有数据裁剪时 `warnings` 增加一条并把核验降为 limited（与既有截断口径一致）。能力目录索引化属于表示变化，不降级核验。
- **能力目录**：每轮全量 24.3k → 静态**索引**（id/label/kind/schemaVersion，按 id 排序）+ 一次性 `capabilityBoundary`（原先每个能力重复一份 `decisionBoundary`）。`inputSchema` 仅在问题点名某能力（id 分段/label）或询问"能力/参数/调用…"时按需展开（点名最多 4 个；这类请求被视为"当前问题所需"，超限时 platform 数据先让位，schema 最多占上限的 35%）。聊天助手是只读的，不执行能力，所以不丢失执行面。
- **同族修复**：`prepareAiInput` 的 256 来源/120k 文本额度按键序消耗，Web 发送顺序使 `recentConversation/bimEvidence` 排在 `platform` 后被替换成 `{truncated:true}`。现在注入扫描前用 `prioritizeContextForScan` 把 focus/记忆排前、platform 排后。

### 2.3 缓存友好前缀

- 发送顺序：`系统指令(按模式稳定) → 能力索引 → 边界 → provider → 记忆 → platform → 其他字段 → focus → 按需 schema → 裁剪说明 → 用户问题`。**问题移到最后**（原先在最前，直接破坏任何前缀缓存）。裁剪量对 platform 的影响与 focus 的实际大小无关（focus 小于 15% 预留时），因此同会话多轮间 `系统+索引+记忆+platform` 字节一致（有测试：`keeps the static and slow prefix byte-identical…`）。
- 缓存指标：provider 回执解析 `prompt_tokens_details.cached_tokens`（chat）/`input_tokens_details.cached_tokens`（responses）/`prompt_cache_hit_tokens`（DeepSeek），进入 `AiProviderCompletion.usage.cachedInputTokens` 与遥测 `cachedInputTokens`；另记 `contextChars`、`route`。**未回执则缺省，绝不推断。**
- 显式断点：适配层只有 OpenAI 兼容协议，没有 `cache_control` 等价物 → **不做**。`prompt_cache_key` 仅 `AI_PROMPT_CACHE_KEY=1` 时发送（key = 项目+模式的 24 位哈希，不含内容），默认关闭以免严格网关 400。

### 2.4 意图路由（`assistantModelRouter.ts`）

「自动」是**新增选项**，不选则行为与原来逐字节一致（路由器根本不运行）。显式 `model` 永远优先于 `routing:"auto"`。

| 顺序 | 条件 | 去向 | reason |
|---|---|---|---|
| 1 | 未选自动 / 未配置小模型 / 小模型==默认模型 | 默认模型 | `not-auto` / `no-fast-model` |
| 2 | 可靠性评估非 allow（含可疑注入） | 强 | `input-risk` |
| 3 | 模式 ∉ {platform, operations, vision, scene, component}（即 bim/dashboard/sql） | 强 | `mode-needs-strong` |
| 4 | 问题 > `AI_ROUTER_FAST_MAX_CHARS`（默认 160） | 强 | `long-question` |
| 5 | **含写入/控制意图**（创建/删除/修改/设置/移动/导出/运行/发布…，及英文 create/delete/update/run…） | 强 | `write-intent` |
| 6 | 含代码/SQL 片段 | 强 | `code-input` |
| 7 | 规划/分析/编码类（为什么/分析/方案/对比/优化/实现…） | 强 | `planning-or-code` |
| 8 | 多步骤（然后/并且/首先…） | 强 | `multi-step` |
| 9 | 命中 `AI_ROUTER_STRONG_KEYWORDS`（逗号分隔） | 强 | `custom-keyword` |
| 10 | **正向命中**简单只读问法（是什么/多少/有哪些/状态/当前/列出…，what/which/status…） | **小模型** | `simple-question` |
| 11 | 其余一切 | 强 | `no-fast-match` |

- fail-open：路由器任何异常 → `router-error` 强模型；小模型请求在出字前失败（模型不存在/5xx 等，非用户取消）→ **同一请求原地改用默认强模型重试一次**（流式会先发一次 `execution: null` 重置回执），仍失败才进入既有主备 failover；已出字后不重放。小模型不携带强模型的思考档位；强路由保留。
- 配置（环境变量，无新依赖）：`AI_ROUTER_FAST_MODEL`（必填才启用）、`AI_ROUTER_ENABLED=off` 关闭、`AI_ROUTER_FAST_MAX_CHARS`、`AI_ROUTER_STRONG_KEYWORDS`。
- 问数：`sql` 模式本来就走受控问数服务（`mode-needs-strong` 且 `resolveAssistantSessionOptions` 对 sql 拒绝模型覆盖），路由器**不静默切换模式**，保留现有"改用受控问数"恢复路径。
- UI：`/api/ai/assistant/models` 增加 `routing:{autoAvailable, strongModel, fastModel?}`；仅当小模型已配置、与默认不同且（目录可得时）在目录内才出现「自动」。`AssistantModelControls` compact 加 `allowAuto`（仅 chat 面板开启；Agent 决策是规划，不提供）与 `lastRoute`：下拉里显示「自动 · <实际模型>」，title 说明规则；回答的"模型与思考设置"折叠行显示「自动路由：小模型 · mini · 简单只读问答」，回退时追加说明。

### 2.5 前后对比（`scripts/measureAssistantPrompt.ts`，同一样本同一问题）

| 指标 | 改造前 | 改造后 |
|---|---:|---:|
| 总提示字符 | 80 185 | **21 535**（−73%） |
| 实际发送的上下文 | 80 000（前缀截断，截在 JSON 中间） | 21 207（完整合法 JSON） |
| 能力目录 | 24 307（30.3%）——**实际未发送**（被排在 80k 之后） | 1 439（6.7%）索引，已发送 |
| `recentConversation` | 703（被来源额度压坏）——**未发送** | 1 654（完整 6 轮，7.7%） |
| `workspace`（选中/场景） | 1 133（1.4%） | 1 133（5.3%） |
| `platform`（批量数据） | 82 753 → 发送其前 ≈78.8k（98.5%） | 16 334（75.8%），operations 2 877 / vision 5 061 / data 3 263 / battery 3 234 |
| 裁剪说明 | 仅一句"已截断" | 回执逐来源 + 模型侧 `contextBudget` 290 |
| 跨轮字节稳定前缀 | 系统指令 83（0.1%，问题在前） | 系统+索引+边界+provider+platform ≈ 18 192（**84.5%**） |
| 问"你有哪些能力和参数" | 目录根本没发出去 | 索引 + 14 个 schema 8 762，platform 让位到 9 975，总计 22 577 |

### 2.6 验证

- `apps/api`：`npx tsc --noEmit` 无本任务文件错误（余下 `world-runtime` 为他人在途）；`npx vitest run src/ai src/assistantPrompts.test.ts` → 60 文件 / 467 测试全过。新增：`assistantContextBudget.test.ts`（15）、`assistantModelRouter.test.ts`（30，含 10 条写意图误路由用例）、`assistantRouting.integration.test.ts`（12：路由/回退/流式回退/取消不重试/缓存键/缓存命中遥测/回执）、provider 缓存（6）、session 选项（2）；改写 `assistantPrompts.test.ts`、`assistantService.test.ts` 中依赖 80k 前缀截断语义的 4 个用例。
- `apps/web`：`npx tsc --noEmit -p .` 无本任务文件错误（余下 `useAppRuntimeEffects` 等为他人在途）；相关 vitest 32 文件 / 206 测试全过（新增 `AiContextBudget.test.tsx`，扩展 `AssistantModelControls.test.tsx`）。
- 视觉：深色 1920×1080 无头 Chrome（`/api/ai/assistant/models` 与流式响应用 Playwright 模拟以呈现已配置小模型的状态）两轮：①下拉出现「自动」且不挤压工具栏；②选自动提问后下拉显示「自动 · gpt-5.5-mini」、"模型与思考设置"出现自动路由行、"实际发送来源"出现预算行（用量/原始/逐来源动作）；另验证浅色主题。颜色只用 `--muted/--text/--accent/--line-strong`；顺手给此前无样式的 `.ai-execution-details` 补了克制的小号样式。

### 2.7 遗留 / 后续

1. **Agent 决策器**（`industrialAgentDecisionProvider` 的 80k `assertAgentContextBudget`）未改：它是安全关键的"超限即拒绝"路径，且工具记录不可裁剪；其 `objective` 在前、context 在后的布局同样不利于缓存。需要单独设计（可复用本预算器的 `shrinkTo`，但 `priorDecisions/toolResults` 必须整项保留）。
2. **chat 流式未请求 `stream_options.include_usage`**：chat-completions 流式通常拿不到 usage，缓存命中指标只在 responses 流式与非流式可见；开启需确认目标网关兼容性。
3. 缓存指标目前只进入 `/api/admin/ai-settings/telemetry`；管理页 UI 未展示命中率。
4. 小模型 ID 只能用环境变量配置，管理页（`AiProviderSettings`）未加表单；`mergeAiSettingsDraft` 的"未知字段拒绝"需一并扩展。
5. 路由规则是中英文启发式（正向命中 + 一票否决），不是分类器；误判方向被设计为"偏向强模型"。若要进一步省钱需用线上遥测里的 `route.reason` 分布迭代词表。
6. 既有缺口（未动）：`assistantContextDelivery` 的 `SOURCE_PATHS` 中 `workspace-scene/selected` 指向顶层 `scene/selected`，而 Web 实际发送 `workspace.scene`，回执里这些来源不出现。
7. 平台数据缩减目前按整项保留数组头部；若要"最新优先"，需要客户端按时间倒序发送或在预算器里加 per-key 方向（`recentConversation` 已按尾部保留）。
