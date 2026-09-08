import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { buildDashboardSampleMetric, dashboardSampleFields, dashboardSampleFilterWidgets, isolateCopiedDashboardSamples, withDashboardSampleData } from "./dashboardSampleMetrics";
import { replaceDashboardWidgetDataProduct } from "./dashboardDataProductReplacement";
import { applyDashboardFilters } from "./DashboardWidgetVisualization";

const widget: DashboardDataWidgetConfig = { title: "产量", type: "value", key: "output", unit: "件", field: "output", analysis: { measureField: "output", aggregation: "sum" } };
describe("sample metrics", () => {
  it("retains explicitly declared numeric and boolean columns after clearing all rows", () => {
    expect(dashboardSampleFields({ columns: [{ key: "output", type: "number" }, { key: "active", type: "boolean" }], rows: [] }).map(field => field.type)).toEqual(["number", "boolean"]);
  });
  it("does not combine filters owned by separate inserted or copied templates", () => {
    const one = { ...widget, sampleData: { sourceId: "one", rows: [] } };
    const two = { ...widget, sampleData: { sourceId: "two", rows: [] } };
    const filters = ["one:filter", "two:filter", "global"].map(key => ({ ...widget, type: "filter" as const, key }));
    expect(dashboardSampleFilterWidgets(one, [one, two, ...filters]).map(item => item.key)).toEqual(["one:filter", "global"]);
    const node = { id: "filter-copy", kind: "data-widget" as const, widget: filters[0]!, frame: { x: 0, y: 0, width: 10, height: 10 }, zIndex: 0 };
    const copied = isolateCopiedDashboardSamples([node, { ...node, id: "value-copy", widget: one }]);
    expect(copied[0]).not.toMatchObject({ widget: { key: "one:filter" } });
  });
  it("isolates copied sample identities while retaining sharing within the copied set", () => {
    const nodes = ["a", "b"].map(id => ({ id, kind: "data-widget" as const, frame: { x: 0, y: 0, width: 1, height: 1 }, zIndex: 0,
      widget: { ...widget, sampleData: { sourceId: "old", rows: [{ output: 4 }] } } }));
    const cloned = isolateCopiedDashboardSamples(nodes);
    const widgets = cloned.flatMap(node => node.kind === "data-widget" ? [node.widget] : []);
    expect(widgets[0]?.sampleData?.sourceId).not.toBe("old");
    expect(widgets[0]?.sampleData?.sourceId).toBe(widgets[1]?.sampleData?.sourceId);
    expect(new Set(widgets.map(item => item.key)).size).toBe(2);
    expect(nodes[0]?.widget.sampleData.sourceId).toBe("old");
  });
  it("aggregates genuine zero values and does not invent values for empty data", () => {
    expect(buildDashboardSampleMetric(widget, [{ output: 0 }, { output: 20 }]).value).toBe(20);
    expect(buildDashboardSampleMetric(widget, []).value).toBeUndefined();
    expect(buildDashboardSampleMetric({ ...widget, analysis: { aggregation: "average" } }, [{ output: 10 }, { output: 20 }]).value).toBe(15);
  });
  it("consumes the existing filter pipeline without a network source", () => {
    const filter = { ...widget, type: "filter" as const, key: "lineFilter", filterField: "line" };
    const rows = applyDashboardFilters([{ line: "A", output: 4 }, { line: "B", output: 9 }], { lineFilter: "B" }, [filter]);
    expect(buildDashboardSampleMetric(widget, rows as never).value).toBe(9);
  });
  it("removes the old source when switching to and away from samples", () => {
    const next = withDashboardSampleData({ ...widget, datasetId: "real" });
    expect(next.datasetId).toBeUndefined(); expect(next.sampleData?.rows).toHaveLength(2);
    expect(replaceDashboardWidgetDataProduct(next, "dataset:new", [{ key: "output", label: "产量", type: "number" }]).sampleData).toBeUndefined();
    expect(widget).not.toHaveProperty("sampleData");
  });
  it("infers all columns and ignores nulls when identifying numeric fields", () => {
    expect(dashboardSampleFields({ rows: [{ line: "A", output: null }, { line: "B", output: 2 }] }).map(field => field.type)).toEqual(["string", "number"]);
  });
});
