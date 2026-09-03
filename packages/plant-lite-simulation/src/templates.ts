import type { PlantLiteModel } from "./modelTypes.js";

export const AGV_LINE_TEMPLATE_ID = "agv-line-v1" as const;

export interface AgvLineTemplateOptions {
  agvCount?: number;
  bufferCapacity?: number;
}

/** API 与浏览器作者器共用同一份起步模板，避免两端复制拓扑后发生漂移。 */
export function createAgvLinePlantLiteModel(options: AgvLineTemplateOptions = {}): PlantLiteModel {
  const agvCount = boundedInteger(options.agvCount, 4, 1, 100, "AGV 数量");
  const bufferCapacity = boundedInteger(options.bufferCapacity, 10, 1, 10_000, "缓冲容量");
  return {
    id: AGV_LINE_TEMPLATE_ID,
    name: "AGV 两工位产线",
    energyEconomics: {
      electricityPricePerKwh: 0.85,
      carbonEmissionFactorKgPerKwh: 0.58,
      source: "estimate",
    },
    resources: [{
      id: "agv-fleet",
      name: "AGV 车队",
      kind: "agv",
      capacity: agvCount,
      availability: { shifts: [{ startMinute: 0, endMinute: 480 }] },
      failure: {
        timeToFailure: { kind: "exponential", mean: 720 },
        repairTime: { kind: "normal", mean: 10, standardDeviation: 2, minimum: 1 },
      },
      power: { activePowerKw: 1.2, idlePowerKw: 0.08, source: "estimate" },
    }],
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "uniform", minimum: 0.75, maximum: 1.25 }, maxItems: 720 },
      { id: "station-a", name: "装配工位", kind: "station", processingTime: { kind: "normal", mean: 0.9, standardDeviation: 0.12, minimum: 0.2 }, capacity: 1, power: { activePowerKw: 18, idlePowerKw: 2.2, source: "estimate" } },
      { id: "queue-buffer", name: "工序间缓冲", kind: "queue-buffer", capacity: bufferCapacity },
      { id: "transport", name: "AGV 转运", kind: "transport", travelTime: { kind: "uniform", minimum: 0.6, maximum: 1 }, resourceId: "agv-fleet" },
      { id: "station-b", name: "检验工位", kind: "station", processingTime: { kind: "normal", mean: 0.7, standardDeviation: 0.08, minimum: 0.2 }, capacity: 1, power: { activePowerKw: 8, idlePowerKw: 1.2, source: "estimate" } },
      { id: "sink", name: "成品", kind: "sink" },
    ],
    edges: [
      { id: "source-a", from: "source", to: "station-a" },
      { id: "a-buffer", from: "station-a", to: "queue-buffer" },
      { id: "buffer-transport", from: "queue-buffer", to: "transport" },
      { id: "transport-b", from: "transport", to: "station-b" },
      { id: "b-sink", from: "station-b", to: "sink" },
    ],
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const numeric = value ?? fallback;
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new RangeError(`${label}必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return numeric;
}
