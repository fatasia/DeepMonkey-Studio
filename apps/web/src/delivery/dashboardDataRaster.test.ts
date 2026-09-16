import { expect, it } from "vitest";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import { fixture, content } from "./dashboardDataRaster.testUtils";
it("compiles actual formatted KPI parts into measured local boxes", async () => {
  const { input, host, rasterizeText } = fixture();
  const result = await compileDashboardRasterContent(input, host);
  expect(rasterizeText.mock.calls.map(([request]) => request.text)).toEqual(["利用率", "81.7", "%"]);
  expect(content(result).quads.map((quad: any) => quad.destination)).toEqual([[17,17,20,10],[37,17,20,10],[57,17,20,10]]);
  expect(result.capabilityReport.contentCompiled).toBe(1);
  expect(result.publicationReady).toBe(false);
});
it("requires every nonempty semantic role and rejects duplicate roles before raster work", async () => {
  for (const duplicate of [false, true]) {
    const { input, host, rasterizeText, textBoxes } = fixture();
    if (duplicate) textBoxes[2] = textBoxes[1]!; else textBoxes.pop();
    const result = await compileDashboardRasterContent(input, host);
    expect(result.capabilityReport.contentCompiled).toBe(0); expect(content(result).quads).toHaveLength(0);
    expect(rasterizeText).not.toHaveBeenCalled();
  }
});
it("preserves fractional clipping through C1 node layers without rounding", async () => {
  const first = fixture(); first.textBoxes[0] = { ...first.textBoxes[0]!, clip: [17.5,17.2,10.1,9.8] };
  const result = await compileDashboardRasterContent(first.input, first.host);
  const dashboard = result.package.payloads[result.package.entrypoints.dashboard] as any;
  expect(dashboard.pages[0].nodes[1].clip).toEqual([17.5,17.2,10.1,9.8]);
  expect(content(result).quads[0]).toMatchObject({ source: [0,0,20,10], destination: [17,17,20,10] });
  expect(result.capabilityReport.contentCompiled).toBe(1);
});
it("does not publish partially prepared data pixels after producer failure", async () => {
  const { input, host, rasterizeText } = fixture();
  const original = host.rasterizeText; let count = 0;
  host.rasterizeText = request => ++count === 2 ? Promise.reject(new Error("producer failed")) : original(request);
  await expect(compileDashboardRasterContent(input, host)).rejects.toThrow("producer failed");
  expect(rasterizeText).toHaveBeenCalledTimes(1);
});
it("binds data and measured layout to compilation evidence", async () => {
  const first = fixture(), original = await compileDashboardRasterContent(first.input, first.host);
  const second = fixture(); second.textBoxes[0] = { ...second.textBoxes[0]!, rect: [18,17,20,10] };
  const revised = await compileDashboardRasterContent(second.input, second.host);
  expect(revised.sourceSemanticHash).not.toBe(original.sourceSemanticHash);
  expect(revised.targetArtifactHash).not.toBe(original.targetArtifactHash);
});
