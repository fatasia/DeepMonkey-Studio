import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { DataDatasetRecord } from "@bim-studio/contracts";
import { dashboardWritebackDataset, DashboardDatasetWriteback } from "./DashboardDatasetWriteback";

const dataset: DataDatasetRecord = { id: "ds", projectId: "p", connectionId: "c", name: "产量", fields: [], refreshSeconds: 0, createdAt: "now", updatedAt: "now", writeback: { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number" }] } };
describe("2D author record-entry binding", () => {
  it("does not inherit modal blur or shrink the nonmodal dock to its content", async () => {
    const css = await readFile(new URL("./DashboardDatasetWriteback.css", import.meta.url), "utf8");
    expect(css).toContain("backdrop-filter: none"); expect(css).toContain("place-items: normal");
    expect(css).toContain("width: 100%; box-sizing: border-box");
    expect(css).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
  });
  it("resolves only configured datasets in the current project", () => {
    expect(dashboardWritebackDataset("p", { datasetId: "ds" }, [dataset])).toBe(dataset);
    expect(dashboardWritebackDataset("other", { datasetId: "ds" }, [dataset])).toBeUndefined();
    expect(dashboardWritebackDataset("p", { datasetId: "missing" }, [dataset])).toBeUndefined();
    const { writeback: _writeback, ...readonly } = dataset;
    expect(dashboardWritebackDataset("p", { datasetId: "ds" }, [readonly])).toBeUndefined();
  });
  it("does not write through stale dataset IDs behind pipeline, direct or sample bindings", () => {
    expect(dashboardWritebackDataset("p", { datasetId: "ds", pipelineId: "pipe" }, [dataset])).toBeUndefined();
    expect(dashboardWritebackDataset("p", { datasetId: "ds", directBinding: {} as never }, [dataset])).toBeUndefined();
    expect(dashboardWritebackDataset("p", { datasetId: "ds", sampleData: {} as never }, [dataset])).toBeUndefined();
  });
  it("requires explicit user identity and opens no form or request by default", () => {
    const props = { locale: "zh-CN" as const, projectId: "p", widget: { datasetId: "ds" }, datasets: [dataset], userId: "u", canWrite: true };
    expect(renderToStaticMarkup(<DashboardDatasetWriteback {...props} userId="" />)).toBe("");
    const html = renderToStaticMarkup(<DashboardDatasetWriteback {...props} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("填报"); expect(html).not.toContain('role="dialog"');
    expect(renderToStaticMarkup(<DashboardDatasetWriteback {...props} canWrite={false} />)).toContain("当前账号只读");
  });
});
