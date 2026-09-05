import type {
  DataDatasetField,
  SemanticMetricFilter,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { SemanticFieldSelect } from "./SemanticEditorFields";

const operators: SemanticMetricFilter["op"][] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "in",
];
const operatorLabels = [
  "等于",
  "不等于",
  "大于",
  "大于等于",
  "小于",
  "小于等于",
  "包含",
  "属于集合",
];

export function SemanticMetricFilters({
  value,
  fields,
  onChange,
  locale,
}: {
  value: SemanticMetricFilter[];
  fields: DataDatasetField[];
  onChange: (items: SemanticMetricFilter[]) => void;
  locale: AppLocale;
}) {
  const patch = (index: number, update: Partial<SemanticMetricFilter>) =>
    onChange(
      value.map((filter, at) =>
        at === index ? { ...filter, ...update } : filter,
      ),
    );
  return (
    <div className="semantic-filters">
      {value.map((filter, index) => (
        <div key={index} className="semantic-filter-row">
          <SemanticFieldSelect
            label={tr(
              locale,
              `过滤字段 ${index + 1}`,
              `Filter field ${index + 1}`,
            )}
            value={filter.fieldKey}
            fields={fields}
            onChange={(fieldKey) => patch(index, { fieldKey })}
            locale={locale}
          />
          <label>
            <span>{tr(locale, "条件", "Operator")}</span>
            <select
              value={filter.op}
              onChange={(event) =>
                patch(index, {
                  op: event.target.value as SemanticMetricFilter["op"],
                })
              }
            >
              {operators.map((op, at) => (
                <option key={op} value={op}>
                  {locale === "zh-CN" ? operatorLabels[at] : op}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{tr(locale, "值", "Value")}</span>
            <input
              value={
                Array.isArray(filter.value)
                  ? filter.value.join(", ")
                  : String(filter.value ?? "")
              }
              onChange={(event) => {
                const raw = event.target.value;
                const numeric =
                  fields.find((field) => field.key === filter.fieldKey)
                    ?.type === "number";
                const parse = (item: string) =>
                  numeric && item.trim() && Number.isFinite(Number(item))
                    ? Number(item)
                    : item;
                patch(index, {
                  value:
                    filter.op === "in"
                      ? raw.split(/[,，]/).map((item) => parse(item.trim()))
                      : parse(raw),
                });
              }}
              placeholder={
                filter.op === "in"
                  ? tr(locale, "多个值用逗号分隔", "Comma-separated values")
                  : ""
              }
            />
          </label>
          <button
            type="button"
            onClick={() => onChange(value.filter((_, at) => at !== index))}
            aria-label={tr(
              locale,
              `删除过滤 ${index + 1}`,
              `Remove filter ${index + 1}`,
            )}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([...value, { fieldKey: "", op: "eq", value: "" }])
        }
      >
        {tr(locale, "新增默认过滤", "Add default filter")}
      </button>
    </div>
  );
}
