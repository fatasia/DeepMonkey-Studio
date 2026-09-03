import { describe, expect, it } from "vitest";
import type { PlantLiteExperiment } from "./model.js";
import { runPlantLiteExperiment, validatePlantLiteModel } from "./index.js";

describe("Plant Lite energy economics", () => {
  it("integrates active and idle power over real DES state transitions", () => {
    const result = runPlantLiteExperiment(stationEnergyExperiment());
    const energy = result.replications[0]?.energy;

    expect(energy).toMatchObject({
      activeEnergyKwh: 5,
      idleEnergyKwh: 1,
      totalEnergyKwh: 6,
      energyPerCompletedItemKwh: 6,
      electricityCost: 6,
      electricityCostPerCompletedItem: 6,
      carbonEmissionKg: 3,
      carbonEmissionPerCompletedItemKg: 3,
      peakDemandKw: 10,
    });
    expect(energy?.consumers).toEqual([{
      consumerId: "station",
      consumerKind: "node",
      activeEnergyKwh: 5,
      idleEnergyKwh: 1,
      totalEnergyKwh: 6,
    }]);
    expect(result.energy95?.totalEnergyKwh).toMatchObject({ mean: 6, samples: 2 });
    expect(result.energy95?.consumerEnergyKwh.station).toMatchObject({ mean: 6, samples: 2 });
  });

  it("stops charging idle power for failed resource units", () => {
    const experiment: PlantLiteExperiment = {
      seed: 3,
      replications: 1,
      limits: { durationMinutes: 60, maxEvents: 100, maxResources: 2 },
      model: {
        id: "failed-idle",
        name: "Failed idle fleet",
        energyEconomics: { electricityPricePerKwh: 1, carbonEmissionFactorKgPerKwh: 0.5 },
        resources: [{
          id: "agv",
          name: "AGV",
          kind: "agv",
          capacity: 2,
          power: { activePowerKw: 2, idlePowerKw: 1 },
          failure: {
            timeToFailure: { kind: "deterministic", value: 30 },
            repairTime: { kind: "deterministic", value: 60 },
          },
        }],
        nodes: [
          { id: "source", name: "Source", kind: "source", initialDelay: 100, maxItems: 1, interarrivalTime: { kind: "deterministic", value: 100 } },
          { id: "transport", name: "Transport", kind: "transport", resourceId: "agv", travelTime: { kind: "deterministic", value: 5 } },
          { id: "sink", name: "Sink", kind: "sink" },
        ],
        edges: [{ id: "a", from: "source", to: "transport" }, { id: "b", from: "transport", to: "sink" }],
      },
    };

    const energy = runPlantLiteExperiment(experiment).replications[0]?.energy;
    expect(energy).toMatchObject({ activeEnergyKwh: 0, idleEnergyKwh: 1, totalEnergyKwh: 1, peakDemandKw: 2 });
    const aggregate = runPlantLiteExperiment(experiment).energy95;
    expect(aggregate?.totalEnergyKwh).toMatchObject({ mean: 1, samples: 1 });
    expect(aggregate?.energyPerCompletedItemKwh).toMatchObject({ mean: 0, samples: 0 });
  });

  it("rejects incomplete and double-counted energy models", () => {
    const withoutEconomics = stationEnergyExperiment().model;
    delete withoutEconomics.energyEconomics;
    expect(validatePlantLiteModel(withoutEconomics)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.energyEconomics" })]),
    });

    const doubleCounted = stationEnergyExperiment().model;
    const station = doubleCounted.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    station.resourceId = "equipment";
    doubleCounted.resources = [{ id: "equipment", name: "Equipment", kind: "equipment", capacity: 1, power: { activePowerKw: 10, idlePowerKw: 1 } }];
    expect(validatePlantLiteModel(doubleCounted)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.nodes[1].power", message: expect.stringContaining("重复计量") })]),
    });

    const invalidProvenance = stationEnergyExperiment().model;
    const poweredStation = invalidProvenance.nodes.find((node) => node.kind === "station");
    if (!poweredStation || poweredStation.kind !== "station" || !poweredStation.power) throw new Error("missing powered station fixture");
    (poweredStation.power as { source?: string }).source = "vendor-claim";
    expect(validatePlantLiteModel(invalidProvenance)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.nodes[1].power.source" })]),
    });
  });
});

function stationEnergyExperiment(): PlantLiteExperiment {
  return {
    seed: "energy",
    replications: 2,
    limits: { durationMinutes: 60, maxEvents: 100, maxResources: 1 },
    model: {
      id: "energy-line",
      name: "Energy line",
      energyEconomics: { electricityPricePerKwh: 1, carbonEmissionFactorKgPerKwh: 0.5 },
      nodes: [
        { id: "source", name: "Source", kind: "source", interarrivalTime: { kind: "deterministic", value: 100 }, maxItems: 1 },
        { id: "station", name: "Station", kind: "station", processingTime: { kind: "deterministic", value: 30 }, power: { activePowerKw: 10, idlePowerKw: 2 } },
        { id: "sink", name: "Sink", kind: "sink" },
      ],
      edges: [{ id: "a", from: "source", to: "station" }, { id: "b", from: "station", to: "sink" }],
    },
  };
}
