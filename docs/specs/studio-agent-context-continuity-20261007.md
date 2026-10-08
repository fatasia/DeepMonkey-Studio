# Agent 工具目录与运行记录连续性

默认工业工具目录不应挤掉已完成查询的调用与结果。此修复供 Agent 用户和上下文维护者使用。

## 现状核查

1. 搜索 packages/apps 的 `prepareAiInput`、`availableTools`、`compressAgentContext`，核对未跟踪文件；已有可靠性扫描、完整历史校验与预算压缩，不重建。
2. 读取 industrial-agent-orchestrator 的 AgentToolDefinition、AgentCheckpoint、AgentToolRecord，以及 API 的 AgentContextBudget。工具执行合同和持久化记录已存在，无需扩类型。
3. 核对 API package.json：已有 Vitest、tsx 和工业 Agent 包，不新增依赖。
4. 消费方为 industrialAgentDecisionProvider；它将完整工具 schema 放在调用历史之前。普通助手已有扫描排序，但不适合直接代替 Agent 的完整历史合同。
5. 查看 provider、预算和可靠性测试；已有 501 项结果被裁剪时拒绝调用的回归。API 回读 QA 项目失败 run `db56b744-f0a4-44a5-bb8b-19361f17280d`，并用真实 19 工具目录复现：915 个字符串超过 256 来源额度，32,588 字符未超字符预算。计划工具返回后尚未调用 read，失败与 500 行数据无关。证据在交付目录 intro-astra/agent-context-diagnosis.json、agent-new-failed-run.json、agent-tool-catalog.json。
6. 阅读 AI-first framework 规格与 Agent 运行历史规格，核对当前 Astra 视频录制状态：本轮失败不能剪成成功；修复后新建相同目标任务，同一新run录完整开始与结果。

已有（不重建）：工具白名单、执行授权、输入扫描、历史压缩、完整结果校验、同一任务恢复接口。

真实缺口：工具 schema 的每个字符串消耗扫描来源额度；复杂目录还会触发通用深度限制，模型可能收到残缺参数合同。

## 最小改动

每个工具定义编码成一个独立 JSON 片段参与原可靠性扫描，保持工具之间的隔离。片段未经裁剪或隔离才还原为原结构交给模型；调用历史与结果仍使用原逐字段扫描和完整性检查。保留全局额度，不绕过输入策略或结果大小检查。

## 验证

四文件 40 项测试通过，API 类型检查通过。复杂目录与已完成计划同时存在时，模型消费完整工具 schema、原调用和原结果；高风险目录被隔离时不还原；既有 501 项结果及超预算请求继续拒绝。真实目录与失败 run 的离线 provider 消费核查也通过，未调用外部模型。

第二次实录 run `5776ed87-7187-41c4-b8a2-20ff6b21ba3d` 已完成计划与查询，聚合结果1行：18条、温度19.55–25.63℃、压力97.78–106.06kPa，无截断。失败原因不是预算：模型历史说明“只读低风险工具，无需额外审批”触发原扫描器critical隔离，完整历史比较随后终止。窄修只允许该说明字段保留原扫描产生的隔离标记，不恢复文字；结构化调用、参数、结果与其余历史仍须完全一致，持久化历史不变。真实第二次run及19工具消费证据在 `agent-context-diagnosis-fixed.json`；第四次完成见文末。

现成恢复入口仅支持可重试决策传输错误，此次 `invalid-decision` 不属于恢复范围。生产 API 更新后需新运行相同目标并补录启动、工具和结果；原失败保留。全仓源码体量检查发现域外在途 pbrRendererFrames.ts 为 801 行，已交给其所有者收口。

## 单任务时间预算现状核查

第三次新run `4110a372-e76e-476a-a7fb-7e2ba0654e69` 没有上下文连续性错误，但在完成一次计划后耗尽90秒预算，尚未读取数据。模型为glm-5.3-flash；原始回读在 `intro-astra/agent-final-run-readback.json`。不能将预算耗尽列为成功。

1. 已搜索Web/API/内核及未跟踪文件的budget/maxDurationMs，UI启动写死90秒；已有后台预算与取消。
2. AgentBudget和runValidation已定义单任务1秒至15分钟，默认内核120秒；Web历史默认90秒保持。
3. React/Vitest与现有原生选择控件已在用，无新增依赖。
4. IndustrialAgentWorkspace.start将DEFAULT_BUDGET传给真实startIndustrialAgentRun；场景改动走另一路径，不套用工具任务预算。
5. 已查工作区SSR、工具运行测试、runValidation及真实第三run；缺UI选择后的实际启动参数回归。
6. 已核对Agent历史、Astra录制与本轮新要求。只补单任务运行时间，步骤数/工具次数与全局策略不变。

已有（不重建）：预算执行/持久化/耗尽状态/取消和API参数。真实缺口：作者无法为慢模型显式选择更充分的单任务时间。

工具任务增加“运行预算”原生选择：90秒（默认）、3分钟、5分钟，实际选择送入既有budget.maxDurationMs。切项目恢复90秒；提交期间禁用，已有运行时显示任务面板而非新任务表单，场景改动模式不显示。较长预算只影响新任务，不改已执行历史或全局上限。

工作区预算控件到真实启动API消费的5项回归通过：90秒默认、3/5分钟参数、非法值拒绝/项目切换重置、提交等待禁用；连同既有工作区测试17项通过。Web类型检查通过。第四次UI显式5分钟任务已完成；480视觉检查仍待Root。

## 当前生产任务完成

run `74b77de6-7d25-46ed-b41b-7d0dd9b825e7` 已真实completed，budget.maxDurationMs=300000，activeDurationMs=96488，3次决策/2次工具。实际 `data.query.plan` 与 `data.query.read` 完成后模型finish，18条匹配返回1行聚合结果，未截断。全部19工具仍可发现，未改全局扫描额度；原始请求/调用/结果/完成摘要在 `intro-astra/agent-success-run-readback.json`。

1920×1080实页显示100%、3/10、2/6与查询数值。当前视频实录为完成后的12秒结果查看，源墙钟/原帧在 `raw/astra-agent-success-result-take2/frames.json`，不将片长记为任务耗时。前3次失败全部保留，未恢复为成功状态。
