/**
 * Plant Lite 的统一引擎端口适配器(PS/PD/Plant R0)。
 * 同步内核经此接入 `SimulationEnginePort`:validate → prepare(进度可观测)→ run → result → trace。
 * 本文件不新增任何统计语义;指纹与信封是唯一增量。
 */

import {
  fingerprint64Labeled,
  SimulationPortError,
  summarizeValidation,
  type SimulationEngineDescriptor,
  type SimulationEnginePort,
  type SimulationEngineRunOptions,
  type SimulationIssueSeverity,
  type SimulationRunRecord,
  type SimulationRunRequest,
  type SimulationTraceEnvelope,
  type SimulationValidationIssue,
  type SimulationValidationReport,
} from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "./engine.js";
import type { PlantLiteExperiment, PlantLiteExperimentResult, PlantLiteReplicationTrace } from "./model.js";
import type { PlantLiteModelIssue } from "./modelTypes.js";
import { validatePlantLiteModel } from "./modelValidation.js";

export const PLANT_LITE_TRACE_FORMAT_ID = "plant-lite-trace@1";

/** 与内核 `engineVersion: "1.0.0"` 保持一致;内核版本变更时两处同步。 */
export const PLANT_LITE_ENGINE_DESCRIPTOR: SimulationEngineDescriptor = {
  engineId: "plant-lite-des",
  engineVersion: "1.0.0",
  capabilities: ["discrete-event", "experiment"],
  deterministic: true,
  timeUnit: "minute",
};

function toIssueSeverity(): SimulationIssueSeverity {
  // 内核校验只产出阻塞问题;警告档位留给 R1 的容量/预热建议。
  return "error";
}

function toPortIssues(issues: readonly PlantLiteModelIssue[]): SimulationValidationIssue[] {
  return issues.map((issue) => ({
    severity: toIssueSeverity(),
    path: issue.path,
    message: issue.message,
  }));
}

function experimentInputFingerprint(request: SimulationRunRequest<PlantLiteExperiment>): string {
  return fingerprint64Labeled([
    ["engineId", PLANT_LITE_ENGINE_DESCRIPTOR.engineId],
    ["engineVersion", PLANT_LITE_ENGINE_DESCRIPTOR.engineVersion],
    ["input", request.input],
    ["seed", request.seed],
    ["replications", request.replications ?? request.input.replications],
  ]);
}

function aggregateTermination(result: PlantLiteExperimentResult): SimulationRunRecord<PlantLiteExperimentResult>["termination"] {
  // 零个重复只会在协作取消(首查即中断)时出现;校验失败在更早阶段抛错。
  if (result.replications.length === 0) return "cancelled";
  let sawCancelled = false;
  let sawLimit = false;
  for (const replication of result.replications) {
    if (replication.termination === "cancelled") sawCancelled = true;
    if (replication.termination === "limit-reached") sawLimit = true;
  }
  if (sawCancelled) return "cancelled";
  if (sawLimit) return "limit-reached";
  return "completed";
}

function traceEnvelope(result: PlantLiteExperimentResult): SimulationTraceEnvelope<PlantLiteReplicationTrace> | undefined {
  if (!result.representativeTrace) return undefined;
  return {
    formatId: PLANT_LITE_TRACE_FORMAT_ID,
    trace: result.representativeTrace,
    fingerprint: fingerprint64Labeled([
      ["formatId", PLANT_LITE_TRACE_FORMAT_ID],
      ["trace", result.representativeTrace],
    ]),
  };
}

export class PlantLiteSimulationEngine implements SimulationEnginePort<PlantLiteExperiment, PlantLiteExperimentResult, PlantLiteReplicationTrace> {
  public readonly descriptor = PLANT_LITE_ENGINE_DESCRIPTOR;

  public validate(input: PlantLiteExperiment): SimulationValidationReport {
    return summarizeValidation(toPortIssues(validatePlantLiteModel(input.model).issues));
  }

  public async run(
    request: SimulationRunRequest<PlantLiteExperiment>,
    options: SimulationEngineRunOptions = {},
  ): Promise<SimulationRunRecord<PlantLiteExperimentResult, PlantLiteReplicationTrace>> {
    const { onProgress } = request;
    onProgress?.({ phase: "validating" });
    const report = this.validate(request.input);
    if (!report.valid) {
      throw new SimulationPortError(
        `Plant Lite 模型校验失败(${report.errors.length} 项):${report.errors[0]?.message ?? ""}`,
        report.errors,
      );
    }

    onProgress?.({ phase: "preparing" });
    const inputFingerprint = experimentInputFingerprint(request);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    let abortedBySignal = false;
    const signal = options.signal;
    const onAbort = () => {
      abortedBySignal = true;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const requestedReplications = request.replications ?? request.input.replications;
      if (requestedReplications !== undefined) {
        onProgress?.({ phase: "running", totalReplications: requestedReplications });
      } else {
        onProgress?.({ phase: "running" });
      }
      // 端口层的 seed 是唯一权威;内核 input 自带的 seed 字段一律被请求种子覆盖。
      const experiment: PlantLiteExperiment = {
        ...request.input,
        seed: request.seed,
        ...(requestedReplications === undefined ? {} : { replications: requestedReplications }),
      };
      const result = runPlantLiteExperiment(
        experiment,
        {
          shouldCancel: () => abortedBySignal || request.shouldCancel?.() === true,
          onReplicationCompleted: (completed, total) => {
            onProgress?.({ phase: "running", completedReplications: completed, totalReplications: total });
          },
        },
      );
      onProgress?.({ phase: "tracing" });
      const trace = traceEnvelope(result);
      const completedAtMs = Date.now();
      const termination = aggregateTermination(result);
      onProgress?.({ phase: "completed", completedReplications: result.replications.length });
      return {
        descriptor: this.descriptor,
        seed: request.seed,
        replications: result.replications.length,
        termination,
        inputFingerprint,
        resultFingerprint: fingerprint64Labeled([
          ["engineId", this.descriptor.engineId],
          ["engineVersion", this.descriptor.engineVersion],
          ["inputFingerprint", inputFingerprint],
          ["result", result],
        ]),
        ...(trace ? { trace } : {}),
        result,
        wallClock: {
          startedAt,
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
        },
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** 共享单例:端口无状态,避免每次调用重建。 */
export const plantLiteSimulationEngine = new PlantLiteSimulationEngine();
