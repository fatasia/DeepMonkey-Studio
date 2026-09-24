# 二维编辑器 AI 助手统一收口（2026-09-24）

## 结论

二维编辑器已复用平台通用 `AiAssistantPanel`、会话恢复、Composer、模型控制、可靠性证据和变更确认链。旧的 `DashboardAiDraftEntry/useDashboardAiDraft` 平行入口已移除；AI 生成的二维变更先经过现有 dashboard draft 校验器，展示差异后才派发可撤销命令，不直接保存或发布。

## 现状核查

### 已有（不重建）

- 平台与三维场景已经共用 `AiAssistantPanel`、`useAssistantSessions`、`useAssistantChatRun` 和 `AiChangeConfirmation`。
- `dashboardDraftPageContext`、`validateDashboardDraft` 已定义二维页面上下文、允许变更、数据集绑定校验、diff 与应用命令。
- `applicationRuntime.dispatchApplicationCommand` 已提供撤销/重做所需的权威命令入口。
- Dashboard 顶栏和平台 overlay 已有 AI 开关状态，不新增第三个浮层管理器。

### 真实缺口与修复

- 二维编辑器此前使用独立 Draft 组件，视觉、会话、停止/重试和可靠性行为与通用助手不一致。
- Dashboard 路由现向通用助手提供当前应用、页面、选区、组件摘要和数据集字段；助手默认进入二维模式。
- 响应中的二维草稿先由 `validateDashboardDraft` 生成 diff，用户确认后才派发命令；viewer 只能查看，不能应用。
- 会话 scope 纳入 dashboard/page 身份，切换页面不会串会话；会话恢复期间 Composer 明确禁用。
- 原独立 Dashboard AI 入口、样式与 diff 组件删除，避免两套实现继续漂移。

## 验证

- `AiAssistantPanel`、Composer、请求、会话、dashboard draft、DashboardWorkspace 聚焦测试：36/36。
- 通用助手测试覆盖二维默认模式、变更确认、viewer 权限、会话恢复期间禁发和可靠性状态。
- 应用动作只更新当前作者草稿，仍需用户走既有保存/发布流程。

