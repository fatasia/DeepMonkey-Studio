import type { DashboardPageDocument, JsonValue } from "@bim-studio/contracts";
import { buildDashboardReport, dashboardReportCsv } from "./dashboardAnalytics";

export interface DashboardPageExportMetric {
  value: unknown;
  samples: Array<{ value: number; time: number }>;
  rows?: Array<Record<string, unknown>>;
}

export interface DashboardPageExportEntry {
  fileName: string;
  csv: string;
}

export function buildDashboardPageExportEntries(page: DashboardPageDocument, metrics: Readonly<Record<string, DashboardPageExportMetric>>): DashboardPageExportEntry[] {
  const used = new Map<string, number>();
  return page.nodes.flatMap((node) => {
    if (node.kind !== "data-widget" || !["table", "scroll-table"].includes(node.widget.type)) return [];
    const report = buildDashboardReport(node.widget, metrics[node.widget.key]);
    const base = safeExportName(node.name || node.widget.title || "report");
    const sequence = (used.get(base) ?? 0) + 1;
    used.set(base, sequence);
    return [{ fileName: `${base}${sequence > 1 ? `-${sequence}` : ""}.csv`, csv: dashboardReportCsv(report) }];
  });
}

export async function downloadDashboardPageData(page: DashboardPageDocument, metrics: Readonly<Record<string, DashboardPageExportMetric>>, filters: Readonly<Record<string, JsonValue>>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const entries = buildDashboardPageExportEntries(page, metrics);
  const filterSnapshot = JSON.stringify(filters, null, 2);
  if (!entries.length) throw new Error("当前页面没有可导出的表格组件");
  const { default: JSZip } = await import("jszip");
  signal?.throwIfAborted();
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.fileName, entry.csv);
  zip.file("筛选条件.json", filterSnapshot);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeExportName(page.name || "dashboard")}-数据.zip`;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

function safeExportName(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\.+$/g, "").slice(0, 80);
  return safe || "report";
}
