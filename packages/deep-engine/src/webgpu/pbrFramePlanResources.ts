import { ambientOcclusionHalfSize } from "../postprocess/ambientOcclusion.js";
import { AMBIENT_OCCLUSION_OUTPUT_FORMAT } from "../postprocess/ambientOcclusionTypes.js";
import { BLOOM_COLOR_FORMAT } from "../postprocess/bloomTypes.js";
import { TEMPORAL_AA_COLOR_FORMAT } from "../postprocess/temporalAaTypes.js";
import { SSR_COMPOSITE_FORMAT, SSR_TRACE_FORMAT } from "../postprocess/screenSpaceReflectionTypes.js";
import { VOLUMETRIC_FOG_SCATTER_FORMAT } from "../fog/volumetricFogPassTypes.js";
import { VOLUMETRIC_FOG_COMPOSITE_FORMAT } from "../fog/volumetricFogCompositeTypes.js";
import { PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_MAIN_SAMPLE_COUNT,
  PBR_MOTION_FORMAT, PBR_VIEW_NORMAL_FORMAT } from "./renderTargets.js";
import { surfaceSize, type SurfaceSize } from "./surfaceSize.js";
import { WEIGHTED_OIT_ACCUMULATION_FORMAT, WEIGHTED_OIT_REVEALAGE_FORMAT } from "./weightedOitTypes.js";

/** DE26/B03 · 计划侧资源合同目录:每个条目的格式/采样/usage 都取自实际创建代码的真实常量。 */

/** 语义 usage;纯 Node 计划层禁止依赖运行时 GPUTextureUsage 对象,用稳定字符串声明。 */
export const FRAME_PLAN_USAGES = ["render-attachment", "texture-binding", "storage-binding", "copy-src"] as const;
export type FramePlanUsage = typeof FRAME_PLAN_USAGES[number];

/** sizeRole:"surface"=主帧全分辨率;"half"=AO 半分辨率;"independent"=尺寸独立于主帧(图集/金字塔/buffer)。 */
export type PbrFrameResourceSizeRole = "surface" | "half" | "independent";

export interface PbrFrameResourceContract {
  readonly id: string;
  readonly descriptor: string;
  /** undefined:非单张 2D 纹理(swapchain / buffer / mip-chain 概念资源),格式比较降级为 descriptor 相等。 */
  readonly format?: string;
  readonly sampleCount: number;
  readonly usages: readonly FramePlanUsage[];
  readonly sizeRole: PbrFrameResourceSizeRole;
  readonly external: boolean;
  /** 跨帧 history 资源:previous=消费上帧产物;next=发布给下帧。 */
  readonly historyRole?: "previous" | "next";
}

const FULL_COLOR = Object.freeze(["render-attachment", "texture-binding"] as const);
const FULL_HDR_TRANSIENT = Object.freeze(["render-attachment", "texture-binding", "storage-binding", "copy-src"] as const);

