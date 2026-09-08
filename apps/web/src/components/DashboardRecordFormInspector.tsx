import { useState } from "react";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardRecordFormInspector() {
  const { locale, selectedNode, datasets, project, catalogError, updateDataWidget } = useDashboardWorkspace();
  const [error, setError] = useState("");
  if (selectedNode?.kind !== "data-widget" || selectedNode.widget.type !== "record-form") return null;
  const widget = selectedNode.widget;
  const available = datasets.filter(dataset => dataset.projectId === project.id && dataset.writeback);
  return <section className="dashboard-inspector-section dashboard-data-widget-properties">
    <label><span>{tr(locale, "填报数据集", "Record dataset")}</span>
      <select value={widget.datasetId ?? ""} disabled={selectedNode.locked} onChange={event => updateDataWidget({ datasetId: event.target.value })}>
        <option value="">{tr(locale, "选择数据集", "Select a dataset")}</option>
        {widget.datasetId && !available.some(dataset => dataset.id === widget.datasetId) && <option value={widget.datasetId}>{tr(locale, "数据集不可用", "Dataset unavailable")}</option>}
        {available.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
      </select>
    </label>
    <label><span>{tr(locale, "记录编号", "Record ID")}</span>
      <input key={`${selectedNode.id}:${widget.recordForm?.recordId ?? ""}`} defaultValue={widget.recordForm?.recordId ?? ""} maxLength={128} disabled={selectedNode.locked}
        onBlur={event => {
          const recordId = event.currentTarget.value.trim();
          if (recordId && !/^[\p{L}\p{N}_-]{1,128}$/u.test(recordId)) { setError(tr(locale, "仅支持文字、数字、下划线和短横线", "Use letters, numbers, underscores or hyphens")); return; }
          setError(""); updateDataWidget({ recordForm: { recordId } });
        }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    </label>
    {error && <small className="dashboard-field-error" role="alert">{error}</small>}
    {catalogError && <small className="dashboard-field-error" role="alert">{tr(locale, "数据目录读取失败，请刷新页面重试", "Could not load the data catalog. Reload to retry.")}</small>}
  </section>;
}
