import {
  SEMANTIC_AGGREGATIONS,
  type DataDatasetField,
  type SemanticMetricDefinition,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  SemanticExpressionEditor,
  SemanticFieldSelect,
  SemanticIdentityFields,
} from "./SemanticEditorFields";
import { SemanticMetricFilters } from "./SemanticMetricFilters";
import {
  semanticUniqueKey,
  setSemanticMetricMode,
} from "./semanticModelEditorLogic";

const aggregationLabels = ["计数", "去重计数", "求和", "平均", "最小", "最大"];
export function SemanticMetricList({
  value,
  fields,
  onChange,
  locale,
}: {
  value: SemanticMetricDefinition[];
  fields: DataDatasetField[];
  onChange: (items: SemanticMetricDefinition[]) => void;
  locale: AppLocale;
}) {
  const patch = (id: string, update: Partial<SemanticMetricDefinition>) =>
    onChange(
      value.map((metric) =>
        metric.id === id ? { ...metric, ...update } : metric,
      ),
    );
  return (
    <section
      className="semantic-definitions"
      aria-label={tr(locale, "指标定义", "Metric definitions")}
    >
      <header>
        <div>
          <h3>{tr(locale, "指标", "Metrics")}</h3>
          <p>
            {tr(
              locale,
              "统一计算方式与业务口径",
              "Define shared calculations and business meaning",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...value,
              {
                id: crypto.randomUUID(),
                key: semanticUniqueKey("metric", value),
                label: "",
                aggregation: "sum",
                fieldKey: "",
              },
            ])
          }
        >
          {tr(locale, "新增指标", "Add metric")}
        </button>
      </header>
      {!value.length && (
        <p className="semantic-empty-inline">
          {tr(
            locale,
            "还没有指标。选择字段或写一个表达式开始。",
            "No metrics yet. Start with a field or expression.",
          )}
        </p>
      )}
      {value.map((metric, index) => (
        <details key={metric.id} className="semantic-definition" open>
          <summary>
            {metric.label ||
              tr(locale, `指标 ${index + 1}`, `Metric ${index + 1}`)}
            <small>{metric.key}</small>
          </summary>
          <div className="semantic-definition-body">
            <SemanticIdentityFields
              value={metric}
              onChange={(update) => patch(metric.id, update)}
              locale={locale}
            />
            <label>
              <span>{tr(locale, "口径描述", "Business definition")}</span>
              <input
                value={metric.description ?? ""}
                onChange={(event) =>
                  patch(metric.id, { description: event.target.value })
                }
              />
            </label>
            <div className="semantic-form-grid">
              <label>
                <span>{tr(locale, "聚合方式", "Aggregation")}</span>
                <select
                  aria-label={tr(locale, "聚合方式", "Aggregation")}
                  value={metric.aggregation}
                  onChange={(event) =>
                    patch(metric.id, {
                      aggregation: event.target
                        .value as SemanticMetricDefinition["aggregation"],
                    })
                  }
                >
                  {SEMANTIC_AGGREGATIONS.map((aggregation, index) => (
                    <option key={aggregation} value={aggregation}>
                      {locale === "zh-CN"
                        ? aggregationLabels[index]
                        : aggregation}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{tr(locale, "计算来源", "Calculation source")}</span>
                <select
                  aria-label={tr(locale, "计算来源", "Calculation source")}
                  value={
                    metric.expression !== undefined ? "expression" : "field"
                  }
                  onChange={(event) =>
                    onChange(
                      value.map((item) =>
                        item.id === metric.id
                          ? setSemanticMetricMode(
                              item,
                              event.target.value as "field" | "expression",
                            )
                          : item,
                      ),
                    )
                  }
                >
                  <option value="field">{tr(locale, "字段", "Field")}</option>
                  <option value="expression">
                    {tr(locale, "表达式", "Expression")}
                  </option>
                </select>
              </label>
            </div>
            {metric.expression !== undefined ? (
              <SemanticExpressionEditor
                value={metric.expression}
                fields={fields}
                onChange={(expression) => patch(metric.id, { expression })}
                locale={locale}
              />
            ) : (
              <SemanticFieldSelect
                label={tr(locale, "指标字段", "Metric field")}
                value={metric.fieldKey ?? ""}
                fields={fields}
                onChange={(fieldKey) => patch(metric.id, { fieldKey })}
                locale={locale}
              />
            )}
            {["count", "countDistinct"].includes(metric.aggregation) && (
              <small>
                {tr(
                  locale,
                  "此聚合允许不指定字段或表达式。",
                  "This aggregation allows no field or expression.",
                )}
              </small>
            )}
            <details className="semantic-advanced">
              <summary>
                {tr(locale, "默认过滤与格式", "Default filters and formatting")}
              </summary>
              <div>
                <div className="semantic-form-grid">
                  <label>
                    <span>{tr(locale, "单位", "Unit")}</span>
                    <input
                      value={metric.unit ?? ""}
                      onChange={(event) =>
                        patch(metric.id, { unit: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>{tr(locale, "小数位", "Decimals")}</span>
                    <input
                      type="number"
                      min={0}
                      max={8}
                      value={metric.decimalPlaces ?? 2}
                      onChange={(event) =>
                        patch(metric.id, {
                          decimalPlaces: Math.max(
                            0,
                            Math.min(8, Number(event.target.value) || 0),
                          ),
                        })
                      }
                    />
                  </label>
                </div>
                <SemanticMetricFilters
                  value={metric.defaultFilters ?? []}
                  fields={fields}
                  onChange={(defaultFilters) =>
                    patch(metric.id, { defaultFilters })
                  }
                  locale={locale}
                />
              </div>
            </details>
            <footer>
              <button
                type="button"
                onClick={() =>
                  onChange([
                    ...value,
                    {
                      ...structuredClone(metric),
                      id: crypto.randomUUID(),
                      key: semanticUniqueKey(metric.key, value),
                      label: `${metric.label} ${tr(locale, "副本", "copy")}`,
                    },
                  ])
                }
              >
                {tr(locale, "复制指标", "Copy metric")}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  onChange(value.filter((item) => item.id !== metric.id))
                }
              >
                {tr(locale, "删除指标", "Delete metric")}
              </button>
            </footer>
          </div>
        </details>
      ))}
    </section>
  );
}
