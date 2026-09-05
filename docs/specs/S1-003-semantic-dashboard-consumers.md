# S1-003 语义口径的 2D 真实消费

## 状态与范围

本批承接 S1-001/002 和 EX-003 计划，复用已有 CRUD、公式引擎、聚合、图表钻取面包屑及参数级联清理。不重复实现语义编辑器。

**本批实现与隔离浏览器验收通过；不代表 S1 全范围完成**：

- 2D 数据检查器可选择语义模型、指标、维度/层级及参数；引用保存 `modelId/revision/key`，不把计算结果保存到应用。
- 基础折线/面积/柱状/组合/饼图、数值/仪表等指标、表格及筛选组件接入。暂未验证的雷达、地图、关系图、排行等不开放语义入口，保留原有裸字段功能。
- 默认指标过滤、六种聚合及安全表达式；数据产品仍通过原有数据集/管道预览取数；同模型组件结果独立，不能按共享 `product.field` 覆盖不同业务口径。
- 同模型基础图表默认联动，可逐组件关闭；同组件后点替换前点，不过滤自身；多组件 AND、跨模型隔离、明细只能被过滤。钻取保存完整祖先路径，回根清除该组件条件。
- 参数取维度的真实去重值，父条件缩小子选项；级联沿用现有参数键，使用模型命名空间避免跨模型串值。
- 删除模型、指标/维度失效、版本变化、真实输出字段变化均明确显示错误；版本更新须作者确认，不静默切新口径。切指标不闪回旧计算结果，源失败不伪装空数据。
- 预览变量合并保留指标的行集及解析配置，修复旧合并过程丢弃 `rows` 导致图表与钻取只剩数值的同族问题。
- 播放状态的参数更新复用既有级联 helper，父值变化清除跨页面的所有后代。批量查询按父到子应用，不因组件图层顺序倒置而误清除已提交子条件。
- 截图复查发现浮动「参数查询」未接入语义指标元数据，导致一直显示加载。现已使用原始数据快照按参数草稿重算选项，不提前应用查询、不重新发请求；同时修正检查器复选框尺寸与确认按钮样式。

## 验证

- 聚焦 `ApplicationPlaybackParameters / dashboardSemanticMetrics / DashboardWidgetRuntime / dashboardAnalytics / dashboardFieldBinding / dashboardDataProductReplacement`：6 文件、38 项通过（23:06，包含参数草稿与父子顺序回归；冻结后 23:25 再跑仍全通过）。`pnpm --filter @bim-studio/web typecheck` 通过。
- 既有源文件尺寸门禁通过；最终新增文件与跨组组合以主代理统一检查为准。
- 隔离门禁 `apps/web/scripts/gate-semantic-consumers.mjs`，中间构建报告 `test-output/codex-2026-09-05/semantic-consumers-IwAkFl/report.json`：1440/980 × 深/浅四组通过；正常 UI 登录、独立 HTTP 数据源/项目、绑定保存刷新、30→20/10 的默认口径与级联、真实图表点击钻取与回根、503 故障/恢复、版本失效确认、预览不写草稿、发布引用仍冻结 v1。意外控制台警告/错误为 0，检查器文字最小对比度深色 8.22 / 浅色 8.26。
- 人工查看上述中间截图后发现浮动查询面板遗漏，追加实现和真实 UI 草稿/查询/重置门禁；查询重置与钻取均等待图表过渡稳定后截图。未单独构建或提交，由主代理统一构建后验收。
- **最终报告**：`test-output/codex-2026-09-05/semantic-consumers-q9ezkE/report.json`，四组全部通过，意外控制台警告/错误均为 0；故意注入的 503 分开记录（四组分别 2/1/1/2 条）。检查器最小文字对比度深色 8.22 / 浅色 8.26、复选框 16×16，无检查器或页面横向溢出。
- 已人工查看最终 `dark-1440-query-parameters.png`、`light-980-query-parameters.png`、`dark-1440-linked-drill.png`、`light-980-saved-binding.png`、`light-1440-revision-stale.png`：查询参数可用、重置后的图表为 10/20、钻取后 KPI 为 10、确认按钮与窄屏检查器可用。另附每组源故障截图，共 20 张。
- 最终 gate 进程退出码 0，`finally` 关闭隔离浏览器、产品服务器及样本源；从其 API 日志得到的独立 PID 25580 已确认退出。未结束真实开发服务，未写原业务数据。

