import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { DashboardConditionalRulesEditor } from "./DashboardConditionalRulesEditor";
import { DashboardDataSource } from "./DashboardDataSource";
import { DashboardDatasetWriteback } from "./DashboardDatasetWriteback";
import { DashboardLegacyFieldRoles } from "./DashboardLegacyFieldRoles";
import { DashboardReportFields } from "./DashboardReportFields";
import { DashboardFieldSlots } from "./DashboardFieldSlots";
import { dashboardFieldRoles } from "./dashboardFieldBinding";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { useDashboardDataBinding } from "./DashboardDataBindingProvider";

export function DashboardInspectorData() {
  const fields = useDashboardDataBinding();
  const {
    inspectorTab,
    locale,
    selectedNode,
    updateDataWidget,
    datasets, project, page, selectedNodeIds, writebackAccess, refreshDataset,
  } = useDashboardWorkspace();
  if (!selectedNode) return null;

  return (
    inspectorTab === "data" &&
    selectedNode.kind === "data-widget" &&
    !["text", "shape", "decoration", "topology"].includes(selectedNode.widget.type) && (
      <section className="dashboard-inspector-section dashboard-data-widget-properties">
        {selectedNodeIds.length === 1 && writebackAccess && <DashboardDatasetWriteback
          key={`${writebackAccess.userId}:${project.id}:${page.id}:${selectedNode.id}:${selectedNode.widget.datasetId ?? ""}`}
          locale={locale} projectId={project.id} widget={selectedNode.widget} datasets={datasets}
          userId={writebackAccess.userId} canWrite={writebackAccess.canWrite} onSaved={refreshDataset}
          fieldsOpen={fields.open} onOpen={() => { fields.setDrag(undefined); fields.setOpen(false); }} />}
        <DashboardDataSource />
        {!selectedNode.widget.directBinding && !selectedNode.widget.semanticBinding && !selectedNode.widget.sampleData && <DashboardFieldSlots key={selectedNode.id} />}
        {!selectedNode.widget.semanticBinding && ["line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "gauge", "sankey", "sunburst", "treemap", "graph", "map", "rank", "table", "scroll-table"].includes(
          selectedNode.widget.type,
        ) && (
          <details className="dashboard-data-analysis-settings" open={Boolean(selectedNode.widget.analysis || selectedNode.widget.report || selectedNode.widget.type === "map")}>
            <summary>{tr(locale, "分析与报表", "Analysis & report")}</summary>
            {(!dashboardFieldRoles(selectedNode.widget.type).length || selectedNode.widget.directBinding) && <DashboardLegacyFieldRoles />}
            <label>
              <span>{tr(locale, "聚合方式", "Aggregation")}</span>
              <select
                value={selectedNode.widget.analysis?.aggregation ?? "none"}
                onChange={(event) =>
                  updateDataWidget({
                    analysis: {
                      ...(selectedNode.widget.analysis ?? {
                        aggregation: "none",
                      }),
                      aggregation: event.target.value as NonNullable<DashboardDataWidgetConfig["analysis"]>["aggregation"],
                    },
                  })
                }
              >
                <option value="none">{tr(locale, "不聚合 / 原始", "Raw")}</option>
                <option value="count">{tr(locale, "计数", "Count")}</option>
                <option value="distinct-count">{tr(locale, "去重计数", "Distinct count")}</option>
                <option value="sum">{tr(locale, "求和", "Sum")}</option>
                <option value="average">{tr(locale, "平均", "Average")}</option>
                <option value="minimum">{tr(locale, "最小", "Minimum")}</option>
                <option value="maximum">{tr(locale, "最大", "Maximum")}</option>
              </select>
            </label>
            <label>
              <span>{tr(locale, "钻取层级（逗号分隔）", "Drill hierarchy (comma separated)")}</span>
              <input
                defaultValue={(selectedNode.widget.analysis?.drillFields ?? []).join(", ")}
                placeholder="province, city, site"
                onBlur={(event) =>
                  updateDataWidget({
                    analysis: {
                      aggregation: selectedNode.widget.analysis?.aggregation ?? "none",
                      ...selectedNode.widget.analysis,
                      drillFields: event.currentTarget.value
                        .split(/[,，]/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
              <small>{tr(locale, "运行时点击图表进入下一级，可随时返回上一级。", "Click the chart at runtime to drill down, then return to any previous level.")}</small>
            </label>
            {["line", "area", "bar", "combo"].includes(selectedNode.widget.type) && (
              <div className="dashboard-analysis-grid">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedNode.widget.chart?.showLegend ?? false}
                    onChange={(event) =>
                      updateDataWidget({
                        chart: {
                          ...selectedNode.widget.chart,
                          showLegend: event.target.checked,
                        },
                      })
                    }
                  />
                  {tr(locale, "显示图例", "Show legend")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedNode.widget.chart?.showDataLabels ?? false}
                    onChange={(event) =>
                      updateDataWidget({
                        chart: {
                          ...selectedNode.widget.chart,
                          showDataLabels: event.target.checked,
                        },
                      })
                    }
                  />
                  {tr(locale, "显示数值标签", "Show values")}
                </label>
                {["bar", "area"].includes(selectedNode.widget.type) && (
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedNode.widget.chart?.stacked ?? false}
                      onChange={(event) =>
                        updateDataWidget({
                          chart: {
                            ...selectedNode.widget.chart,
                            stacked: event.target.checked,
                          },
                        })
                      }
                    />
                    {tr(locale, "系列堆叠", "Stack series")}
                  </label>
                )}
                {selectedNode.widget.type === "combo" && (
                  <label>
                    <span>{tr(locale, "右轴折线系列", "Right-axis line series")}</span>
                    <input
                      defaultValue={(selectedNode.widget.chart?.secondaryAxisSeries ?? []).join(", ")}
                      placeholder={tr(locale, "留空时使用最后一个系列", "Last series when empty")}
                      onBlur={(event) =>
                        updateDataWidget({
                          chart: {
                            ...selectedNode.widget.chart,
                            secondaryAxisSeries: event.currentTarget.value
                              .split(/[,，]/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </label>
                )}
              </div>
            )}
            <DashboardReportFields />
            {selectedNode.widget.type === "map" && (
              <>
                <label>
                  <span>GeoJSON URL</span>
                  <input
                    value={selectedNode.widget.map?.geoJsonUrl ?? ""}
                    placeholder="/assets/maps/china.json"
                    onChange={(event) =>
                      updateDataWidget({
                        map: {
                          ...selectedNode.widget.map,
                          geoJsonUrl: event.target.value,
                          mode: selectedNode.widget.map?.mode ?? "region",
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>{tr(locale, "区域字段", "Region field")}</span>
                  <input
                    value={selectedNode.widget.map?.regionField ?? selectedNode.widget.analysis?.dimensionField ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        map: {
                          ...selectedNode.widget.map,
                          regionField: event.target.value,
                          mode: selectedNode.widget.map?.mode ?? "region",
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>{tr(locale, "地图值字段", "Map value field")}</span>
                  <input
                    value={selectedNode.widget.map?.valueField ?? selectedNode.widget.analysis?.measureField ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        map: {
                          ...selectedNode.widget.map,
                          valueField: event.target.value,
                          mode: selectedNode.widget.map?.mode ?? "region",
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <label>
              <span>{tr(locale, "点击联动参数（可选）", "Click linkage parameter (optional)")}</span>
              <input
                value={selectedNode.widget.linkageParameterKey ?? ""}
                placeholder="filter.region"
                onChange={(event) =>
                  updateDataWidget({
                    linkageParameterKey: event.target.value,
                  })
                }
              />
              <small>
                {tr(locale, "点击图表、排行或表格后直接写入共享参数，无需额外搭建联动流程。", "Writes the clicked value to a shared parameter without an extra interaction flow.")}
              </small>
            </label>
          </details>
        )}
        {["value", "digital-flip", "liquid-fill", "progress", "status", "rank", "table", "scroll-table"].includes(selectedNode.widget.type) && (
          <DashboardConditionalRulesEditor
            locale={locale}
            value={selectedNode.widget.conditionalRules ?? []}
            onChange={(conditionalRules) => updateDataWidget({ conditionalRules })}
          />
        )}
        <small className="dashboard-inspector-hint">
          {tr(
            locale,
            "同一数据产品可同时驱动二维组件、三维对象和对外接口。选择字段后会自动生成绑定键。",
            "The same data product can drive 2D widgets, 3D objects, and external endpoints. Choosing a field creates the binding key automatically.",
          )}
        </small>
        <label>
          <span>{tr(locale, "单位", "Unit")}</span>
          <input
            defaultValue={selectedNode.widget.unit}
            key={`${selectedNode.id}:unit:${selectedNode.widget.unit}`}
            onBlur={(event) => {
              if (event.currentTarget.value !== selectedNode.widget.unit) updateDataWidget({ unit: event.currentTarget.value });
            }}
          />
        </label>
        <label>
          <span>{tr(locale, "设计数据状态", "Design data state")}</span>
          <select
            value={selectedNode.widget.designState ?? "auto"}
            onChange={(event) =>
              updateDataWidget({
                designState: event.target.value as NonNullable<DashboardDataWidgetConfig["designState"]>,
              })
            }
          >
            <option value="auto">{tr(locale, "自动 / 实时", "Auto / Live")}</option>
            <option value="empty">{tr(locale, "空数据", "Empty")}</option>
            <option value="loading">{tr(locale, "加载中", "Loading")}</option>
            <option value="partial">{tr(locale, "部分数据", "Partial")}</option>
            <option value="error">{tr(locale, "错误", "Error")}</option>
            <option value="forbidden">{tr(locale, "无权限", "No permission")}</option>
          </select>
        </label>
        {["gauge", "liquid-fill"].includes(selectedNode.widget.type) && (
          <div className="dashboard-frame-grid">
            <label>
              <span>{tr(locale, "最小", "MIN")}</span>
              <input
                type="number"
                value={selectedNode.widget.min ?? 0}
                onChange={(event) =>
                  updateDataWidget({
                    min: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "最大", "MAX")}</span>
              <input
                type="number"
                value={selectedNode.widget.max ?? 100}
                onChange={(event) =>
                  updateDataWidget({
                    max: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
        )}
      </section>
    )
  );
}
