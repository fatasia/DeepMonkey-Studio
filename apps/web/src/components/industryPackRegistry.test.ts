import { describe, expect, it } from "vitest";
import { createIndustryPackRegistry } from "./industryPackRegistry";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { MANUFACTURING_ASSET_OPS_PACK, MANUFACTURING_PACK_SAMPLES } from "./industryPackManufacturing";
import { LOGISTICS_FULFILLMENT_PACK } from "./industryPackLogistics";
import { LOGISTICS_PACK_SAMPLES } from "./industryPackLogisticsSamples";
import { INDUSTRY_PACK_ISSUES, INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";

const ids = DASHBOARD_TEMPLATES.map(item => item.id);
const manufacturing = { pack: MANUFACTURING_ASSET_OPS_PACK, samples: MANUFACTURING_PACK_SAMPLES };
const logistics = { pack: LOGISTICS_FULFILLMENT_PACK, samples: LOGISTICS_PACK_SAMPLES };

describe("industry pack registry isolation", () => {
  it("registers two distinct business datasets with no runtime catalog errors", () => {
    expect(INDUSTRY_PACK_ISSUES).toEqual([]);
    expect(INDUSTRY_TEMPLATE_PACKS).toHaveLength(2);
    const registry = createIndustryPackRegistry([manufacturing, logistics], ids);
    expect(registry.sample(logistics.pack, "logistics")).toBe(LOGISTICS_PACK_SAMPLES.logistics);
    expect(() => registry.sample({ ...logistics.pack, revision: 99 }, "logistics")).toThrow(/版本/);
    expect(() => registry.sample(manufacturing.pack, "logistics")).toThrow(/来源/);
  });
  it("isolates a missing sample without throwing during module startup or hiding valid packs", () => {
    const registry = createIndustryPackRegistry([manufacturing, { ...logistics, samples: {} }], ids);
    expect(registry.packs).toEqual([manufacturing.pack]);
    expect(registry.issues).toHaveLength(1);
    expect(() => registry.sample(logistics.pack, "logistics")).toThrow();
  });
  it.each(["column-type", "metric", "dimension", "filter", "row-length"])('rejects invalid %s before any import transaction', failure => {
    const samples = structuredClone(LOGISTICS_PACK_SAMPLES);
    const page = samples.logistics!;
    if (failure === "column-type") (page.rowValues[0] as unknown[])[1] = "18";
    if (failure === "metric") page.metrics[0]!.field = "不存在";
    if (failure === "dimension") page.primary.dimensionField = "不存在";
    if (failure === "filter") (page.rowValues[0] as unknown[])[0] = "D";
    if (failure === "row-length") (page.rowValues[0] as unknown[]).pop();
    const registry = createIndustryPackRegistry([{ ...logistics, samples }], ids);
    expect(registry.packs).toEqual([]);
    expect(registry.issues).toHaveLength(1);
  });
  it("rejects both duplicate IDs instead of silently picking one revision", () => {
    const registry = createIndustryPackRegistry([manufacturing, logistics, { ...logistics, pack: { ...logistics.pack, revision: 2 } }], ids);
    expect(registry.packs).toEqual([manufacturing.pack]);
    expect(registry.issues).toHaveLength(2);
  });
});
