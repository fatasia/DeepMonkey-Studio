import type { AssistantMode } from "../api";
import type { AiContextDelivery } from "@bim-studio/contracts";
import { readContextDelivery } from "./assistantContextDelivery";
import type { BimAssistantPreparedContext } from "../bimAssistant";

export type AssistantSourceState = "ready" | "partial" | "unavailable";

/**
 * 输入给助手的上下文来源。snapshot 只是本次请求快照，capability 才表示能力已真实执行。
 */
export interface AssistantContextSource {
  id: string;
  label: string;
  state: AssistantSourceState;
  kind: "snapshot" | "capability";
  count?: number;
  detail?: string;
}

export interface AssistantWorkspaceTarget {
  project?: { id?: string; name?: string };
  workspace?: string;
  scene?: { id?: string; name?: string; modelCount?: number };
  selected?: { id?: string; name?: string; kind?: string };
  script?: { id?: string; name?: string; language?: string; revision?: number };
  simulation?: { id?: string; name?: string; status?: string };
  dashboardWidgetCount?: number;
}

export type AssistantVerificationGrade =
  | "capability-verified"
  | "context-supported"
  | "limited"
  | "unverified";

export interface AssistantReliabilitySummary {
  contextDelivery?: AiContextDelivery;
  contextSourceLabels?: Record<string, string>;
  grade: AssistantVerificationGrade;
  contextTrust: "client-snapshot" | "server-evidence" | "capability-result";
  traceId?: string;
  contextFingerprint?: string;
  evidenceCount: number;
  inputRisk: "low" | "medium" | "high";
  writePolicy: "read-only" | "confirm-required";
  warnings: string[];
  sourceLabels: string[];
  fallbackReason?: "no-capability-evidence";
}

interface ReliabilityMetadata {
  contextDelivery?: unknown;
  traceId?: unknown;
  verification?: unknown;
  inputRisk?: unknown;
  contextFingerprint?: unknown;
  contextTrust?: unknown;
  evidenceCount?: unknown;
  warnings?: unknown;
  writePolicy?: unknown;
}

/** 仅提取产品界面需要展示的对象身份，不把未知大对象递归展开。 */
export function assistantWorkspaceTarget(context: unknown): AssistantWorkspaceTarget {
  const record = asRecord(context);
  const project = asRecord(record?.project);
  const scene = asRecord(record?.scene);
  const selected = asRecord(record?.selected);
  const dashboard = asRecord(record?.dashboard);
  const script = asRecord(record?.script);
  const simulation = asRecord(record?.simulation);
  const widgets = Array.isArray(dashboard?.widgets) ? dashboard.widgets : undefined;
  const projectId = stringValue(project?.id);
  const projectName = stringValue(project?.name);
  const sceneId = stringValue(scene?.id);
  const sceneName = stringValue(scene?.name);
  const sceneModelCount = numberValue(scene?.modelCount);
  const selectedId = stringValue(selected?.id);
  const selectedName = stringValue(selected?.name);
  const selectedKind = stringValue(selected?.kind);
  const workspace = stringValue(record?.currentView);
  const scriptId = stringValue(script?.id);
  const scriptName = stringValue(script?.name);
  const scriptLanguage = stringValue(script?.language);
  const scriptRevision = numberValue(script?.revision);
  const simulationId = stringValue(simulation?.id ?? simulation?.studyId);
  const simulationName = stringValue(simulation?.name);
  const simulationStatus = stringValue(simulation?.status);
  return {
    ...(project
      ? { project: { ...(projectId ? { id: projectId } : {}), ...(projectName ? { name: projectName } : {}) } }
      : {}),
    ...(workspace
      ? { workspace }
      : scene
        ? { workspace: "scene" }
        : {}),
    ...(scene
      ? {
          scene: {
            ...(sceneId ? { id: sceneId } : {}),
            ...(sceneName ? { name: sceneName } : {}),
            ...(sceneModelCount === undefined ? {} : { modelCount: sceneModelCount }),
          },
        }
      : {}),
    ...(selected
      ? {
          selected: {
            ...(selectedId ? { id: selectedId } : {}),
            ...(selectedName ? { name: selectedName } : {}),
            ...(selectedKind ? { kind: selectedKind } : {}),
          },
        }
      : {}),
    ...(script
      ? {
          script: {
            ...(scriptId ? { id: scriptId } : {}),
            ...(scriptName ? { name: scriptName } : {}),
            ...(scriptLanguage ? { language: scriptLanguage } : {}),
            ...(scriptRevision === undefined ? {} : { revision: scriptRevision }),
          },
        }
      : {}),
    ...(simulation
      ? {
          simulation: {
            ...(simulationId ? { id: simulationId } : {}),
            ...(simulationName ? { name: simulationName } : {}),
            ...(simulationStatus ? { status: simulationStatus } : {}),
          },
        }
      : {}),
    ...(widgets ? { dashboardWidgetCount: widgets.length } : {}),
  };
}

