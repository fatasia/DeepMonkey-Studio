import { expect, it } from "vitest";
import { dashboardTextRasterScale, scaleRasterButtonGroup, scaleRasterTextStyle } from "./dashboardRasterDensity";
import { fixture, content } from "./dashboardDataRaster.testUtils";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";

it("accepts only the bounded text compilation densities", () => {
  expect(dashboardTextRasterScale(undefined)).toBe(1);
  expect(dashboardTextRasterScale(2)).toBe(2);
  for (const scale of [0, -1, 1.25, 3, Infinity, NaN]) expect(() => dashboardTextRasterScale(scale)).toThrow();
});

it("rerasterizes at double density while preserving logical quads and clip coordinates", async () => {
  const f = fixture();
  f.textBoxes[0] = { ...f.textBoxes[0]!, rect: [17.25, 17.5, 20.25, 10.25], clip: [17.5, 17.5, 19.5, 9.75] };
  const baseline = await compileDashboardRasterContent(f.input, f.host);
  const dense = await compileDashboardRasterContent({ ...f.input, textRasterScale: 2 }, f.host);
  expect(content(dense).quads.map((quad: any) => quad.destination)).toEqual(content(baseline).quads.map((quad: any) => quad.destination));
  expect(content(dense).quads[0].source).toEqual([0, 0, 42, 22]);
  expect(f.rasterizeText.mock.calls[3]![0]).toMatchObject({ width: 42, height: 22, fontSize: 20, lineHeight: 20 });
  const dashboard = (result: typeof dense) => result.package.payloads[result.package.entrypoints.dashboard] as any;
  expect(dashboard(dense).pages[0].nodes.map((node: any) => node.clip)).toEqual(dashboard(baseline).pages[0].nodes.map((node: any) => node.clip));
  expect(dense.producerEvidence.every(item => item.textRasterScale === 2)).toBe(true);
  expect(dense.producerEvidence[0]!.requestHash).not.toBe(baseline.producerEvidence[0]!.requestHash);
  expect(dense.sourceSemanticHash).not.toBe(baseline.sourceSemanticHash);
});

it("enforces physical raster extent before asking the producer to allocate", async () => {
  const f = fixture(); f.textBoxes[0] = { ...f.textBoxes[0]!, rect: [0, 0, 5000, 10] };
  await expect(compileDashboardRasterContent({ ...f.input, textRasterScale: 2 }, f.host)).rejects.toThrow(/extent/);
  expect(f.rasterizeText).not.toHaveBeenCalled();
});

it("uses the same logical frame for standalone text while rerasterizing the source font", async () => {
  const f = fixture(), node = f.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  node.widget = { type: "text", title: "标题", content: "中文标题", key: "heading", unit: "" };
  const input = { ...f.input, nodeAssets: { kpi: { fonts: ["font"], textStyle: f.textBoxes[0]!.style } } };
  const one = await compileDashboardRasterContent(input, f.host);
  const two = await compileDashboardRasterContent({ ...input, textRasterScale: 2 }, f.host);
  expect(content(two).quads[0].destination).toEqual(content(one).quads[0].destination);
  expect(content(two).quads[0].source.slice(2)).toEqual(content(one).quads[0].source.slice(2).map((value: number) => value * 2));
  expect(f.rasterizeText.mock.calls[1]![0].fontSize).toBe(20);
});
it("rerasterizes font metrics and rounded button geometry without changing colors or opacity", () => {
  const style = { fontSize: 14, lineHeight: 21, fontWeight: 400, fontStyle: "normal" as const,
    align: "left" as const, color: [255, 255, 255, 255] as const };
  expect(scaleRasterTextStyle(style, 2)).toEqual({ ...style, fontSize: 28, lineHeight: 42 });
  const group = { rect: [1.5, 2.5, 20, 10] as const, radius: 3, borderWidth: 1, opacity: 0.5,
    background: [0, 0, 0, 255] as const, border: [255, 255, 255, 255] as const };
  expect(scaleRasterButtonGroup(group, 2)).toEqual({ ...group, rect: [3, 5, 40, 20], radius: 6, borderWidth: 2 });
  expect(group.radius).toBe(3);
});
