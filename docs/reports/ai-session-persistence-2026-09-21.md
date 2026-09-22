# 普通问答会话持久化服务

该服务保存当前用户的项目问答快照，供前端恢复已完成回答、停止后的部分回答和中断状态。它不调用模型，不替代现有工业 Agent 检查点，也不把客户端保存的回答标为已验证证据。

## 接口合同

合同为 `packages/contracts/src/aiSession.ts`，从 contracts/index 显式导出。以下路径均以 `/api/projects/:projectId/ai/assistant-sessions` 为前缀：

| 方法 / 后缀 | 请求 | 返回 |
|---|---|---|
| GET 集合 | after=上一条 ID；limit=1..50，默认20 | AiSessionList |
| PUT /:sessionId | {title} | AiSessionSummary |
| GET /:sessionId/messages | 同上分页 | AiSessionMessages |
| PUT /:sessionId/messages/:messageId | AiSessionMessageInput | AiSessionMessage |

session/message ID 支持 UUID，字符为英文字母、数字、下划线、短横线，长度1..128。消息代表一轮问答，保存 question、answer、mode、status、sequence，可选 model 与稳定对象 scope ID；包含 createdAt / updatedAt。客户端提供的 owner、projectId、context、配置等额外字段不会入库。

状态写入可取 streaming / completed / stopped / failed；服务进程初始化时将历史 streaming 转为 interrupted 并保留部分文字。普通 GET 不改变仍在运行的状态。前端应在流式过程中节流写入部分回答，完成 / 停止时等待终态保存；这是会话快照读写链，本切片没有改造模型 SSE 为后台任务，也没有自动重放未保存增量。

## 一致性和权限

- owner 只取已认证 systemUser；GET / PUT 均重新校验项目访问权，其他用户及其他项目不能复用会话 ID。viewer 仅新增自己的问答快照保存权限，原 Agent 写入权限不变。
- 创建重试要求同 ID 同标题；消息同 sequence 同正文幂等，不同正文409；旧序号409；终态不可回活。更新不能改变问题、模式、所属对象。
- 会话按创建顺序倒序（最近优先），消息按创建顺序正序，用末条 ID 作游标。更新不重排，分页途中新增会话不影响 after 游标后面的旧会话。
- 原子文件替换完成后才提交内存；队列内校验版本，写入失败不暴露未提交内容，后续可重试。
- 每用户项目50会话、每会话100轮、全服务500会话；问题4000字符、回答100000字符、标题120、模型/对象标识256；文件20MiB、单消息请求512KiB。达到上限明确429，不删除旧会话凑空间。

## 验证

五文件15项通过，API类型检查通过。真实临时磁盘覆盖会话 / 消息保存、关闭API并重建后恢复、部分回答 interrupted、完成和停止终态保留、并发幂等、序号冲突、稳定分页、字数和数量限制、真实原子替换失败与重试。

真实 registerSystemRoutes 登录链测试证明 viewer 可保存和读取自己的项目会话，匿名401、外项目403；不同owner / 项目会话404，未放宽工业 Agent 启动权限。测试不调用外部模型，不更改运行环境的账户或凭据。

## 前端接线与竞争修复（17:53）

前端已通过 `useAssistantSessions` / `useAssistantChatRun` 接入会话选择、新建、历史分页恢复、800ms 快照合并、终态立即保存和失败重试。`AssistantSessionWriter` 串行写入，网络结果不明时重试相同序号与正文，终态后丢弃迟到 delta。历史不保存原始项目上下文或令牌，也不把未存储的 reliability 补成已验证证据。

本次续跑先核对既有接线，仅修补剩余缺口：停止的部分回答在下一次提问时归入历史，保留上下文；会话租约防止它进入已切换的新会话。项目或认证身份切换清空当前重试集合和分页游标，旧项目失败写入不进入新项目的重试操作。新会话同时清除旧错误，迟到的历史分页不会覆盖新会话。

四文件 14 项关键测试通过：writer 3 项、恢复 6 项、消息渲染 3 项、请求生命周期 2 项；覆盖失败同序号重试、串行终态、跨项目迟到读取/保存隔离、新会话历史竞争、停止部分答复进入下一轮和迟到 delta 拒绝。未调用付费模型。完整页面刷新、双主题与全量回归按用户要求留到统一验收。

会话事件日志、断线增量重放、后台问答生成和跨进程共享写入仍未实现。现有文件存储限单 API 进程，重启恢复不会自动续调用付费模型。

## 可靠性与上下文回执恢复（2026-09-22）

普通回答现在一并保存页面已展示的有界可靠性快照：等级、证据来源、Trace、指纹、风险、写入策略、警告、来源标签及上下文实际发送计数。API 对这些字段做枚举、长度、数量和字符预算校验，拒绝伪造超界对象；旧消息没有该字段时继续按历史兼容路径显示。刷新或重新打开会话后，前端恢复同一快照并继续展示证据折叠区，不再把已保存回答降级成“未保存验证证据”。该快照是回答元数据，不替代重新执行 Capability。

本次新增/修改：`packages/contracts/src/aiSession.ts`、`packages/contracts/src/index.ts`、`apps/api/src/ai/assistantSessionRoutes.ts`、`apps/web/src/ai/useAssistantSessions.ts`、`apps/web/src/ai/useAssistantChatRun.ts` 及对应 API/Web 定向测试。合同类型检查、API 路由 4 项、Web 会话/请求 9 项通过；正式页面刷新、双主题和真实供应商回执仍属于最终验收。
