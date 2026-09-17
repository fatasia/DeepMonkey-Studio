import { expect, it } from "vitest";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import { fixture, content } from "./dashboardDataRaster.testUtils";
function nodes(result: Awaited<ReturnType<typeof compileDashboardRasterContent>>) {
  const authored = new Set(result.nodeBindings.flatMap(binding => binding.runtimeNodeIds));
  return ((result.package.payloads[result.package.entrypoints.dashboard] as any).pages[0].nodes as any[])
    .filter(node => authored.has(node.id));
}
it("clips fractional measured boxes without squeezing rasterized glyph pixels", async () => {
  const value = fixture();
  value.textBoxes[0] = { ...value.textBoxes[0]!, rect: [17.2, 17.3, 20.2, 10.2], clip: [18, 17, 100, 20] };
  const result = await compileDashboardRasterContent(value.input, value.host);
  expect(value.rasterizeText.mock.calls[0]![0]).toMatchObject({ width: 21, height: 11, fontSize: 10 });
  expect(content(result).quads[0]).toMatchObject({ source: [0, 0, 21, 11], destination: [17.2, 17.3, 21, 11] });
  const clip = nodes(result)[1].clip;
  expect(clip[0]).toBe(18); expect(clip[1]).toBe(17.3);
  expect(clip[2]).toBeCloseTo(19.4); expect(clip[3]).toBeCloseTo(10.2);
});
it("keeps integer viewports batched but splits intervening fractional clips in order", async () => {
  const value = fixture();
  value.textBoxes[1] = { ...value.textBoxes[1]!, rect: [37, 17, 20.2, 10.2] };
  const result = await compileDashboardRasterContent(value.input, value.host);
  expect(nodes(result).map(node => node.clip)).toEqual([null, null, [37, 17, 20.2, 10.2], null]);
  expect(nodes(result).map(node => node.zOrder)).toEqual([1, 2, 3, 4]);
});
it("retains the composition node budget when fractional boxes create more layers", async () => {
  const value = fixture(), original = value.input.document.application.pages[0]!.nodes[0]!;
  value.textBoxes[1] = { ...value.textBoxes[1]!, rect: [37, 17, 20.2, 10.2] };
  const authored = Array.from({ length: 33 }, (_, index) => ({ ...structuredClone(original), id: `kpi-${index}` }));
  value.input.document.application.pages[0]!.nodes = authored;
  await expect(compileDashboardRasterContent({ ...value.input,
    data: Object.fromEntries(authored.map(node => [node.id, value.data])) }, value.host)).rejects.toThrow(/node budget|bounded array/i);
});
it("rejects frozen sticky tables before drawing an incorrect background/text order", async () => {
  const value = fixture(), node = value.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  node.widget.type = "table"; node.widget.report = { mode: "detail", freezeFirstColumn: true };
  const result = await compileDashboardRasterContent(value.input, value.host);
  expect(result.capabilityReport.objects[0]?.contentCompiled).toBe(false);
  expect(result.capabilityReport.objects[0]?.reasons.join()).toContain("Sticky table");
  expect(value.rasterizeText).not.toHaveBeenCalled();
});
it("also keeps standalone text pixels at 1:1 without clipping its container chrome", async () => {
  const value = fixture(), node = value.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  node.widget.type = "text"; node.widget.content = "text";
  node.frame.width = 54.2; node.frame.height = 44.2;
  const result = await compileDashboardRasterContent({ ...value.input,
    nodeAssets: { kpi: { fonts: ["font"], textStyle: value.textBoxes[0]!.style } } }, value.host);
  expect(nodes(result)).toHaveLength(2);
  expect(nodes(result)[0].clip).toBeNull();
  expect(nodes(result)[1].clip[2]).toBeCloseTo(20.2);
  expect(content(result).quads[0]).toMatchObject({ source: [0, 0, 21, 11], destination: [17, 17, 21, 11] });
});
