import { compileFormula } from "@bim-studio/data-runtime";
import type { DataDatasetField, SemanticModelRecord } from "@bim-studio/contracts";
import { SEMANTIC_AGGREGATIONS } from "@bim-studio/contracts";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface SemanticModelValidationContext {
  listDatasets(projectId: string): Array<{ id: string; fields: DataDatasetField[]; computedFields?: Array<{ key: string; label?: string; type: string }> }>;
  listDataPipelines(projectId: string): Array<{ id: string }>;
}

/** 解析语义模型源字段：数据集静态取 fields+computedFields；管道源要求显式字段清单。 */
export function resolveSemanticSourceFields(
  model: Pick<SemanticModelRecord, "source">,
  ctx: SemanticModelValidationContext,
  projectId: string,
): { status: "ok"; fields: DataDatasetField[] } | { status: "error"; message: string } {
  if (model.source.kind === "pipeline") {
    if (!ctx.listDataPipelines(projectId).some((pipeline) => pipeline.id === model.source.id)) {
      return { status: "error", message: "语义模型引用的数据管道不存在" };
    }
    const fields = model.source.fields ?? [];
    if (fields.length === 0) return { status: "error", message: "管道源的输出字段只能在运行时推导，请在模型中显式填写字段清单" };
    return { status: "ok", fields };
  }
  const dataset = ctx.listDatasets(projectId).find((item) => item.id === model.source.id);
  if (!dataset) return { status: "error", message: "语义模型引用的数据集不存在" };
  const computed: DataDatasetField[] = (dataset.computedFields ?? []).map((field) => ({
    key: field.key,
    label: field.label?.trim() || field.key,
    type: field.type as DataDatasetField["type"],
  }));
  return { status: "ok", fields: [...dataset.fields, ...computed] };
}

/** 保存前校验；返回全部问题，空数组表示通过。 */
export function validateSemanticModel(
  model: SemanticModelRecord,
  ctx: SemanticModelValidationContext,
  projectId: string,
): string[] {
  const errors: string[] = [];
  const push = (message: string) => errors.push(message);

  if (!model.name?.trim()) push("语义模型名称不能为空");
  if (model.name && model.name.trim() && model.name.trim().length > 80) push("语义模型名称不能超过 80 个字符");

  const resolved = resolveSemanticSourceFields(model, ctx, projectId);
  if (resolved.status === "error") push(resolved.message);
  const fieldKeys = new Set(resolved.status === "ok" ? resolved.fields.map((field) => field.key) : []);

  const assertUniqueKeys = (items: Array<{ key: string }>, kind: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      const key = item.key ?? "";
      if (!key || !IDENTIFIER_PATTERN.test(key)) push(`${kind}标识 ${key || "(空)"} 必须以字母开头，只能包含字母、数字和下划线`);
      // 重复检测不依赖格式合法性：同名标识即使非法也要报重复，避免编辑器只修一处。
      if (key) {
        if (seen.has(key)) push(`${kind}标识 ${key} 在模型内重复`);
        seen.add(key);
      }
    }
  };

  for (const metric of model.metrics) {
    if (!metric.id?.trim()) push("指标缺少 id");
    if (!metric.label?.trim()) push(`指标 ${metric.key || metric.id} 缺少名称`);
    if (!SEMANTIC_AGGREGATIONS.includes(metric.aggregation)) push(`指标 ${metric.key || metric.id} 的聚合方式无效`);
    const hasField = Boolean(metric.fieldKey?.trim());
    const hasExpression = Boolean(metric.expression?.trim());
    if (hasField && hasExpression) push(`指标 ${metric.key} 不能同时指定字段和表达式`);
    if (!hasField && !hasExpression && metric.aggregation !== "count" && metric.aggregation !== "countDistinct") {
      push(`指标 ${metric.key} 需要指定字段或表达式`);
    }
    if (hasField && metric.fieldKey && !fieldKeys.has(metric.fieldKey)) push(`指标 ${metric.key} 引用的字段 ${metric.fieldKey} 不在源字段中`);
    if (hasExpression) {
      try {
        const compiled = compileFormula(metric.expression ?? "");
        for (const dependency of compiled.dependencies) {
          if (!fieldKeys.has(dependency)) push(`指标 ${metric.key} 表达式依赖的字段 ${dependency} 不在源字段中`);
        }
      } catch (reason) {
        push(`指标 ${metric.key} 表达式无效：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    for (const filter of metric.defaultFilters ?? []) {
      if (!fieldKeys.has(filter.fieldKey)) push(`指标 ${metric.key} 默认过滤的字段 ${filter.fieldKey} 不在源字段中`);
    }
  }
  assertUniqueKeys(model.metrics, "指标");

  for (const dimension of model.dimensions) {
    if (!dimension.id?.trim()) push("维度缺少 id");
    if (!dimension.label?.trim()) push(`维度 ${dimension.key || dimension.id} 缺少名称`);
    if (dimension.fieldKey && !fieldKeys.has(dimension.fieldKey)) push(`维度 ${dimension.key} 引用的字段 ${dimension.fieldKey} 不在源字段中`);
    const hierarchyFieldKeys = dimension.hierarchy?.map((level) => level.fieldKey) ?? [];
    for (const [index, level] of (dimension.hierarchy ?? []).entries()) {
      if (!level.label?.trim()) push(`维度 ${dimension.key} 第 ${index + 1} 级层级缺少名称`);
      if (!fieldKeys.has(level.fieldKey)) push(`维度 ${dimension.key} 第 ${index + 1} 级字段 ${level.fieldKey} 不在源字段中`);
    }
    const distinctLevels = new Set(hierarchyFieldKeys);
    if (distinctLevels.size !== hierarchyFieldKeys.length) push(`维度 ${dimension.key} 的层级字段重复`);
  }
  assertUniqueKeys(model.dimensions, "维度");

  const dimensionKeys = new Set(model.dimensions.map((dimension) => dimension.key).filter(Boolean));
  for (const parameter of model.parameters) {
    if (!parameter.id?.trim()) push("参数缺少 id");
    if (!parameter.label?.trim()) push(`参数 ${parameter.key || parameter.id} 缺少名称`);
    if (parameter.parentKey && !model.parameters.some((item) => item.key === parameter.parentKey)) {
      push(`参数 ${parameter.key} 的级联父参数 ${parameter.parentKey} 不存在`);
    }
    if (parameter.optionsSource?.kind === "dimension" && !dimensionKeys.has(parameter.optionsSource.dimensionKey)) {
      push(`参数 ${parameter.key} 的选项维度 ${parameter.optionsSource.dimensionKey} 不存在`);
    }
    if (parameter.optionsSource?.kind === "static" && parameter.optionsSource.options.length === 0 && parameter.type === "option") {
      push(`参数 ${parameter.key} 是选项类型但没有静态选项`);
    }
  }
  assertUniqueKeys(model.parameters, "参数");

  // 级联父参数环检测：沿 parentKey 链走，步数超过参数总数即存在环。
  for (const parameter of model.parameters) {
    let current: string | undefined = parameter.key;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) {
        push(`参数 ${parameter.key} 的级联链存在循环`);
        break;
      }
      visited.add(current);
      const node = model.parameters.find((item) => item.key === current);
      current = node?.parentKey;
    }
  }

  if (model.revision < 0 || !Number.isInteger(model.revision)) push("revision 必须是非负整数");
  return errors;
}
