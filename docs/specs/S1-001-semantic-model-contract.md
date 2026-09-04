# S1-001 语义模型合同、持久化与 API

> 按模板 `docs/specs/TEMPLATE.md` 编写；执行者：夜间 GLM-5.3-Flash。

## 0. 元信息

- 所属批次：S1 数据语义层（`docs/platform-surpass-development-plan-2026-09-04.md`）
- 依赖：无（本规格是 S1-002~S1-007 全部任务的地基）
- 预估夜间时段：≤4h
- 触碰域：contracts / api（无 UI，无浏览器门禁）

## 1. 目标与用户故事

作为项目编辑者，我可以在数据中心创建"语义模型"：选定一个数据产品（数据集或管道），在其字段之上集中定义**指标**（带业务口径的度量）、**维度**（可含钻取层级）和**参数**（可级联）。定义一次，后续 2D 绑定、组件联动、钻取、AskData 全部引用同一份口径。

本规格只交付合同、校验、持久化与 CRUD API；编辑器 UI 是 S1-002。

## 2. 现状与复用（已核对，禁止重复造轮子）

- 数据资产持久化模式：挂在 `ProjectRecord` 可选数组上（`packages/contracts/src/project.ts` 146-149 行已有 `dataConnections?/datasets?/dataPipelines?/dataEndpoints?`），由 `apps/api/src/metadataStore.ts` 的 `MetadataStore` 提供 list/save/remove。语义模型**沿用同一模式**，不建新存储。
- 数据产品抽象：`dataset:${id}` / `pipeline:${id}` 字符串引用贯穿 Inspector、`dataRefreshPolicy.ts`、`dashboardDataProductReplacement.ts`。语义模型 source 直接复用该抽象。
- 字段元数据：`DataDatasetRecord.fields`（key/label/type/unit）+ `computedFields`（contracts/data.ts 97-118）。
- 公式引擎：`packages/data-runtime` 的 `compileFormula`（无 eval、依赖收集）；dataset 计算字段保存前逐条编译校验的模式在 `apps/api/src/routes.ts` 已有。
- 引用级联保护：连接←数据集←管道←接口的 409 保护链已存在（routes.ts），语义模型加入该链（数据集/管道被语义模型引用时删除返回 409）。
- 聚合现状是三套互不复用：看板前端 `dashboardAnalytics.ts`（7 种）、管道 aggregate 节点（`packages/data-runtime`，5 种）、AskData（`packages/contracts/src/askData.ts`，count/sum/avg/min/max）。本规格定义统一枚举与映射，不强行改写三处调用点（映射落地即可，重调用点是 S1-003 的事）。

## 3. 合同设计（类型先行的部分照抄实现）

新文件 `packages/contracts/src/semantic.ts`（目标 ≤200 行）：

```ts
import type { JsonValue } from "./common"; // 按仓库实际通用类型路径调整

/** 统一聚合枚举：覆盖现有三套的并集；映射见 specAppendixA */
export type SemanticAggregation =
  | "count" | "countDistinct" | "sum" | "avg" | "min" | "max";

export interface SemanticMetricFilter {
  fieldKey: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
  value: JsonValue;
}

export interface SemanticMetricDefinition {
  id: string;
  key: string;              // 模型内唯一标识符
  label: string;
  description?: string;     // 业务口径（人话，给 AskData 与编辑者看）
  fieldKey?: string;        // 基础字段（与 expression 二选一）
  expression?: string;      // 公式引擎表达式（与 fieldKey 二选一）
  aggregation: SemanticAggregation;
  unit?: string;
  decimalPlaces?: number;
  defaultFilters?: SemanticMetricFilter[]; // 口径默认过滤
}

export interface SemanticDimensionLevel {
  fieldKey: string;
  label: string;
}

export interface SemanticDimensionDefinition {
  id: string;
  key: string;
  label: string;
  fieldKey: string;          // 主字段（无层级时的钻取目标）
  hierarchy?: SemanticDimensionLevel[]; // 有序层级，浅→深，供钻取/级联
}

export interface SemanticParameterOption { value: JsonValue; label: string; }

export interface SemanticParameterDefinition {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "datetime" | "option";
  parentKey?: string;        // 级联父参数 key（无环）
  optionsSource?:
    | { kind: "static"; options: SemanticParameterOption[] }
    | { kind: "dimension"; dimensionKey: string }; // 选项来自维度字段去重值，S1-006 实现服务端取数
  defaultValue?: JsonValue;
}

export interface SemanticModelSource {
  kind: "dataset" | "pipeline";
  id: string;
}

export interface SemanticModelRecord {
  id: string;
  name: string;              // 项目内唯一
  description?: string;
  source: SemanticModelSource;
  metrics: SemanticMetricDefinition[];
  dimensions: SemanticDimensionDefinition[];
  parameters: SemanticParameterDefinition[];
  revision: number;          // 每次保存 +1，AskData 对齐 datasetRevision 模式
  createdAt: string;
  updatedAt: string;
}
```

