import { expect, it, vi } from "vitest";
import { measureDashboardFilterVariants } from "./dashboardFilterLayout.mjs";
import { dashboardCanonicalJsonSha256 as hash } from "../../apps/api/src/dashboardPublicationFreeze.ts";
import { dashboardDataRequestId } from "../../apps/api/src/dashboardDataRequestId.ts";
import { runtimeContentSha256 } from "../../packages/deep-engine/src/runtimePackage/index.ts";

function fixture() {
  const node = { id: "value", kind: "data-widget", frame: { width: 320, height: 200 },
    widget: { type: "value", key: "value", title: "Output", field: "value", analysis: { aggregation: "sum", measureField: "value" } } };
  const filter = { id: "filter", kind: "data-widget", widget: { type: "filter", key: "region", options: ["全部", "东"] } };
  const metric = { samples: [], rows: [{ region: "东", value: 2 }, { region: "西", value: 3 }] };
  const data = { source: { kind: "sample", id: "sample", revision: 1, contentSha256: runtimeContentSha256(metric) }, metric };
  const document = { application: { pages: [{ nodes: [node, filter] }] } }, id = dashboardDataRequestId(node.id);
  const source = { document, data: { [id]: data }, resources: { font: Uint8Array.of(1, 2) },
    freezeManifest: { authority: {}, documentSha256: hash(document), manifestSha256: "b".repeat(64),
      data: [{ id, sha256: hash(data) }], resources: [{ id: "font", kind: "font", nodeIds: [node.id], faceIndex: 0, sha256: "a".repeat(64) }] } };
  const input = { document, locale: "zh-CN", nodeAssets: { value: { fonts: ["font"] } }, data: { value: data } };
  const capture = vi.fn(async () => ({ protocol: "dashboard-measured-layout-v1", layout: { textBoxes: [], backgrounds: [] } }));
  return { source, input, capture, host: { id: "test-layout", version: "1", capture } };
}
it("measures each derived metric and preserves original freeze data and identity", async () => {
  const value = fixture(), before = structuredClone(value.source);
  await measureDashboardFilterVariants(value.source, value.input, value.host);
  expect(value.capture.mock.calls.map(([request]) => request.data.metric.value)).toEqual([5, 2]);
  expect(value.input.filterData.map(option => option.data.value.layout)).toEqual([
    { textBoxes: [], backgrounds: [] }, { textBoxes: [], backgrounds: [] }]);
  expect(value.source).toEqual(before);
});
it("requires a layout host and cancels without publishing partial variants", async () => {
  const value = fixture();
  await expect(measureDashboardFilterVariants(value.source, value.input)).rejects.toThrow(/trusted layout/);
  const controller = new AbortController();
  value.host.capture = async () => { controller.abort(); return { protocol: "dashboard-measured-layout-v1", layout: { textBoxes: [], backgrounds: [] } }; };
  await expect(measureDashboardFilterVariants(value.source, value.input, value.host, controller.signal)).rejects.toThrow();
  expect(value.input.filterData).toBeUndefined();
});
