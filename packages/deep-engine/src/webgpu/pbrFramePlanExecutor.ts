export { createPbrPassTimingSample, createPbrPassUnavailableSample, createPbrFrameReceipt,
  pbrReceiptSampleWindow, pbrPassChannelName, pbrFramePassTimingsUnavailable } from "./pbrFrameReceipt.js";
export type { PbrFrameExecutionReceipt, PbrPassChannelSample, PbrPassTimingEntry,
  PbrFramePassTimings } from "./pbrFrameReceipt.js";
import type { RenderGraphBuilder, RenderPassDescriptor, RenderResourceLifetime } from "../renderGraph.js";
import { buildPbrFrameGraph, type PbrFrameGraphOptions } from "./pbrFrameGraph.js";
import { PBR_TIMED_PASS_IDS } from "./pbrTimedPassIds.js";
import { describePbrOpaquePass } from "./pbrOpaquePass.js";
import { describePbrPresentPasses } from "./pbrOutputBindings.js";
import { pbrFrameResourceContract, resolvePbrFrameResourceSizes, type PbrActualPassDescription,
  type PbrFrameResourceSizeRole, type FramePlanUsage } from "./pbrFramePlanResources.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { SurfaceSize } from "./surfaceSize.js";
import { PbrTransparencyPass } from "./pbrTransparencyPass.js";
import { PbrPostProcessChain } from "./pbrPostProcessChain.js";
import { describeContactShadowPass, describeContactApplyPass } from "../shadows/contactShadowResources.js";
import { describeSdfGiSkyTracePass, describeSdfGiProbeUpdatePass } from "../gi/sdfGiFramePlanDescriptors.js";

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
  /** Stable hash emitted by the same RenderGraph compile that supplies pass order/lifetimes. */
  readonly planHash: string;
  /** 编译计划的拓扑序(可追踪性基准)。 */
  readonly passOrder: readonly string[];
  readonly passes: readonly PbrPlannedPass[];
  readonly resourceLifetimes: readonly PbrPlannedResourceLifetime[];
  readonly mappedPassIds: readonly string[];
  readonly unmappedPassIds: readonly string[];
}

