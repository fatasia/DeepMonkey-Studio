import type { DashboardDataWidgetConfig, DirectBindingSpec } from "@bim-studio/contracts";
import { createUpdateDashboardDataWidgetCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { DashboardConditionalRulesEditor } from "./DashboardConditionalRulesEditor";
import { createDefaultDirectBinding, DirectBindingEditor } from "./DirectBindingEditor";
import { DashboardDataRefreshSummary } from "./DashboardDataRefreshSummary";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardInspectorData() {
  const {
    analysisFields,
    assignAnalysisField,
    catalogError,
    datasets,
    fieldsByProduct,
    inspectorTab,
    locale,
    onCommand,
    onOpenData,
    page,
    pipelines,
    selectDataField,
    selectDataProduct,
    selectedNode,
    statusByProduct,
    toggleReportValueField,
    updateDataWidget,
  } = useDashboardWorkspace();
  if (!selectedNode) return null;

  return (
    inspectorTab === "data" &&
    selectedNode.kind === "data-widget" &&
    !["text", "shape", "decoration", "topology"].includes(selectedNode.widget.type) && (
      <section className="dashboard-inspector-section dashboard-data-widget-properties">
        <label>
          <span>{tr(locale, "数据来源", "Data source")}</span>
          <select
            value={selectedNode.widget.directBinding ? "direct" : selectedNode.widget.pipelineId || selectedNode.widget.datasetId ? "platform" : "unbound"}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === "direct") {
                const next = {
                  ...selectedNode.widget,
                  directBinding: createDefaultDirectBinding(),
                };
                delete next.datasetId;
                delete next.pipelineId;
                onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
              } else if (mode === "platform") selectDataProduct(pipelines[0] ? `pipeline:${pipelines[0].id}` : datasets[0] ? `dataset:${datasets[0].id}` : "");
              else selectDataProduct("");
            }}
          >
            <option value="unbound">{tr(locale, "实时变量 / 未绑定", "Live variable / Unbound")}</option>
            <option value="platform">{tr(locale, "数据中心", "Data Center")}</option>
            <option value="direct">{tr(locale, "直接 HTTP / WebSocket", "Direct HTTP / WebSocket")}</option>
          </select>
        </label>
        {!selectedNode.widget.directBinding && (selectedNode.widget.pipelineId || selectedNode.widget.datasetId) && (
          <label>
            <span>{tr(locale, "数据产品", "Data product")}</span>
            <select
              value={
                selectedNode.widget.pipelineId ? `pipeline:${selectedNode.widget.pipelineId}` : selectedNode.widget.datasetId ? `dataset:${selectedNode.widget.datasetId}` : ""
              }
              onChange={(event) => selectDataProduct(event.target.value)}
            >
              {pipelines.length > 0 && (
                <optgroup label={tr(locale, "数据管道（推荐）", "Data pipelines (recommended)")}>
                  {pipelines.map((pipeline) => (
                    <option key={pipeline.id} value={`pipeline:${pipeline.id}`}>
                      {pipeline.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {datasets.length > 0 && (
                <optgroup label={tr(locale, "原始数据集", "Raw datasets")}>
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={`dataset:${dataset.id}`}>
                      {dataset.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
        {!selectedNode.widget.directBinding && (selectedNode.widget.pipelineId || selectedNode.widget.datasetId) && (
          <DashboardDataRefreshSummary
            locale={locale}
            kind={selectedNode.widget.pipelineId ? "pipeline" : "dataset"}
            productId={selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId!}
            datasets={datasets}
            pipelines={pipelines}
            onOpenData={onOpenData}
          />
        )}
        {selectedNode.widget.directBinding && (
          <DirectBindingEditor
            locale={locale}
            value={selectedNode.widget.directBinding}
            onChange={(directBinding: DirectBindingSpec) =>
              updateDataWidget({
                directBinding,
                key: selectedNode.widget.key || directBinding.selection?.field || "value",
              })
            }
          />
        )}
        {(() => {
          if (selectedNode.widget.directBinding)
            return (
              <label>
                <span>{tr(locale, "组件数据键", "Widget data key")}</span>
                <input value={selectedNode.widget.key} onChange={(event) => updateDataWidget({ key: event.target.value })} />
              </label>
            );
          const productId = selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId;
          const productKey = selectedNode.widget.pipelineId
            ? `pipeline:${selectedNode.widget.pipelineId}`
            : selectedNode.widget.datasetId
              ? `dataset:${selectedNode.widget.datasetId}`
              : undefined;
          const status = productKey ? statusByProduct[productKey] : undefined;
          const fields = productKey ? (fieldsByProduct[productKey] ?? []) : [];
          if (!productId)
            return (
              <label>
                <span>{tr(locale, "数据键", "Data key")}</span>
                <input
                  defaultValue={selectedNode.widget.key}
                  key={`${selectedNode.id}:key:${selectedNode.widget.key}`}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== selectedNode.widget.key)
                      updateDataWidget({
                        key: event.currentTarget.value,
                      });
                  }}
                />
              </label>
            );
          if (status === "loading" && fields.length === 0) return <div className="dashboard-data-binding-state">{tr(locale, "正在读取字段…", "Loading fields…")}</div>;
          if (status === "error")
            return (
              <div className="dashboard-data-binding-state error">
                {tr(locale, "数据产品运行失败，请到数据中心检查节点诊断。", "The data product failed. Open Data Center for node diagnostics.")}
              </div>
            );
          return (
            <label>
              <span>{tr(locale, "字段", "Field")}</span>
              <select value={selectedNode.widget.field ?? ""} onChange={(event) => selectDataField(event.target.value)}>
                <option value="">{tr(locale, "选择输出字段", "Choose an output field")}</option>
                {fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                    {field.unit ? ` · ${field.unit}` : ""}
                  </option>
                ))}
              </select>
            </label>
          );
        })()}
        {catalogError && <div className="dashboard-data-binding-state error">{tr(locale, "数据目录暂不可用，请稍后重试。", "The data catalog is temporarily unavailable.")}</div>}
        {["line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "gauge", "sankey", "sunburst", "treemap", "graph", "map", "rank", "table", "scroll-table"].includes(
          selectedNode.widget.type,
        ) && (
          <details className="dashboard-data-analysis-settings" open={Boolean(selectedNode.widget.analysis || selectedNode.widget.report || selectedNode.widget.type === "map")}>
            <summary>{tr(locale, "分析与报表", "Analysis & report")}</summary>
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
            {["table", "scroll-table"].includes(selectedNode.widget.type) && (
              <div className="dashboard-analysis-grid">
                <label>
                  <span>{tr(locale, "报表模式", "Report mode")}</span>
                  <select
                    value={selectedNode.widget.report?.mode ?? "detail"}
                    onChange={(event) =>
                      updateDataWidget({
                        report: {
                          ...selectedNode.widget.report,
                          mode: event.target.value as NonNullable<DashboardDataWidgetConfig["report"]>["mode"],
                        },
                      })
                    }
                  >
                    <option value="detail">{tr(locale, "明细表", "Detail")}</option>
                    <option value="grouped">{tr(locale, "分组汇总", "Grouped")}</option>
                    <option value="crosstab">{tr(locale, "交叉表", "Crosstab")}</option>
                  </select>
                </label>
                <label>
                  <span>{tr(locale, "行字段", "Row field")}</span>
                  <input
                    value={selectedNode.widget.report?.rowField ?? selectedNode.widget.analysis?.dimensionField ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        report: {
                          mode: selectedNode.widget.report?.mode ?? "detail",
                          ...selectedNode.widget.report,
                          rowField: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>{tr(locale, "列字段", "Column field")}</span>
                  <input
                    value={selectedNode.widget.report?.columnField ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        report: {
                          mode: selectedNode.widget.report?.mode ?? "crosstab",
                          ...selectedNode.widget.report,
                          columnField: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>{tr(locale, "默认汇总指标", "Default measure")}</span>
                  <input
                    value={selectedNode.widget.report?.valueField ?? selectedNode.widget.analysis?.measureField ?? ""}
                    onChange={(event) =>
                      updateDataWidget({
                        report: {
                          mode: selectedNode.widget.report?.mode ?? "detail",
                          ...selectedNode.widget.report,
                          valueField: event.target.value,
                          valueFields: event.target.value ? [event.target.value] : [],
                        },
                      })
                    }
                  />
                </label>
                {selectedNode.widget.report?.mode !== "detail" && analysisFields.length > 0 && (
                  <div className="dashboard-report-measures">
                    <header>
                      <strong>{tr(locale, "汇总指标（可多选）", "Measures (multi-select)")}</strong>
                      <small>
                        {selectedNode.widget.report?.valueFields?.length ?? (selectedNode.widget.report?.valueField || selectedNode.widget.analysis?.measureField ? 1 : 0)}
                      </small>
                    </header>
                    <div>
                      {analysisFields.map((field) => {
                        const active = (
                          selectedNode.widget.report?.valueFields ?? [selectedNode.widget.report?.valueField ?? selectedNode.widget.analysis?.measureField ?? ""]
                        ).includes(field.key);
                        return (
                          <button type="button" key={field.key} className={active ? "active" : ""} onClick={() => toggleReportValueField(field.key)}>
                            {field.label}
                          </button>
                        );
                      })}
                    </div>
                    <small>{tr(locale, "至少保留一个指标；交叉表会按列值 × 指标展开。", "Keeps at least one measure; crosstabs expand by column value × measure.")}</small>
                  </div>
                )}
                <label>
                  <span>{selectedNode.widget.type === "scroll-table" ? tr(locale, "可见行数", "Visible rows") : tr(locale, "每页行数", "Rows per page")}</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={selectedNode.widget.report?.pageSize ?? 8}
                    onChange={(event) =>
                      updateDataWidget({
                        report: {
                          mode: selectedNode.widget.report?.mode ?? "detail",
                          ...selectedNode.widget.report,
                          pageSize: Math.max(1, Number(event.target.value) || 8),
                        },
                      })
                    }
                  />
                </label>
                {selectedNode.widget.type === "table" && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedNode.widget.report?.freezeFirstColumn ?? false}
                        onChange={(event) =>
                          updateDataWidget({
                            report: {
                              mode: selectedNode.widget.report?.mode ?? "detail",
                              ...selectedNode.widget.report,
                              freezeFirstColumn: event.target.checked,
                            },
                          })
                        }
                      />
                      {tr(locale, "冻结首列", "Freeze first column")}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedNode.widget.report?.showRowNumbers ?? false}
                        onChange={(event) =>
                          updateDataWidget({
                            report: {
                              mode: selectedNode.widget.report?.mode ?? "detail",
                              ...selectedNode.widget.report,
                              showRowNumbers: event.target.checked,
                            },
                          })
                        }
                      />
                      {tr(locale, "显示行号", "Show row numbers")}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedNode.widget.report?.stripedRows ?? false}
                        onChange={(event) =>
                          updateDataWidget({
                            report: {
                              mode: selectedNode.widget.report?.mode ?? "detail",
                              ...selectedNode.widget.report,
                              stripedRows: event.target.checked,
                            },
                          })
                        }
                      />
                      {tr(locale, "斑马纹", "Striped rows")}
                    </label>
                    <label>
                      <span>{tr(locale, "数值格式", "Value format")}</span>
                      <select
                        value={selectedNode.widget.report?.valueFormat ?? "auto"}
                        onChange={(event) =>
                          updateDataWidget({
                            report: {
                              mode: selectedNode.widget.report?.mode ?? "detail",
                              ...selectedNode.widget.report,
                              valueFormat: event.target.value as NonNullable<DashboardDataWidgetConfig["report"]>["valueFormat"],
                            },
                          })
                        }
                      >
                        <option value="auto">{tr(locale, "自动", "Auto")}</option>
                        <option value="number">{tr(locale, "数值", "Number")}</option>
                        <option value="percent">{tr(locale, "百分比", "Percent")}</option>
                        <option value="currency">{tr(locale, "货币", "Currency")}</option>
                      </select>
                    </label>
                    {selectedNode.widget.report?.valueFormat && selectedNode.widget.report.valueFormat !== "auto" && (
                      <label>
                        <span>{tr(locale, "小数位", "Decimals")}</span>
                        <input
                          type="number"
                          min="0"
                          max="8"
                          value={selectedNode.widget.report.decimalPlaces ?? 2}
                          onChange={(event) =>
                            updateDataWidget({
                              report: {
                                mode: selectedNode.widget.report?.mode ?? "detail",
                                ...selectedNode.widget.report,
                                decimalPlaces: Math.max(0, Math.min(8, Number(event.target.value) || 0)),
                              },
                            })
                          }
                        />
                      </label>
                    )}
                    {selectedNode.widget.report?.valueFormat === "currency" && (
                      <label>
                        <span>{tr(locale, "币种", "Currency")}</span>
                        <input
                          value={selectedNode.widget.report.currency ?? "CNY"}
                          onChange={(event) =>
                            updateDataWidget({
                              report: {
                                mode: selectedNode.widget.report?.mode ?? "detail",
                                ...selectedNode.widget.report,
                                currency: event.target.value.toUpperCase().slice(0, 3),
                              },
                            })
                          }
                        />
                      </label>
                    )}
                    {selectedNode.widget.report?.mode === "crosstab" && (
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedNode.widget.report?.showSubtotal ?? false}
                          onChange={(event) =>
                            updateDataWidget({
                              report: {
                                mode: "crosstab",
                                ...selectedNode.widget.report,
                                showSubtotal: event.target.checked,
                              },
                            })
                          }
                        />
                        {tr(locale, "显示行总计", "Show row totals")}
                      </label>
                    )}
                    {selectedNode.widget.report?.mode !== "detail" && (
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedNode.widget.report?.showGrandTotal ?? false}
                          onChange={(event) =>
                            updateDataWidget({
                              report: {
                                mode: selectedNode.widget.report?.mode ?? "grouped",
                                ...selectedNode.widget.report,
                                showGrandTotal: event.target.checked,
                              },
                            })
                          }
                        />
                        {tr(locale, "显示总计", "Show grand total")}
                      </label>
                    )}
                  </>
                )}
              </div>
            )}
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
