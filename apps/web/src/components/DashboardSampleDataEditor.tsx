import { useEffect, useMemo, useState } from "react";
import { assertDashboardSampleData, DASHBOARD_SAMPLE_LIMITS, type DashboardDataWidgetConfig, type DashboardSampleData } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { dashboardSampleFields } from "./dashboardSampleMetrics";
import "./DashboardSampleDataEditor.css";

export function DashboardSampleDataEditor({ widget, locale, disabled = false, dataOnly = false, onChange }: {
  widget: DashboardDataWidgetConfig; locale: AppLocale; disabled?: boolean; dataOnly?: boolean;
  onChange(patch: Partial<DashboardDataWidgetConfig>): void;
}) {
  const serialized = JSON.stringify(widget.sampleData?.rows ?? []);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  useEffect(() => { setDraft(serialized); setError(""); }, [serialized]);
  const fields = useMemo(() => dashboardSampleFields(widget.sampleData), [widget.sampleData]);
  const rows = JSON.parse(draft) as DashboardSampleData["rows"];
  const dirty = draft !== serialized;
  const columns = fields.length ? fields : [{ key: widget.field || "value", label: widget.field || "value", type: "number" }];
  function updateRows(next: DashboardSampleData["rows"]) {
    setDraft(JSON.stringify(next)); setApplied(false); setError("");
  }
  function apply() {
    try {
      const parsedRows = rows.map((row, index) => Object.fromEntries(Object.entries(row).map(([key, cell]) => {
        const type = fields.find(field => field.key === key)?.type;
        if (type === "number" && cell !== null) {
          const number = typeof cell === "number" ? cell : typeof cell === "string" && cell.trim() ? Number(cell) : NaN;
          if (!Number.isFinite(number)) throw new Error(tr(locale, `第 ${index + 1} 行 ${key}：请输入有效数字`, `Row ${index + 1}, ${key}: enter a valid number`));
          return [key, number];
        }
        return [key, cell];
      })));
      const sampleData = { ...widget.sampleData, rows: parsedRows };
      assertDashboardSampleData(sampleData);
      onChange({ sampleData }); setApplied(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <section className="dashboard-sample-editor" aria-label={tr(locale, "示例数据编辑", "Sample data editor")} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape" && dirty) { event.preventDefault(); setDraft(serialized); setError(""); }
  }}>
    <header><strong>{tr(locale, "示例数据", "Sample data")}</strong><span title={tr(locale, "随发布版本公开，不用于保存敏感数据", "Public in the published version; do not enter sensitive data")}>{rows.length} / {DASHBOARD_SAMPLE_LIMITS.rows}</span></header>
    {!dataOnly && <label><span>{tr(locale, "数值字段", "Value field")}</span><select aria-label={tr(locale, "示例数值字段", "Sample value field")} disabled={disabled} value={widget.analysis?.measureField ?? widget.field ?? ""} onChange={event => onChange({ field: event.target.value, analysis: { ...widget.analysis, aggregation: widget.analysis?.aggregation ?? "none", measureField: event.target.value } })}>
      <option value="">{tr(locale, "未指定", "Unassigned")}</option>{fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
    </select></label>}
    {!dataOnly && !['value', 'digital-flip', 'progress', 'status', 'gauge', 'liquid-fill'].includes(widget.type) && <label><span>{tr(locale, "维度字段", "Dimension field")}</span><select aria-label={tr(locale, "示例维度字段", "Sample dimension field")} disabled={disabled} value={widget.analysis?.dimensionField ?? ""} onChange={event => onChange({ analysis: { ...widget.analysis, aggregation: widget.analysis?.aggregation ?? "none", dimensionField: event.target.value } })}>
      <option value="">{tr(locale, "未指定", "Unassigned")}</option>{fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
    </select></label>}
    <div className="dashboard-sample-scroll" tabIndex={0} aria-label={tr(locale, "示例数据表格", "Sample data table")}>
      <table style={{ width: columns.length * 104 + 40 }}><thead><tr>{columns.map(field => <th key={field.key} title={field.key}>{field.label}</th>)}<th aria-label={tr(locale, "操作", "Actions")} /></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{columns.map(field => <td key={field.key}><input
          aria-label={`${index + 1} · ${field.label}`} title={String(row[field.key] ?? "")}
          disabled={disabled} maxLength={DASHBOARD_SAMPLE_LIMITS.text} inputMode={field.type === "number" ? "decimal" : "text"}
          value={row[field.key] === null || row[field.key] === undefined ? "" : String(row[field.key])}
          onChange={event => {
            const text = event.target.value;
            const cell = text === "" ? null : typeof row[field.key] === "boolean" && /^(true|false)$/.test(text) ? text === "true" : text;
            updateRows(rows.map((item, rowIndex) => rowIndex === index ? { ...item, [field.key]: cell } : item));
          }}
        /></td>)}<td><button type="button" disabled={disabled} aria-label={tr(locale, `删除第 ${index + 1} 行`, `Delete row ${index + 1}`)} onClick={() => updateRows(rows.filter((_, rowIndex) => rowIndex !== index))}>×</button></td></tr>)}</tbody>
      </table>
      {!rows.length && <p>{tr(locale, "暂无示例数据", "No sample data")}</p>}
    </div>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" disabled={disabled || rows.length >= DASHBOARD_SAMPLE_LIMITS.rows} title={rows.length >= DASHBOARD_SAMPLE_LIMITS.rows ? tr(locale, "最多 100 行", "Up to 100 rows") : undefined} onClick={() => updateRows([...rows, Object.fromEntries(columns.map(field => [field.key, null]))])}>{tr(locale, "添加行", "Add row")}</button>
      <button type="button" disabled={disabled || !dirty} onClick={() => { setDraft(serialized); setError(""); }}>{tr(locale, "取消", "Cancel")}</button>
      <button type="button" className="primary" disabled={disabled || !dirty} onClick={apply}>{tr(locale, "应用", "Apply")}</button>
    </footer>
    {applied && !dirty && <span role="status">{tr(locale, "已应用", "Applied")}</span>}
  </section>;
}
