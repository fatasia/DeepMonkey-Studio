import { batteryBindingFeatures, type AiDataBinding, type BatteryDataContractAssessment, type DataDatasetRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { batteryExampleFile, type BatteryExample } from "../ai/batterySample";
import type { AiDataRunPolicyDraft } from "./AiDataRunPolicyFields";
import {
  COMBINED_BATTERY_MODELS,
  optionalPositiveNumber,
  requiredRange,
  type BatteryChemistry,
  type BatterySourceMode,
} from "./batteryIntelligenceConfig";

interface ExecutionSource {
  sourceMode: BatterySourceMode;
  selectedExample: BatteryExample;
  sourceFile: File | undefined;
  datasetId: string;
  nominalCapacity: string;
  chemistry: BatteryChemistry;
  targetRetention: string;
  dynamicRouting: boolean;
}

interface SingleExecutionInput extends ExecutionSource {
  projectId: string;
  selectedTask: { model: "socformer" | "bmsformer" | "batterymformer"; label: string; id: string };
  selectedDataset: DataDatasetRecord | undefined;
  bindings: AiDataBinding[];
  runPolicy: AiDataRunPolicyDraft;
  dataContract: BatteryDataContractAssessment;
  signal: AbortSignal;
}

export async function executeSingleBatteryPrediction(input: SingleExecutionInput) {
  input.signal.throwIfAborted();
  const capacity = input.sourceMode === "example"
    ? input.selectedExample.nominalCapacityAh
    : optionalPositiveNumber(input.nominalCapacity, "额定容量");
  const retention = input.selectedTask.id === "rul" ? requiredRange(input.targetRetention, "寿命阈值", 50, 100) : undefined;
  const common = {
    model: input.selectedTask.model,
    chemistry: input.chemistry,
    ...(input.selectedTask.model === "batterymformer" ? { routingMode: input.dynamicRouting ? "dynamic" as const : "standard" as const } : {}),
    ...(capacity !== undefined ? { nominalCapacityAh: capacity } : {}),
    ...(retention !== undefined ? { targetCapacityRetention: retention } : {}),
  };
  let bindingId: string | undefined;
  if (input.sourceMode === "dataset") {
    const dataset = input.selectedDataset;
    if (!dataset) throw new Error("选择的电池数据集已删除");
    const existing = input.bindings.find((item) => item.capabilityId === "battery.model.predict" && item.datasetId === dataset.id && item.parameters?.model === input.selectedTask.model);
    const binding = await api.saveAiDataBinding(input.projectId, {
      ...(existing ? { id: existing.id } : {}),
      name: `${input.selectedTask.label} · ${dataset.name}`,
      datasetId: dataset.id,
      capabilityId: "battery.model.predict",
      status: "active",
      parameters: common,
      ...(input.runPolicy.entityField ? { entity: { keyField: input.runPolicy.entityField } } : {}),
      ...(input.runPolicy.timeField ? { time: { field: input.runPolicy.timeField, order: "asc" } } : {}),
      features: batteryBindingFeatures(input.dataContract),
      window: { rows: input.runPolicy.windowRows },
      trigger: input.runPolicy.mode === "interval" ? { type: "interval", seconds: input.runPolicy.intervalSeconds } : { type: "manual" },
      quality: { minimumSamples: input.runPolicy.minimumSamples, maxAgeSeconds: input.runPolicy.maxAgeSeconds, maximumMissingRate: input.runPolicy.maximumMissingRate },
      retry: { maxAttempts: 3, backoffSeconds: 5 },
      output: { type: "record" },
    });
    bindingId = binding.id;
  }
  input.signal.throwIfAborted();
  const response = input.sourceMode === "example"
    ? await api.predictBatteryFromFile<Record<string, unknown>>(input.projectId, { ...common, file: await batteryExampleFile(input.selectedExample, input.signal) }, input.signal)
    : input.sourceMode === "dataset"
      ? await api.predictBatteryFromDataset<Record<string, unknown>>(input.projectId, { ...common, datasetId: input.datasetId, ...(bindingId ? { bindingId } : {}) }, input.signal)
      : await api.predictBatteryFromFile<Record<string, unknown>>(input.projectId, { ...common, file: input.sourceFile! }, input.signal);
  if (!response.output) throw new Error(response.error?.message ?? "模型没有返回结构化结果");
  return { response: { ...response, output: response.output }, bindingCreated: Boolean(bindingId) };
}

export async function executeCombinedBatteryPrediction(input: ExecutionSource & { projectId: string; signal: AbortSignal }) {
  const capacity = input.sourceMode === "example"
    ? input.selectedExample.nominalCapacityAh
    : optionalPositiveNumber(input.nominalCapacity, "额定容量");
  const retention = requiredRange(input.targetRetention, "寿命阈值", 50, 100);
  const file = input.sourceMode === "example"
    ? await batteryExampleFile(input.selectedExample, input.signal)
    : input.sourceMode === "file" ? input.sourceFile! : undefined;
  const outcomes = await Promise.allSettled(COMBINED_BATTERY_MODELS.map(async ({ task, model, label }) => {
    const common = {
      model,
      chemistry: input.chemistry,
      ...(model === "batterymformer" ? { routingMode: input.dynamicRouting ? "dynamic" as const : "standard" as const } : {}),
      ...(capacity !== undefined ? { nominalCapacityAh: capacity } : {}),
      ...(model === "batterymformer" ? { targetCapacityRetention: retention } : {}),
    };
    const response = file
      ? await api.predictBatteryFromFile<Record<string, unknown>>(input.projectId, { ...common, file }, input.signal)
      : await api.predictBatteryFromDataset<Record<string, unknown>>(input.projectId, { ...common, datasetId: input.datasetId }, input.signal);
    if (!response.output) throw new Error(response.error?.message ?? `${label} 模型没有返回结构化结果`);
    return { task, output: response.output, requestId: response.requestId };
  }));
  const combined: Record<string, unknown> = {};
  const failures: Array<{ label: string; message: string }> = [];
  let requestId = "";
  outcomes.forEach((outcome, index) => {
    const entry = COMBINED_BATTERY_MODELS[index]!;
    if (outcome.status === "fulfilled") {
      combined[entry.task] = outcome.value.output;
      requestId = requestId || outcome.value.requestId;
    } else {
      failures.push({ label: entry.label, message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    }
  });
  if (failures.length === COMBINED_BATTERY_MODELS.length) throw new Error(failures[0]!.message);
  combined.failures = failures;
  return { combined, requestId };
}
