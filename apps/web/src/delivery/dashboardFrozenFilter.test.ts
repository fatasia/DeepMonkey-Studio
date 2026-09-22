import { expect, it } from "vitest";
import { assertDashboardDocument, type DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileFrozenFilterVariants } from "./dashboardFrozenFilter";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

function fixture() {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  const filter: DashboardDataWidgetNode = { id: "filter", kind: "data-widget", zIndex: 2,
    frame: { x: 0, y: 0, width: 180, height: 160 },
    widget: { type: "filter", title: "区域", key: "region", unit: "", options: ["全部", "华东", "华南"] } };
  const chart: DashboardDataWidgetNode = { id: "chart", kind: "data-widget", zIndex: 1,
    frame: { x: 200, y: 0, width: 640, height: 360 },
    widget: { type: "bar", title: "产量", key: "output", unit: "件", field: "value",
      analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" } } };
  document.application.pages = [document.application.pages[0]!];
  document.application.pages[0]!.nodes = [filter, chart];
  const metric = { samples: [], rows: [{ region: "华东", value: 3 }, { region: "华南", value: 8 }, { region: "华东", value: 4 }] };
  const input: DashboardRasterCompileInput = { document, packageId: "filter", packageVersion: "1.0.0", locale: "zh-CN",
    assets: {}, nodeAssets: {}, data: { chart: { source: { kind: "sample", id: "author", revision: 1,
      contentSha256: runtimeContentSha256(metric) }, metric } } };
  return { input, filter, chart };
}
const identities = new Map([["filter", `node.${"a".repeat(64)}`], ["chart", `node.${"b".repeat(64)}`]]);
it("reuses Web exact/all and sum semantics without mutating the frozen rows", () => {
  const { input } = fixture(), before = structuredClone(input);
  const result = compileFrozenFilterVariants(input, identities);
  expect(result.filter?.options.map(option => option.updates[0]!.datasets[0]!.rows)).toEqual([
    [["华东", 7], ["华南", 8]], [["华东", 7]], [["华南", 8]],
  ]);
  expect(input).toEqual(before);
});
it("blocks unsupported modes, cascades, duplicate options and combinations", () => {
  for (const patch of [{ filterMode: "text" }, { parentFilterKey: "parent" }, { options: ["A", "A"] },
    { options: Array.from({ length: 257 }, (_, i) => String(i)) }]) {
    const { input, filter } = fixture(); Object.assign(filter.widget, patch);
    expect(compileFrozenFilterVariants(input, identities).filter).toBeUndefined();
  }
  const { input, filter } = fixture(); input.document.application.pages[0]!.nodes.push({ ...filter, id: "other" });
  expect(compileFrozenFilterVariants(input, identities).reason).toMatch(/Multiple/);
});
it("diagnoses misleading all-labels instead of enabling a silent empty initial chart", () => {
  const { input, filter } = fixture(); filter.widget.options![0] = "全部区域";
  expect(compileFrozenFilterVariants(input, identities).reason).toMatch(/请将/);
});
it("keeps series-structure changes blocked instead of applying datasets to the wrong legend", () => {
  const { input, chart } = fixture();
  chart.widget.analysis!.seriesField = "region";
  expect(compileFrozenFilterVariants(input, identities).reason).toMatch(/structure/);
});
it("rejects a corrupt source hash and preserves empty matches without fabricated values", () => {
  const { input, filter } = fixture();
  filter.widget.options = ["missing"];
  expect(compileFrozenFilterVariants(input, identities).filter?.options[0]?.updates[0]?.datasets[0]?.rows).toEqual([]);
  (input.data!.chart!.metric.rows as Array<Record<string, unknown>>)[0]!.value = 999;
  expect(() => compileFrozenFilterVariants(input, identities)).toThrow(/identity mismatch/);
});
