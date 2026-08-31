# 统一通知 Lite

该模块提供单向、服务端统一分发，适合告警、预测维护、AI、仿真和发布等事件调用。当前纵向证据是场景发布：发布记录落库后异步派发 `scene.published`，投递失败只写服务端日志和审计，不回滚已发布场景。

## 管理 API

所有 API 都位于 `/api/admin/notifications`：

- `GET /snapshot`：读取可编辑配置的脱敏快照。
- `POST|PUT|DELETE /channels`：渠道；更新和删除路径以 `/:id` 结尾。
- `POST|PUT|DELETE /recipients`：个人、内部成员组或外部目标。
- `POST|PUT|DELETE /rules`：按事件、严重度及 project/scene/object 目标匹配。
- `POST|PUT|DELETE /templates`：仅 `text`、`markdown`、`card-lite` 三种内部格式。
- `POST /test`：提交一条测试事件；`GET /audit`：读取投递、压制、失败和跳过的审计记录。

配置保存在 API 的 `data/notification-configuration.json`。Webhook 端点和结构化凭据只保存在服务端；`snapshot` 只返回 `endpointConfigured`、掩码和 `secretConfigured`，不会返回明文。管理页可维护收件人并在同一规则中选择渠道、目标、模板和静默时段；失效引用会被明确标出，不能误保存。服务端也会拒绝缺少渠道、收件人、模板或引用不存在对象的规则，已被规则引用的配置无法删除。SMTP 与企业应用渠道创建时必须写入和渠道类型一致的 `credential`，而不是把凭据放在浏览器状态。

## 渠道与身份边界

支持固定渠道 `smtp`、`lark`、`wecom`、`dingtalk`、`webhook`。飞书、企业微信、钉钉的 `deliveryMode: "bot"` 调用自定义机器人 Webhook，即一个群端点；组目标可声明 `@全体` 和平台用户 ID。个人/部门定向使用 `platformUserId`、`platformTargetType`、`platformDepartmentIds` 合同字段，并要求 `deliveryMode: "application"`。前端应明确区分这两种模式：机器人是一个群端点；企业应用发送给平台用户或部门。

SMTP 使用 `nodemailer` 按 host/port/from/auth 真实投递。飞书企业应用先获取并缓存 `tenant_access_token`，再按 `open_id`、`user_id` 或 `chat_id` 发送 interactive card-lite；企业微信先获取并缓存 `access_token`，再使用 `touser`、`toparty`；钉钉企业内部应用先获取并缓存 token，再使用 `userid_list`、`dept_id_list` 发送工作通知。三种企业应用默认使用各平台官方 URL，并可在结构化凭据中以 `baseUrl` 注入本地 mock。临时网络、429 与 5xx 归为可重试错误，凭据错误与收件人错误会立即失败。

密钥引用、平台身份 ID 与出站卡片映射可复用；飞书/企微/钉钉的入站 AI 对话不属于本模块，后续应由独立 `officeBotBridge` 接入既有 AI capability registry。当前有本地 mock HTTP 和 mock SMTP 边界测试，尚未取得真实企业租户、真实 SMTP 服务与真实终端的实网验收证据。

## 办公 AI 机器人的轻量接入结论

市场上的入站机器人不是一种通用 Webhook：飞书使用应用机器人和事件订阅，企业微信同时存在加密 URL 回调与智能机器人长连接，钉钉优先提供 Stream 机器人及交互卡片。三者只共享内部标准消息，不共享鉴权、加密、重试和流式回复协议。因此不把入站协议塞进通知 Transport，也不让外部平台用户默认继承管理员权限。

若后续取得真实企业租户，本项目只增加薄适配层：

1. 各平台 Adapter 完成来源验签、解密、事件去重、超时快速确认和异步回复，再输出统一 `OfficeBotMessage`。
2. `platformUserId` 必须显式绑定现有平台账号、项目角色和允许的项目范围；未绑定用户只能收到绑定入口，不执行问数或项目查询。
3. 首期只调用现有只读 AI capability 与确定性查询；需要改场景、脚本、规则或发布时，返回平台内变更链接，在现有页面完成差异预览、一次确认、撤销和审计。
4. 会话只保存最小上下文、项目 ID、能力 ID、输入指纹和回执状态；附件、密钥和完整业务数据不复制到通知配置。
5. 每个平台必须用真实租户完成验签、重放攻击、重复事件、超时、断网重试、权限越界和卡片回执验收，才标记为可用。

这个边界保留“在办公软件里问状态、收告警、打开处置上下文”的高价值体验，同时避免复制一套聊天系统、审批中心或 Agent 平台。

未配置 `NOTIFICATION_WEBHOOK_URL` 时运行时默认没有外发渠道；配置测试使用本地 mock，不会访问真实服务。
