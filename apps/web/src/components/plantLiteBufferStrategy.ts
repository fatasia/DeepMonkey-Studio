import type { PlantLiteModel, PlantLiteStudyRecord } from "@bim-studio/contracts";
import {
  createPlantLiteSingleVariableSweep,
  type PlantLiteSingleVariableSweep,
} from "./plantLiteBottleneckSweep";

export const PLANT_LITE_BUFFER_CAPACITY_MIN = 1;
export const PLANT_LITE_BUFFER_CAPACITY_MAX = 10_000;

export interface PlantLiteBufferOption {
  id: string;
  name: string;
  capacity: number;
}

export interface PlantLiteBufferStrategyCandidate {
  capacity: number;
  direction: "reduce" | "expand";
  baselineFactor: number;
  label: string;
}

export interface PlantLiteBufferStrategySweep extends PlantLiteSingleVariableSweep {
  bufferId: string;
  currentCapacity: number;
  candidates: PlantLiteBufferStrategyCandidate[];
}

/** 任一流程缓冲区都可进入策略实验，不要求它先被统计为第一瓶颈。 */
export function listPlantLiteBufferOptions(study: PlantLiteStudyRecord): PlantLiteBufferOption[] {
  return (study.model?.nodes ?? []).flatMap((node) => node.kind === "buffer" || node.kind === "queue-buffer"
    ? [{ id: node.id, name: node.name, capacity: node.capacity }]
    : []);
}

/**
 * 围绕已保存基线取 50% / 75% / 150% / 200% 容量；结果四舍五入、去重并限制在
 * 1..10,000 件。边界容量只返回仍然有效的一侧，不伪造 0 容量或越界方案。
 */
export function createPlantLiteBufferCandidates(currentCapacity: number): PlantLiteBufferStrategyCandidate[] {
  if (!Number.isSafeInteger(currentCapacity)
    || currentCapacity < PLANT_LITE_BUFFER_CAPACITY_MIN
    || currentCapacity > PLANT_LITE_BUFFER_CAPACITY_MAX) return [];

  const raw = [
    { capacity: Math.round(currentCapacity * 0.5), baselineFactor: 0.5 },
    { capacity: Math.round(currentCapacity * 0.75), baselineFactor: 0.75 },
    { capacity: Math.round(currentCapacity * 1.5), baselineFactor: 1.5 },
    { capacity: Math.round(currentCapacity * 2), baselineFactor: 2 },
  ];
  const capacities = new Set<number>();
  return raw
    .map((candidate) => ({
      ...candidate,
      capacity: Math.min(PLANT_LITE_BUFFER_CAPACITY_MAX, Math.max(PLANT_LITE_BUFFER_CAPACITY_MIN, candidate.capacity)),
    }))
    .filter((candidate) => {
      if (candidate.capacity === currentCapacity || capacities.has(candidate.capacity)) return false;
      capacities.add(candidate.capacity);
      return true;
    })
    .sort((left, right) => left.capacity - right.capacity)
    .map((candidate) => {
      const direction = candidate.capacity < currentCapacity ? "reduce" as const : "expand" as const;
      return {
        ...candidate,
        direction,
        label: `${direction === "reduce" ? "减容" : "扩容"}至 ${candidate.capacity} 件（基线 ×${candidate.baselineFactor} 取整）`,
      };
    });
}

export function createPlantLiteBufferStrategySweep(
  study: PlantLiteStudyRecord,
  bufferId: string,
): PlantLiteBufferStrategySweep | undefined {
  const model = study.model;
  const buffer = model?.nodes.find((node) => node.id === bufferId && (node.kind === "buffer" || node.kind === "queue-buffer"));
  if (!model || !buffer || (buffer.kind !== "buffer" && buffer.kind !== "queue-buffer")) return undefined;
  const candidates = createPlantLiteBufferCandidates(buffer.capacity);
  if (!candidates.length) return undefined;

  const sweep = createPlantLiteSingleVariableSweep({
    study,
    subjectName: buffer.name,
    parameterLabel: `${buffer.name} · 缓冲容量`,
    groupId: `buffer-strategy:${study.id}:${buffer.id}`,
    values: candidates.map((candidate) => candidate.capacity),
    update: (capacity) => updateBufferCapacity(model, buffer.id, capacity),
    label: (capacity) => candidates.find((candidate) => candidate.capacity === capacity)?.label ?? `${capacity} 件`,
  });
  return { ...sweep, bufferId: buffer.id, currentCapacity: buffer.capacity, candidates };
}

function updateBufferCapacity(model: PlantLiteModel, bufferId: string, capacity: number): PlantLiteModel {
  const next = structuredClone(model);
  next.nodes = next.nodes.map((node) => node.id === bufferId && (node.kind === "buffer" || node.kind === "queue-buffer")
    ? { ...node, capacity }
    : node);
  return next;
}
