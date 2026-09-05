
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardLegacyFieldRoles() {
  const { analysisFields, assignAnalysisField, locale, selectedNode, updateDataWidget } = useDashboardWorkspace();
  if (selectedNode?.kind !== "data-widget") return null;
  return <>
            {analysisFields.length > 0 && (
              <div className="dashboard-field-role-picker">
                <header>
                  <strong>{tr(locale, "字段角色", "Field roles")}</strong>
                  <small>{tr(locale, "一键指定维度 / 指标 / 系列", "Assign dimension / measure / series")}</small>
                </header>
                {analysisFields.map((field) => (
                  <div key={field.key}>
                    <span title={field.key}>
                      <b>{field.label}</b>
                      <small>
                        {field.type}
                        {field.unit ? ` · ${field.unit}` : ""}
                      </small>
                    </span>
                    <button className={selectedNode.widget.analysis?.dimensionField === field.key ? "active" : ""} onClick={() => assignAnalysisField(field.key, "dimension")}>
                      {tr(locale, "维", "Dim")}
                    </button>
                    <button
                      className={(selectedNode.widget.analysis?.measureField ?? selectedNode.widget.field) === field.key ? "active" : ""}
                      onClick={() => assignAnalysisField(field.key, "measure")}
                    >
                      {tr(locale, "值", "Val")}
                    </button>
                    <button className={selectedNode.widget.analysis?.seriesField === field.key ? "active" : ""} onClick={() => assignAnalysisField(field.key, "series")}>
                      {tr(locale, "列", "Series")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label>
              <span>{tr(locale, "维度字段", "Dimension field")}</span>
              <input
                value={selectedNode.widget.analysis?.dimensionField ?? ""}
                placeholder="region / time"
                onChange={(event) =>
                  updateDataWidget({
                    analysis: {
                      aggregation: selectedNode.widget.analysis?.aggregation ?? "none",
                      ...selectedNode.widget.analysis,
                      dimensionField: event.target.value,
                    },
                  })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "指标字段", "Measure field")}</span>
              <input
                value={selectedNode.widget.analysis?.measureField ?? selectedNode.widget.field ?? ""}
                placeholder="value / amount"
                onChange={(event) =>
                  updateDataWidget({
                    field: event.target.value,
                    analysis: {
                      aggregation: selectedNode.widget.analysis?.aggregation ?? "sum",
                      ...selectedNode.widget.analysis,
                      measureField: event.target.value,
                    },
                  })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "系列字段（可选）", "Series field (optional)")}</span>
              <input
                value={selectedNode.widget.analysis?.seriesField ?? ""}
                placeholder="category"
                onChange={(event) =>
                  updateDataWidget({
                    analysis: {
                      aggregation: selectedNode.widget.analysis?.aggregation ?? "none",
                      ...selectedNode.widget.analysis,
                      seriesField: event.target.value,
                    },
                  })
                }
              />
            </label>
  </>;
}