export const PBR_FRAME_RESOURCE_CONTRACTS: readonly PbrFrameResourceContract[] = Object.freeze([
  { id: "animation-state", descriptor: "scene-animation-v1", sampleCount: 1, usages: [], sizeRole: "independent", external: true },
  { id: "lights", descriptor: "clustered-lights-v1", sampleCount: 1, usages: [], sizeRole: "independent", external: true },
  { id: "previous-hiz", descriptor: "r32float-mip-chain", format: "r32float", sampleCount: 1,
    usages: ["texture-binding", "storage-binding", "copy-src"], sizeRole: "independent", external: true, historyRole: "previous" },
  { id: "deformed-vertices", descriptor: "vertex-storage-v1", sampleCount: 1, usages: [], sizeRole: "independent", external: false },
  { id: "visible-draws", descriptor: "indexed-indirect-v1", sampleCount: 1, usages: [], sizeRole: "independent", external: false },
  { id: "shadow-atlas", descriptor: "depth32float-array", format: "depth32float", sampleCount: 1,
    usages: ["render-attachment"], sizeRole: "independent", external: false },
  { id: "light-grid", descriptor: "forward-plus-grid-v1", sampleCount: 1, usages: [], sizeRole: "independent", external: false },
  { id: "opaque-hdr", descriptor: "rgba16float", format: PBR_HDR_FORMAT, sampleCount: PBR_MAIN_SAMPLE_COUNT,
    usages: FULL_HDR_TRANSIENT, sizeRole: "surface", external: false },
  { id: "linear-depth", descriptor: "r32float", format: PBR_LINEAR_DEPTH_FORMAT, sampleCount: PBR_MAIN_SAMPLE_COUNT,
    usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface", external: false },
  { id: "view-normal", descriptor: "rgba8unorm", format: PBR_VIEW_NORMAL_FORMAT, sampleCount: PBR_MAIN_SAMPLE_COUNT,
    usages: FULL_COLOR, sizeRole: "surface", external: false },
  { id: "motion", descriptor: "rg16float", format: PBR_MOTION_FORMAT, sampleCount: PBR_MAIN_SAMPLE_COUNT,
    usages: FULL_COLOR, sizeRole: "surface", external: false },
  { id: "current-hiz", descriptor: "r32float-mip-chain", format: "r32float", sampleCount: 1,
    usages: ["texture-binding", "storage-binding", "copy-src"], sizeRole: "independent", external: false },
  { id: "next-hiz", descriptor: "r32float-mip-chain", format: "r32float", sampleCount: 1,
    usages: ["texture-binding", "storage-binding", "copy-src"], sizeRole: "independent", external: true, historyRole: "next" },
  { id: "ao-half", descriptor: "r32float-half", format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "half", external: false },
  { id: "ao-hdr", descriptor: "rgba16float", format: PBR_HDR_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding", "render-attachment", "copy-src"], sizeRole: "surface", external: false },
  { id: "temporal-hdr", descriptor: "rgba16float", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "surface", external: false },
  { id: "ssr-trace", descriptor: "rgba16float-half", format: SSR_TRACE_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding"], sizeRole: "half", external: false },
  { id: "ssr-hdr", descriptor: "rgba16float", format: SSR_COMPOSITE_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding"], sizeRole: "surface", external: false },
  { id: "volumetric-fog-scatter", descriptor: "rgba16float-half", format: VOLUMETRIC_FOG_SCATTER_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding"], sizeRole: "half", external: false },
  { id: "volumetric-fog-hdr", descriptor: "rgba16float", format: VOLUMETRIC_FOG_COMPOSITE_FORMAT, sampleCount: 1,
    usages: ["storage-binding", "texture-binding"], sizeRole: "surface", external: false },
  { id: "bloom-hdr", descriptor: "rgba16float", format: BLOOM_COLOR_FORMAT, sampleCount: 1,
    usages: ["texture-binding", "storage-binding", "render-attachment", "copy-src"], sizeRole: "surface", external: false },
  { id: "oit-accumulation", descriptor: "rgba16float", format: WEIGHTED_OIT_ACCUMULATION_FORMAT, sampleCount: 1,
    usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface", external: false },
  { id: "oit-revealage", descriptor: "r16float", format: WEIGHTED_OIT_REVEALAGE_FORMAT, sampleCount: 1,
    usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface", external: false },
  { id: "composited-hdr", descriptor: "rgba16float", format: PBR_HDR_FORMAT, sampleCount: 1,
    usages: FULL_HDR_TRANSIENT, sizeRole: "surface", external: false },
  { id: "surface", descriptor: "swapchain", sampleCount: 1, usages: ["render-attachment"], sizeRole: "independent", external: true },
]);

/** frame graph 声明漂移守卫:图里的 descriptor/external 与目录不一致即报,不许静默。 */
export function pbrFrameResourceContract(id: string): PbrFrameResourceContract {
  const contract = PBR_FRAME_RESOURCE_CONTRACTS.find(candidate => candidate.id === id);
  if (!contract) throw new Error(`PBR frame plan resource contract is missing: ${id}.`);
  return contract;
}

/**
 * 计划侧尺寸推导纯函数:与 RenderTargets 同源 —— 直接复用 surfaceSize(),
 * 保证计划推导与 renderTargets/TextureTargets.resize 的最终尺寸推导一致。
 */
export function resolvePbrFramePlanSurface(width: number, height: number, ratio: number,
  textureLimit: number): SurfaceSize | undefined {
  return surfaceSize(width, height, ratio, textureLimit);
}

/** 每个 pass 资源的读写声明:格式/采样/usage/尺寸角色必须逐项声明,缺项在对拍时报出。 */
export interface PbrPassResourceClaim {
  readonly id: string;
  readonly access: "read" | "write";
  readonly format: string;
  readonly sampleCount: number;
  readonly usages: readonly FramePlanUsage[];
  readonly sizeRole: PbrFrameResourceSizeRole;
}

/** 图外附件/私有资源:第一切片尚未入图的实现事实,显式声明,禁止静默。 */
export interface PbrUnplannedAttachment {
  readonly id: string;
  readonly reason: string;
}

/** 实际执行描述:由各执行者文件贴近自身 encode 代码路径书写,与编译计划对拍。 */
export interface PbrActualPassDescription {
  readonly passId: string;
  readonly executor: string;
  readonly kind: "render" | "compute" | "history";
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly claims: readonly PbrPassResourceClaim[];
  readonly unplannedAttachments?: readonly PbrUnplannedAttachment[];
  /** 实际 GPU pass 数(一个计划 pass 可展开为多个 GPU pass,如 AO evaluate+双边模糊)。 */
  readonly gpuPassCount?: number;
}

/**
 * 计划侧尺寸推导:full 角色直接继承 surface(RenderTargets.resize 语义);
 * half 角色复用 ambientOcclusionHalfSize(真实 AO 推导);independent 资源不入表。
 * 同输入同输出;与 renderTargets 推导不一致只能来自调用方传入错误的 surface。
 */
export function resolvePbrFrameResourceSizes(surface: SurfaceSize): ReadonlyMap<string, SurfaceSize> {
  const sizes = new Map<string, SurfaceSize>();
  const [halfWidth, halfHeight] = ambientOcclusionHalfSize(surface.width, surface.height);
  for (const contract of PBR_FRAME_RESOURCE_CONTRACTS) {
    if (contract.sizeRole === "surface") sizes.set(contract.id, surface);
    if (contract.sizeRole === "half") sizes.set(contract.id, { width: halfWidth, height: halfHeight });
  }
  return sizes;
}
