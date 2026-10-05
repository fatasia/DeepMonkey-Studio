# Semantica 线:账本三刀 + 本体/数据中心 UI 精做任务书(2026-10-05)

> 用户拍板:按分析方案补足高价值差距、尽量轻量化;页面侧本体表现力与数据中心要做到最精、一线水平。
> 分析底稿:Semantica(开源图原生基础设施)九能力对位——我们强在溯源链,缺决策链查询面/冲突检测/本体治理。

## 已有底座(不重建)

- `apps/api/src/ai/provenanceLedger.ts`(H-C3):假设→内核运行→判定→报告链+本体动作链,指纹幂等,证据最小化。
- `apps/api/src/ai/agentMemory.ts`:4 源记忆+fingerprint 去重+verdict 覆盖窗口。
- `apps/api/src/ai/ontologyActionService.ts`:本体动作审计(plan/execution/receipt)。
- `alarmRcaEngine.ts`(deterministic-alarm-rca)+`chatEvidenceGate.ts`:确定性规则先例。

## 账本三刀 — **在跑**(轻量、零新依赖)

1. **决策链查询面**(provenanceLedger 追加):traceDecisionChain(链回放+断链容错)/findSimilarDecisions(指纹+理由码先例检索)/analyzeDecisionImpact(指纹反查下游影响面);provenanceRoutes 只读端点。
2. **记忆冲突检测**(agentMemory 写入路径):同主题相悖→标记 conflictWith 不阻断;delivery 返回冲突对;确定性规则判定(指纹/理由码),不做向量语义。
3. **本体约束校验**(ontologyActionService 写入前):轻量 SHACL 式(必填/类型/枚举/单位),violation 清单返回,strict 选项阻断;规则表数据化。

## Semantica UI:本体表现力 + 数据中心精做 — 排账本三刀后(设计闭环纪律)

现状底座:OntologyWorkspace(694 行)/OntologyGraphView(522)/OntologyGraphInspector(364);DataCenter.tsx+Forms+Presentation。
定位:精做升级(不是重写)——现有空态引导/治理态筛选/四步向导底子好,按一线水位补表现力。

一刀位(本体图谱表现力,对标 Palantir/Gephi 一线图探索):
- 图谱交互:节点力导向布局+缩放平移+框选;1/2/3 跳已有→补**路径高亮**(选节点亮起所有关联链路);
- 节点编码:治理态(草稿/待评审/已发布/已退役)色+形双编码(色从 --accent 派生,形=圆/方/菱);对象/数据/行动/事件四类图标;
- 边语义:关系类型着色+悬停 tooltip(关系名/基数/来源);
- 详情侧栏:选中对象卡(属性表+关联清单+决策链入口——**消费账本三刀的 traceDecisionChain**,本体对象↔AI 决策证据贯通,这是两线会合点);
- 大图性能:>500 节点自动 LOD(聚合簇+展开),canvas 渲染不求 DOM;
- 空态保持现有诚实引导。

二刀位(数据中心,对标帆软 FVS 信息密度纪律):
- 四步向导视觉升级:步骤指示器(当前/完成/可跳转三态)、连接监控延迟/失败计数可视化(迷你趋势条);
- 表格:虚拟滚动+列宽拖拽+行悬停语义;空/加载/错误三态齐备;
- 数据预览卡:类型徽章(数值/文本/时间/布尔)+样例值+空值率;
- 全程设计令牌(base.css),深色默认+浅色兼容,截图视觉闭环 ≥2 轮(design-taste-digitaltwin)。

## 验收
- 账本三刀:测试绿+路由信封合规+零新依赖;
- UI 两刀位:浏览器截图视觉闭环≥2 轮+10 维打分逐维 ≥9+空态/错误态/数据态三态齐;
- 会合点验收:本体对象详情卡能回放该对象的 AI 决策链(provenance 链贯通)。
