import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { measureFrozenDashboardCharts } from "./dashboardChartLayout.mjs";
import { dashboardCanonicalJsonSha256 } from "../../apps/api/src/dashboardPublicationFreeze.ts";
import { dashboardDataRequestId } from "../../apps/api/src/dashboardDataRequestId.ts";

function fixture() {
  const node = { id: "chart", kind: "data-widget", frame: { width: 320, height: 200 }, widget: { type: "bar", title: "Output" } };
  const data = { source: { id: "sample" }, metric: { samples: [] } }, bytes = Uint8Array.of(1, 2);
  const document = { application: { pages: [{ nodes: [node] }] } };
  const source = { document, data: { [dashboardDataRequestId(node.id)]: data }, resources: { first: bytes, second: bytes },
    freezeManifest: { authority: {}, documentSha256: "a".repeat(64), manifestSha256: "b".repeat(64),
      data: [{ id: dashboardDataRequestId(node.id), sha256: dashboardCanonicalJsonSha256(data) }],
      resources: ["first", "second"].map(id => ({ id, kind: "font", nodeIds: [node.id], faceIndex: 0,
        sha256: createHash("sha256").update(bytes).digest("hex") })) } };
  const input = { document, locale: "en-US", nodeAssets: { chart: { fonts: ["second", "first"] } }, data: { chart: structuredClone(data) } };
  const layout = { textBoxes: [], backgrounds: [] };
  const capture = vi.fn(async () => ({ protocol: "dashboard-measured-layout-v1", layout }));
  return { node, source, input, capture, host: { id: "test-layout", version: "1", capture } };
}
it("uses configured frozen font order and does not mutate the freeze data", async () => {
  const value = fixture(), before = structuredClone(value.source);
  await measureFrozenDashboardCharts(value.source, value.input, value.host);
  expect(value.capture.mock.calls[0][0].fonts.map(font => font.id)).toEqual(["second", "first"]);
  expect(value.input.data.chart.layout).toEqual({ textBoxes: [], backgrounds: [] });
  expect(value.source).toEqual(before);
});
it.each(["value", "table"])("connects measured %s content instead of leaving a chrome-only package", async type => {
  const value = fixture(); value.node.widget.type = type;
  value.capture.mockResolvedValue({ protocol: "dashboard-measured-layout-v1", layout: { textBoxes: [], backgrounds: [] },
    ...(type === "table" ? { table: { page: 0, scrollLeft: 0 } } : {}) });
  await measureFrozenDashboardCharts(value.source, value.input, value.host);
  expect(value.capture).toHaveBeenCalledOnce();
  expect(value.input.data.chart.layout).toEqual({ textBoxes: [], backgrounds: [] });
  if (type === "table") expect(value.input.data.chart.table).toEqual({ page: 0, scrollLeft: 0 });
});
it("does not install a table state onto a value widget", async () => {
  const value = fixture(); value.node.widget.type = "value";
  value.capture.mockResolvedValue({ protocol: "dashboard-measured-layout-v1", layout: { textBoxes: [], backgrounds: [] },
    table: { page: 0, scrollLeft: 0 } });
  await expect(measureFrozenDashboardCharts(value.source, value.input, value.host)).rejects.toThrow("Only table widgets");
  expect(value.input.data.chart).not.toHaveProperty("layout");
});
it("rejects a late aborted capture without installing its layout", async () => {
  const value = fixture(), controller = new AbortController();
  value.capture.mockImplementation(async () => { controller.abort(); return { protocol: "dashboard-measured-layout-v1", layout: { textBoxes: [], backgrounds: [] } }; });
  await expect(measureFrozenDashboardCharts(value.source, value.input, value.host, controller.signal)).rejects.toThrow();
  expect(value.input.data.chart).not.toHaveProperty("layout");
});
it("propagates capture failure and skips hidden or unbound nodes", async () => {
  const value = fixture(); value.capture.mockRejectedValue(new Error("font missing"));
  await expect(measureFrozenDashboardCharts(value.source, value.input, value.host)).rejects.toThrow("font missing");
  expect(value.input.data.chart).not.toHaveProperty("layout");
  value.capture.mockClear(); value.node.visible = false;
  await measureFrozenDashboardCharts(value.source, value.input, value.host);
  value.node.visible = true; value.input.nodeAssets = {};
  await measureFrozenDashboardCharts(value.source, value.input, value.host);
  expect(value.capture).not.toHaveBeenCalled();
});
