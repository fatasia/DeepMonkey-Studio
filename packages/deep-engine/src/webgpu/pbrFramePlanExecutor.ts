import { BENCHMARK_SAMPLE_SCHEMA_VERSION, createSampleWindow, type ChannelSample, type SampleWindow } from "../benchmarkSampleSchema.js";
import type { RenderGraphBuilder, RenderPassDescriptor, RenderResourceLifetime } from "../renderGraph.js";
import { buildPbrFrameGraph, type PbrFrameGraphOptions } from "./pbrFrameGraph.js";
import { describePbrOpaquePass } from "./pbrOpaquePass.js";
import { describePbrPresentPasses } from "./pbrOutputBindings.js";
import { pbrFrameResourceContract, resolvePbrFrameResourceSizes, type PbrActualPassDescription,
  type PbrFrameResourceSizeRole, type FramePlanUsage } from "./pbrFramePlanResources.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { SurfaceSize } from "./surfaceSize.js";
import { PbrTransparencyPass } from "./pbrTransparencyPass.js";
import { PbrPostProcessChain } from "./pbrPostProcessChain.js";

/** DE26/B03 第一切片:把 compilePbrFrameGraph 的编译计划落成可执行、可对拍、可回执的执行计划。 */

export interface PbrPlannedPassResource {
  readonly id: string;
  readonly access: "read" | "write";
  readonly format: string;
  readonly sampleCount: number;
  readonly usages: readonly FramePlanUsage[];
  readonly sizeRole: PbrFrameResourceSizeRole;
  /** independent 资源(图集/金字塔/buffer)尺寸独立于主帧,不展开 width/height。 */
  readonly width?: number;
  readonly height?: number;
}

export type PbrPassMapping =
  | { readonly status: "mapped"; readonly executor: string }
  | { readonly status: "unmapped"; readonly reason: string };

export interface PbrPlannedPass {
  readonly passId: string;
  readonly kind: string;
  readonly order: number;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly resources: readonly PbrPlannedPassResource[];
  readonly mapping: PbrPassMapping;
}

export interface PbrPlannedResourceLifetime extends RenderResourceLifetime {
  readonly historyRole?: "previous" | "next";
}

export interface PbrFrameExecutionPlan {
  readonly transparency: boolean;
  readonly surface: SurfaceSize;
  /** 编译计划的拓扑序(可追踪性基准)。 */
  readonly passOrder: readonly string[];
  readonly passes: readonly PbrPlannedPass[];
  readonly resourceLifetimes: readonly PbrPlannedResourceLifetime[];
  readonly mappedPassIds: readonly string[];
  readonly unmappedPassIds: readonly string[];
}

/** passId ↔ 实际执行体:AO→TAA→Bloom 子链、OIT、opaque/present 的第一切片映射。 */
const MAPPED_EXECUTORS: Readonly<Record<string, string>> = Object.freeze({
  "opaque": "PbrRenderer main pass via beginPbrOpaquePass",
  "ambient-occlusion": "AmbientOcclusionPass.encode",
  "apply-ambient-occlusion": "AmbientOcclusionCompositePass.encode",
  "transparent-oit": "PbrTransparencyPass.encode → WeightedOitPass accumulation",
  "composite-oit": "PbrTransparencyPass.encode → WeightedOitPass.encodeComposite",
  "temporal-aa": "TemporalAaPass.encode",
  "bloom": "BloomPass.encode (AuthorBloomPass shares the plan slot)",
  "present": "PbrOutputBindings.present",
});

const UNMAPPED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  "deform": "GPU 变形编码(packets.encodeDeformation)未纳入第一切片",
  "visibility": "GPU 可见性剔除(packets.encodeCulling)未纳入第一切片",
  "shadows": "阴影级联渲染未纳入第一切片",
  "cluster-lights": "Forward+ 光源聚类未纳入第一切片",
  "build-hiz": "Hi-Z 构建(HiZPyramid)未纳入第一切片",
  "publish-hiz": "Hi-Z 跨帧发布(PreviousHiZVisibility)未纳入第一切片",
});

function validateGraphAgainstContracts(compiledResources: readonly RenderResourceLifetime[]): void {
  for (const resource of compiledResources) {
    const contract = pbrFrameResourceContract(resource.id);
    if (contract.descriptor !== resource.descriptor) {
      throw new Error(`Frame graph resource ${resource.id} descriptor drifted from the plan contract: ${resource.descriptor} !== ${contract.descriptor}.`);
    }
    if (contract.external !== resource.external) {
      throw new Error(`Frame graph resource ${resource.id} external flag drifted from the plan contract.`);
    }
  }
}

