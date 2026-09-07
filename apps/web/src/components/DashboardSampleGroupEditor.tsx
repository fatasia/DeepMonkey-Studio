import { createUpdateDashboardDataWidgetsCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { DashboardSampleDataEditor } from "./DashboardSampleDataEditor";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

/** 模板整组选中后即可改数据，不要求用户先破坏编组。 */
export function DashboardSampleGroupEditor() {
  const { page, inspectorTab, selectedDataNodes, locale, busy, onCommand } = useDashboardWorkspace();
  const samples = selectedDataNodes.filter(node => node.widget.sampleData?.sourceId);
  const sourceId = samples[0]?.widget.sampleData?.sourceId;
  if (inspectorTab !== "data" || samples.length < 2 || !sourceId || samples.some(node => node.widget.sampleData?.sourceId !== sourceId)) return null;
  const linked = page.nodes.flatMap(node => node.kind === "data-widget" && node.widget.sampleData?.sourceId === sourceId ? [node] : []);
  return <section className="dashboard-inspector-section"><DashboardSampleDataEditor key={sourceId} dataOnly locale={locale} widget={samples[0]!.widget}
    disabled={busy || linked.some(node => node.locked)} onChange={patch => {
      if (!patch.sampleData) return;
      onCommand(createUpdateDashboardDataWidgetsCommand(page.id, linked.map(node => ({ nodeId: node.id,
        widget: { ...node.widget, sampleData: { ...patch.sampleData!, sourceId } } })), tr(locale, "修改示例数据", "Edit sample data")));
    }} /></section>;
}
