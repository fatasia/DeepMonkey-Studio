# AI 模型与思考档位执行信息

普通问答的回答详情现在区分请求参数和供应商回执。此信息不是供应商内部执行的独立证明。

- OpenAI 兼容 Chat/Responses 普通与流式路径记录实际发送的协议档位，保留响应中的模型名及回执档位；未回执保持缺省。
- 主模型尚未输出正文就失败并切换备用时，清理主模型旧 model、usage 和 execution；协议自动切换记录最终实际采用的协议。
- 前端按需展开模型与思考设置，展示请求模型、服务商返回模型、发送档位、返回档位。普通会话持久化与恢复保留这份有界信息，不保存服务商响应原文或凭据。
- 服务商未返回模型时，旧 model 字段继续兼容请求配置；execution.reportedModel 缺省明确表示没有回执，不能据旧 model 字段推断为已确认。

验证：API 4文件30项（provider、service/failover、真实磁盘session路由），Web 4文件21项（回答展示、请求、会话与运行hook）及两端类型检查通过。

追加实现：Agent 每一步通过独立 provider 回调保存执行回执，模型决策 JSON 不能覆盖回执；checkpoint 磁盘保存和新实例恢复保留该字段，旧 checkpoint 缺字段仍可展示。普通回答通过 SSE 及时保存回执，停止/失败保留已收到的执行信息，迟到事件不覆盖终态；备用模型接管先清理主模型回执。流式与停止回答复用折叠详情。

追加修复：Responses 流的 token 用量从 response.usage 读取，避免完成事件中的嵌套用量丢失。

增量验证：编排器9项；API provider/checkpoint/协议3文件31项；Web展示与流/运行5文件30项；插件运行时4项；API service/failover/integration3文件18项，新增备用回执清理后 failover 单文件8项通过。API类型检查通过。各轮测试存在重叠，不累加为独立覆盖总数。

待办：实际页面详情/刷新交互及正式生成最终验收。普通会话保存是私有历史记录，不作为不可篡改审计凭证。

18:34 终态修复：普通与流式兼容协议不再把 HTTP 200 下的失败、Responses incomplete 或 Chat length 截断当作完成；流在没有终止标记时断开会报未完成，收到 DONE 立即关闭 reader。此前正文非空即可进入完成态，会把上游失败后的部分回答当作成功。失败片段沿用已实现的会话保存，输出正文后不拼接备用模型答案。协议判定参照 [Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming/response/incomplete)。provider、真实本地 HTTP failover、service failover 三文件31项与API类型检查通过；未调用收费模型。

2026-09-22 00:16 增量：执行回执新增可选 servedBy/failoverCategory。普通非流式、流式在收到备用回执时即写入主/备用来源与分类原因；停止后的部分回答仍保留，迟到回调不覆盖。Industrial Agent 同样把备用接管原因交给已有 checkpoint 持久层。会话 API 限定原因类别，不保存上游错误原文；详情显示“备用模型接管 · 主模型限流”等短标签，长模型名允许断行。旧回执无字段不补造原因。没有回执的第三方 provider 仍保持缺省。

API 第一轮3文件25项，增量2文件13项（包含9项failover复验）；Web展示2文件9项通过；两端类型检查通过。新增真实磁盘会话恢复、Agent checkpoint恢复、备用SSE回执与完成一致、停止后保留原因/拒绝迟到覆盖。1280/980双主题实际页面及正式生成仍归集中验收，本次未调用付费模型。
