import { expect, it } from "vitest";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compositeDashboardButtonGroup } from "./dashboardButtonGroup";
import { verifyDashboardButtonComposition } from "./verifyDashboardButtonComposition";
import type { DashboardButtonGroup } from "./dashboardDataRasterTypes";
import type { DashboardRasterCompileInput, DashboardRasterEvidence } from "./dashboardRasterTypes";

const group: DashboardButtonGroup = { rect: [0, 0, 4, 4], radius: 0, borderWidth: 0,
  opacity: 0.35, background: [255, 0, 0, 255], border: [0, 0, 0, 0] };
const encoded = (value: Uint8Array) => btoa(String.fromCharCode(...value));
it("applies opacity once to background plus overlapping text, preserving isolated alpha", () => {
  const result = compositeDashboardButtonGroup(group, { rect: [1, 1, 1, 1], width: 1, height: 1, rgba: new Uint8Array([0, 0, 255, 128]) });
  const index = (1 * 4 + 1) * 4;
  expect([...result.rgba.slice(index, index + 4)]).toEqual([127, 0, 128, 89]);
  expect([...result.rgba.slice(0, 4)]).toEqual([255, 0, 0, 89]);
});
it("preserves rounded corners and the solid border before group opacity", () => {
  const result = compositeDashboardButtonGroup({ ...group, rect: [0, 0, 20, 20], radius: 5, borderWidth: 2,
    border: [0, 255, 0, 255], opacity: 1 }, { rect: [9, 9, 1, 1], width: 1, height: 1, rgba: new Uint8Array([0, 0, 255, 255]) });
  expect(result.rgba[3]).toBe(0);
  expect([...result.rgba.slice(10 * 4, 10 * 4 + 4)]).toEqual([0, 255, 0, 255]);
  expect([...result.rgba.slice((10 * 20 + 10) * 4, (10 * 20 + 10) * 4 + 4)]).toEqual([255, 0, 0, 255]);
});
function fixture() {
  const rgba = new Uint8Array([0, 0, 255, 128]), textRect = [1, 1, 1, 1] as const, role = { kind: "previous" as const };
  const result = compositeDashboardButtonGroup(group, { rect: textRect, width: 1, height: 1, rgba });
  const recipe = { group, textRect, role };
  const evidence = { nodeId: "table", pixelSha256: sha256Bytes(result.rgba), producerEvidence: { pixelSha256: sha256Bytes(rgba) },
    composition: { id: "dashboard-button-group-v1", sourceWidth: 1, sourceHeight: 1, sourceRgbaBase64: encoded(rgba),
      sourcePixelSha256: sha256Bytes(rgba), outputPixelSha256: sha256Bytes(result.rgba), recipe, recipeSha256: runtimeContentSha256(recipe) } } as DashboardRasterEvidence;
  const input = { data: { table: { layout: { textBoxes: [{ role, rect: textRect, buttonGroup: group }] } } } } as unknown as DashboardRasterCompileInput;
  return { evidence, input, atlas: { width: 4, height: 4, dataBase64: encoded(result.rgba) } };
}
it("replays source pixels and exact frozen recipe before accepting transformed font evidence", () => {
  const f = fixture(); expect(() => verifyDashboardButtonComposition(f.evidence, f.input, f.atlas)).not.toThrow();
  expect(() => verifyDashboardButtonComposition(f.evidence, f.input, { ...f.atlas, dataBase64: encoded(new Uint8Array(64)) })).toThrow(/output/);
  const changed = structuredClone(f.evidence) as { composition: { recipe: { group: { opacity: number } }; recipeSha256: string } };
  changed.composition.recipe.group.opacity = 1;
  changed.composition.recipeSha256 = runtimeContentSha256(changed.composition.recipe);
  expect(() => verifyDashboardButtonComposition(changed as DashboardRasterEvidence, f.input, f.atlas)).toThrow(/frozen/);
  const altered = structuredClone(f.evidence) as { composition: { sourceRgbaBase64: string } };
  altered.composition.sourceRgbaBase64 = encoded(new Uint8Array(4));
  expect(() => verifyDashboardButtonComposition(altered as DashboardRasterEvidence, f.input, f.atlas)).toThrow(/source/);
});
it("rejects oversized group allocation and corrupt text byte lengths", () => {
  const text = { rect: [0, 0, 1, 1] as const, width: 1, height: 1, rgba: new Uint8Array(4) };
  expect(() => compositeDashboardButtonGroup({ ...group, rect: [0, 0, 10000, 10000] }, text)).toThrow(/oversized/);
  expect(() => compositeDashboardButtonGroup(group, { ...text, rgba: new Uint8Array(3) })).toThrow(/text pixels/);
});
import { fixture as dataFixture } from "./dashboardDataRaster.testUtils";
import { dataPresentation } from "./dashboardDataPresentation";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
it("compiles actual table pager roles through isolated atlas output and replays its receipt", async () => {
  const f = dataFixture(), node = f.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  node.widget = { type: "table", title: "", key: "table", unit: "", report: { mode: "detail", pageSize: 1 } };
  const metric = { rows: [{ count: 1 }, { count: 2 }], samples: [] };
  const data = { ...f.data, metric, source: { ...f.data.source, contentSha256: runtimeContentSha256(metric) }, table: { page: 0, scrollLeft: 0 } };
  const textBoxes = [...dataPresentation(node.widget, data, "zh-CN").values()].map(({ role }) => ({ ...f.textBoxes[0]!, role,
    ...(role.kind === "previous" || role.kind === "next" ? { buttonGroup: { ...group, rect: [15, 15, 28, 18] as const } } : {}) }));
  const input = { ...f.input, data: { kpi: { ...data, layout: { textBoxes, backgrounds: [] } } } };
  const result = await compileDashboardRasterContent(input, f.host);
  expect(result.capabilityReport.contentCompiled).toBe(1);
  expect(result.capabilityReport.objects[0]!.reasons).toContain("CSV/Excel export toolbar buttons have a static appearance capture contract; the production widget is not yet wired into the measured table view");
  expect(result.capabilityReport.objects[0]!.reasons).toContain("CSV/Excel export download actions are not included in the measured table contract");
  const composed = result.producerEvidence.filter(item => item.composition);
  expect(composed).toHaveLength(2);
  for (const receipt of composed) {
    const layers = Object.values(result.package.payloads) as Array<{ atlases?: Array<{ id: string; width: number; height: number; dataBase64: string }> }>;
    const atlas = layers.flatMap(layer => layer.atlases ?? []).find(atlas => atlas.id === receipt.atlasId)!;
    expect(() => verifyDashboardButtonComposition(receipt, input, atlas)).not.toThrow();
    expect(receipt.pixelSha256).not.toBe(receipt.producerEvidence!.pixelSha256);
  }
});
