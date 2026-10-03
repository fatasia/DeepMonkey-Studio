# H-C5-K9 chat 整体 deadline 与 SSE 空闲超时（2026-10-02）

## 现状核查（六步）

1. 全仓/未跟踪：chat 链 = `useAssistantChatRun`（停止/取消/归属）→ `runAssistantRequest`（模式编排，140 行）→ `aiApi.streamAssistant` → `assistantStream.readAssistantStream`（49 行 SSE 读取）。无重复实现。
2. 契约：`AiAssistantResponse` 流式合同（delta/execution/error/done 四事件）不动；`runAssistantRequest` 的 `signal` 是唯一取消入口（sql/bim/dashboard 三模式共用）。
3. 依赖：零新增（AbortController/setTimeout/TextDecoder 既有）。
4. 消费方：`readAssistantStream` 仅 aiApi 一处生产消费（另有专测）；`streamAssistant` 经 api 对象注入 runAssistantRequest（测试可注入假 client）。
5. 测试与证据：`assistantStream.test.ts`/`runAssistantRequest.test.ts`/`useAssistantChatRun.test.ts` 存在，无任何 idle/deadline 用例——挂死场景零覆盖。
6. 规格：61 行估时表 H-C5-K9（chat 整体 deadline/停止/超时语义，处理 SSE 挂死；2-4h 高信心）；root 账本只读。

**已有（不重建）**：手动停止（abort+reader.cancel+会话保存"stopped"）、逐事件解析、错误事件透传、execution 合同。

**真实缺口**：①服务器接受连接后不发字节 → `reader.read()` 永久挂起，界面无限 busy；②流发几个 delta 后停摆 → 同样永久等待；③无整体 deadline → sql/bim 前置与流合计可挂任意久。用户只能手动停止，且没有可读的超时原因。

## 最小方案

- `readAssistantStream` 增可选 `idleTimeoutMs`（缺省 30_000）：每次 `reader.read()` 与空闲计时器竞速，超时 → cancel reader + 抛本地化错误"AI 响应超时（30 秒无数据）…"；有字节即重置。零字节与停摆同门。
- `runAssistantRequest` 增可选 `overallDeadlineMs`（缺省 180_000，覆盖 sql 草稿/读取、bim 准备与流全程）：内部 AbortController 与外部 signal 级联；超时 → abort 下游 + race 抛本地化超时错误（下游后续 rejection 吞掉防 unhandled）；外部手动取消语义不变（仍归类"stopped"）。
- 两个缺省常量集中导出；不改事件合同、不加 UI、不加依赖。
- 测试：空闲挂死超时/有字节重置/整体 deadline 触发并 abort 下游/手动取消优先于 deadline/既有全族回归。

## 结果

- `assistantStream.test.ts` 既有族 + 新 2 例、`runAssistantRequest.test.ts` 既有族 + 新 3 例（含假 client 挂死→超时错误、手动取消仍 stopped 归类、deadline 后下游 abort 被调用）全绿；同族 `useAssistantChatRun.test.ts`/`scriptAssistantSession.test.ts`/`assistantSessionApi.test.ts` 回归绿；web tsc 0。
- 缺省：空闲 30s、整体 180s（`CHAT_STREAM_IDLE_TIMEOUT_MS`/`CHAT_REQUEST_DEADLINE_MS` 集中导出，可测注入）。超时错误信息人话+可操作（重试/检查网络）。
- 如实边界：服务端仍在写但整体超 180s 的长回答会被截为失败——这是 K9 要求的 deadline 语义本身，用户可重试；误伤率未做线上统计。仅 chat 链覆盖，agent 运行时（industrialAgentRuntime）有自身预算语义不在本行。

## 实测与首跑缺陷（2026-10-02 主线程完成）

- **首跑 5 失败全是本实现真缺陷**，逐一修：①入口前已 abort 的外部 signal 不触发 abort 事件→deadlineController 未级联（加 `if (signal.aborted)` 立即级联）；②deadline 赢得竞速后内层随 abort 解体的迟到 rejection 未吞→unhandled（workload 挂 no-op catch）；③④两个既有断言绑死下游 signal 与外层对象同一——合同演进为级联 signal（外部取消/超时都 abort），断言改为"非外层 + 外部取消即刻 aborted"，意图（取消级联到 SQL 两段）保持；⑤done 后 cancel 是既有合同，新断言误写 not.toHaveBeenCalled 已撤。
- 新增测试自身一缺陷：手动取消用例在 abort 监听器里 throw——那是 uncaught 不是 promise rejection，改为以 reason 拒绝流 promise（模拟真实 fetch）。
- 终验：`assistantStream`（idle 3 例：零字节挂死/首块后停摆/逐块重置不误伤）+`runAssistantRequest`（deadline 触发并 abort 下游/手动取消保持 AbortError/正常完成不受影响 3 例）+既有 chat 链族 **41/41**；接线材质用例 4/4 复验；**web tsc 0**（遗留调试文件已删）。证据 `test-output/hc5-k9-chat-deadline-20261002/`。
- 边界：默认空闲 30s/整体 180s 是工程定值非产品统计；超时长回答按 K9 deadline 语义截为失败可重试；agent 运行时预算不在本行。

## K18 相邻刀（超时失败的端到端会话收口）

- 锁定用例（useAssistantChatRun.test.ts，4/4）：超时错误以人话文案进 `error` 态即时可见（mock useState 下重读 cell 读取，非裸 AbortError），会话条目按 `failed` 收口且 writer 保留失败快照可重试。
- **K18 审计面如实登记（非本批修复）**：失败原因文案只存于瞬时 `error` 态，不持久化进会话条目——刷新/切域后失败条目无原因。属既有设计，留 K18 行审计裁决是否持久化。
- 过程自纠：初版断言误读 `input.setError`（hook 输入无此键）与首渲快照，修正为重渲读取；修测试非放宽。
