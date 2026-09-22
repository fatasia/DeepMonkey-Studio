export type PublicationCapabilityStatus = "supported" | "degraded" | "blocked" | "webview-only";
export type ScenePublicationTarget = "three-webview" | "deep-native";

export interface PublicationCapabilityItem {
  readonly sceneId: string;
  readonly objectId: string;
  readonly path: string;
  readonly capability: string;
  readonly status: PublicationCapabilityStatus;
  readonly reason: string;
  readonly remediation: string;
  readonly evidenceIds: readonly string[];
}

/** 证据只适用于指定编译、产物和样本，静态转换通过不代表原生窗口可运行。 */
export interface PublicationCapabilityEvidence {
  readonly id: string;
  readonly capability: string;
  readonly target: ScenePublicationTarget;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly scope: "static-render-packet" | "native-window" | "web-runtime";
  readonly fixtureId: string;
  readonly platform: string;
}

interface PublicationEvidenceContext {
  readonly target: ScenePublicationTarget;
  readonly sceneId: string;
  /** 直接使用编译结果的 sourceSemanticHash，不另算一套源身份。 */
  readonly contentFingerprint: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly fixtureId: string;
  readonly platform: string;
  readonly evidence: readonly PublicationCapabilityEvidence[];
}

export interface ScenePublicationCompatibilityInput extends PublicationEvidenceContext {
  /** 能力集合只定义已知名称，支持与否由每项的运行证据决定。 */
  readonly profile: { readonly version: string; readonly capabilities: readonly string[] };
  readonly items: readonly PublicationCapabilityItem[];
}

export interface ScenePublicationCompatibilityReport extends PublicationEvidenceContext {
  readonly schemaVersion: 1;
  readonly capabilityProfileVersion: string;
  readonly items: readonly PublicationCapabilityItem[];
  readonly status: "ready" | "confirmation-required" | "blocked";
}

/**
 * 汇总可信检查器的结果。调用者负责遍历全部场景能力并验证证据真实性；
 * 本函数不执行编译、不判断能力覆盖完整性，ready 仅表示传入的检查项通过。
 */
export function summarizeScenePublicationCompatibility(input: ScenePublicationCompatibilityInput): ScenePublicationCompatibilityReport {
  validateContext(input);
  const capabilities = new Set(input.profile.capabilities);
  const evidenceIds = input.evidence.map((entry) => entry.id);
  const duplicateEvidence = duplicates(evidenceIds);
  const evidence = new Map(input.evidence.map((entry) => [entry.id, entry]));
  const duplicateItems = duplicates(input.items.map(itemKey));
  const items = input.items.map((item): PublicationCapabilityItem => {
    const copy = { ...item, evidenceIds: [...item.evidenceIds] };
    const failure = itemFailure(item, input, capabilities, duplicateItems);
    if (failure) return block(copy, failure);
    if (item.status === "blocked") return copy;
    if (item.status === "webview-only" && input.target === "deep-native") return copy;
    // Degraded capabilities are explicitly optional fallbacks. They must carry
    // a reason/remediation, but do not require runtime evidence for a feature
    // that is intentionally omitted from the target package.
    const omittedOptional = item.status === "degraded" && input.target === "deep-native"
      && ["postProcessing", "weather", "measurements", "annotations", "camera", "navigationSettings", "lighting"].includes(item.path)
      && item.objectId === input.sceneId && item.evidenceIds.length === 0;
    if (!omittedOptional && (item.evidenceIds.length === 0 || new Set(item.evidenceIds).size !== item.evidenceIds.length)) {
      return block(copy, "缺少唯一且可追溯的运行证据。");
    }
    for (const id of item.evidenceIds) {
      const proof = evidence.get(id);
      if (duplicateEvidence.has(id) || !proof || !matchesEvidence(proof, item, input)) {
        return block(copy, "运行证据与本次能力、编译、产物或样本范围不匹配。");
      }
    }
    return copy;
  });
  const blocked = items.some((item) => item.status === "blocked" || (item.status === "webview-only" && input.target === "deep-native"));
  return {
    schemaVersion: 1, target: input.target, sceneId: input.sceneId,
    contentFingerprint: input.contentFingerprint, compileGraphHash: input.compileGraphHash,
    targetArtifactHash: input.targetArtifactHash, fixtureId: input.fixtureId, platform: input.platform,
    capabilityProfileVersion: input.profile.version, evidence: input.evidence.map((entry) => ({ ...entry })), items,
    status: blocked ? "blocked" : items.some((item) => item.status === "degraded") ? "confirmation-required" : "ready",
  };
}

function itemFailure(item: PublicationCapabilityItem, input: ScenePublicationCompatibilityInput, known: Set<string>, duplicateItems: Set<string>): string | undefined {
  if (item.sceneId !== input.sceneId || ![item.objectId, item.path, item.reason, item.remediation].every(nonblank)) return "能力项缺少对象定位、原因或替代路径。";
  if (!known.has(item.capability)) return "能力不在本次发布能力配置中。";
  if (!["supported", "degraded", "blocked", "webview-only"].includes(item.status)) return "能力状态未知。";
  if (duplicateItems.has(itemKey(item))) return "同一对象路径的能力检查重复，无法确定结果。";
  return undefined;
}

function matchesEvidence(proof: PublicationCapabilityEvidence, item: PublicationCapabilityItem, input: ScenePublicationCompatibilityInput): boolean {
  return nonblank(proof.id) && proof.capability === item.capability && proof.target === input.target
    && proof.sourceSemanticHash === input.contentFingerprint && proof.compileGraphHash === input.compileGraphHash
    && proof.targetArtifactHash === input.targetArtifactHash && proof.fixtureId === input.fixtureId
    && proof.platform === input.platform
    && (input.target === "deep-native" ? proof.scope === "native-window" && proof.platform === "windows-x64" : proof.scope === "web-runtime");
}

function validateContext(input: ScenePublicationCompatibilityInput): void {
  const hash = /^[a-f0-9]{64}$/;
  if (!["deep-native", "three-webview"].includes(input.target)
    || ![input.sceneId, input.fixtureId, input.platform, input.profile.version].every(nonblank)
    || ![input.contentFingerprint, input.compileGraphHash, input.targetArtifactHash].every((value) => hash.test(value))
    || input.items.length === 0 || input.profile.capabilities.some((value) => !nonblank(value))
    || new Set(input.profile.capabilities).size !== input.profile.capabilities.length) {
    throw new Error("发布兼容报告缺少有效的内容、编译、产物、样本或能力检查上下文。");
  }
}

function block(item: PublicationCapabilityItem, reason: string): PublicationCapabilityItem {
  return { ...item, status: "blocked", reason: item.status === "blocked" ? `${item.reason} ${reason}` : reason,
    remediation: item.status === "blocked" && nonblank(item.remediation) ? item.remediation : "补齐当前目标和样本的运行证据后重新检查，或选择已验证的交付方式。" };
}
function nonblank(value: string): boolean { return typeof value === "string" && value.trim().length > 0; }
function itemKey(item: PublicationCapabilityItem): string { return JSON.stringify([item.sceneId, item.objectId, item.path, item.capability]); }
function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const value of values) { if (seen.has(value)) repeated.add(value); seen.add(value); }
  return repeated;
}
