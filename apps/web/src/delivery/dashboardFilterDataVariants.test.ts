import { expect, it } from "vitest";
import { dashboardFilterDataVariants } from "./dashboardFilterDataVariants";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

function fixture() {
  const metric = { rows: [{ region: "东", value: 3 }, { region: "西", value: 5 }], samples: [] };
  const widgets = [
    { id: "filter", widget: { type: "filter", key: "region", options: ["全部", "东", "missing"] } },
    { id: "value", widget: { type: "value", key: "value", field: "value", analysis: { measureField: "value", aggregation: "sum" } } },
    { id: "table", widget: { type: "table", key: "table", field: "value" } },
  ].map(node => ({ ...node, kind: "data-widget" }));
  return { document: { application: { pages: [{ nodes: widgets }] } }, data: Object.fromEntries(["value", "table"].map(id => [id,
    { source: { kind: "sample", id, revision: 1, contentSha256: runtimeContentSha256(metric) }, metric }])) } as unknown as DashboardRasterCompileInput;
}
it("derives KPI and table from the same exact filter semantics without mutating source", () => {
  const input = fixture(), before = structuredClone(input), result = dashboardFilterDataVariants(input);
  expect(result.map(option => option.data.table!.metric.rows.length)).toEqual([2, 1, 0]);
  expect(result[1]!.data.value!.metric.value).toBe(3);
  expect(input).toEqual(before);
  for (const option of result) for (const data of Object.values(option.data)) expect(data.source.contentSha256).toBe(runtimeContentSha256(data.metric));
});
it("rejects non-sample and corrupt source instead of freezing misleading static results", () => {
  const input = fixture(); (input.data!.value!.source as { kind: string }).kind = "dataset";
  expect(() => dashboardFilterDataVariants(input)).toThrow(/frozen sample/);
  const corrupt = fixture(); (corrupt.data!.value!.source as { contentSha256: string }).contentSha256 = "a".repeat(64);
  expect(() => dashboardFilterDataVariants(corrupt)).toThrow(/identity/);
});
