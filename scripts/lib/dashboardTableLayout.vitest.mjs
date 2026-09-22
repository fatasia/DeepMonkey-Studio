import { expect, it, vi } from "vitest";
import { measureDashboardTableViews } from "./dashboardTableLayout.mjs";
import { dashboardCanonicalJsonSha256 as hash } from "../../apps/api/src/dashboardPublicationFreeze.ts";
import { dashboardDataRequestId } from "../../apps/api/src/dashboardDataRequestId.ts";
import { runtimeContentSha256 } from "../../packages/deep-engine/src/runtimePackage/index.ts";

function fixture() {
  const node = { id: "table", kind: "data-widget", frame: { width: 600, height: 400 }, widget: {
    type: "table", key: "units", title: "Output", report: { mode: "detail", pageSize: 1 } } };
  const metric = { samples: [], rows: [{ value: 2 }, { value: 3 }] };
  const data = { source: { kind: "sample", id: "sample", revision: 1, contentSha256: runtimeContentSha256(metric) }, metric };
  const document = { application: { pages: [{ nodes: [node] }] } }, id = dashboardDataRequestId(node.id);
  const source = { document, data: { [id]: data }, resources: { font: Uint8Array.of(1, 2) },
    freezeManifest: { authority: {}, documentSha256: hash(document), manifestSha256: "b".repeat(64),
      data: [{ id, sha256: hash(data) }], resources: [{ id: "font", kind: "font", nodeIds: [node.id], faceIndex: 0, sha256: "a".repeat(64) }] } };
  const input = { document, locale: "zh-CN", nodeAssets: { table: { fonts: ["font"] } }, data: { table: data } };
  const capture = vi.fn(async request => ({ protocol: "dashboard-measured-layout-v1", table: request.table,
    layout: { textBoxes: [], backgrounds: [] } }));
  return { source, input, capture, host: { id: "test-layout", version: "1", capture } };
}
it("measures Web sort/page states without changing the frozen source", async () => {
  const value = fixture(), before = structuredClone(value.source);
  const result = await measureDashboardTableViews(value.source, value.input, value.host);
  expect(result[0].families[0]).toHaveLength(3);
  expect(value.capture).toHaveBeenCalledTimes(6);
  expect(value.capture.mock.calls.map(([request]) => request.table.page)).toEqual([0,1,0,1,0,1]);
  expect(value.capture.mock.calls[2][0].table.sort).toEqual({ column: "value", direction: "asc" });
  expect(value.source).toEqual(before);
});
it("rejects a host returning a different page and cancels without partial plans", async () => {
  const value = fixture();
  value.host.capture = async () => ({ protocol: "dashboard-measured-layout-v1", table: { page: 99, scrollLeft: 0 }, layout: { textBoxes: [], backgrounds: [] } });
  await expect(measureDashboardTableViews(value.source, value.input, value.host)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(measureDashboardTableViews(value.source, value.input, value.host, controller.signal)).rejects.toThrow();
});
