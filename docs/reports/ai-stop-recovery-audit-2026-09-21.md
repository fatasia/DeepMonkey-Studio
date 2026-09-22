# AI 停止幂等与恢复审计

本切片修复工业 Agent 停止后的持久化竞争，面向断线重试和页面刷新恢复。普通问答会话持久化仍未实现。

## 已有链路

- 工业 Agent 使用 `industrial-agent-checkpoints.json` 原子替换存储，保存成功后才更新读侧快照。
- `/api/projects/:projectId/ai/agent-runs` 支持 background 启动，GET runId 返回持久检查点；approve / resume 已处理审批、用户选择和 revision 冲突。
- DELETE 已在编排器对终态短路；客户端断线不自动终止 background 任务。恢复依赖已知 runId，不是 SSE 事件重放。
- 普通问答仍是 React 内存会话与单次流式请求，尚无服务端会话目录、运行 ID、事件序号或跨刷新消息恢复。本次不新增第二套 Agent 存储。

## 修复

原持久层只按排队顺序覆盖，迟到旧快照可以覆盖较新状态乃至取消终态；并发 DELETE 可各自读取同一旧检查点再重复保存。

持久层现在在写队列内部核对最新已提交版本：相同快照重试不写盘；旧 revision、同 revision 不同内容、取消后的任何变更均返回 checkpoint-conflict。正常失败决策恢复仍可通过更高 revision 保存，不把所有终态一概锁死。

同一个运行的并发 DELETE 共享正在进行的取消 Promise。落盘失败时清除该请求记录，客户端可重试；不会把未提交取消当作成功。项目匹配与 viewer 拒绝仍先于取消操作执行。

## 验证

真实临时目录、原子文件存储、实际 IndustrialAgentOrchestrator 和 Fastify 注入集成覆盖：

- 八个并发 DELETE 得到完全相同检查点，仅调用一次取消，revision 只前进一步。
- 迟到旧版本和较新版本伪回活均被拒绝；重新构造 store / API 后，GET 和重复 DELETE 仍返回同一取消状态。
- 外项目 404、viewer 403；取消过程未执行工具，未调用外部模型。
- 排队陈旧写入不能覆盖最新磁盘状态；一次持久化失败后取消可重试，未提交状态不对外可见。

stop/recovery、checkpoint store、routes、data flow 四文件共 17 项通过，API 类型检查通过。磁盘写失败用定向错误注入；既有 store 测试另通过将目标文件换成目录覆盖真实写入失败与恢复。

## 仍需补齐

普通问答跨刷新恢复、首次 background 创建响应丢失时找回运行、事件序号重放尚未完成。当前文件存储的写队列属于单个服务实例；本切片不承诺多个 API 进程同时写同一文件的跨进程事务能力。

17:25 API 已由既有 watch 自动恢复，父 PID 62640 / 子 PID 47240，4100 health 200；未启动额外服务副本。
