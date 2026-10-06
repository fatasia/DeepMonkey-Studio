/**
 * J4 渲染能力协商合同 —— 渲染能力登记表(单源清单,shared by Studio and native hosts)。
 *
 * == 为什么需要这张表 ==
 * 过渡期(单源化铺完前)每个新渲染能力必须在"任一端"落地的同时在 capacities 登记
 * **双端状态**。缺少这张表时,能力经常只在一端实现而另一端静默缺失/降级,验收
 * 只看实现端就会误报"完成"。本清单把"悄悄只做一边"变成结构化可测事实:
 * 每个 capability id 必须同时给出 web(Studio/TS)与 native(deep-engine-native/Rust)
 * 的支持档 + 原因码 + 文件证据。
 *
 * == 词汇 ==
 * - 支持档:`supported / degraded / unavailable`(封闭集,与 native
 *   `host_capabilities/rt_probe.rs::RtSupport` 的"支持档+原因档+记录式理由"先例同构)。
 * - 原因码:封闭集,见 `RENDERER_CAPABILITY_REASON_CODES`;每档有合法配对集
 *   (`reasonPairsForSupport`),配对非法视为清单损坏。
 * - 质量档词汇沿用既有跨端合同:DeepGiQuality = performance|balanced|quality
 *   (deep-engine probeClipmapPlan.ts,注释明示 shared by Studio and native hosts);
 *   native quality_profile.rs 把作者档 quality 解析为 High 并在遥测写回 quality。
 *
 * == 纪律(强制) ==
 * 1. 新能力落地(任一端)必须在 `RENDERER_CAPABILITY_MANIFEST` 登记双端状态与原因;
 *    只做一端 = 清单漂移,会被对拍/覆盖率测试打红。
 * 2. 状态变化必须同步更新证据(evidence 指向真实文件,测试断言文件存在)。
 * 3. TS 侧实际面自检导出:`deep-engine/src/webgpu/rendererCapabilitySelfCheck.ts`
 *    (从 PbrRendererFeatures/计时 pass 清单/GI 方向门等实际代码面派生);
 *    Rust 侧同形声明:`deep-engine-native/src/renderer_capability_manifest.rs`。
 *    双端与金样 `fixtures/renderer-capability-manifest.json` 三方对拍。
 * 4. 结构先例:deep-engine pbrTimedPassIds.ts(冻结 id 数组+构建期漂移校验)、
 *    native rt_probe(支持+原因+理由)、probeRadianceDirectionGate(能力常量+加载期断言)。
 */

import { RENDERER_CAPABILITY_MANIFEST } from "./rendererCapabilityManifestEntries.js";

/** 支持档封闭词汇。 */
export const RENDERER_CAPABILITY_SUPPORT_VOCABULARY = Object.freeze([
  "supported",
  "degraded",
  "unavailable",
] as const);

export type RendererCapabilitySupport = (typeof RENDERER_CAPABILITY_SUPPORT_VOCABULARY)[number];

/** 原因码封闭词汇(kebab-case,与 native serde rename_all="kebab-case" 逐词一致)。 */
export const RENDERER_CAPABILITY_REASON_CODES = Object.freeze([
  /** 该端完整实现,语义达到能力定义。 */
  "full",
  /** 完整实现但默认关闭(opt-in),开启即得完整语义。 */
  "opt-in-default-off",
  /** 该端仅验收/参考 harness(CPU 参考或金样对拍),非运行时通路。 */
  "harness-only",
  /** 有实现,但范围/档位低于能力定义(降级存在,原因必须写进 evidence)。 */
  "reduced-tier",
  /** 该端没有实现。 */
  "absent",
  /** 底层 API 缺席(如 wgpu 30 不暴露 ray tracing),与实现无关。 */
  "api-missing",
  /** 能力按设计只属于某类宿主(如 WebGPU 时间历史 vs native 直出通路)。 */
  "host-specific",
] as const);

export type RendererCapabilityReasonCode = (typeof RENDERER_CAPABILITY_REASON_CODES)[number];

/** 支持档 → 合法原因码集合。双端校验与 native 端镜像必须逐词一致。 */
export const REASON_PAIRS_FOR_SUPPORT: Readonly<Record<RendererCapabilitySupport, readonly RendererCapabilityReasonCode[]>> = Object.freeze({
  supported: Object.freeze(["full", "opt-in-default-off", "harness-only"] as const),
  degraded: Object.freeze(["opt-in-default-off", "harness-only", "reduced-tier"] as const),
  unavailable: Object.freeze(["absent", "api-missing", "host-specific"] as const),
});

/** 合同版本:清单结构变化(增删字段/词汇)时递增,金样与 native 端同步。 */
export const RENDERER_CAPABILITY_CONTRACT_VERSION = 1;

/** 单端声明。 */
export interface RendererCapabilityEndDeclaration {
  readonly support: RendererCapabilitySupport;
  readonly reason: RendererCapabilityReasonCode;
  /** 文件证据:仓库根相对路径(可带 `:符号/行` 后缀),指向当前真实实现。 */
  readonly evidence: string;
}