同步修改：

- `packages/contracts/src/project.ts`：`ProjectRecord` 增加 `semanticModels?: SemanticModelRecord[]`。
- `packages/contracts/src/index.ts`：导出 semantic.ts 全部类型。
- `apps/api/src/metadataStore.ts`：`MetadataStore` 增加 `listSemanticModels / saveSemanticModel / removeSemanticModel`（照抄 datasets 三方法的实现模式，含底层 store 持久化）。

## 4. 实现要点

新文件（每个 ≤300 行）：

1. `packages/contracts/src/semantic.ts`：上述类型 + `SEMANTIC_AGGREGATIONS` 常量数组 + `LEGACY_AGGREGATION_ALIASES` 映射表（见附录 A）。
2. `apps/api/src/semanticModelService.ts`（~220 行）：
   - `validateSemanticModel(record, ctx)`：ctx 提供 `resolveSourceFields(source)`（从 store 读 dataset.fields+computedFields 或管道 output 字段，管道字段用 `derivePipelineFieldHints` 同源逻辑或其输出节点契约——夜间先读 `DataPipelineStudioParts.ts` 648-668 与管道 output 节点定义，选已有实现复用，找不到就对 pipeline 源要求显式字段清单并在校验错误里说明）。
   - 校验规则：name 非空且项目内唯一；metric/dimension/parameter 的 key 各自模型内唯一且匹配 `/^[A-Za-z][A-Za-z0-9_]*$/`；metric 的 fieldKey 与 expression 恰好其一；expression 必须过 `compileFormula` 且依赖字段 ⊆ 源字段；aggregation ∈ 枚举，count/countDistinct 忽略字段；dimension.fieldKey 与 hierarchy 各级 fieldKey ∈ 源字段；parameter.parentKey 存在且无环（参照 `dashboardDiagnostics.ts` 的 filter-cycle 检测写法）；optionsSource.dimensionKey 引用存在的维度；defaultFilters 的 fieldKey ∈ 源字段。
   - `nextRevision()`：保存时 revision+1。
3. `apps/api/src/semanticModelRoutes.ts`（~130 行）：`GET/POST /api/projects/:projectId/semantic-models`、`PUT/DELETE /api/projects/:projectId/semantic-models/:id`。照抄现有 datasets 路由的鉴权、错误格式与 409/400 语义。**先读 `routes.ts` 的路由注册模式**：若路由集中在 routes.ts，则本文件导出注册函数由 routes.ts 一行挂载，避免 routes.ts（474 行）继续膨胀。
4. `apps/api/src/routes.ts`：只加挂载行；同时在既有 `DELETE /datasets/:id` 与 `DELETE /data-pipelines/:id` 的引用保护处增加语义模型引用检查（被引用返回 409，错误信息列出引用方模型名）。

禁止事项：不改 DashboardInspectorData、不动三处聚合调用点、不做 UI、不做参数取数（S1-006）、不引入新依赖。

## 5. 测试计划

