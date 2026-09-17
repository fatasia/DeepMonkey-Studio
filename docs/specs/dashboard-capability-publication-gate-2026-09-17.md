# P0-04 能力报告放行消费方（2026-09-17）

对应 [codex-mainline-handoff](../codex-mainline-handoff-2026-09-17.md) 阶段 2 P0-04："能力报告写入正式发布 manifest 并作为放行/阻断消费方"。

## 现状校准

能力报告（`DashboardPublicationCapabilityReport`）**已经在 C5 候选记录内**（`DashboardNativeCandidate.capability`，随 `freezeCandidate` 冻结）；三 hash 与逐对象 supported/degraded/blocked 合同此前已落地（30 项合同测试）。真正缺口是**没有任何消费方**：下载验收读的是候选原始冻结清单，报告只被编译输入边界使用。本片补上放行消费方。

## 改动（7e8c60c）

`apps/api/src/dashboardNativeCandidateRegistry.ts` 新增 `assertDashboardCandidatePublicationGate`：

1. 报告 schema/版本必须存在；
2. 报告身份（authority 四元组 + freezeManifestSha256 + sourceSemanticHash + compileGraphHash + targetArtifactHash）与候选逐项一致，且 targetArtifactHash 等于实际 artifact 字节的 hash；
3. `objects` 非空（没有任何对象证据的发布不成立）；
4. 对象身份无重复；`blocked` 必须携带 deferred 原因；`supported` 必须零 deferred（部分编译不得宣称 supported）。

双边界接线：

- **发布放行**：`dashboardNativeCandidateService.prepare` 在候选冻结为 current 之前调用，不满足则候选不可观测且 prepare 失败；
- **下载复核**：三个离线下载路由（DMDA/ZIP/单EXE）在 registry 读取后、构建归档前调用，不满足返回 409 `candidate_invalid` 且不触碰存储/打包字节——登记后被篡改或不再自洽的旧记录同样不可下载。

## 测试

- 路由测试夹具升级为真实 capability 合同对象（原为 `{}` 强转），新增 4 个参数化用例：缺报告/报告未绑定/blocked 无原因/零对象覆盖 → 全部 409 且 `readFreezeManifest` 未被调用；
- 下载取消测试夹具同步为最小合法报告；
- 现有服务测试走真实 `buildDashboardPublicationCapabilityReport`，天然通过 gate；
- 聚焦 49 项通过，API 全量 1182 通过 / 1 跳过，typecheck 通过，`pnpm gate:repository` 通过。

## 明确未完成（不标成完成）

- `webview-only` 第四态仍未建模（保持明示，不在本片偷偷引入）；
- 放行规则目前是"证据自洽"，不是"必须全部 supported"——blocked/degraded 对象仍可发布，由能力报告如实携带状态；是否提高到"blocked 阻断发布"由产品决策，属 P0-04 与 V 验收的后续范围；
- 筛选等新内容类型进入能力矩阵依赖其编译回执，随 G02 宿主接线推进。
