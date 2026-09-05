import { describe, expect, it } from "vitest";
import { filterDashboardFieldProducts } from "./DashboardDataPanel";
import type { DashboardFieldProduct } from "./dashboardFieldBinding";

const products: DashboardFieldProduct[] = [{ key: "dataset:p", name: "生产", status: "ready", fields: [{ key: "amount", label: "产量", type: "number", unit: "件" }, { key: "region", label: "区域", type: "string" }] }];
describe("dashboard field catalog search", () => {
  it("searches product, label, key and unit without mutating the catalog", () => {
    expect(filterDashboardFieldProducts(products, "生产")[0]?.fields).toHaveLength(2);
    for (const query of ["产量", " AMOUNT ", "件"]) expect(filterDashboardFieldProducts(products, query)[0]?.fields.map((field) => field.key)).toEqual(["amount"]);
    expect(products[0]?.fields).toHaveLength(2);
    expect(filterDashboardFieldProducts(products, "missing")).toEqual([]);
  });
  it("preserves per-product loading/error state and handles no products", () => {
    expect(filterDashboardFieldProducts([], "")).toEqual([]);
    const failed: DashboardFieldProduct = { key: "pipeline:p", name: "异常管道", fields: [], status: "error", error: "来源不可达" };
    expect(filterDashboardFieldProducts([failed], "异常")).toEqual([failed]);
  });
});
