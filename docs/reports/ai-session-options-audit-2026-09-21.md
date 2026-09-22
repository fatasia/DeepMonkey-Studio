# AI 会话模型接线复验（2026-09-21）

此次核查既有会话模型 / 思考档位实现，没有重建模型目录或助手面板。

已核对的链路：`AssistantModelControls` → `AiAssistantPanel.sessionOptions` → `runAssistantRequest` → `aiApi.streamAssistant` → `/api/ai/assistant/stream` → `resolveAssistantSessionOptions` → provider 请求。SQL 走独立受控查询能力，界面禁用会话覆盖，服务端同样拒绝 SQL 覆盖。

普通用户目录通过系统认证钩子保护；返回默认模型、模型 ID 与配置支持的思考档位，不返回 URL / 密钥。换模型剥离主模型 reasoning 默认值，failover 同样不继承主模型思考参数。服务端没有按模型名称猜测能力。

本次修复：

- 供应商 `/models` 返回 `data` 对象 / 字符串时，原 `.map` 抛出异常；现在校验数组及成员，保留配置模型降级行为。
- 原 15 秒目录超时在响应头抵达时即清除，响应体可无限等待；现在覆盖 JSON 响应体读取。
- 普通与 SSE 助手请求的 `question` / `projectId` 非字符串原先在 `.trim` 抛出 500；现在在启动模型请求和 SSE 前返回 JSON 400。
- 目录 HTTP 200 但供应商不可用时，模型控件原来没有重试入口；现在允许直接重试，已配置模型仍可使用。

验证：API `aiModelCatalog`、`assistantSessionOptions`、`assistantServiceFailover` 3 文件 23 项通过；包括真实 Fastify 认证注入、把内存测试用户改为 viewer 后查询目录、有效覆盖传入 assistant 依赖、无效覆盖与畸形请求在 SSE 前拒绝。测试的 provider / assistant 依赖为本地替身，不调用付费模型。API 类型检查通过。

Web `AssistantModelControls`、`runAssistantRequest`、`AiAssistantPanel` 3 文件 15 项通过，覆盖模型切换参数、思考支持、SQL禁用与降级重试。尚不能将这些测试扩大为实际供应商推理成功、整个 AI 升级或浏览器视觉验收通过。

运行时核查：16:41 读取 `http://127.0.0.1:4100/health` 与未认证目录均连接拒绝，主线程同刻确认 API 进程已消失并接手恢复。本车道未停止或重启服务；运行实例的目录 / 无效请求复验待其恢复，未更改固定账户或环境凭据。

## 运行实例复验

16:45 后续只读复验通过：health 200，未认证模型目录 401，既有管理员认证目录 200，返回 27 个模型；顶层只含 defaultModel / models / catalogAvailable，各模型只含 id / reasoningEfforts，缓存头 no-store / private，不含 apiKey / baseUrl / protocol / failover。未输出令牌、模型服务地址或密钥。

普通及 SSE 两条助手接口分别验证 question 为数字、projectId 为数组、model 为数字、reasoningEffort 为非法值，共八次均为 JSON 400。未发送有效生成请求，未触发收费模型推理。运行实例没有新增或修改账户；普通 viewer 的权限对照由上述隔离的认证集成测试证明。

API 进程诊断发现重复启动的确切证据：报告给定 PID 91700 已退出，而 4100 实际由 PID 88584（16:41:48 创建）监听，其父 PID 62640 是 09:02 启动的 `node --conditions=development --import tsx --watch src/index.ts`；该参数与 API package.json 的 dev 命令一致。`test-output/layer-qa-api.err.log` 记录 `EADDRINUSE 0.0.0.0:4100`，说明手动恢复副本曾与既有 watch 重启实例竞争端口。

推断：源码编辑会让 watch 子进程更换，启动间隔内暂时拒绝连接；这解释了至少部分“PID 消失 / 短暂 502”，不能把旧 PID 消失直接认定为服务永久停止。后续应先检查 4100 当前监听者及其父 watch 进程，再决定是否需要恢复；不要只按旧子 PID 反复启动。第二次探测仍为 PID 88584 / health 200。本车道没有杀进程或改变启动配置。

## 流式请求生命周期复验

