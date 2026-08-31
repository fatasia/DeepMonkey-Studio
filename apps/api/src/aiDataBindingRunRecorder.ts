import { randomUUID } from "node:crypto";
import type {
  AiDataBinding,
  AiDataBindingRunRecord,
  DataSourceEvidence,
} from "@bim-studio/contracts";
import type { MetadataStore } from "./metadataStore.js";

/** 运行历史只保存标量摘要和来源证据，避免把模型大结果写入项目元数据。 */
export async function startAiDataBindingRun(
  store: MetadataStore,
  binding: AiDataBinding,
  attempt = 1,
): Promise<AiDataBindingRunRecord> {
  const now = new Date().toISOString();
  return store.saveAiDataBindingRun(binding.projectId, {
    id: randomUUID(),
    projectId: binding.projectId,
    bindingId: binding.id,
    bindingRevision: binding.revision,
    capabilityId: binding.capabilityId,
    datasetId: binding.datasetId,
    trigger: structuredClone(binding.trigger),
    status: "running",
    attempt,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  });
}

export async function succeedAiDataBindingRun(
  store: MetadataStore,
  run: AiDataBindingRunRecord,
  binding: AiDataBinding,
  sourceEvidence: DataSourceEvidence,
  output: unknown,
): Promise<AiDataBindingRunRecord> {
  const completedAt = new Date().toISOString();
  return store.saveAiDataBindingRun(run.projectId, {
    ...run,
    status: "succeeded",
    input: { sourceEvidence, sampleCount: sourceEvidence.rowCount },
    output: {
      type: binding.output.type,
      ...outputSummary(output),
    },
    completedAt,
    durationMs: duration(run.startedAt, completedAt),
    updatedAt: completedAt,
  });
}

export async function failAiDataBindingRun(
  store: MetadataStore,
  run: AiDataBindingRunRecord,
  error: unknown,
  sourceEvidence?: DataSourceEvidence,
): Promise<AiDataBindingRunRecord> {
  const completedAt = new Date().toISOString();
  return store.saveAiDataBindingRun(run.projectId, {
    ...run,
    status: "failed",
    ...(sourceEvidence ? { input: { sourceEvidence, sampleCount: sourceEvidence.rowCount } } : {}),
    failure: { message: compactError(error), retryable: true },
    completedAt,
    durationMs: duration(run.startedAt, completedAt),
    updatedAt: completedAt,
  });
}

function outputSummary(value: unknown): Pick<NonNullable<AiDataBindingRunRecord["output"]>, "summary" | "metrics"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { summary: "能力运行成功" };
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.slice(0, 500) : "能力运行成功";
  const metrics: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(record).slice(0, 30)) {
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
      metrics[key] = typeof item === "string" ? item.slice(0, 300) : item as number | boolean | null;
    }
  }
  return { summary, ...(Object.keys(metrics).length ? { metrics } : {}) };
}

function duration(startedAt: string | undefined, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt ?? completedAt));
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 500);
}
