import { randomUUID } from "node:crypto";
import {
  runPlantLiteExperiment,
  type PlantLiteExperiment,
  type PlantLiteExperimentResult,
} from "@bim-studio/plant-lite-simulation";
import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { evidenceFingerprint } from "./operationsEngine.js";

const TEMPLATE_ID = "agv-line-v1" as const;
const EXECUTION_LIMITS = { durationMinutes: 480, maxEvents: 100_000, maxResources: 12 } as const;

/** 已校准的两工位 AGV 产线。页面只允许调整车辆、缓冲、seed 与重复次数。 */
export function runPlantLiteStudy(
  projectId: string,
  request: PlantLiteStudyRequest,
  now = new Date().toISOString(),
  shouldCancel?: () => boolean,
): PlantLiteStudyRecord {
  const input = normalizeRequest(request);
  const experiment = templateExperiment(input);
  const inputFingerprint = evidenceFingerprint({ input, model: experiment.model, limits: EXECUTION_LIMITS, engineVersion: "1.0.0" });
  const result = runPlantLiteExperiment(experiment, shouldCancel ? { shouldCancel } : {});
  return {
    id: randomUUID(), projectId, createdAt: now,
    ...input, inputFingerprint,
    outcome: outcome(result),
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint, deterministic: true, limits: EXECUTION_LIMITS },
  };
}

export function plantLiteRequestFromRecord(record: PlantLiteStudyRecord): PlantLiteStudyRequest {
  return { name: record.name, templateId: record.templateId, agvCount: record.agvCount, bufferCapacity: record.bufferCapacity, seed: record.seed, replications: record.replications };
}

function normalizeRequest(request: PlantLiteStudyRequest): Required<PlantLiteStudyRequest> {
  const templateId = request.templateId ?? TEMPLATE_ID;
  if (templateId !== TEMPLATE_ID) throw new Error("当前仅支持“AGV 两工位产线”模板");
  const name = request.name?.trim() || "AGV 两工位产线";
  if (name.length > 80) throw new Error("工况名称不能超过 80 个字符");
  const seed = request.seed ?? "plant-lite-baseline";
  if ((typeof seed !== "string" && typeof seed !== "number") || (typeof seed === "string" && (!seed.trim() || seed.length > 120)) || (typeof seed === "number" && !Number.isSafeInteger(seed))) throw new Error("seed 必须是短文本或安全整数");
  return {
    name, templateId,
    agvCount: boundedInteger(request.agvCount, 4, 1, 12, "AGV 数量"),
    bufferCapacity: boundedInteger(request.bufferCapacity, 10, 1, 200, "缓冲容量"),
    seed,
    replications: boundedInteger(request.replications, 12, 1, 30, "重复次数"),
  };
}

function templateExperiment(input: Required<PlantLiteStudyRequest>): PlantLiteExperiment {
  return {
    seed: input.seed, replications: input.replications, limits: EXECUTION_LIMITS,
    model: {
      id: TEMPLATE_ID, name: "AGV 两工位产线",
      resources: [{
        id: "agv-fleet", name: "AGV 车队", kind: "agv", capacity: input.agvCount,
        availability: { shifts: [{ startMinute: 0, endMinute: 480 }] },
        failure: { timeToFailure: { kind: "exponential", mean: 720 }, repairTime: { kind: "normal", mean: 10, standardDeviation: 2, minimum: 1 } },
      }],
      nodes: [
        { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "uniform", minimum: 0.75, maximum: 1.25 }, maxItems: 720 },
        { id: "station-a", name: "装配工位", kind: "station", processingTime: { kind: "normal", mean: 0.9, standardDeviation: 0.12, minimum: 0.2 }, capacity: 1 },
        { id: "queue-buffer", name: "工序间缓冲", kind: "queue-buffer", capacity: input.bufferCapacity },
        { id: "transport", name: "AGV 转运", kind: "transport", travelTime: { kind: "uniform", minimum: 0.6, maximum: 1 }, resourceId: "agv-fleet" },
        { id: "station-b", name: "检验工位", kind: "station", processingTime: { kind: "normal", mean: 0.7, standardDeviation: 0.08, minimum: 0.2 }, capacity: 1 },
        { id: "sink", name: "成品", kind: "sink" },
      ],
      edges: [
        { id: "source-a", from: "source", to: "station-a" }, { id: "a-buffer", from: "station-a", to: "queue-buffer" },
        { id: "buffer-transport", from: "queue-buffer", to: "transport" }, { id: "transport-b", from: "transport", to: "station-b" },
        { id: "b-sink", from: "station-b", to: "sink" },
      ],
    },
  };
}

function outcome(result: PlantLiteExperimentResult): PlantLiteStudyRecord["outcome"] {
  const completed = result.replications.filter((item) => item.termination === "completed");
  const hasCancellation = result.replications.some((item) => item.termination === "cancelled");
  const hasLimit = result.replications.some((item) => item.termination === "limit-reached");
  const hasItems = completed.some((item) => item.completedItems > 0);
  const status = hasCancellation ? "cancelled" : hasLimit ? "limited" : completed.length < 2 || !hasItems ? "insufficient-data" : "completed";
  const message = status === "cancelled" ? "客户端取消了离散仿真；未把未完成重复纳入置信区间。"
    : status === "limited" ? "离散仿真达到受限执行边界；仅展示已完成重复的统计结果。"
      : status === "insufficient-data" ? "有效完成重复不足 2 次或没有完成件，不能据此判断稳定的 95% 区间。" : undefined;
  return {
    status, ...(message ? { message } : {}), completedReplications: completed.length,
    throughputPerHour: result.confidence95.throughputPerHour,
    averageWip: result.confidence95.averageWip,
    averageLeadTimeMinutes: result.confidence95.averageLeadTimeMinutes,
    resourceUtilization95: result.resourceUtilization95,
    bottlenecks: result.bottlenecks,
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const numeric = value ?? fallback;
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 的整数`);
  return numeric;
}