16:49 核对现有 `AiAssistantPanel`：项目 / 场景 / 脚本切换会取消旧 controller，回调同时校验请求身份、signal 与同步 scope；`runAssistantRequest` 已在 BIM 准备、SQL 两阶段和模型返回后检查取消。现有测试覆盖迟到 BIM、SQL、delta 与结果，保留这些实现。

发现并修复 transport 层资源问题：原 `aiApi.streamAssistant` 在 done / error 后直接返回或抛出，没有取消未关闭响应体、释放 reader；读取器也没有独立处理中止，依赖 fetch 实现。抽出 `apiClients/assistantStream.ts`，收到终止事件、中止、格式错误或无 done 的 EOF 均释放 reader；中止立即取消待读取，逐事件检查 signal，避免同一 chunk 中止后继续派发旧事件。done 必须包含字符串 text，未知事件跳过。

真实 ReadableStream 定向测试覆盖逐字节中文 / CRLF、done 后服务端仍未关闭、待 read 中止、delta 回调内中止后同 chunk 迟到 delta / done、错误与格式异常、缺终止帧，以及真实 createAiApi 的“取消旧请求 → 立即重试”隔离；加上已有请求编排回归，2 文件 18 项通过，Web 类型检查通过。无外部生成请求，未改模型控件外观。该证据证明客户端流生命周期，尚不代替整个页面场景切换端到端验收。

## 消息操作切片

16:53 对照方案 P0“基础交互修正”，现有消息组件没有复制入口，新增 `AiMessageCopyAction` 接入完整回答与停止 / 失败后的部分回答。流式仍进行时不显示此动作，避免复制到不断变化的半句。复用既有 `DocsCenterClipboard` 的 Clipboard API + 内网 HTTP / WebView 兼容路径；复制中禁重复，成功以按钮状态和读屏播报反馈，失败提示手选复制并允许重试。没有新增剪贴板框架或修改模型控件。

消息操作、消息呈现与面板 3 文件 9 项定向测试通过，覆盖准确文本 / 换行、失败与重试、空文本、停止后部分回答入口和流式进行时隐藏。样式只使用既有主题令牌，布局允许窄窗换行。真实浏览器剪贴板权限、双主题和窄窗截图仍由产品验收继续。

## 上下文预算与来源范围复核

17:00 修复问答最后装配阶段的静默截断：原 `assistantPrompts` 直接取 JSON 前 80,000 字符，模型与用户均不知道后续来源没有发送。现在模型输入明确标为不完整 JSON 前缀，并说明服务端整理后的总字符数与实际发送字符数；避免在代理字符对中间截断。普通与流式回答共用相同截断警告，可靠等级标为“证据有限”，现有回答证据详情直接显示该警告。字符计数为 UTF-16，不是 token 数，也不是原始客户端载荷大小。

问答与 Agent 尚未采用同一预算策略：问答在 `prepareAiInput` 预处理后加入能力目录，再受 80,000 字符前缀限制；Agent 的 `agentContextBudget` 仅针对决策 / 工具历史约 48,000 字符压缩，保留最近一轮，因此可以超限，用户上下文、工具目录与项目证据也不计入该历史预算。另发现 compression.approxChars 当前始终为 0；本切片未修改 Agent。共同的 prepareAiInput 还包含字符串 / 来源 / 深度 / 数组成员限额，其剪裁并未全面汇总到来源 UI。

前端来源检视当前反映请求准备快照的就绪状态与数量，不等于最终模型输入逐来源覆盖范围。此次回答详情补上真实最终截断警告；逐来源保留 / 截断 / 未发送映射、统一总预算仍待后续，不应据此宣布 P0 全部完成。

验证：assistantPrompts 与 assistantService 两文件 13 项通过，包含真实 PluginRegistry 普通 / 流式编排、能力目录落在截断后确实未发送、相同警告回传、短上下文无警告、Unicode 边界；API typecheck 通过。使用本地测试 provider，未调用外部收费生成。源码改动触发既有 watch 后，父 PID 62640 / 子 PID 89976 自动恢复，17:00 端口 4100 由该子进程监听、health 200；没有启动额外 API 副本。

## Agent 预算硬门槛补齐

17:04 后续修复上节 Agent 缺口：历史压缩统计 approxChars 改为实际 decisions + toolResults JSON 的 UTF-16 长度，并携带 charBudget；旧决策摘要保留完整 call，结果保留 step，可与决策按 step 对应。保留最近一轮完整调用与结果，逐步缩小旧轮完整窗口；最近一轮或历史调用参数仍无法装入预算时返回 agent-context-budget-exceeded，不再带着超额内容调用模型。

