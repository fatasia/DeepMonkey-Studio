import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { DashboardDataWidgetConfig, DataDatasetRecord } from "@bim-studio/contracts";
import { DashboardRecordForm, DashboardRecordFormContext } from "./DashboardRecordForm";
import { publicWidgetRestriction } from "../behavior/publicPlaybackPolicy";
import { writebackDraftKey } from "./datasetWritebackDraftCache";
import { api } from "../api";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { canSelectDataWidgetType } from "./dashboardWorkspaceModel";

const widget: DashboardDataWidgetConfig = { title: "产量填报", key: "record.form", unit: "", type: "record-form", datasetId: "ds", recordForm: { recordId: "record1" } };
const dataset: DataDatasetRecord = { id: "ds", projectId: "p", connectionId: "c", name: "产量", fields: [], refreshSeconds: 0, createdAt: "now", updatedAt: "now", writeback: { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number" }] } };
const access = { userId: "u", canWrite: true, datasets: [dataset], onSaved: async () => "ready" as const };
const render = (value = access, runtime = true, target = widget) => renderToStaticMarkup(<DashboardRecordFormContext.Provider value={value}><DashboardRecordForm widget={target} locale="zh-CN" projectId="p" runtime={runtime} /></DashboardRecordFormContext.Provider>);
describe("authored canvas record form", () => {
  it("blocks incompatible type switches without deleting a source binding", () => {
    for (const key of ["pipelineId", "directBinding", "sampleData", "semanticBinding"] as const) {
      const bound = { ...widget, [key]: key === "pipelineId" ? "pipe" : {} } as DashboardDataWidgetConfig;
      const before = JSON.stringify(bound);
      expect(canSelectDataWidgetType("record-form", bound)).toBe(false);
      expect(canSelectDataWidgetType("value", bound)).toBe(true); expect(JSON.stringify(bound)).toBe(before);
    }
    expect(canSelectDataWidgetType("record-form", widget)).toBe(true);
  });
  it("previews actual form fields and a submit control, not generic shapes", () => {
    const html = renderToStaticMarkup(<DashboardComponentPreview type="record-form" />);
    expect(html).toContain("dashboard-library-preview record-form"); expect(html.match(/<rect /g)).toHaveLength(3); expect(html).not.toContain("lucide-shapes");
  });
  it("renders design-only content without mounting a record session", () => {
    expect(render(access, false)).toContain("record1");
    expect(render(access, false)).not.toContain("读取记录");
  });
  it("requires explicit identity and ignores forged runtime values on public pages", () => {
    const read = vi.spyOn(api, "readDatasetRecord"), write = vi.spyOn(api, "writeDatasetRecord");
    expect(render({ ...access, userId: "" })).toContain("公开页只读");
    expect(renderToStaticMarkup(<DashboardRecordForm widget={widget} locale="zh-CN" projectId="p" runtime />)).not.toContain("读取记录");
    expect(publicWidgetRestriction(widget, true)).toContain("只读");
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); vi.restoreAllMocks();
  });
  it("mounts the reused panel with a fixed record and rejects missing/cross-project targets", () => {
    expect(render()).toContain('value="record1"'); expect(render()).toContain('readOnly=""');
    expect(render({ ...access, datasets: [{ ...dataset, projectId: "other" }] })).toContain("请选择已启用填报");
    expect(render(access, true, { ...widget, recordForm: { recordId: "../record" } })).not.toContain("读取记录");
  });
  it("isolates fixed-record drafts from other records and legacy dataset forms", () => {
    const keys = [writebackDraftKey("u", "p", "ds"), writebackDraftKey("u", "p", "ds", "a"), writebackDraftKey("u", "p", "ds", "b"), writebackDraftKey("v", "p", "ds", "a")];
    expect(new Set(keys).size).toBe(4);
  });
  it("uses scoped tokens and a scrollable form instead of clipping long or conflict content", async () => {
    const css = await readFile(new URL("./DashboardRecordForm.css", import.meta.url), "utf8");
    expect(css).toContain("overflow: auto"); expect(css).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
  });
});
