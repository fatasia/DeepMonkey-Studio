import type {
  PlantLiteEnergyEconomics,
  PlantLiteModel,
  PlantLitePowerProfile,
} from "@bim-studio/contracts";

export const DEFAULT_PLANT_ENERGY_ECONOMICS: PlantLiteEnergyEconomics = {
  electricityPricePerKwh: 0.85,
  carbonEmissionFactorKgPerKwh: 0.58,
  source: "estimate",
};

export function enablePlantLiteEnergyModel(model: PlantLiteModel): PlantLiteModel {
  const next = structuredClone(model);
  next.energyEconomics ??= { ...DEFAULT_PLANT_ENERGY_ECONOMICS };
  next.nodes = next.nodes.map((node) => node.kind === "station" && !node.resourceId
    ? { ...node, power: node.power ?? defaultNodePower() }
    : node);
  if (next.resources) {
    next.resources = next.resources.map((resource) => resource.kind === "worker" ? resource : ({
      ...resource,
      power: resource.power ?? defaultResourcePower(resource.kind),
    }));
  }
  return next;
}

export function ensurePlantLiteEnergyEconomics(model: PlantLiteModel): PlantLiteModel {
  if (model.energyEconomics) return structuredClone(model);
  return { ...structuredClone(model), energyEconomics: { ...DEFAULT_PLANT_ENERGY_ECONOMICS } };
}

export function setPlantLiteEnergyEconomics(model: PlantLiteModel, economics: PlantLiteEnergyEconomics): PlantLiteModel {
  return { ...structuredClone(model), energyEconomics: { ...economics } };
}

export function setPlantLiteStationPower(model: PlantLiteModel, nodeId: string, power: PlantLitePowerProfile | undefined): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.nodes.findIndex((node) => node.id === nodeId && node.kind === "station");
  const station = next.nodes[index];
  if (!station || station.kind !== "station" || station.resourceId) return next;
  if (power) next.nodes[index] = { ...station, power: { ...power } };
  else {
    const { power: _power, ...withoutPower } = station;
    next.nodes[index] = withoutPower;
  }
  return withoutOrphanedEconomics(next);
}

export function setPlantLiteResourcePower(model: PlantLiteModel, resourceId: string, power: PlantLitePowerProfile | undefined): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.resources?.findIndex((resource) => resource.id === resourceId) ?? -1;
  const resource = next.resources?.[index];
  if (!resource || !next.resources || resource.kind === "worker") return next;
  if (power) next.resources[index] = { ...resource, power: { ...power } };
  else {
    const { power: _power, ...withoutPower } = resource;
    next.resources[index] = withoutPower;
  }
  return withoutOrphanedEconomics(next);
}

export function countPlantLiteEnergyConsumers(model: PlantLiteModel): number {
  return model.nodes.filter((node) => node.kind === "station" && Boolean(node.power)).length
    + (model.resources ?? []).filter((resource) => resource.kind !== "worker" && Boolean(resource.power)).length;
}

export function defaultPlantLitePower(kind: "station" | "agv" | "transport" | "equipment"): PlantLitePowerProfile {
  return kind === "station" ? defaultNodePower() : defaultResourcePower(kind);
}

function defaultNodePower(): PlantLitePowerProfile {
  return { activePowerKw: 10, idlePowerKw: 1, source: "estimate" };
}

function defaultResourcePower(kind: "agv" | "transport" | "equipment"): PlantLitePowerProfile {
  return kind === "equipment"
    ? { activePowerKw: 12, idlePowerKw: 1, source: "estimate" }
    : { activePowerKw: 1.2, idlePowerKw: 0.08, source: "estimate" };
}

function withoutOrphanedEconomics(model: PlantLiteModel): PlantLiteModel {
  if (countPlantLiteEnergyConsumers(model) > 0) return model;
  const { energyEconomics: _economics, ...withoutEconomics } = model;
  return withoutEconomics;
}
