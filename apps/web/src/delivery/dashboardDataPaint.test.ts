import { expect, it } from "vitest";
import { dashboardDataPaint } from "./dashboardDataPaint";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import { fixture } from "./dashboardDataRaster.testUtils";
import { dataPresentation } from "./dashboardDataPresentation";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";

it("validates a complete paint permutation and retains the legacy default", () => {
  const layout = fixture().data.layout;
  expect(dashboardDataPaint(layout)).toEqual([0, 1, 2].map(index => ({ kind: "text", index })));
  for (const paint of [[], [{ kind: "text", index: 0 }, { kind: "text", index: 0 }, { kind: "text", index: 2 }],
    [{ kind: "text", index: 0 }, { kind: "text", index: 1 }, { kind: "text", index: 3 }]]) {
    expect(() => dashboardDataPaint({ ...layout, paint: paint as never })).toThrow();
  }
});
it("keeps opaque sticky background after behind-cell text and before foreground text", async () => {
  const value = fixture(), node = value.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  node.widget = { type: "table", title: "", key: "table", unit: "", report: { mode: "detail", freezeFirstColumn: true } };
  const metric = { rows: [{ first: "front", second: "behind" }], samples: [] };
  const data = { ...value.data, metric, source: { ...value.data.source, contentSha256: runtimeContentSha256(metric) },
    table: { page: 0, scrollLeft: 20 } };
  const roles = [...dataPresentation(node.widget, data, "zh-CN").values()].map(item => item.role);
  const textBoxes = roles.map(role => ({ ...value.textBoxes[0]!, role, rect: [17, 17, 20, 10] as const }));
  const front = roles.findIndex(role => role.kind === "cell" && role.column === "first");
  const paint = roles.flatMap((_, index) => index === front ? [] : [{ kind: "text" as const, index }]);
  const ordered = [...paint, { kind: "background" as const, index: 0 }, { kind: "text" as const, index: front }];
  const result = await compileDashboardRasterContent({ ...value.input, data: { kpi: { ...data,
    layout: { textBoxes, backgrounds: [{ rect: [17, 17, 20, 10], color: [0.1, 0.2, 0.3, 1] }], paint: ordered } } } }, value.host);
  expect(result.capabilityReport.contentCompiled).toBe(1);
  const layers = Object.values(result.package.payloads).filter((item: any) => item.schema === "deep-engine.deep2d-runtime") as any[];
  const painted = layers.find(item => item.quads.length);
  expect(painted.composition).toBe("z-ordered");
  expect(painted.displayList.commands[0].zOrder).toBe(roles.length - 1);
  expect(painted.quads.at(-1).zOrder).toBe(roles.length);
  expect(painted.quads.slice(0, -1).every((quad: any) => quad.zOrder < roles.length - 1)).toBe(true);
});
it("validates paint before requesting pixels and retains runtime layer budgets", async () => {
  const value = fixture();
  const result = await compileDashboardRasterContent({ ...value.input,
    data: { kpi: { ...value.data, layout: { ...value.data.layout, paint: [] } } } }, value.host);
  expect(result.capabilityReport.contentCompiled).toBe(0);
  expect(value.rasterizeText).not.toHaveBeenCalled();
});
it("preserves the total node budget when alternating paint needs separate clip layers", async () => {
  const value = fixture(), original = value.input.document.application.pages[0]!.nodes[0]!;
  const textBoxes = value.textBoxes.map(box => ({ ...box, clip: box.rect }));
  const backgrounds = textBoxes.map(box => ({ rect: box.rect, color: [0, 0, 0, 1] as const }));
  const paint = textBoxes.flatMap((_, index) => [{ kind: "text" as const, index }, { kind: "background" as const, index }]);
  const data = { ...value.data, layout: { textBoxes, backgrounds, paint } };
  const authored = Array.from({ length: 19 }, (_, index) => ({ ...structuredClone(original), id: `kpi-${index}` }));
  value.input.document.application.pages[0]!.nodes = authored;
  await expect(compileDashboardRasterContent({ ...value.input, data: Object.fromEntries(authored.map(node => [node.id, data])) }, value.host))
    .rejects.toThrow(/node budget|bounded array/i);
});
