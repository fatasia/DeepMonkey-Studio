# H-C6-S3-connect v2：client 方法 × 产品链消费对账（2026-10-03，主线程）

## 口径与工具

inventory v2 余量②「端点逐条对账到 UI 消费点」的自动化面：`apps/web/scripts/apiEndpointConsumptionAudit.mjs`——以 apiClients 导出方法为对账主体（121 个，15 域），全仓 grep 调用方并按域分类（components/hooks/panels/controllers/adapters/delivery/studio = 产品链；apiClients/other = 间接）。

## 结果（三轮分类修正后终版）

**121 方法：115 有产品链消费，6 条无直接 fetch 消费，逐条判定零真缺口：**

| 条目 | 判定 |
|---|---|
| ai.onDelta / ai.askAssistant | 解析伪影（回调参数名/内部别名，非独立端点） |
| alertIngest.fetchReplay（data/replay） | 预留回放 API；E1 验收见空态 400 面板指引（文档化设计） |
| industrial.getCapability / assessMaintenance | API-only 合法：能力单项查询与维护评估属 agent 网关/脚本域服务能力 |
| modelScene.getPublishedScene | 双通道合法：云 Worker 直接拦截 URL（sceneViewerDelivery），client 为桌面/直连备用 |

脚本分类缺陷修复记录（初版→终版）：controllers/adapters 域漏分类（4 条误报）→ delivery/studio 域漏分类（5 条误报）→ 终版 6 条全部人工判定合法。

## 结论

- **v2 端点对账完成，无未接线的孤儿端点、无静默丢失的消费面。**
- connect 行两批闭合：首批（externalResource/scriptGit 两入口升接通+三真缺陷根因修复+浏览器证据）+v2（全量端点消费对账）。
- 余量如实登记：403 组件逐个能力标签（纯文档增强，不阻塞产品）；"/operations" 子任务全参数面（归属运营中心域）。
- 证据：`test-output/hc6s3-v2-audit-20261003/consumption-audit.json`（121 条全量明细）。
