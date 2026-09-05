import type {
  SemanticDimensionDefinition,
  SemanticParameterDefinition,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { SemanticIdentityFields } from "./SemanticEditorFields";
import { semanticUniqueKey } from "./semanticModelEditorLogic";
import { SemanticParameterOptions } from "./SemanticParameterOptions";

export function SemanticParameterList({
  value,
  dimensions,
  onChange,
  locale,
}: {
  value: SemanticParameterDefinition[];
  dimensions: SemanticDimensionDefinition[];
  onChange: (value: SemanticParameterDefinition[]) => void;
  locale: AppLocale;
}) {
  const patch = (id: string, update: Partial<SemanticParameterDefinition>) =>
    onChange(
      value.map((item) => (item.id === id ? { ...item, ...update } : item)),
    );
  return (
    <section
      className="semantic-definitions"
      aria-label={tr(locale, "参数定义", "Parameter definitions")}
    >
      <header>
        <div>
          <h3>{tr(locale, "参数", "Parameters")}</h3>
          <p>
            {tr(
              locale,
              "定义默认值与级联选择关系",
              "Define defaults and cascading choices",
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
                key: semanticUniqueKey("parameter", value),
                label: "",
                type: "text",
              },
            ])
          }
        >
          {tr(locale, "新增参数", "Add parameter")}
        </button>
      </header>
      {!value.length && (
        <p className="semantic-empty-inline">
          {tr(
            locale,
            "例如：选择工厂后，只展示该工厂的产线。",
            "For example: a factory selection limits the available lines.",
          )}
        </p>
      )}
      {value.map((parameter, index) => (
        <details key={parameter.id} className="semantic-definition" open>
          <summary>
            {parameter.label ||
              tr(locale, `参数 ${index + 1}`, `Parameter ${index + 1}`)}
            <small>{parameter.key}</small>
          </summary>
          <div className="semantic-definition-body">
            <SemanticIdentityFields
              value={parameter}
              onChange={(update) => patch(parameter.id, update)}
              locale={locale}
            />
            <div className="semantic-form-grid">
              <label>
                <span>{tr(locale, "类型", "Type")}</span>
                <select
                  aria-label={tr(locale, "参数类型", "Parameter type")}
                  value={parameter.type}
                  onChange={(event) =>
                    patch(parameter.id, {
                      type: event.target
                        .value as SemanticParameterDefinition["type"],
                    })
                  }
                >
                  {(["text", "number", "datetime", "option"] as const).map(
                    (type, at) => (
                      <option key={type} value={type}>
                        {locale === "zh-CN"
                          ? ["文本", "数值", "日期", "选项"][at]
                          : type}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                <span>{tr(locale, "级联父参数", "Parent parameter")}</span>
                <select
                  aria-label={tr(locale, "级联父参数", "Parent parameter")}
                  value={parameter.parentKey ?? ""}
                  onChange={(event) =>
                    patch(parameter.id, { parentKey: event.target.value })
                  }
                >
                  <option value="">{tr(locale, "无", "None")}</option>
                  {parameter.parentKey &&
                    !value.some((item) => item.key === parameter.parentKey) && (
                      <option value={parameter.parentKey}>
                        {parameter.parentKey} ·{" "}
                        {tr(locale, "已失效", "Unavailable")}
                      </option>
                    )}
                  {value
                    .filter((item) => item.id !== parameter.id)
                    .map((item) => (
                      <option key={item.id} value={item.key}>
                        {item.label || item.key}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              <span>{tr(locale, "默认值", "Default value")}</span>
              <input
                aria-label={tr(locale, "默认值", "Default value")}
                type={parameter.type === "number" ? "number" : "text"}
                value={
                  typeof parameter.defaultValue === "object"
                    ? JSON.stringify(parameter.defaultValue)
                    : String(parameter.defaultValue ?? "")
                }
                onChange={(event) => {
                  if (event.target.value === "") {
                    const next = { ...parameter };
                    delete next.defaultValue;
                    onChange(
                      value.map((item) =>
                        item.id === parameter.id ? next : item,
                      ),
                    );
                  } else
                    patch(parameter.id, {
                      defaultValue:
                        parameter.type === "number"
                          ? Number(event.target.value)
                          : event.target.value,
                    });
                }}
              />
            </label>
            <SemanticParameterOptions
              parameter={parameter}
              dimensions={dimensions}
              locale={locale}
              onChange={(next) =>
                onChange(
                  value.map((item) => (item.id === parameter.id ? next : item)),
                )
              }
            />
            <footer>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  onChange(value.filter((item) => item.id !== parameter.id))
                }
              >
                {tr(locale, "删除参数", "Delete parameter")}
              </button>
            </footer>
          </div>
        </details>
      ))}
    </section>
  );
}
