import type { PlantLiteAvailability, PlantLiteModel, PlantLiteResource } from "@bim-studio/contracts";
import { plantLiteEffectiveCapacity } from "./capacity.js";
import type { EnergyRunMetrics } from "./model.js";
import { isPlantLiteAvailableAt, unionPlantLiteAvailabilities } from "./operatingCalendar.js";
import type { EnergyConsumerState, EnergyState, Runtime } from "./runtimeTypes.js";

/** 只有功率和经济口径都存在时才建立证据，避免把缺失价格或排放因子静默当作 0。 */
export function createPlantLiteEnergyState(model: PlantLiteModel): EnergyState | undefined {
  const hasPower = model.nodes.some((node) => node.kind === "station" && Boolean(node.power))
    || (model.resources ?? []).some((resource) => Boolean(resource.power));
  if (!hasPower || !model.energyEconomics) return undefined;
  return { activeEnergyKwh: 0, idleEnergyKwh: 0, peakDemandKw: 0, consumers: new Map() };
}

/**
 * 事件间状态恒定，因此按每个 DES 时间片积分，而不是事后用平均利用率近似。
 * 班次、故障、开工和完工事件都会切开时间片。
 */
export function advancePlantLiteEnergy(runtime: Runtime, elapsedMinutes: number): void {
  const energy = runtime.energy;
  if (!energy || elapsedMinutes <= 0) return;
  let activePowerKw = 0;
  let idlePowerKw = 0;

  for (const node of runtime.model.nodes) {
    if (node.kind !== "station" || !node.power) continue;
    const state = runtime.states.get(node.id);
    if (!state) continue;
    const active = state.active * node.power.activePowerKw;
    const idleUnits = isPlantLiteAvailableAt(runtime.now, node.availability)
      ? Math.max(0, plantLiteEffectiveCapacity(runtime.model, node) - state.active)
      : 0;
    const idle = idleUnits * node.power.idlePowerKw;
    addConsumerEnergy(energy, "node", node.id, active, idle, elapsedMinutes);
    activePowerKw += active;
    idlePowerKw += idle;
  }

  for (const resource of runtime.model.resources ?? []) {
    if (!resource.power) continue;
    const state = runtime.resources.get(resource.id);
    if (!state) continue;
    const active = state.busy * resource.power.activePowerKw;
    const idleUnits = isPlantLiteAvailableAt(runtime.now, resourceAvailability(runtime.model, resource))
      ? Math.max(0, resource.capacity - state.busy - state.failedUnits.size)
      : 0;
    const idle = idleUnits * resource.power.idlePowerKw;
    addConsumerEnergy(energy, "resource", resource.id, active, idle, elapsedMinutes);
    activePowerKw += active;
    idlePowerKw += idle;
  }

  energy.activeEnergyKwh += activePowerKw * elapsedMinutes / 60;
  energy.idleEnergyKwh += idlePowerKw * elapsedMinutes / 60;
  energy.peakDemandKw = Math.max(energy.peakDemandKw, activePowerKw + idlePowerKw);
}

export function plantLiteEnergyMetrics(runtime: Runtime): EnergyRunMetrics | undefined {
  const state = runtime.energy;
  const economics = runtime.model.energyEconomics;
  if (!state || !economics) return undefined;
  const totalEnergyKwh = state.activeEnergyKwh + state.idleEnergyKwh;
  const divisor = runtime.measuredCompleted > 0 ? runtime.measuredCompleted : 1;
  const electricityCost = totalEnergyKwh * economics.electricityPricePerKwh;
  const carbonEmissionKg = totalEnergyKwh * economics.carbonEmissionFactorKgPerKwh;
  return {
    activeEnergyKwh: state.activeEnergyKwh,
    idleEnergyKwh: state.idleEnergyKwh,
    totalEnergyKwh,
    energyPerCompletedItemKwh: runtime.measuredCompleted > 0 ? totalEnergyKwh / divisor : 0,
    electricityCost,
    electricityCostPerCompletedItem: runtime.measuredCompleted > 0 ? electricityCost / divisor : 0,
    carbonEmissionKg,
    carbonEmissionPerCompletedItemKg: runtime.measuredCompleted > 0 ? carbonEmissionKg / divisor : 0,
    peakDemandKw: state.peakDemandKw,
    consumers: [...state.consumers.values()]
      .map((consumer) => ({
        ...consumer,
        totalEnergyKwh: consumer.activeEnergyKwh + consumer.idleEnergyKwh,
      }))
      .sort((left, right) => right.totalEnergyKwh - left.totalEnergyKwh || left.consumerId.localeCompare(right.consumerId)),
  };
}

function addConsumerEnergy(
  state: EnergyState,
  consumerKind: EnergyConsumerState["consumerKind"],
  consumerId: string,
  activePowerKw: number,
  idlePowerKw: number,
  elapsedMinutes: number,
): void {
  const key = `${consumerKind}:${consumerId}`;
  const consumer = state.consumers.get(key) ?? { consumerId, consumerKind, activeEnergyKwh: 0, idleEnergyKwh: 0 };
  consumer.activeEnergyKwh += activePowerKw * elapsedMinutes / 60;
  consumer.idleEnergyKwh += idlePowerKw * elapsedMinutes / 60;
  state.consumers.set(key, consumer);
}

function resourceAvailability(model: PlantLiteModel, resource: PlantLiteResource): PlantLiteAvailability | undefined {
  if (resource.availability?.shifts?.length) return resource.availability;
  if (resource.kind !== "equipment") return undefined;
  return unionPlantLiteAvailabilities(model.nodes
    .filter((node): node is Extract<typeof node, { kind: "station" }> => node.kind === "station" && node.resourceId === resource.id)
    .map((station) => station.availability));
}