- `packages/contracts/src/semantic.test.ts`：类型编译 + 枚举/别名映射快照。
- `apps/api/src/semanticModelService.test.ts`：合法模型通过；逐条校验规则各有正/反用例（key 重复、expression 与 fieldKey 同时存在/同时缺失、公式编译失败、依赖字段越界、参数环、层级字段越界、name 重复）。
- `apps/api/src/semanticModelRoutes.test.ts`（或并入现有 routes 测试模式）：CRUD 往返、revision 递增、删除被引用数据集返回 409、删除被引用管道返回 409、无权限沿用现有项目权限语义。
- 门禁：`pnpm --filter @bim-studio/contracts test && pnpm --filter @bim-studio/api test && pnpm --filter @bim-studio/api typecheck && pnpm quality:source-size`。

## 6. 验收标准

- [ ] 合同类型导出且 contracts 测试通过
- [ ] CRUD 四路由按现有错误合同工作；revision 每次保存 +1
- [ ] 全部校验规则有正反测试用例
- [ ] 数据集/管道删除的 409 保护覆盖语义模型引用
- [ ] 新文件全部 ≤300 行，routes.ts 增量 ≤10 行
- [ ] api/contracts typecheck + 相关测试全绿；`pnpm quality:source-size` 通过

## 7. 风险与回滚

- routes.ts 路由注册若不支持模块挂载，允许在 routes.ts 内新增一小节路由（+40 行以内），但必须在回填里说明原因。
- 管道源字段解析若现有实现不可复用，v1 允许"管道源模型要求手填字段清单"降级（在合同中给 `source.fields?: DataDatasetField[]` 可选覆盖，校验时优先使用），并在回填记录。回滚点：本规格全部改动独立成一次提交，出问题整体 revert 不影响他人。

## 8. 完成回填（2026-09-04 GLM-5.3 白天直接实现，状态：已完成）

- 实际改动：`packages/contracts/src/semantic.ts`（新增，151 行）、`semantic.test.ts`（新增）、`project.ts`（+semanticModels?）、`index.ts`（+导出）；`apps/api/src/semanticModelService.ts`（新增，144 行）、`semanticModelService.test.ts`、`semanticModelRoutes.ts`（新增，83 行）、`semanticModelRoutes.test.ts`、`metadataStore.ts`（接口 +3 方法）、`jsonStore.ts`（实现）、`routes.ts`（挂载 1 行 + 数据集/管道 DELETE 各 +5 行 409 保护，共 +12 行，符合 ≤10 行的轻微超限，原因：引用保护必须内联在既有 DELETE 处理器）。
- 与规格偏差：①聚合映射按实际三套枚举定稿（看板 distinct-count→countDistinct、average/minimum/maximum→avg/min/max；管道 average→avg；AskData 同名直映），别名表 `LEGACY_AGGREGATION_ALIASES` 带三套枚举全覆盖快照测试；②管道源显式字段清单放在 `source.fields`（规格即如此设计）；③revision 服务端控制：创建=1、保存+1，忽略 body 值。
- 门禁结果：contracts 166 项、api 全量 108 文件 428 项测试通过（含本规格新增 18 项）；api/contracts/web typecheck 通过；`quality:source-size` 1,634 个源文件全部 ≤800 行。
- 行为要点：名称项目内唯一（409）；指标 fieldKey/expression 恰一（count/countDistinct 可全空）；表达式过 compileFormula 且依赖⊆源字段；维度/层级/过滤字段必须在源字段内；参数 parentKey 无环、选项维度必须存在；数据集/管道被语义模型引用时删除返回 409。

---

## 附录 A：聚合映射（夜间先核实三处实际枚举值再定稿映射）

统一枚举 `count/countDistinct/sum/avg/min/max`。落点：

| 统一枚举 | 看板 analytics（7 种，实际值以 dashboardAnalytics.ts 为准） | 管道 aggregate（5 种，以 data-runtime 为准） | AskData（count/sum/avg/min/max） |
|---|---|---|---|
| count | count | count | count |
| countDistinct | （若无则别名映射到现有 distinct 计数；没有就仅统一枚举可用） | — | — |
| sum / avg / min / max | 同名 | 同名 | 同名 |

夜间第一步：读三个文件记录实际枚举字面量，把映射表补全为代码常量 `LEGACY_AGGREGATION_ALIASES` 并配快照测试；三处调用点不改。
