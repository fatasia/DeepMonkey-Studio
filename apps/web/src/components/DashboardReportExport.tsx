import { useEffect, useRef, useState } from "react";
import { dashboardReportCsv, type DashboardReportResult } from "./dashboardAnalytics";
import { translate as tr, type AppLocale } from "../i18n";

export function DashboardReportExport({ report, title, locale }: { report: DashboardReportResult; title: string; locale: AppLocale }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState(false);
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function download(format: "csv" | "xlsx") {
    if (running.current) return;
    running.current = true; setBusy(true); setMessage(""); setError(false);
    try {
      const snapshot = structuredClone(report);
      const blob = format === "csv" ? new Blob([dashboardReportCsv(snapshot)], { type: "text/csv;charset=utf-8" })
        : new Blob([new Uint8Array(await (await import("./dashboardReportXlsx")).dashboardReportXlsx(snapshot, title))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${(title || "report").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100)}.${format}`;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 2000); }
      setMessage(tr(locale, "已导出", "Exported"));
    } catch (reason) {
      if (mounted.current) { setError(true); setMessage(reason instanceof Error ? reason.message : tr(locale, "导出失败，请重试", "Export failed. Retry.")); }
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  return <span onClick={event => event.stopPropagation()}>
    <button type="button" data-capture-role="tool" data-capture-tool="csv" disabled={busy} title={tr(locale, "导出 CSV", "Export CSV")} onClick={() => void download("csv")}>CSV</button>
    <button type="button" data-capture-role="tool" data-capture-tool="excel" disabled={busy} title={tr(locale, "导出 Excel", "Export Excel")} onClick={() => void download("xlsx")}>{busy ? "…" : "Excel"}</button>
    {message && <span role={error ? "alert" : "status"} style={{ color: error ? "var(--danger)" : "var(--text-muted)", overflowWrap: "anywhere" }}>{message}</span>}
  </span>;
}
