import { compileFormula } from "@bim-studio/data-runtime";
import type {
  DataDatasetField,
  DataDatasetRecord,
  SemanticMetricDefinition,
  SemanticModelRecord,
} from "@bim-studio/contracts";

export function newSemanticModel(
  kind: "dataset" | "pipeline",
): SemanticModelRecord {
  return {
    id: crypto.randomUUID(),
    name: "",
    source: { kind, id: "", ...(kind === "pipeline" ? { fields: [] } : {}) },
    metrics: [],
    dimensions: [],
    parameters: [],
    revision: 0,
    createdAt: "",
    updatedAt: "",
  };
}
export function semanticUniqueKey(
  prefix: string,
  items: readonly { key: string }[],
) {
  const keys = new Set(items.map((item) => item.key));
  let index = 1;
  while (keys.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}
export function semanticSourceFields(
  model: SemanticModelRecord,
  datasets: DataDatasetRecord[],
): DataDatasetField[] {
  if (model.source.kind === "pipeline") return model.source.fields ?? [];
  const source = datasets.find((dataset) => dataset.id === model.source.id);
  return source
    ? [
        ...new Map(
          [...source.fields, ...(source.computedFields ?? [])].map((field) => [
            field.key,
            field,
          ]),
        ).values(),
      ]
    : [];
}
export function setSemanticMetricMode(
  metric: SemanticMetricDefinition,
  mode: "field" | "expression",
): SemanticMetricDefinition {
  const next = { ...metric };
  if (mode === "field") {
    delete next.expression;
    next.fieldKey ??= "";
  } else {
    delete next.fieldKey;
    next.expression ??= "";
  }
  return next;
}
export function semanticFormulaEvidence(
  expression: string,
  fields: readonly DataDatasetField[],
) {
  try {
    const dependencies = [...compileFormula(expression).dependencies];
    const missing = dependencies.filter(
      (key) => !fields.some((field) => field.key === key),
    );
    return {
      dependencies,
      error: missing.length ? `字段不存在：${missing.join("、")}` : "",
    };
  } catch (error) {
    return {
      dependencies: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export function semanticSaveErrors(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .split("；")
    .filter(Boolean);
}
export function moveSemanticItem<T>(
  items: readonly T[],
  index: number,
  direction: -1 | 1,
) {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
