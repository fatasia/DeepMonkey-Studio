import type { BatteryDataContractAssessment, DataDatasetRecord } from "@bim-studio/contracts";
import type { BatteryExample } from "../ai/batterySample";
import type { AiDataRunPolicyDraft } from "./AiDataRunPolicyFields";
import type { BatteryAnalysisTask } from "./batteryResultPresentation";

export type BatteryTask = BatteryAnalysisTask;
export type FormalBatteryModel = "socformer" | "bmsformer" | "batterymformer";
export type BatteryChemistry = "lfp" | "ncm";
export type BatterySourceMode = "example" | "dataset" | "file";

export const BATTERY_TASKS: Array<{
  id: BatteryTask;
  label: string;
  detail: string;
  model: FormalBatteryModel;
}> = [
  { id: "soc", label: "计算 SOC", detail: "连续工况荷电校正", model: "socformer" },
  { id: "soh", label: "评估 SOH", detail: "健康度与可用容量", model: "bmsformer" },
  { id: "rul", label: "预测 RUL", detail: "退化轨迹与寿命阈值", model: "batterymformer" },
  { id: "combined", label: "综合评估", detail: "SOC · SOH · RUL 联合核验", model: "batterymformer" },
];

export const COMBINED_BATTERY_MODELS: Array<{
  task: "soc" | "soh" | "rul";
  model: FormalBatteryModel;
  label: string;
}> = [
  { task: "soc", model: "socformer", label: "SOC" },
  { task: "soh", model: "bmsformer", label: "SOH" },
  { task: "rul", model: "batterymformer", label: "RUL" },
];

export const BATTERY_RUN_POLICIES: Record<BatteryTask, AiDataRunPolicyDraft> = {
  soc: { mode: "interval", intervalSeconds: 10, windowRows: 120, minimumSamples: 20, maxAgeSeconds: 30, maximumMissingRate: 0.1, entityField: "", timeField: "" },
  soh: { mode: "interval", intervalSeconds: 3_600, windowRows: 100, minimumSamples: 30, maxAgeSeconds: 7_200, maximumMissingRate: 0.1, entityField: "", timeField: "" },
  rul: { mode: "interval", intervalSeconds: 86_400, windowRows: 100, minimumSamples: 30, maxAgeSeconds: 172_800, maximumMissingRate: 0.1, entityField: "", timeField: "" },
  combined: { mode: "interval", intervalSeconds: 86_400, windowRows: 100, minimumSamples: 30, maxAgeSeconds: 172_800, maximumMissingRate: 0.1, entityField: "", timeField: "" },
};

export type DatasetContractAssessments = Map<string, BatteryDataContractAssessment[]>;

export function exampleSupportsBatteryTask(example: BatteryExample, task: BatteryTask) {
  return task === "combined"
    ? COMBINED_BATTERY_MODELS.every(({ task: item }) => example.tasks.includes(item))
    : example.tasks.includes(task);
}

export function batteryDatasetFields(dataset: DataDatasetRecord) {
  return [...dataset.fields, ...(dataset.computedFields ?? [])];
}

export function optionalPositiveNumber(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须是正数`);
  return number;
}

export function positiveOrUndefined(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function requiredRange(value: string, label: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label}必须在 ${minimum}–${maximum} 之间`);
  return number;
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}
