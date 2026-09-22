import { expect, it } from "vitest";
import source from "../../fixtures/dashboard-composition-v1.json";
import { validateDashboardFilter } from "./dashboardFilterValidation.js";
import type { DashboardRuntimePageV1 } from "./dashboardCompositionTypes.js";

function fixture() {
  const payloads = structuredClone(source.payloads);
  const pages = payloads["dashboard.root"].pages;
  const node = pages[0]!.nodes[0]!, target = pages[0]!.nodes[1]!;
  node.hitId = node.id; target.chartSim = null;
  const chart = payloads["dashboard.chart.a"].chart;
  const filter = { nodeId: node.id, sourceNodeId: "author.filter", key: "region",
    options: [{ value: "全部", updates: [{ nodeId: target.id,
      datasets: chart.datasets.map(dataset => ({ datasetId: dataset.id, rows: dataset.rows })) }] }] };
  return { filter, pages: pages as unknown as DashboardRuntimePageV1[], payloads };
}
it("accepts 25 options only with the bounded select presentation and rejects unknown profiles", () => {
  const valid = fixture(), option = valid.filter.options[0]!;
  valid.filter.options = Array.from({ length: 25 }, (_, index) => ({ ...option, value: `option ${index}` }));
  const filter = { ...valid.filter, presentation: { kind: "select-v1", rowHeight: 32, visibleRows: 8 } };
  expect(() => validateDashboardFilter(filter, valid.pages, valid.payloads, "$filter")).not.toThrow();
  expect(() => validateDashboardFilter(valid.filter, valid.pages, valid.payloads, "$filter")).toThrow();
  expect(() => validateDashboardFilter({ ...filter, presentation: { ...filter.presentation, visibleRows: 100 } }, valid.pages, valid.payloads, "$filter")).toThrow();
  expect(() => validateDashboardFilter({ ...filter, options: Array.from({ length: 257 }, (_, i) => ({ ...option, value: String(i) })) }, valid.pages, valid.payloads, "$filter")).toThrow();
});
it("accepts closed chart datasets and rejects foreign targets, datasets, scalar rows and unknown actions", () => {
  const valid = fixture(); expect(() => validateDashboardFilter(valid.filter, valid.pages, valid.payloads, "$filter")).not.toThrow();
  for (const mutate of [
    (value: any) => { value.filter.command = "eval"; },
    (value: any) => { value.filter.options[0].updates[0].nodeId = "foreign"; },
    (value: any) => { value.filter.options[0].updates[0].datasets[0].datasetId = "foreign"; },
    (value: any) => { value.filter.options[0].updates[0].datasets[0].rows = [[{ code: "eval" }]]; },
    (value: any) => { value.filter.options.push(value.filter.options[0]); },
    (value: any) => { value.pages[0].nodes[0].hitId = null; },
  ]) {
    const value = fixture(); mutate(value);
    expect(() => validateDashboardFilter(value.filter, value.pages, value.payloads, "$filter")).toThrow();
  }
});

it("validates static visibility targets without permitting filter, chart or foreign-node mutation", () => {
  const valid = fixture();
  const base = valid.pages[0]!.nodes[0]!;
  const staticNode = { ...base, id: `node.${"c".repeat(64)}`, hitId: null, visible: false };
  (valid.pages[0]!.nodes as any[]).push(staticNode);
  const filter = { ...valid.filter, options: valid.filter.options.map(option => ({ ...option,
    visibility: [{ nodeId: staticNode.id, visible: true }] })) };
  expect(() => validateDashboardFilter(filter, valid.pages, valid.payloads, "$filter")).not.toThrow();
  for (const nodeId of ["foreign", base.id, valid.pages[0]!.nodes[1]!.id]) {
    const invalid = structuredClone(filter); invalid.options[0]!.visibility[0]!.nodeId = nodeId;
    expect(() => validateDashboardFilter(invalid, valid.pages, valid.payloads, "$filter")).toThrow(/static target/);
  }
  const inconsistent = structuredClone(filter);
  inconsistent.options.push({ ...inconsistent.options[0]!, value: "other", visibility: [] });
  expect(() => validateDashboardFilter(inconsistent, valid.pages, valid.payloads, "$filter")).toThrow(/target set/);
});
