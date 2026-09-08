import type { DashboardDataWidgetNode, DashboardSampleData } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

/** 手工编写的小型产线样板；不是设备实测，也不计作新增行业深度包。 */
export function applyProductionSample(nodes: DashboardDataWidgetNode[], locale: AppLocale): DashboardDataWidgetNode[] {
  const sourceId = `production:${crypto.randomUUID()}`;
  const line = tr(locale, "产线", "Line"), output = tr(locale, "产量", "Output");
  const oee = "OEE", alarms = tr(locale, "活动告警", "Active alerts"), delivery = tr(locale, "准时交付", "On-time delivery");
  const rows: DashboardSampleData["rows"] = [
    { [line]: "A", [output]: 1080, [oee]: 90, [alarms]: 0, [delivery]: 99 },
    { [line]: "B", [output]: 920, [oee]: 88, [alarms]: 2, [delivery]: 96 },
    { [line]: "C", [output]: 600, [oee]: 86, [alarms]: 1, [delivery]: 93 },
  ];
  const fields = [output, oee, alarms, delivery];
  return nodes.map((node, index) => {
    const widget = { ...node.widget, key: `${sourceId}:${index}` };
    delete widget.conditionalRules;
    // 示例模板使用应用主题；不改变用户已有画布中保存的颜色。
    delete widget.color; delete widget.backgroundColor;
    if (index === 0) widget.content = widget.title = tr(locale, "生产运行监控 · 示例", "Production monitoring · Sample");
    else if (index === 1) {
      widget.title = line; widget.filterField = line; widget.options = [tr(locale, "全部", "All"), "A", "B", "C"];
    } else {
      widget.sampleData = { sourceId, rows: structuredClone(rows) };
      widget.field = index < 6 ? fields[index - 2]! : output;
      widget.analysis = { measureField: widget.field, aggregation: index === 3 || index === 5 ? "average" : "sum" };
      if (index < 6) widget.type = "value";
      if (index === 3) widget.title = tr(locale, "平均 OEE", "Mean OEE");
      if (index === 5) widget.title = tr(locale, "平均准时交付", "Mean on-time delivery");
      if (index === 6 || index === 7) {
        widget.type = index === 6 ? "bar" : "pie";
        widget.title = index === 6 ? tr(locale, "各产线产量", "Output by line") : tr(locale, "产量占比", "Output share");
        widget.unit = tr(locale, "件", "units");
        widget.analysis.dimensionField = line;
        widget.chart = { showLegend: index === 7, showDataLabels: true };
      }
      if (index === 8) {
        widget.title = tr(locale, "产线明细", "Line detail");
        widget.report = { mode: "detail", pageSize: 10, stripedRows: true, valueFormat: "number", decimalPlaces: 0 };
      }
    }
    return { ...node, widget };
  });
}
