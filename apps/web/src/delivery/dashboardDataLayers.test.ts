import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { expect, it } from "vitest";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import { fixture } from "./dashboardDataRaster.testUtils";
function nodes(result: Awaited<ReturnType<typeof compileDashboardRasterContent>>) {
  return (result.package.payloads[result.package.entrypoints.dashboard] as any).pages[0].nodes as any[];
}
function authoredNodes(result: Awaited<ReturnType<typeof compileDashboardRasterContent>>) {
  const ids = new Set(result.nodeBindings.flatMap(binding => binding.runtimeNodeIds));
  return nodes(result).filter(node => ids.has(node.id));
}
it("keeps interleaved clips in separate consecutive layers", async () => {
  const value = fixture();
  // Each box ends at y=27; these clips remove the final pixel row.
  value.textBoxes.forEach((box, index) => { value.textBoxes[index] = { ...box, clip: index === 1 ? [0,0,100.5,26] : [0,0,120.2,26] }; });
  const result = await compileDashboardRasterContent(value.input, value.host);
  expect(authoredNodes(result).map(node => node.clip)).toEqual([null,[0,0,120.2,26],[0,0,100.5,26],[0,0,120.2,26]]);
  expect(result.nodeBindings[0]!.runtimeNodeIds).toHaveLength(4);
  expect(result.nodeBindings[0]!.runtimeNodeIds[0]).toBe(result.nodeBindings[0]!.runtimeNodeId);
});
it("coalesces fully-contained clips without changing atlas pixels or quad extents", async () => {
  const value = fixture(), baseline = await compileDashboardRasterContent(value.input, value.host);
  value.textBoxes.forEach((box, index) => {
    value.textBoxes[index] = { ...box, clip: index === 1 ? [0, 0, 100.5, 40] : [0, 0, 120.2, 40] };
  });
  const actual = await compileDashboardRasterContent(value.input, value.host);
  const payloads = (result: typeof actual) => Object.values(result.package.payloads)
    .filter((item: any) => item.schema === "deep-engine.deep2d-runtime") as any[];
  expect(payloads(actual).flatMap(item => item.atlases)).toEqual(payloads(baseline).flatMap(item => item.atlases));
  expect(payloads(actual).flatMap(item => item.quads)).toEqual(payloads(baseline).flatMap(item => item.quads));
  expect(authoredNodes(actual).map(node => node.clip)).toEqual([null, null]);
});
it("keeps each author group contiguous for equal and negative authored z", async () => {
  const value = fixture(), first = value.input.document.application.pages[0]!.nodes[0]!;
  first.zIndex = -7;
  const second = { ...structuredClone(first), id: "second" };
  value.input.document.application.pages[0]!.nodes.push(second);
  const input = { ...value.input, data: { kpi: value.data, second: value.data } };
  const result = await compileDashboardRasterContent(input, value.host);
  const bindings = result.nodeBindings;
  expect(bindings.map(binding => binding.runtimeNodeId)).toEqual(bindings.map(binding => binding.runtimeNodeId).sort());
  expect(authoredNodes(result).map(node => node.id)).toEqual(bindings.flatMap(binding => binding.runtimeNodeIds));
  expect(authoredNodes(result).map(node => node.zOrder)).toEqual([1,2,3,4]);
});
it("retains the existing 128 total runtime node budget after layering", async () => {
  const value = fixture(), node = value.input.document.application.pages[0]!.nodes[0]!;
  const authorNodes = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(node), id: `kpi-${index}` }));
  value.input.document.application.pages[0]!.nodes = authorNodes;
  const input = { ...value.input, data: Object.fromEntries(authorNodes.map(node => [node.id, value.data])) };
  await expect(compileDashboardRasterContent(input, value.host)).rejects.toThrow(/node budget|bounded array/i);
});

it("connects a frozen chart metric to the C1 chart envelope without claiming appearance parity", async () => {
  const value = fixture(), node = value.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  node.widget.type = "bar";
  const metric = { samples: [{ time: 0, value: 7 }, { time: 1, value: 9 }] };
  const data = { source: { ...value.data.source, contentSha256: runtimeContentSha256(metric) }, metric };
  const result = await compileDashboardRasterContent({ ...value.input, data: { kpi: data } }, value.host);
  const chartNodes = authoredNodes(result).filter(node => node.chart !== null);
  expect(chartNodes).toHaveLength(1);
  expect(chartNodes[0].id).toBe(result.nodeBindings[0]!.runtimeNodeId);
  expect(chartNodes[0].frame).toEqual([37, 47, 126, 66]);
  expect(authoredNodes(result).some(node => node.deep2d && node.chart === null)).toBe(true);
  const chartId = chartNodes[0].chart;
  expect(result.package.payloads[chartId]).toMatchObject({ schema: "deep-engine.chart-runtime", schemaVersion: 1 });
  expect(result.capabilityReport.contentCompiled).toBe(1);
  expect(result.capabilityReport.objects[0]).toMatchObject({ contentCompiled: true, status: "degraded" });
  expect(result.capabilityReport.objects[0]!.reasons.join()).not.toContain("Dashboard 组合尚未接线");
  expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("appearance and interactions remain deferred");
  expect(result.capabilityReport.objects[0]!.deferredFields).toContain("widget.title");
  expect(result.capabilityReport.objects[0]!.reasons.join()).toMatch(/ChartIR|图表/);
  expect(value.rasterizeText).not.toHaveBeenCalled();
});