/** 登记表行:一个渲染能力的双端状态。 */
export interface RendererCapabilityManifestEntry {
  readonly id: string;
  readonly title: string;
  /** 该能力覆盖的 Web `PbrRendererFeatures` 特性键(可为空;非特性面能力如材质 ABI)。 */
  readonly webFeatureKeys: readonly string[];
  readonly web: RendererCapabilityEndDeclaration;
  readonly native: RendererCapabilityEndDeclaration;
  /** 质量档词汇是否与跨端合同同词(performance/balanced/quality)。 */
  readonly sharedQualityVocabulary?: boolean;
}

/**
 * evidence 里的仓库路径:截掉 `:符号/行` 与紧跟路径的 `(说明)` 后缀,
 * 只留可用于 fs 存在性断言的仓库相对路径。
 */
export function rendererCapabilityEvidencePath(evidence: string): string {
  const colon = evidence.indexOf(":");
  const base = colon === -1 ? evidence : evidence.slice(0, colon);
  const paren = base.indexOf("(");
  return paren === -1 ? base : base.slice(0, paren);
}

/** 单端声明的结构校验:返回问题列表,空数组=合法。 */
export function rendererCapabilityDeclarationIssues(
  end: RendererCapabilityEndDeclaration, endName: string, id: string): string[] {
  const issues: string[] = [];
  if (!(RENDERER_CAPABILITY_SUPPORT_VOCABULARY as readonly string[]).includes(end.support)) {
    issues.push(`${id}[${endName}] 未知支持档 ${String(end.support)}`);
  }
  if (!(RENDERER_CAPABILITY_REASON_CODES as readonly string[]).includes(end.reason)) {
    issues.push(`${id}[${endName}] 未知原因码 ${String(end.reason)}`);
    return issues;
  }
  const allowed = REASON_PAIRS_FOR_SUPPORT[end.support];
  if (allowed && !allowed.includes(end.reason)) {
    issues.push(`${id}[${endName}] 支持档 ${end.support} 不允许原因码 ${end.reason}(允许:${allowed.join("|")})`);
  }
  if (!end.evidence || !rendererCapabilityEvidencePath(end.evidence).endsWith(".ts")
    && !rendererCapabilityEvidencePath(end.evidence).endsWith(".rs")) {
    issues.push(`${id}[${endName}] 证据必须是 .ts/.rs 仓库路径:${end.evidence}`);
  }
  return issues;
}

/**
 * 渲染能力登记行集(体量门拆分):行集原文整体迁至
 * `rendererCapabilityManifestEntries.ts`,此处 re-export 保持消费方、`index.ts`
 * 导出面与金样对拍口径不变;行序稳定合同不变(金样/native include_str! 依赖)。
 */
export { RENDERER_CAPABILITY_MANIFEST };

/** 能力 id 单源冻结数组(结构先例:pbrTimedPassIds.PBR_TIMED_PASS_IDS)。 */
export const RENDERER_CAPABILITY_IDS = Object.freeze(
  RENDERER_CAPABILITY_MANIFEST.map((entry) => entry.id),
);

/** 按 id 取登记行;未知 id 返回 undefined(调用方必须显式处理,不得静默)。 */
export function findRendererCapabilityEntry(id: string): RendererCapabilityManifestEntry | undefined {
  return RENDERER_CAPABILITY_MANIFEST.find((entry) => entry.id === id);
}

/** 覆盖率缺口结构:每类缺口列出能力 id 与说明。 */
export interface RendererCapabilityCoverageReport {
  readonly missingWeb: readonly string[];
  readonly missingNative: readonly string[];
  readonly invalidDeclarations: readonly string[];
  readonly duplicateIds: readonly string[];
}

/**
 * 清单结构校验:双端声明齐全 + 词汇合法 + id 唯一。
 * 返回空缺口 = 清单自洽;任何非空缺口都应让覆盖率测试红。
 */
export function rendererCapabilityCoverageReport(
  entries: readonly RendererCapabilityManifestEntry[] = RENDERER_CAPABILITY_MANIFEST,
): RendererCapabilityCoverageReport {
  const missingWeb: string[] = [];
  const missingNative: string[] = [];
  const invalidDeclarations: string[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicateIds.push(entry.id);
    seen.add(entry.id);
    if (!entry.web) missingWeb.push(entry.id);
    if (!entry.native) missingNative.push(entry.id);
    if (entry.web) invalidDeclarations.push(...rendererCapabilityDeclarationIssues(entry.web, "web", entry.id));
    if (entry.native) invalidDeclarations.push(...rendererCapabilityDeclarationIssues(entry.native, "native", entry.id));
  }
  return Object.freeze({
    missingWeb: Object.freeze(missingWeb),
    missingNative: Object.freeze(missingNative),
    invalidDeclarations: Object.freeze(invalidDeclarations),
    duplicateIds: Object.freeze(duplicateIds),
  });
}

/** 金样 JSON(提交于 fixtures/renderer-capability-manifest.json,native 端 include_str! 消费)。 */
export function rendererCapabilityManifestJson(): string {
  return JSON.stringify({
    contractVersion: RENDERER_CAPABILITY_CONTRACT_VERSION,
    entries: RENDERER_CAPABILITY_MANIFEST,
  }, null, 2) + "\n";
}