/** passId ↔ 实际执行体:AO→TAA→Bloom 子链、OIT、opaque/present 的第一切片映射。 */
const MAPPED_EXECUTORS: Readonly<Record<string, string>> = Object.freeze({
  "contact-shadow": "ContactShadowResources.encode (short-range depth trace)",
  "contact-apply": "ContactShadowResources.encode/apply",
  "opaque": "PbrRenderer main pass via beginPbrOpaquePass",
  "ambient-occlusion": "AmbientOcclusionPass.encode",
  "apply-ambient-occlusion": "AmbientOcclusionCompositePass.encode",
  "screen-space-reflection-trace": "ScreenSpaceReflectionPass.encode/trace",
  "screen-space-reflection-composite": "ScreenSpaceReflectionPass.encode/composite",
  "screen-space-gi-trace": "ScreenSpaceGiPass.encode/trace",
  "screen-space-gi-composite": "ScreenSpaceGiPass.encode/composite",
  "projected-texture-light": "ProjectedTexturePass.encode",
  "volumetric-fog-march": "VolumetricFogPass.encode",
  "volumetric-fog-composite": "VolumetricFogCompositePass.encode",
  "transparent-oit": "PbrTransparencyPass.encode → WeightedOitPass accumulation",
  "composite-oit": "PbrTransparencyPass.encode → WeightedOitPass.encodeComposite",
  "temporal-aa": "TemporalAaPass.encode",
  "temporal-upscale": "TemporalUpscalePass.encode",
  "bloom": "BloomPass.encode (AuthorBloomPass shares the plan slot)",
  "present": "PbrOutputBindings.present",
  // GI-FIN:sdfGi 逐 pass 计时登记(sdfGiPacking 单源;主 encoder 直编执行)。
  "sdf-gi-sky-trace": "SdfGiProductionRuntime.encodeFrame (sky visibility trace dispatch)",
  "sdf-gi-probe-update": "SdfGiProductionRuntime.encodeFrame (probe SH update dispatch)",
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

/** F1 计时身份单源校验:mapped pass 必须都在 pbrTimedPassIds 清单里,漂移在计划构建期显式报错。 */
function validateTimedPassIdentity(plan: PbrFrameExecutionPlan): void {
  const timed = new Set<string>(PBR_TIMED_PASS_IDS);
  const drifted = plan.mappedPassIds.filter(passId => !timed.has(passId));
  if (drifted.length) {
    throw new Error(`Mapped passes missing from PBR_TIMED_PASS_IDS (per-pass GPU timing cannot bracket them): ${drifted.join(", ")}.`);
  }
}

function plannedResources(pass: RenderPassDescriptor, sizes: ReadonlyMap<string, SurfaceSize>, hdrDisplay = false): readonly PbrPlannedPassResource[] {
  const claims: PbrPlannedPassResource[] = [];
  for (const access of ["read", "write"] as const) {
    for (const id of access === "read" ? pass.inputs ?? [] : pass.outputs ?? []) {
      const contract = pbrFrameResourceContract(id);
      const size = sizes.get(id);
      claims.push(Object.freeze({
        id, access, format: id === "surface" && hdrDisplay ? "rgba16float" : contract.format ?? contract.descriptor, sampleCount: contract.sampleCount,
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
  const compiled = builder.compile({ cullUnusedPasses: options.features !== undefined });
  if (!compiled.valid) {
    throw new Error(`PBR frame graph compile failed: ${compiled.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  if (!compiled.planHash) throw new Error("PBR frame graph compile produced no plan hash.");
  validateGraphAgainstContracts(compiled.resources);
  const sizes = resolvePbrFrameResourceSizes(surface);
  const descriptorByPass = new Map(builder.declaredPasses().map(pass => [pass.id, pass]));
  const passes = compiled.order.map((passId, order) => {
    const descriptor = descriptorByPass.get(passId);
    if (!descriptor) throw new Error(`Compiled pass missing from graph declarations: ${passId}.`);
    const executor = passId === "volumetric-fog-march" && options.godRays ? "VolumetricGodRaysPass.encode" : MAPPED_EXECUTORS[passId];
    const reason = UNMAPPED_REASONS[passId];
    let mapping: PbrPassMapping;
    if (executor !== undefined) mapping = { status: "mapped", executor };
    else if (reason !== undefined) mapping = { status: "unmapped", reason };
    else throw new Error(`Frame graph pass ${passId} has neither an executor mapping nor an explicit unmapped reason.`);
    return Object.freeze({
      passId, kind: descriptor.kind, order,
      reads: Object.freeze([...descriptor.inputs ?? []]), writes: Object.freeze([...descriptor.outputs ?? []]),
      resources: plannedResources(descriptor, sizes, options.hdrDisplay),
      mapping: Object.freeze(mapping),
    });
  });
  const lifetimes = compiled.resources.map(resource => {
    const { historyRole } = pbrFrameResourceContract(resource.id);
    return Object.freeze({ ...resource, ...(historyRole ? { historyRole } : {}) });
  });
  const mappedPassIds = passes.filter(pass => pass.mapping.status === "mapped").map(pass => pass.passId);
  const unmappedPassIds = passes.filter(pass => pass.mapping.status === "unmapped").map(pass => pass.passId);
  const planValue = Object.freeze({ transparency: options.transparency, surface, planHash: compiled.planHash,
    passOrder: [...compiled.order], passes, resourceLifetimes: lifetimes, mappedPassIds, unmappedPassIds });
  validateTimedPassIdentity(planValue);
  return planValue;
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
export function collectActualPbrFramePasses(features: PbrRendererFeatures, transparency: boolean,
  options: { readonly opaqueColorResource?: string; readonly presentInputResource?: string;
    readonly directDisplay?: boolean; readonly writeGeometryBuffers?: boolean; readonly bloom?: boolean; readonly godRays?: boolean; readonly hdrDisplay?: boolean;
    readonly msaa?: boolean; readonly depthResolved?: boolean } = {}): readonly PbrActualPassDescription[] {
  // GI-FIN(2026-10-05)sdfGi 两 pass 的实际描述由 gi 域单源提供(sdfGiFramePlanDescriptors);
  // 真实编码序:主 encoder 上 opaque 之前(pbrRendererFrames host.sdfGi 分支,直出帧同序)。
  const sdfGiPasses = features.sdfGi ? [describeSdfGiSkyTracePass(), describeSdfGiProbeUpdatePass()] : [];
  if (options.directDisplay) return Object.freeze([...sdfGiPasses, describePbrOpaquePass(options)]);
  const opaqueColorResource = options.opaqueColorResource ?? (features.ambientOcclusion ? "ao-hdr" : "opaque-hdr");
  const effects = PbrPostProcessChain.describePasses(features, transparency, { opaqueColorResource, ...(options.godRays ? { godRays: true } : {}) });
  const opaqueEffect = (pass: PbrActualPassDescription): boolean =>
    pass.passId === "ambient-occlusion" || pass.passId === "apply-ambient-occlusion";
  // F4 超分开启时 upscale-hdr 是唯一 display 输入(优先级最高,链尾)。
  // 超分 pass 的实际描述由 PbrPostProcessChain.describePasses 追加进 effects(同 taa/bloom)。
  const upscaleInput = features.temporalUpscale ? "upscale-hdr" : undefined;
  // C10 真实编码序(pbrRenderer):contact 在**全部 effects 编码后**把遮蔽乘回最终 HDR,
  // present 读其输出(contact-hdr)——不是链头。此前模拟写在链头,默认 opt-in 时从不暴露;
  // 默认开启后被 plan/actual 对拍抓出(本修复对齐真实编码,非放宽)。
  const chainTail = features.bloom ? "bloom-hdr" : features.temporalAa ? "temporal-hdr"
    : features.screenSpaceReflection ? "ssr-hdr"
      : features.projectedTextures ? "projected-texture-hdr"
        : features.ssgi ? "ssgi-hdr"
          : features.volumetricFog ? "volumetric-fog-hdr"
            : transparency ? "composited-hdr" : opaqueColorResource;
  return Object.freeze([
    ...sdfGiPasses,
    describePbrOpaquePass(options),
    ...effects.filter(opaqueEffect),
    ...(transparency ? PbrTransparencyPass.describePasses(opaqueColorResource) : []),
    ...effects.filter(pass => !opaqueEffect(pass)),
    ...(features.contactShadows && !options.directDisplay
      ? [describeContactShadowPass(), describeContactApplyPass(upscaleInput ?? chainTail)] : []),
    describePbrPresentPasses(features.contactShadows && !options.directDisplay
      ? "contact-hdr" : upscaleInput ?? chainTail, features.spatialAa, options.hdrDisplay),
  ]);
}