export function assistantContextReadiness(sources: AssistantContextSource[]): {
  ready: number;
  total: number;
  unavailable: number;
} {
  return {
    ready: sources.filter((source) => source.state === "ready").length,
    total: sources.length,
    unavailable: sources.filter((source) => source.state === "unavailable").length,
  };
}

/**
 * 后端若没有返回可靠性元数据，界面必须降级为“仅上下文支持”，不能把 LLM 文本冒充能力执行事实。
 */
export function assistantReliabilityFromResponse(
  response: unknown,
  mode: AssistantMode,
  sources: AssistantContextSource[],
  bimEvidence?: BimAssistantPreparedContext,
): AssistantReliabilitySummary {
  const responseRecord = asRecord(response);
  const nested = asRecord(responseRecord?.reliability);
  const metadata: ReliabilityMetadata = nested ?? responseRecord ?? {};
  const evidenceCount = Math.max(0, Math.floor(numberValue(metadata.evidenceCount) ?? 0));
  const verification = stringValue(metadata.verification);
  const sourceLabels = sources.filter((source) => source.state !== "unavailable").map((source) => source.label);
  const warnings = stringArray(metadata.warnings);
  const traceId = stringValue(metadata.traceId);
  const contextFingerprint = stringValue(metadata.contextFingerprint);
  const contextAvailable = sourceLabels.length > 0 || Boolean(bimEvidence);
  const limitedBim = mode === "bim" && bimEvidence?.confidence === "insufficient";
  const contextDelivery = readContextDelivery(metadata.contextDelivery);
  return {
    ...(contextDelivery ? { contextDelivery, contextSourceLabels: Object.fromEntries(sources.map((source) => [source.id, source.label])) } : {}),
    grade: verificationGrade({
      evidenceCount,
      ...(verification ? { verification } : {}),
      limitedBim,
      contextAvailable,
    }),
    ...(traceId ? { traceId } : {}),
    ...(contextFingerprint ? { contextFingerprint } : {}),
    evidenceCount,
    contextTrust: trustValue(metadata.contextTrust, evidenceCount),
    inputRisk: riskValue(metadata.inputRisk),
    writePolicy: metadata.writePolicy === "confirm-required" ? "confirm-required" : "read-only",
    warnings,
    sourceLabels,
    ...(warnings.length === 0 && evidenceCount === 0 ? { fallbackReason: "no-capability-evidence" as const } : {}),
  };
}

/** 问数结果来自真实 Capability 调用，因此可以展示 trace 和证据指纹。 */
export function queryCapabilityReliability(input: {
  traceId?: string;
  evidenceCount: number;
  warnings?: string[];
  evidenceFingerprint?: string;
  sourceLabel: string;
}): AssistantReliabilitySummary {
  return {
    grade: input.evidenceCount > 0 || Boolean(input.evidenceFingerprint) ? "capability-verified" : "limited",
    contextTrust: "capability-result",
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.evidenceFingerprint ? { contextFingerprint: input.evidenceFingerprint } : {}),
    evidenceCount: input.evidenceCount,
    inputRisk: "low",
    writePolicy: "read-only",
    warnings: input.warnings ?? [],
    sourceLabels: [input.sourceLabel],
  };
}

export function sourceFromSettled<T>(
  id: string,
  label: string,
  result: PromiseSettledResult<T>,
  count: (value: T) => number | undefined,
): AssistantContextSource {
  if (result.status === "rejected") {
    return { id, label, state: "unavailable", kind: "snapshot" };
  }
  const sourceCount = count(result.value);
  return {
    id,
    label,
    state: "ready",
    kind: "snapshot",
    ...(sourceCount === undefined ? {} : { count: sourceCount }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function riskValue(value: unknown): "low" | "medium" | "high" {
  return value === "medium" || value === "high" ? value : "low";
}

function trustValue(
  value: unknown,
  evidenceCount: number,
): "client-snapshot" | "server-evidence" | "capability-result" {
  if (value === "server-evidence" || value === "capability-result") return value;
  return evidenceCount > 0 ? "server-evidence" : "client-snapshot";
}

function verificationGrade(input: {
  evidenceCount: number;
  verification?: string;
  limitedBim: boolean;
  contextAvailable: boolean;
}): AssistantVerificationGrade {
  if (input.evidenceCount > 0 && input.verification === "verified") return "capability-verified";
  if (input.verification === "limited" || input.limitedBim) return "limited";
  if (input.verification === "unverified") return "unverified";
  return input.contextAvailable ? "context-supported" : "unverified";
}