## 本轮待办

- AskData 消费同一语义模型；页面级默认联动总开关、跨源类型匹配关系配置。
- 参数默认值与静态选项 label/value 的完整有类型求值；参数服务端取数、任意客户规模与空值矩阵。
- 受保护数据的公开授权网关及发布语义模型快照策略。当前公开页沿用明确受限提示，不因本批接入而偷偷开放私有数据。
- 语义模型引用删除保护与并发 revision 冲突等后端治理；目前运行时拒绝失效，不能宣称已实现服务端引用阻止。
- 本轮目视记录的非阻塞视觉债：钻取路径及筛选辅助标签仍用 `region/factory` 等物理字段名；浅色运行页「返回编辑」按钮仍偏暗。应在下一轮领域标签/共享运行页主题验收处理，不能把上述检查器对比度扩大为全画布达标。

## AskData 消费者只读审计（后续，未实施）

### 已有能力与真实缺口

- `apps/web/src/ai/dataSemanticContext.ts` 的「语义上下文」是原始字段的别名/角色推测，并非 S1 `SemanticModelRecord`。`runAssistantRequest.ts` 的真实问数调用只向 `data.query.draft` 传 prompt，前端加模型上下文并不能独自打通执行链。
- 服务端 `apps/api/src/ai/registerDataQueryAiPlugin.ts` 只提供数据集/字段目录；`apps/api/src/dataQuerySource.ts` 也只有数据集来源。当前计划合同、严格 schema、指纹及读取校验没有模型 ID/revision/指标引用，不能保证默认过滤和业务聚合含义。
- 既有 `packages/data-query-plugin` 已有受限计划、字段/类型校验、数据集 revision、指纹和 plan/read 两阶段证据，应复用，不新造自由 SQL 执行器。当前 AskData 只支持 count/sum/avg/min/max，没有 countDistinct、指标表达式和管道来源。
- `AskDataQuickQuery.tsx` 当前直接选择裸字段/聚合，无语义指标模式；运行未绑定请求所有权/取消，切换字段后旧结果可能仍展示；无数值字段的数据集不能从 UI 使用本来合法的 count。尚无结构化问数结果直接创建已绑定看板组件的入口。
- 两条现有引擎在空值/空集平均值及宽松字符串相等上并非完全同义。不能宣称跨通道业务口径已经一致；需约定策略并以真实行集做对照测试。

### 最小闭环建议及改动位置

1. 服务端解析同项目 `modelId/revision/metricKey/dimensionKeys`，把已确认引用纳入计划指纹与 read 阶段版本检查；模型默认过滤由服务端编译，AI 只选择引用，不重写口径。先支持数据集来源的字段/count 指标；表达式、countDistinct、管道不支持时明确返回待补全，不静默降级。
2. QuickQuery 增加裸字段/语义模式；语义模式展示标签、单位、定义与版本，不允许另改聚合；补请求所有权/取消和旧结果失效。结果携带来源引用，复用本批 `bindSemanticWidget` 接入既有组件创建命令。
3. 对应文件：`packages/contracts/src/askData.ts`；`packages/data-query-plugin/src/{schemas,draft,queryEngine,provider}.ts` 或独立适配器；`apps/api/src/{dataQuerySource,ai/registerDataQueryAiPlugin}.ts`；`apps/web/src/components/{AskDataQuickQuery,AiAssistantPanel}.tsx` 及 `ai/{runAssistantRequest,dataSemanticContext,useAiProjectContext}.ts`。继续遵守小文件与领域边界，不直接把语义逻辑塞进面板。
4. 必须验证：跨项目/篡改引用、revision 变化、默认过滤不可绕过、计划指纹、空值矩阵、2D 与问数真实行集一致、切项目晚到结果、503 恢复及无数值字段 count；随后隔离真实浏览器验证问数到组件。当前仅完成审计，未改这些文件。

## 明确排除 / 项目级后验收

- 不改 admin/admin、.env、PostgreSQL+MinIO、原场景和项目；仅本地提交，无 push。
- 全站 E2E、性能/可访问性/稳定性/发布回滚为统一后验收；本夹具不能扩大成任意数据规模与全平台性能承诺。
