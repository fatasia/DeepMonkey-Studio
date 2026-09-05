import type {
  SemanticDimensionDefinition,
  SemanticParameterDefinition,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

/** 固定选项与维度引用共用同一参数合同；切换来源只更新选项，不触碰级联关系。 */
export function SemanticParameterOptions({
  parameter,
  dimensions,
  locale,
  onChange,
}: {
  parameter: SemanticParameterDefinition;
  dimensions: SemanticDimensionDefinition[];
  locale: AppLocale;
  onChange: (parameter: SemanticParameterDefinition) => void;
}) {
  const onPatch = (update: Partial<SemanticParameterDefinition>) =>
    onChange({ ...parameter, ...update });
  return (
    <>
      {" "}
      <label>
        <span>{tr(locale, "选项来源", "Options source")}</span>
        <select
          aria-label={tr(locale, "选项来源", "Options source")}
          value={parameter.optionsSource?.kind ?? "none"}
          onChange={(event) => {
            const next = { ...parameter };
            if (event.target.value === "none") delete next.optionsSource;
            else
              next.optionsSource =
                event.target.value === "dimension"
                  ? { kind: "dimension", dimensionKey: "" }
                  : { kind: "static", options: [] };
            onChange(next);
          }}
        >
          <option value="none">{tr(locale, "不设置", "None")}</option>
          <option value="static">
            {tr(locale, "固定选项", "Fixed options")}
          </option>
          <option value="dimension">
            {tr(locale, "维度去重值", "Distinct dimension values")}
          </option>
        </select>
      </label>
      {parameter.optionsSource?.kind === "dimension" && (
        <label>
          <span>{tr(locale, "选项维度", "Options dimension")}</span>
          <select
            aria-label={tr(locale, "选项维度", "Options dimension")}
            value={parameter.optionsSource.dimensionKey}
            onChange={(event) =>
              onPatch({
                optionsSource: {
                  kind: "dimension",
                  dimensionKey: event.target.value,
                },
              })
            }
          >
            <option value="">
              {tr(locale, "选择维度", "Choose dimension")}
            </option>
            {!dimensions.some(
              (item) =>
                item.key ===
                (parameter.optionsSource?.kind === "dimension"
                  ? parameter.optionsSource.dimensionKey
                  : ""),
            ) &&
              parameter.optionsSource.dimensionKey && (
                <option value={parameter.optionsSource.dimensionKey}>
                  {parameter.optionsSource.dimensionKey} ·{" "}
                  {tr(locale, "已失效", "Unavailable")}
                </option>
              )}
            {dimensions.map((item) => (
              <option key={item.id} value={item.key}>
                {item.label || item.key}
              </option>
            ))}
          </select>
        </label>
      )}
      {parameter.optionsSource?.kind === "static" && (
        <div className="semantic-options">
          {parameter.optionsSource.options.map((option, at, options) => (
            <div className="semantic-option-row" key={at}>
              <label>
                <span>{tr(locale, "选项值", "Option value")}</span>
                <input
                  value={
                    typeof option.value === "object"
                      ? JSON.stringify(option.value)
                      : String(option.value)
                  }
                  onChange={(event) =>
                    onPatch({
                      optionsSource: {
                        kind: "static",
                        options: options.map((item, offset) =>
                          offset === at
                            ? { ...item, value: event.target.value }
                            : item,
                        ),
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{tr(locale, "显示名", "Display label")}</span>
                <input
                  value={option.label}
                  onChange={(event) =>
                    onPatch({
                      optionsSource: {
                        kind: "static",
                        options: options.map((item, offset) =>
                          offset === at
                            ? { ...item, label: event.target.value }
                            : item,
                        ),
                      },
                    })
                  }
                />
              </label>
              <button
                type="button"
                aria-label={tr(
                  locale,
                  `删除选项 ${at + 1}`,
                  `Remove option ${at + 1}`,
                )}
                onClick={() =>
                  onPatch({
                    optionsSource: {
                      kind: "static",
                      options: options.filter((_, offset) => offset !== at),
                    },
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onPatch({
                optionsSource: {
                  kind: "static",
                  options: [
                    ...(parameter.optionsSource?.kind === "static"
                      ? parameter.optionsSource.options
                      : []),
                    { value: "", label: "" },
                  ],
                },
              })
            }
          >
            {tr(locale, "新增固定选项", "Add fixed option")}
          </button>
        </div>
      )}
    </>
  );
}
