import { createHash, randomUUID } from "node:crypto";
import type { AiReliabilityAssessment } from "./aiReliabilityPolicy.js";

export type AiReliabilityAuditStage = "input-assessment" | "model-completion" | "tool-decision" | "tool-result";
export type AiReliabilityAuditOutcome = "allowed" | "constrained" | "denied" | "completed" | "degraded" | "failed" | "cancelled";

export interface AiReliabilityAuditEvent {
  eventId: string;
  traceId: string;
  occurredAt: string;
  policyVersion: string;
  stage: AiReliabilityAuditStage;
  outcome: AiReliabilityAuditOutcome;
  principal: string;
  projectId?: string;
  providerId?: string;
  model?: string;
  tool?: { id: string; risk: string; resourceFingerprints: string[] };
  findings: Array<{ code: string; severity: string; sourceId: string; contentFingerprint: string }>;
  inputFingerprint: string;
  failure?: { code: string; message: string; retryable: boolean };
  evidenceFingerprint: string;
}

export type AiReliabilityAuditSink = (event: AiReliabilityAuditEvent) => void | Promise<void>;

export interface CreateAiAuditEventInput {
  traceId: string;
  stage: AiReliabilityAuditStage;
  outcome: AiReliabilityAuditOutcome;
  principal: string;
  projectId?: string;
  providerId?: string;
  model?: string;
  assessment?: AiReliabilityAssessment;
  tool?: AiReliabilityAuditEvent["tool"];
  inputFingerprint?: string;
  failure?: AiReliabilityAuditEvent["failure"];
  now?: () => Date;
}

/** 审计记录只保存指纹和判定，不复制用户原文、检索内容、参数或密钥。 */
export function createAiAuditEvent(input: CreateAiAuditEventInput): AiReliabilityAuditEvent {
  const base = {
    eventId: randomUUID(),
    traceId: input.traceId,
    occurredAt: (input.now?.() ?? new Date()).toISOString(),
    policyVersion: input.assessment?.policyVersion ?? "2026-08-30.1",
    stage: input.stage,
    outcome: input.outcome,
    principal: input.principal,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    findings: (input.assessment?.findings ?? []).map(({ code, severity, sourceId, contentFingerprint }) => ({ code, severity, sourceId, contentFingerprint })),
    inputFingerprint: input.inputFingerprint ?? input.assessment?.inputFingerprint ?? fingerprint("empty-input"),
    ...(input.failure ? { failure: input.failure } : {}),
  };
  return { ...base, evidenceFingerprint: fingerprint(base) };
}

/** 供测试和单进程部署使用；生产环境应把 sink 接到现有持久化审计存储。 */
export class AiReliabilityAuditBuffer {
  readonly #events: AiReliabilityAuditEvent[] = [];
  public constructor(private readonly limit = 2_000) {}
  public readonly sink: AiReliabilityAuditSink = (event) => {
    this.#events.push(structuredClone(event));
    if (this.#events.length > this.limit) this.#events.splice(0, this.#events.length - this.limit);
  };
  public list(): AiReliabilityAuditEvent[] { return structuredClone(this.#events); }
}

export async function emitAiAudit(sink: AiReliabilityAuditSink | undefined, event: AiReliabilityAuditEvent, required = false): Promise<void> {
  if (!sink) {
    if (required) throw new Error("高风险 AI 工具缺少审计存储");
    return;
  }
  try { await sink(event); }
  catch (error) {
    if (required) throw new Error(`AI 审计写入失败：${safeErrorMessage(error)}`);
  }
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:bearer\s+|api[_ -]?key[=:]\s*|token[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 300);
}

export function auditFingerprint(value: unknown): string { return fingerprint(canonical(value)); }

function fingerprint(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
}
