import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel, validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import {
  applyPlantLiteProductMix,
  disablePlantLiteProductMix,
  setPlantLiteChangeoverMinutes,
} from "./plantLiteMixEditing";

describe("plantLiteMixEditing", () => {
  it("requires explicit names and a 100 percent total", () => {
    const model = createAgvLinePlantLiteModel();
    expect(() => applyPlantLiteProductMix(model, [
      { name: "A", percentage: 60 },
      { name: "B", percentage: 30 },
    ])).toThrow("合计必须为 100%");
    expect(() => applyPlantLiteProductMix(model, [
      { name: "A", percentage: 50 },
      { name: "a", percentage: 50 },
    ])).toThrow("产品名称");
  });

  it("creates stable explicit product types without mutating the baseline", () => {
    const model = createAgvLinePlantLiteModel();
    const mixed = applyPlantLiteProductMix(model, [
      { name: "阀体", percentage: 65 },
      { name: "泵体", percentage: 35 },
    ]);
    expect(model.productTypes).toBeUndefined();
    expect(mixed.productTypes).toEqual([
      { id: "product-1", name: "阀体", share: 0.65 },
      { id: "product-2", name: "泵体", share: 0.35 },
    ]);
    expect(validatePlantLiteModel(mixed)).toMatchObject({ valid: true });
  });

  it("adds, updates and removes a directed changeover rule", () => {
    const mixed = applyPlantLiteProductMix(createAgvLinePlantLiteModel(), [
      { name: "A", percentage: 50 },
      { name: "B", percentage: 50 },
    ]);
    const stationId = mixed.nodes.find((node) => node.kind === "station")!.id;
    const withRule = setPlantLiteChangeoverMinutes(mixed, stationId, "product-1", "product-2", 7.5);
    const updated = setPlantLiteChangeoverMinutes(withRule, stationId, "product-1", "product-2", 4);
    const cleared = setPlantLiteChangeoverMinutes(updated, stationId, "product-1", "product-2", undefined);
    expect(station(withRule, stationId).changeovers).toEqual([{ fromProductTypeId: "product-1", toProductTypeId: "product-2", minutes: 7.5 }]);
    expect(station(updated, stationId).changeovers?.[0]?.minutes).toBe(4);
    expect(station(cleared, stationId).changeovers).toBeUndefined();
    expect(validatePlantLiteModel(updated)).toMatchObject({ valid: true });
  });

  it("prunes removed-product rules and clears all mix semantics when disabled", () => {
    let model = applyPlantLiteProductMix(createAgvLinePlantLiteModel(), [
      { id: "a", name: "A", percentage: 40 },
      { id: "b", name: "B", percentage: 30 },
      { id: "c", name: "C", percentage: 30 },
    ]);
    const stationId = model.nodes.find((node) => node.kind === "station")!.id;
    model = setPlantLiteChangeoverMinutes(model, stationId, "a", "b", 2);
    model = setPlantLiteChangeoverMinutes(model, stationId, "b", "c", 3);
    const sourceId = model.nodes.find((node) => node.kind === "source")!.id;
    model.productionOrders = [
      { id: "kept", name: "保留产品订单", sourceNodeId: sourceId, productTypeId: "a", quantity: 1, releaseMinute: 0, dueMinute: 60 },
      { id: "removed", name: "删除产品订单", sourceNodeId: sourceId, productTypeId: "c", quantity: 1, releaseMinute: 0, dueMinute: 60 },
    ];
    const pruned = applyPlantLiteProductMix(model, [
      { id: "a", name: "A", percentage: 50 },
      { id: "b", name: "B", percentage: 50 },
    ]);
    expect(station(pruned, stationId).changeovers).toEqual([{ fromProductTypeId: "a", toProductTypeId: "b", minutes: 2 }]);
    expect(pruned.productionOrders).toEqual([
      expect.objectContaining({ id: "kept", productTypeId: "a" }),
      expect.not.objectContaining({ productTypeId: expect.anything() }),
    ]);
    expect(validatePlantLiteModel(pruned)).toMatchObject({ valid: true });
    const disabled = disablePlantLiteProductMix(pruned);
    expect(disabled.productTypes).toBeUndefined();
    expect(station(disabled, stationId).changeovers).toBeUndefined();
    expect(disabled.productionOrders?.every((order) => order.productTypeId === undefined)).toBe(true);
    expect(validatePlantLiteModel(disabled)).toMatchObject({ valid: true });
  });
});

function station(model: ReturnType<typeof createAgvLinePlantLiteModel>, id: string) {
  const node = model.nodes.find((candidate) => candidate.id === id);
  if (!node || node.kind !== "station") throw new Error("station missing");
  return node;
}
