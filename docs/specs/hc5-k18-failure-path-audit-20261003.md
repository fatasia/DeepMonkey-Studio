# H-C5-K18 chat/agent 失败·恢复·应用失败相邻路径对账锁定（2026-10-03，主线程）

## 行定义

「当前 chat/agent 失败、恢复、应用失败的相邻路径回归缺口对账并锁定」（2–4h）。依赖面全部为本周刚收口的相邻刀（K9/K10/K11/K13/K15/K16）。

## 对账矩阵（三类路径 × 三要素）

| 路径 | 错误可见性 | 恢复动作 | 持久化 |
|---|---|---|---|
| chat/agent 失败 | 瞬时 error 态=分型本地化文案（K15/K16）✅ | 失败快照重试（K9）✅ | **条目级 error 字段（本刀补齐）** |
| agent run 恢复 | 404 分型+runId 短码+陈旧/跨项目显式化（K11）✅ | 「重试恢复/清除记录」动作对应（K11）✅ | 多运行历史滚动 10 条（K13）✅ |
| dashboard 草图应用失败 | applyError 既有展示（产品中文校验文案，无需分型）✅ | 撤销通知既有（"可撤销；尚未保存或发布"）✅ | 草图本体在面板态（既有）✅ |

## 本刀补齐（追加六十二登记的缺口）

**失败原因仅存瞬时 error 态、刷新后失败条目无原因** → `AssistantConversationItem.error` 字段：catch 处经 `assistantErrorMessage`（分型本地化）写入条目，writer.update/partialTurn 双路携带，`AiAssistantMessages` failed 条目渲染 `未完成 · <原因>`。手动取消（stopped）不带原因（语义正确）。

## 验证

- 新用例：网络失败（TypeError）→ 条目持久化 error=分型文案「无法连接 AI 服务…」+瞬时态可见；既有 K9 超时用例零回归。useAssistantChatRun 5/5+AiAssistantMessages 13/13。

## 既有设计裁决（维持不改，如实登记）

- dashboard 应用失败不接分型器：应用失败以本地校验中文文案为主，透传已可读；引入分型属过度工程。
- stopped 条目不带 error：取消非失败。
