# H-C5-K15/K16 chat 错误分型与网络错误本地化（2026-10-03，主线程）

## 行定义与现状核查

- K15「存储配额与模型错误分型」/ K16「网络错误本地化与恢复动作」。
- **已有（不重建）**：`AI_FAILOVER_CATEGORY_LABELS` 十类双语标签（aiSettingsDraft.ts，消费方仅管理端 failover 遥测面板）；K9 超时文案已本地化带恢复动作；K11 已做 agent run 恢复入口；K13 已做存储迁移兜底（写入失败保留重试，agentRunHistory 配额降级为文档化设计）；`loginErrorMessage` 为错误本地化先例模式。
- **真实缺口**：chat 主链错误（useAssistantChatRun catch）把浏览器/服务端英文原文直接透传 `setError`，无分型、无恢复动作指引。

## 交付

- 新叶 `apps/web/src/ai/assistantErrorFraming.ts`：`classifyAssistantError`（ServerRequestError status→auth/rate-limit/server/invalid；TypeError+浏览器原文正则→network；K9 超时文案→timeout；额度/策略关键词→quota/policy）+ `assistantErrorMessage`（双语本地化文案，恢复动作统一指向失败条目重试；timeout 原样透传；unknown 保留细节原文——开发者可诊断）。
- 接线：useAssistantChatRun catch `setError(assistantErrorMessage(reason, input.locale))`（零新 UI，错误态既有展示面）。
- 存储 配额半边判定：K13 迁移兜底已覆盖，静默降级为 agentRunHistory 文档化设计——不翻新。

## 验证

- 分型矩阵 5/5（status 分型/网络原文不透传/超时透传/关键词分型双语/未知保原文）；ai 域 21 文件 121/121（含 K9 四例回归）；apps/web tsc 0。
- 诚实边界：分型基于客户端可观测面（status+文案正则），服务端结构化 category 字段（若后续提供）可替换正则——留接口不预建。