决策 Provider 在可靠性预处理前检查完整 objective / context / system 的 80,000 字符上限，发送前再次包括可靠性系统提示检查实际 input + instructions 长度；目录和项目证据不再绕过总门槛。若扫描器因成员 / 深度 / 来源数量限制或隔离改变了必要历史，明确拒绝，避免完整工具记录悄悄变成残缺消息。超限时保留请求与工具结构，不做 JSON 字符串硬切割；让调用者缩小返回范围后继续。

验证：agentContextBudget、industrialAgentDecisionProvider、industrialAgentSelection 三文件 20 项通过，API typecheck 通过。覆盖精确统计与实际输入对应、压缩后的 call/step 配对、最近结果 / 旧调用参数超限、目标 / 用户上下文 / 项目证据超限且 provider 零调用，以及 501 项工具结果被扫描器裁剪时拒绝。当前策略是字符预算而非模型 token 预算；大记录自动分页检索和逐来源发送映射仍未实现。

## 逐来源实际发送回执

17:10 新增可选 reliability.contextDelivery 回执，不改变既有来源 ID。服务端按最终 JSON 属性位置计算每个既有项目 / 工作区来源的 preparedChars、sentChars 与 sent / partial / omitted；JSON 字符串中的同名文字不参与定位。对比整理前后来源，额外标记预处理裁剪 / 隔离，包括 501 条记录先被裁成 500 条而未触发最终字符上限的情况。回执只带路径、计数与状态，不回传来源正文。

每条回答通过既有 reliability 转换保存对应回执，回答证据折叠内新增“实际发送来源”明细，复用既有来源折叠面板样式与 source.id 标签，显示已发送 / 部分发送 / 未发送及实际字数；收到真实回执时不再把原来的就绪标签列为“本次涉及”证据。旧响应缺少回执时保持兼容，不伪造发送证明。发送前来源就绪表示读取状态，回答回执表示该次请求真正发给模型的范围。

API 三文件 16 项通过，Web 三文件 10 项通过；覆盖普通 / 流式回执、预处理裁剪、前缀截断、字段移除、嵌套 JSON 与转义重名、回执到折叠来源明细、畸形与缺失回执。API 类型检查通过。视觉设计沿用西门子式克制信息表达和 base.css 来源组件令牌；浏览器两轮截图、响应式 / 双主题以及十维评分仍待主线程验收，当前不标记视觉通过。字数为 UTF-16，来源明细对应既有来源清单，不等于所有元数据字段，也不意味着模型已验证事实。

17:12 补验：Web exactOptionalPropertyTypes 的可选标签参数已修正，类型检查通过；Web 10 项复测通过。API watch 子进程 78244 已重新监听，health 200。

## 模型与思考档位接线补齐（18:00）

复查现有普通问答链路：AssistantModelControls → streamAssistant session options → resolveAssistantSessionOptions → provider 已接通，切换模型会清除旧思考档位。目录成功刷新后补上失效模型 / 档位校正；目录暂时不可用不清除用户选择。服务端仍按目录与管理员启用能力验证，不因模型名称猜测支持。

工业 Agent 原先只有全局模型配置。本次复用同一模型控件，在创建任务前选择模型与思考；服务端启动前验证并把非敏感 modelOptions 存入 checkpoint，恢复决策复用这些选项，不保存 endpoint 或密钥。旧 checkpoint 缺字段保持既有行为。另修复 Agent failover 把主模型思考档位传给备用模型的问题，与普通问答行为统一。

API 三文件 25 项、Web 两文件 13 项通过，两端类型检查通过；覆盖启动前参数校验、checkpoint 选项持久化、按运行覆盖思考档位、备用模型清理强度、模型目录更新与断网区分。没有付费模型调用；完整页面、双主题和刷新后的任务操作统一后验收。

剩余：上游实际模型名与实际 reasoning 参数尚无贯通的响应回执，现有流式回答模型名来源是请求模型 / 备用模型配置，不能据此证明上游实际执行档位。非主模型的思考能力仍需明确能力配置合同，不能仅凭 `/models` ID 自动开放全部强度。
