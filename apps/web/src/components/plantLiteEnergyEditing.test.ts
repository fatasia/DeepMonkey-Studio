import { describe, expect, it } from "vitest";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import {
  countPlantLiteEnergyConsumers,
  enablePlantLiteEnergyModel,
  setPlantLiteStationPower,
} from "./plantLiteEnergyEditing";

describe("Plant Lite energy authoring", () => {
  it("enables a complete editable energy boundary on a legacy model", () => {
    const legacy = createAgvLinePlantLiteModel();
    delete legacy.energyEconomics;
    legacy.nodes.forEach((node) => { if (node.kind === "station") delete node.power; });
    legacy.resources?.forEach((resource) => { delete resource.power; });

    const enabled = enablePlantLiteEnergyModel(legacy);
    expect(enabled.energyEconomics).toEqual({ electricityPricePerKwh: .85, carbonEmissionFactorKgPerKwh: .58, source: "estimate" });
    expect(countPlantLiteEnergyConsumers(enabled)).toBe(3);
    expect(validatePlantLiteModel(enabled)).toMatchObject({ valid: true });
    expect(legacy.energyEconomics).toBeUndefined();
  });

  it("removes orphaned economics when the last modeled consumer is disabled", () => {
    const model = createAgvLinePlantLiteModel();
    const station = model.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    model.nodes.forEach((node) => { if (node.kind === "station" && node.id !== station.id) delete node.power; });
    model.resources?.forEach((resource) => { delete resource.power; });

    const disabled = setPlantLiteStationPower(model, station.id, undefined);
    expect(countPlantLiteEnergyConsumers(disabled)).toBe(0);
    expect(disabled.energyEconomics).toBeUndefined();
    expect(validatePlantLiteModel(disabled)).toMatchObject({ valid: true });
  });

  it("never turns worker headcount into an energy consumer", () => {
    const legacy = createAgvLinePlantLiteModel();
    legacy.resources?.push({ id: "workers", name: "装配班组", kind: "worker", capacity: 4 });
    const station = legacy.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    station.workerResourceId = "workers";

    const enabled = enablePlantLiteEnergyModel(legacy);
    expect(enabled.resources?.find((resource) => resource.id === "workers")).not.toHaveProperty("power");
    expect(countPlantLiteEnergyConsumers(enabled)).toBe(3);
    expect(validatePlantLiteModel(enabled)).toMatchObject({ valid: true });
  });
});