function plannedResources(pass: RenderPassDescriptor, sizes: ReadonlyMap<string, SurfaceSize>): readonly PbrPlannedPassResource[] {
  const claims: PbrPlannedPassResource[] = [];
  for (const access of ["read", "write"] as const) {
    for (const id of access === "read" ? pass.inputs ?? [] : pass.outputs ?? []) {
      const contract = pbrFrameResourceContract(id);
      const size = sizes.get(id);
      claims.push(Object.freeze({
        id, access, format: contract.format ?? contract.descriptor, sampleCount: contract.sampleCount,
        usages: Object.freeze([...contract.usages]), sizeRole: contract.sizeRole,
        ...(size ? { width: size.width, height: size.height } : {}),
      }));
    }
  }
  return claims;
}

/** 从编译计划生成有序执行计划;图与资源目录漂移、计划无效都显式报错。 */
export function buildPbrFrameExecutionPlan(surface: SurfaceSize, options: PbrFrameGraphOptions): PbrFrameExecutionPlan {
  const builder: RenderGraphBuilder = buildPbrFrameGraph(options);
  const compiled = builder.compile();
  if (!compiled.valid) {
    throw new Error(`PBR frame graph compile failed: ${compiled.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  validateGraphAgainstContracts(compiled.resources);
  const sizes = resolvePbrFrameResourceSizes(surface);
  const descriptorByPass = new Map(builder.declaredPasses().map(pass => [pass.id, pass]));
  const passes = compiled.order.map((passId, order) => {
    const descriptor = descriptorByPass.get(passId);
    if (!descriptor) throw new Error(`Compiled pass missing from graph declarations: ${passId}.`);
    const executor = MAPPED_EXECUTORS[passId];
    const reason = UNMAPPED_REASONS[passId];
    let mapping: PbrPassMapping;
    if (executor !== undefined) mapping = { status: "mapped", executor };
    else if (reason !== undefined) mapping = { status: "unmapped", reason };
    else throw new Error(`Frame graph pass ${passId} has neither an executor mapping nor an explicit unmapped reason.`);
    return Object.freeze({
      passId, kind: descriptor.kind, order,
      reads: Object.freeze([...descriptor.inputs ?? []]), writes: Object.freeze([...descriptor.outputs ?? []]),
      resources: plannedResources(descriptor, sizes),
      mapping: Object.freeze(mapping),
    });
  });
  const lifetimes = compiled.resources.map(resource => {
    const { historyRole } = pbrFrameResourceContract(resource.id);
    return Object.freeze({ ...resource, ...(historyRole ? { historyRole } : {}) });
  });
  const mappedPassIds = passes.filter(pass => pass.mapping.status === "mapped").map(pass => pass.passId);
  const unmappedPassIds = passes.filter(pass => pass.mapping.status === "unmapped").map(pass => pass.passId);
  return Object.freeze({ transparency: options.transparency, surface, passOrder: [...compiled.order],
    passes, resourceLifetimes: lifetimes, mappedPassIds, unmappedPassIds });
}

export interface PbrPlanMismatch {
  readonly passId: string;
  readonly field: string;
  readonly message: string;
  readonly planned?: string;
  readonly actual?: string;
}

export interface PbrPlanDiffResult {
  readonly mismatches: readonly PbrPlanMismatch[];
  /** 计划声明了读取、实际纹理级未消费的资源(几何/光照绑定类)。显式列出,不判失败。 */
  readonly planOnlyReads: readonly { readonly passId: string; readonly resources: readonly string[] }[];
}

const formatSet = (values: readonly string[]): string => JSON.stringify([...values].sort());

function diffClaimAgainstContract(mismatches: PbrPlanMismatch[], passId: string, planResource: string,
  contractFormat: string, contractSampleCount: number, contractUsages: readonly FramePlanUsage[],
  contractSizeRole: PbrFrameResourceSizeRole, claim: { format: string; sampleCount: number;
  usages: readonly FramePlanUsage[]; sizeRole: PbrFrameResourceSizeRole }): void {
  const fail = (field: string, planned: string, actual: string): void => {
    mismatches.push(Object.freeze({ passId, field: `resources.${planResource}.${field}`, message: `Claim mismatch on ${planResource}.`, planned, actual }));
  };
  if (claim.format !== contractFormat) fail("format", contractFormat, claim.format);
  if (claim.sampleCount !== contractSampleCount) fail("sampleCount", String(contractSampleCount), String(claim.sampleCount));
  if (formatSet(claim.usages) !== formatSet(contractUsages)) fail("usages", formatSet(contractUsages), formatSet(claim.usages));
  if (claim.sizeRole !== contractSizeRole) fail("sizeRole", contractSizeRole, claim.sizeRole);
}

/** 计划与实际执行描述逐项对拍:writes 严格相等;actual reads ⊆ plan reads;声明逐字段对拍资源合同。 */
export function diffPlanAgainstActual(plan: PbrFrameExecutionPlan,
  actual: readonly PbrActualPassDescription[]): PbrPlanDiffResult {
  const mismatches: PbrPlanMismatch[] = [];
  const planOnlyReads: { passId: string; resources: string[] }[] = [];
  const plannedByPass = new Map(plan.passes.map(pass => [pass.passId, pass]));
  const actualByPass = new Map(actual.map(description => [description.passId, description]));
  const catalog = new Map(plan.passes.flatMap(pass => pass.resources.map(resource => [resource.id, resource])));

  for (const pass of plan.passes) {
    const description = actualByPass.get(pass.passId);
    if (pass.mapping.status !== "mapped") continue;
    if (!description) {
      mismatches.push(Object.freeze({ passId: pass.passId, field: "actual-description",
        message: `Mapped pass ${pass.passId} has no actual pass description.`, planned: pass.mapping.executor }));
      continue;
    }
    const missingWrites = pass.writes.filter(id => !description.writes.includes(id));
    const extraWrites = description.writes.filter(id => !pass.writes.includes(id));
    if (missingWrites.length || extraWrites.length) {
      mismatches.push(Object.freeze({ passId: pass.passId, field: "writes",
        message: "Write sets differ.", planned: formatSet(pass.writes), actual: formatSet(description.writes) }));
    }
    const undeclaredReads = description.reads.filter(id => !pass.reads.includes(id));
    if (undeclaredReads.length) {
      mismatches.push(Object.freeze({ passId: pass.passId, field: "reads",
        message: "Actual pass reads resources the plan does not declare.", planned: formatSet(pass.reads), actual: formatSet(description.reads) }));
    }
    const planOnly = pass.reads.filter(id => !description.reads.includes(id));
    if (planOnly.length) planOnlyReads.push(Object.freeze({ passId: pass.passId, resources: planOnly }));
    for (const claim of description.claims) {
      const planned = catalog.get(claim.id);
      if (!planned) {
        mismatches.push(Object.freeze({ passId: pass.passId, field: `resources.${claim.id}`,
          message: "Claim references a resource the plan does not declare.", actual: claim.id }));
        continue;
      }
      // 访问方向只对照本 pass 的读写集;同一资源可被一个 pass 写、另一个 pass 读。
      const allowed = claim.access === "write" ? pass.writes : pass.reads;
      if (!allowed.includes(claim.id)) {
        mismatches.push(Object.freeze({ passId: pass.passId, field: `resources.${claim.id}.access`,
          message: `Claim access ${claim.access} contradicts the plan.`,
          planned: claim.access === "write" ? "read" : "write", actual: claim.access }));
        continue;
      }
      diffClaimAgainstContract(mismatches, pass.passId, claim.id, planned.format, planned.sampleCount,
        planned.usages, planned.sizeRole, claim);
    }
  }
  for (const description of actual) {
    if (!plannedByPass.has(description.passId)) {
      mismatches.push(Object.freeze({ passId: description.passId, field: "pass-id",
        message: "Actual pass does not exist in the compiled plan.", actual: description.executor }));
    }
  }
  return Object.freeze({ mismatches: Object.freeze(mismatches), planOnlyReads: Object.freeze(planOnlyReads) });
}

/** 对拍断言:存在任何 mismatch 即抛出,错误信息点名差异字段。 */
export function assertPlanMatchesActual(plan: PbrFrameExecutionPlan, actual: readonly PbrActualPassDescription[]): PbrPlanDiffResult {
  const diff = diffPlanAgainstActual(plan, actual);
  if (diff.mismatches.length) {
    const detail = diff.mismatches.map(issue => `${issue.passId}.${issue.field}: ${issue.message}`
      + `${issue.planned !== undefined ? ` planned=${issue.planned}` : ""}${issue.actual !== undefined ? ` actual=${issue.actual}` : ""}`);
    throw new Error(`PBR frame plan does not match actual passes (${diff.mismatches.length}): ${detail.join(" | ")}`);
  }
  return diff;
}

/** 组装实际执行描述:各执行者文件的 describe* 输出,与 encode 代码路径贴近书写。 */
export function collectActualPbrFramePasses(features: PbrRendererFeatures, transparency: boolean): readonly PbrActualPassDescription[] {
  return Object.freeze([
    describePbrOpaquePass(),
    ...PbrPostProcessChain.describePasses(features, transparency),
    ...(transparency ? PbrTransparencyPass.describePasses() : []),
    describePbrPresentPasses("bloom-hdr"),
  ]);
}

/** A03 ChannelSample 语义的单 pass 耗时通道;channel 取合法枚举,pass 专属命名走 passChannel。 */
export interface PbrPassChannelSample extends ChannelSample {
  readonly passChannel: `gpu-timestamp.pass.${string}`;
}

export function pbrPassChannelName(passId: string): `gpu-timestamp.pass.${string}` {
  return `gpu-timestamp.pass.${passId}`;
}

function assertWindowBounds(windowStartMs: number, windowEndMs: number): void {
  if (![windowStartMs, windowEndMs].every(Number.isFinite) || windowEndMs <= windowStartMs) {
    throw new Error("Pass sample window bounds must be finite with end after start.");
  }
}

export function createPbrPassTimingSample(passId: string, durationMs: number, windowStartMs: number, windowEndMs: number): PbrPassChannelSample {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`Pass ${passId} timing must be finite and non-negative.`);
  assertWindowBounds(windowStartMs, windowEndMs);
  return Object.freeze({ channel: "gpu-timestamp", clockId: "gpu-timestamp", passChannel: pbrPassChannelName(passId),
    samplesMs: Object.freeze([durationMs]), sampleCount: 1, windowStartMs, windowEndMs, availability: "measured" });
}

export function createPbrPassUnavailableSample(passId: string, reason: string, windowStartMs: number, windowEndMs: number): PbrPassChannelSample {
  if (!reason.trim()) throw new Error(`Pass ${passId} unavailable sample requires a reason.`);
  assertWindowBounds(windowStartMs, windowEndMs);
  return Object.freeze({ channel: "gpu-timestamp", clockId: "gpu-timestamp", passChannel: pbrPassChannelName(passId),
    samplesMs: Object.freeze([]), sampleCount: 0, windowStartMs, windowEndMs,
    availability: "unavailable", unavailableReason: reason });
}

export interface PbrFrameExecutionReceipt {
  readonly frame: number;
  readonly passOrder: readonly string[];
  /** 每个计划 pass 恰好一条样本;unmapped pass 显式 unavailable,禁止伪零值。 */
  readonly samples: readonly PbrPassChannelSample[];
}

export interface PbrPassTimingEntry {
  readonly passId: string;
  readonly durationMs: number;
}

/** 回执必须完整覆盖计划 pass:有实测给实测;未接/缺样本一律显式 unavailable。 */
export function createPbrFrameReceipt(frame: number, plan: PbrFrameExecutionPlan,
  timings: readonly PbrPassTimingEntry[], windowStartMs: number, windowEndMs: number): PbrFrameExecutionReceipt {
  assertWindowBounds(windowStartMs, windowEndMs);
  const timingByPass = new Map<string, number>();
  for (const entry of timings) {
    if (timingByPass.has(entry.passId)) throw new Error(`Duplicate timing entry for pass ${entry.passId}.`);
    if (!plan.passOrder.includes(entry.passId)) throw new Error(`Timing entry for pass ${entry.passId} is not in the plan.`);
    timingByPass.set(entry.passId, entry.durationMs);
  }
  const samples = plan.passOrder.map(passId => {
    const durationMs = timingByPass.get(passId);
    if (durationMs !== undefined) return createPbrPassTimingSample(passId, durationMs, windowStartMs, windowEndMs);
    const mapping = plan.passes.find(pass => pass.passId === passId)!.mapping;
    const reason = mapping.status === "unmapped" ? `pass 未纳入第一切片(${mapping.reason})` : "missing timing entry for mapped pass";
    return createPbrPassUnavailableSample(passId, reason, windowStartMs, windowEndMs);
  });
  return Object.freeze({ frame, passOrder: [...plan.passOrder], samples });
}

/** 聚合为 A03 SampleWindow:窗口 schema 禁止重复通道,全部 pass 样本合并进唯一 gpu-timestamp 通道。 */
export function pbrReceiptSampleWindow(receipt: PbrFrameExecutionReceipt, runId: string): SampleWindow {
  const windowStartMs = Math.min(...receipt.samples.map(sample => sample.windowStartMs));
  const windowEndMs = Math.max(...receipt.samples.map(sample => sample.windowEndMs));
  const measured = receipt.samples.filter(sample => sample.availability === "measured");
  const channel: ChannelSample = measured.length
    ? { channel: "gpu-timestamp", clockId: "gpu-timestamp", samplesMs: measured.flatMap(sample => [...sample.samplesMs]),
      sampleCount: measured.reduce((total, sample) => total + sample.sampleCount, 0), windowStartMs, windowEndMs, availability: "measured" }
    : { channel: "gpu-timestamp", clockId: "gpu-timestamp", samplesMs: [], sampleCount: 0, windowStartMs, windowEndMs,
      availability: "unavailable",
      unavailableReason: receipt.samples.map(sample => `${sample.passChannel}: ${sample.unavailableReason ?? "unknown"}`).join("; ") };
  return createSampleWindow({ schema: "deep-engine.benchmark-sample-window", schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
    runId, clockId: "gpu-timestamp", windowStartMs, windowEndMs, channels: [Object.freeze(channel)] });
}
