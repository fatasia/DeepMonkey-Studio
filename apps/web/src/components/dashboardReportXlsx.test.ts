import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { dashboardReportXlsx } from "./dashboardReportXlsx";

describe("Excel report snapshot export", () => {
  it("writes actual OOXML with typed numbers, booleans, blanks and inert formula text", async () => {
    const zip = await JSZip.loadAsync(await dashboardReportXlsx({ columns: ["产线", "产量", "启用", "缺失"], rows: [{ 产线: '=HYPERLINK("x")<&', 产量: -2.5, 启用: false, 缺失: null }] }, "生产/报表"));
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain('r="B2" t="n"><v>-2.5'); expect(sheet).toContain('r="C2" t="b"><v>0');
    expect(sheet).toContain('r="D2"/>'); expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('=HYPERLINK(&quot;x&quot;)&lt;&amp;'); expect(sheet).not.toContain("<f>");
    expect(await zip.file("xl/workbook.xml")!.async("string")).toContain('name="生产 报表"');
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
  });
  it("preserves order and totals and supports columns beyond Z", async () => {
    const columns = Array.from({ length: 28 }, (_, i) => `c${i}`);
    const zip = await JSZip.loadAsync(await dashboardReportXlsx({ columns, rows: [{ c27: 8 }, { c27: 3 }], grandTotal: { c27: 11 } }, "报告"));
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain('r="AB2" t="n"><v>8'); expect(sheet).toContain('r="AB3" t="n"><v>3');
    expect(sheet).toContain('r="AB4" t="n"><v>11'); expect(sheet).toContain('autoFilter ref="A1:AB3"');
  });
  it("exports an empty report and rejects oversized data instead of silently truncating", async () => {
    expect(await dashboardReportXlsx({ columns: [], rows: [] }, "")).toBeInstanceOf(Uint8Array);
    await expect(dashboardReportXlsx({ columns: ["a"], rows: [{ a: "x".repeat(32768) }] }, "x")).rejects.toThrow(/Excel/);
    await expect(dashboardReportXlsx({ columns: Array.from({ length: 16385 }, () => "a"), rows: [] }, "x")).rejects.toThrow(/过大/);
  });
});
