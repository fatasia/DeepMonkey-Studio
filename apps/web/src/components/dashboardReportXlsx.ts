import JSZip from "jszip";
import type { DashboardReportResult } from "./dashboardAnalytics";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

/** 只导出已查询的报表快照，不再请求数据，也不把文本解释为公式。 */
export async function dashboardReportXlsx(report: DashboardReportResult, title: string): Promise<Uint8Array> {
  const rows = [Object.fromEntries(report.columns.map(column => [column, column])), ...report.rows,
    ...(report.grandTotal ? [report.grandTotal] : [])];
  if (report.columns.length > 16384 || rows.length > 1048576 || report.columns.length * rows.length > 200000) throw new Error("报表过大，请先筛选数据 / Filter the report before exporting");
  let textSize = 0;
  const data = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${report.columns.map((column, index) => {
    const value = row[column]; const ref = `${columnName(index)}${rowIndex + 1}`;
    if (value === null || value === undefined) return `<c r="${ref}"/>`;
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}" t="n"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    textSize += text.length;
    if (text.length > 32767 || textSize > 8_000_000) throw new Error("文本超过 Excel 导出限制 / Text exceeds Excel export limits");
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  const name = title.replace(/[\\/?*\[\]:]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Report";
  zip.file("xl/workbook.xml", `${XML}<workbook ${SHEET_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `${XML}<worksheet ${SHEET_NS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${data}</sheetData>${report.columns.length ? `<autoFilter ref="A1:${columnName(report.columns.length - 1)}${report.rows.length + 1}"/>` : ""}</worksheet>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

function escapeXml(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
