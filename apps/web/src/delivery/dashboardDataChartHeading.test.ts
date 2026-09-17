import { expect, it } from "vitest";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import { fixture } from "./dashboardDataRaster.testUtils";

function chartFixture() {
  const value = fixture();
  const node = value.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("Expected data widget");
  node.widget.type = "bar"; node.widget.fontSize = 16;
  value.textBoxes.splice(1, 1);
  return { ...value, node };
}
it("reuses the data producer for chart title and unit without claiming full appearance", async () => {
  const { input, host, rasterizeText } = chartFixture();
  const result = await compileDashboardRasterContent(input, host);
  expect(rasterizeText.mock.calls.map(([request]) => request.text)).toEqual(["利用率", "%"]);
  expect(result.producerEvidence).toHaveLength(2);
  expect(result.capabilityReport.objects[0]!.compiledFields).toContain("widget.title");
  expect(result.capabilityReport.objects[0]!.deferredFields).toContain("widget.fontSize");
  expect(result.capabilityReport.objects[0]!.status).toBe("degraded");
});
it("leaves missing or incomplete title layout deferred without fabricating pixels", async () => {
  for (const missing of [true, false]) {
    const { input, data, textBoxes, host, rasterizeText } = chartFixture();
    if (!missing) textBoxes.pop();
    const result = await compileDashboardRasterContent(missing
      ? { ...input, data: { kpi: { source: data.source, metric: data.metric } } } : input, host);
    expect(result.capabilityReport.objects[0]!.deferredFields).toContain("widget.title");
    expect(rasterizeText).not.toHaveBeenCalled();
  }
});
it("does not invent a heading when the author does not render one", async () => {
  const { input, node, textBoxes, host, rasterizeText } = chartFixture();
  delete node.widget.fontSize; textBoxes.splice(0);
  const result = await compileDashboardRasterContent(input, host);
  expect(rasterizeText).not.toHaveBeenCalled();
  expect(result.capabilityReport.objects[0]!.compiledFields).toContain("widget.title");
});
it("keeps hidden charts and unsupported heading roles out of the producer", async () => {
  const value = chartFixture(); value.node.visible = false;
  await compileDashboardRasterContent(value.input, value.host);
  expect(value.rasterizeText).not.toHaveBeenCalled();
  const invalid = chartFixture(); invalid.textBoxes[0] = { ...invalid.textBoxes[0]!, role: { kind: "value" } };
  const result = await compileDashboardRasterContent(invalid.input, invalid.host);
  expect(invalid.rasterizeText).not.toHaveBeenCalled();
  expect(result.capabilityReport.objects[0]!.deferredFields).toContain("widget.title");
});
