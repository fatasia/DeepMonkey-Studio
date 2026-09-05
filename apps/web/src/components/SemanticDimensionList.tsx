import type {
  DataDatasetField,
  SemanticDimensionDefinition,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  SemanticFieldSelect,
  SemanticIdentityFields,
} from "./SemanticEditorFields";
import {
  moveSemanticItem,
  semanticUniqueKey,
} from "./semanticModelEditorLogic";

export function SemanticDimensionList({
  value,
  fields,
  onChange,
  locale,
}: {
  value: SemanticDimensionDefinition[];
  fields: DataDatasetField[];
  onChange: (value: SemanticDimensionDefinition[]) => void;
  locale: AppLocale;
}) {
  const patch = (id: string, update: Partial<SemanticDimensionDefinition>) =>
    onChange(
      value.map((item) => (item.id === id ? { ...item, ...update } : item)),
    );
  return (
    <section
      className="semantic-definitions"
      aria-label={tr(locale, "维度定义", "Dimension definitions")}
    >
      <header>
        <div>
          <h3>{tr(locale, "维度", "Dimensions")}</h3>
          <p>
            {tr(
              locale,
              "按业务层级组织分类与钻取",
              "Organize categories and drill hierarchies",
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
                key: semanticUniqueKey("dimension", value),
                label: "",
                fieldKey: "",
              },
            ])
          }
        >
          {tr(locale, "新增维度", "Add dimension")}
        </button>
      </header>
      {!value.length && (
        <p className="semantic-empty-inline">
          {tr(
            locale,
            "例如：区域 → 工厂 → 产线。",
            "For example: region → factory → line.",
          )}
        </p>
      )}
      {value.map((dimension, index) => (
        <details key={dimension.id} className="semantic-definition" open>
          <summary>
            {dimension.label ||
              tr(locale, `维度 ${index + 1}`, `Dimension ${index + 1}`)}
            <small>{dimension.key}</small>
          </summary>
          <div className="semantic-definition-body">
            <SemanticIdentityFields
              value={dimension}
              onChange={(update) => patch(dimension.id, update)}
              locale={locale}
            />
            <SemanticFieldSelect
              label={tr(locale, "主字段", "Primary field")}
              value={dimension.fieldKey}
              fields={fields}
              onChange={(fieldKey) => patch(dimension.id, { fieldKey })}
              locale={locale}
            />
            <div className="semantic-hierarchy">
              {(dimension.hierarchy ?? []).map((level, at, levels) => (
                <div key={at} className="semantic-hierarchy-row">
                  <span>{at + 1}</span>
                  <SemanticFieldSelect
                    label={tr(
                      locale,
                      `层级字段 ${at + 1}`,
                      `Level field ${at + 1}`,
                    )}
                    value={level.fieldKey}
                    fields={fields}
                    onChange={(fieldKey) =>
                      patch(dimension.id, {
                        hierarchy: levels.map((item, offset) =>
                          offset === at ? { ...item, fieldKey } : item,
                        ),
                      })
                    }
                    locale={locale}
                  />
                  <label>
                    <span>{tr(locale, "层级名称", "Level name")}</span>
                    <input
                      value={level.label}
                      onChange={(event) =>
                        patch(dimension.id, {
                          hierarchy: levels.map((item, offset) =>
                            offset === at
                              ? { ...item, label: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <div>
                    <button
                      type="button"
                      disabled={at === 0}
                      aria-label={tr(
                        locale,
                        `上移层级 ${at + 1}`,
                        `Move level ${at + 1} up`,
                      )}
                      onClick={() =>
                        patch(dimension.id, {
                          hierarchy: moveSemanticItem(levels, at, -1),
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={at === levels.length - 1}
                      aria-label={tr(
                        locale,
                        `下移层级 ${at + 1}`,
                        `Move level ${at + 1} down`,
                      )}
                      onClick={() =>
                        patch(dimension.id, {
                          hierarchy: moveSemanticItem(levels, at, 1),
                        })
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={tr(
                        locale,
                        `删除层级 ${at + 1}`,
                        `Remove level ${at + 1}`,
                      )}
                      onClick={() =>
                        patch(dimension.id, {
                          hierarchy: levels.filter(
                            (_, offset) => offset !== at,
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  patch(dimension.id, {
                    hierarchy: [
                      ...(dimension.hierarchy ?? []),
                      { fieldKey: "", label: "" },
                    ],
                  })
                }
              >
                {tr(locale, "新增钻取层级", "Add drill level")}
              </button>
            </div>
            <footer>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  onChange(value.filter((item) => item.id !== dimension.id))
                }
              >
                {tr(locale, "删除维度", "Delete dimension")}
              </button>
            </footer>
          </div>
        </details>
      ))}
    </section>
  );
}
