import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardReportFields() {
  const { analysisFields, locale, selectedNode, toggleReportValueField, updateDataWidget } = useDashboardWorkspace();
  if (selectedNode?.kind !== "data-widget") return null;
  return <>
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
  </>;
}

