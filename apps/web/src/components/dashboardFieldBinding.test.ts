import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { bindDashboardField, dashboardFieldRoles, fieldMatchesRole, readDashboardFieldDrag, unbindDashboardField, type DashboardFieldProduct } from "./dashboardFieldBinding";

export const product: DashboardFieldProduct = { key: "dataset:production", name: "生产数据", status: "ready", fields: [
  { key: "region", label: "区域", type: "string" }, { key: "time", label: "时间", type: "datetime" },
  { key: "amount", label: "产量", type: "number", unit: "件" }, { key: "category", label: "工序", type: "string" },
] };
const widget: DashboardDataWidgetConfig = { type: "bar", key: "old.value", title: "产量", unit: "", datasetId: "old", analysis: { aggregation: "sum", dimensionField: "old_region", measureField: "value", seriesField: "region", drillFields: ["old_region", "region"] } };

describe("typed dashboard field bindings", () => {
  it("uses existing numeric cards and chart types, preserving non-slot editors", () => {
    for (const type of ["bar", "line", "combo", "rank"] as const) expect(dashboardFieldRoles(type)).toEqual(["dimension", "measure", "series"]);
    for (const type of ["value", "gauge", "progress", "digital-flip", "liquid-fill"] as const) expect(dashboardFieldRoles(type)).toEqual(["measure"]);
    for (const type of ["table", "scroll-table", "map", "filter", "video", "status"] as const) expect(dashboardFieldRoles(type)).toEqual([]);
  });
  it("validates authoritative fields, not forged MIME metadata", () => {
    const drag = readDashboardFieldDrag(JSON.stringify({ productKey: product.key, fieldKey: "region", fieldType: "number", label: "伪造数值" }))!;
    expect(bindDashboardField(widget, "measure", product, drag.fieldKey)).toBeUndefined();
    expect(bindDashboardField(widget, "dimension", product, "time")).toBeDefined();
    expect(bindDashboardField(widget, "series", product, "time")).toBeUndefined();
    expect(bindDashboardField(widget, "measure", product, "missing")).toBeUndefined();
    expect(bindDashboardField(widget, "measure", { ...product, status: "loading" }, "amount")).toBeUndefined();
    expect(fieldMatchesRole({ key: "json", label: "JSON", type: "json" }, "dimension")).toBe(false);
  });
  it("binds product, field and role atomically without auto-filling unrelated slots", () => {
    const next = bindDashboardField(widget, "measure", product, "amount")!;
    expect(next).toMatchObject({ datasetId: "production", field: "amount", key: "production.amount", unit: "件", analysis: { aggregation: "sum", measureField: "amount", seriesField: "region", drillFields: ["region"] } });
    expect(next.analysis?.dimensionField).toBeUndefined();
    expect(widget.analysis?.dimensionField).toBe("old_region");
  });
  it("keeps the other current-product roles on replacement and removes the old source", () => {
    const current = bindDashboardField(widget, "measure", product, "amount")!;
    const next = bindDashboardField(current, "dimension", { ...product, key: "pipeline:clean" }, "time")!;
    expect(next).toMatchObject({ pipelineId: "clean", key: "clean.amount", analysis: { dimensionField: "time", measureField: "amount", seriesField: "region" } });
    expect(next.datasetId).toBeUndefined();
  });
  it("uses field for numeric cards without inventing an analysis contract", () => {
    const next = bindDashboardField({ type: "value", title: "产量", key: "", unit: "" }, "measure", product, "amount")!;
    expect(next).toMatchObject({ field: "amount", key: "production.amount" });
    expect(next.analysis).toBeUndefined();
  });
  it("unbinds all measure fallbacks and preserves non-measure bindings", () => {
    const current = bindDashboardField(widget, "measure", product, "amount")!;
    const next = unbindDashboardField(current, "measure");
    expect(next.key).toBe(""); expect(next.field).toBeUndefined(); expect(next.analysis?.measureField).toBeUndefined();
    expect(next.analysis?.seriesField).toBe("region");
    expect(unbindDashboardField(current, "series").analysis?.seriesField).toBeUndefined();
    expect(current.field).toBe("amount");
  });
  it("rejects malformed, unrelated and excessive drag payloads", () => {
    for (const value of ["null", "[]", "broken", JSON.stringify({ productKey: "url:evil", fieldKey: "a" }), "x".repeat(10001)]) expect(readDashboardFieldDrag(value)).toBeUndefined();
  });
});
