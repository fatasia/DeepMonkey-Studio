import { AmbientOcclusionPass } from "../postprocess/ambientOcclusion.js";
import { AmbientOcclusionCompositePass } from "../postprocess/ambientOcclusionComposite.js";
import { AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT } from "../postprocess/ambientOcclusionCompositeTypes.js";
import { AMBIENT_OCCLUSION_OUTPUT_FORMAT } from "../postprocess/ambientOcclusionTypes.js";
import { BloomPass } from "../postprocess/bloom.js";
import { AuthorBloomPass } from "../postprocess/authorBloom.js";
import { BLOOM_COLOR_FORMAT } from "../postprocess/bloomTypes.js";
import { TemporalAaPass } from "../postprocess/temporalAa.js";
import { TEMPORAL_AA_COLOR_FORMAT } from "../postprocess/temporalAaTypes.js";
import type { DeviceSession } from "./deviceSession.js";
import { HiZPyramid, type HiZResult } from "./hiZPyramid.js";
import type { RenderTargets } from "./renderTargets.js";
import { PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_MAIN_SAMPLE_COUNT, PBR_MOTION_FORMAT,
  PBR_VIEW_NORMAL_FORMAT } from "./renderTargets.js";
import type { PbrActualPassDescription, FramePlanUsage } from "./pbrFramePlanResources.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { resolvePbrPostProcessOverrides, type PbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures,
  type PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";
import type { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";

/** Soft-knee starts at linear radiance 1: SDR surfaces and backgrounds do not glow. */
export const DEFAULT_PBR_BLOOM_OPTIONS = Object.freeze({ threshold: 1.25, softKnee: 0.2, intensity: 0.55, maxLevels: 5 });

export interface PbrPostProcessInput {
  readonly postProcess?: PbrPostProcessOverrides;
  readonly encoder: GPUCommandEncoder;
  readonly targets: RenderTargets;
  readonly revision: number;
  readonly extent: number;
  readonly verticalFovRadians: number;
  readonly cameraCut: boolean;
  readonly currentJitter: readonly [number, number];
  readonly previousJitter: readonly [number, number];
}

export interface PbrOpaqueEffectsResult {
  readonly color: GPUTexture;
  readonly hiZ?: HiZResult;
  readonly passCount: number;
}

export interface PbrFinalEffectsResult {
  readonly color: GPUTexture;
  readonly passCount: number;
}

/** Owns the stable post-process resources used by the default PBR frame. */
export class PbrPostProcessChain {
  private readonly hiZ: HiZPyramid | undefined;
  private readonly ambientOcclusion: AmbientOcclusionPass | undefined;
  private readonly ambientOcclusionComposite: AmbientOcclusionCompositePass | undefined;
  private readonly temporalAa: TemporalAaPass | undefined;
  private readonly bloom: BloomPass | undefined;
  private authorBloom: AuthorBloomPass | undefined;
  private disposed = false;
  private readonly features: PbrRendererFeatures;

  constructor(private readonly session: DeviceSession, options: PbrRendererFeatureOptions = {}, pool?: PbrTransientTexturePool) {
    this.features = resolvePbrRendererFeatures(options);
    let hiZ: HiZPyramid | undefined, ambientOcclusion: AmbientOcclusionPass | undefined;
    let ambientOcclusionComposite: AmbientOcclusionCompositePass | undefined;
    let temporalAa: TemporalAaPass | undefined, bloom: BloomPass | undefined;
    try {
      if (this.features.occlusionCulling) hiZ = new HiZPyramid(session);
      if (this.features.ambientOcclusion) {
        ambientOcclusion = new AmbientOcclusionPass(session, pool);
        ambientOcclusionComposite = new AmbientOcclusionCompositePass(session, pool);
      }
      if (this.features.temporalAa) temporalAa = new TemporalAaPass(session);
      if (this.features.bloom) bloom = new BloomPass(session);
    } catch (error) {
      failWithResourceCleanup(error, "Post-process construction failed", [
        () => bloom?.dispose(), () => temporalAa?.dispose(), () => ambientOcclusionComposite?.dispose(),
        () => ambientOcclusion?.dispose(), () => hiZ?.dispose(),
      ]);
    }
    this.hiZ = hiZ; this.ambientOcclusion = ambientOcclusion;
    this.ambientOcclusionComposite = ambientOcclusionComposite;
    this.temporalAa = temporalAa; this.bloom = bloom;
  }

  /** Must run after opaque depth is stored and before transparent color composition. */
  encodeOpaque(input: PbrPostProcessInput): PbrOpaqueEffectsResult {
    if (this.disposed) throw new Error("Post-process chain is disposed.");
    const active = resolvePbrPostProcessOverrides(input.postProcess, this.features);
    const { encoder, targets, revision, extent, verticalFovRadians } = input;
    const hiZ = this.features.occlusionCulling
      ? this.hiZ!.encode(encoder, { texture: targets.depthTexture, revision }, { reversedZ: false })
      : undefined;
    const hiZPasses = hiZ?.mipLevelCount ?? 0;
    if (!active.ambientOcclusion) {
      return Object.freeze({ color: targets.hdrTexture, ...(hiZ ? { hiZ } : {}), passCount: hiZPasses });
    }
    const radius = Math.min(100, Math.max(0.1, extent * 0.04));
    const thickness = Math.min(radius, Math.max(0.01, extent * 0.004));
    const ao = this.ambientOcclusion!.encode(encoder, {
      depth: targets.linearDepthTexture, normal: targets.normalTexture, revision,
      depthEncoding: "linear-view-depth-positive", normalSpace: "view",
    }, { verticalFovRadians, radius, thickness, power: 1.5 });
    const composited = this.ambientOcclusionComposite!.encode(encoder, {
      color: targets.hdrTexture, depth: targets.linearDepthTexture, normal: targets.normalTexture, ambientOcclusion: ao,
      revision, colorEncoding: "linear-hdr", depthEncoding: "linear-view-depth-positive",
    }, { depthSigma: Math.min(1_000_000, Math.max(0.01, extent * 0.005)), strength: 1 });
    return Object.freeze({ color: composited.texture, ...(hiZ ? { hiZ } : {}), passCount: hiZPasses + 4 });
  }

  /** Resolves temporal history after transparency, then applies real HDR bloom. */
  encodeFinal(input: PbrPostProcessInput, color: GPUTexture): PbrFinalEffectsResult {
    if (this.disposed) throw new Error("Post-process chain is disposed.");
    const active = resolvePbrPostProcessOverrides(input.postProcess, this.features);
    const { encoder, targets, revision, extent, cameraCut, currentJitter, previousJitter } = input;
    const temporal = this.features.temporalAa ? this.temporalAa!.encode(encoder, {
      color, depth: targets.linearDepthTexture, motion: targets.motionTexture, revision, cameraCut,
      colorEncoding: "linear-hdr", currentJitter, previousJitter,
      depthEncoding: "linear-view-depth-positive", motionEncoding: "current-to-previous-uv",
    }, { feedback: 0.9, depthThreshold: Math.min(100, Math.max(0.01, extent * 0.001)), relativeDepthThreshold: 0.02 })
      : { texture: color };
    if (!active.bloom) return Object.freeze({ color: temporal.texture, passCount: this.features.temporalAa ? 1 : 0 });
    const source = { color: temporal.texture, revision, colorEncoding: "linear-hdr" as const };
    const bloom = active.authorBloom
      ? (this.authorBloom ??= new AuthorBloomPass(this.session)).encode(encoder, source, active.authorBloom)
      : this.bloom!.encode(encoder, source, DEFAULT_PBR_BLOOM_OPTIONS);
    return Object.freeze({ color: bloom.texture, passCount: (this.features.temporalAa ? 1 : 0) + bloom.passCount });
  }

  /**
   * 第一切片计划对拍声明(DE26/B03):逐 pass 描述本类 encode 路径的实际读写、格式与尺寸角色,
   * 供 pbrFramePlanExecutor 与编译计划对拍;纯静态、不触 GPU、不改变执行。
   */
  static describePasses(features: PbrRendererFeatures, transparency: boolean): readonly PbrActualPassDescription[] {
    const temporalInput = transparency ? "composited-hdr" : "ao-hdr";
    // 输入资源的创建 usage 随生产者不同:composited-hdr 来自 OIT scratch;ao-hdr 来自 AO composite 输出。
    const temporalInputUsages: readonly FramePlanUsage[] = transparency ? ["render-attachment", "texture-binding"]
      : ["storage-binding", "texture-binding", "render-attachment", "copy-src"];
    const geometryRead = (id: string): PbrActualPassDescription["claims"][number] => ({
      id, access: "read", format: id === "linear-depth" ? PBR_LINEAR_DEPTH_FORMAT : PBR_VIEW_NORMAL_FORMAT,
      sampleCount: PBR_MAIN_SAMPLE_COUNT, usages: ["render-attachment", "texture-binding"], sizeRole: "surface",
    });
    const passes: PbrActualPassDescription[] = [];
    if (features.ambientOcclusion) passes.push({
      passId: "ambient-occlusion", executor: "AmbientOcclusionPass.encode", kind: "compute",
      reads: ["linear-depth", "view-normal"], writes: ["ao-half"],
      claims: [geometryRead("linear-depth"), geometryRead("view-normal"),
        { id: "ao-half", access: "write", format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "half" }],
      unplannedAttachments: [{ id: "ao-evaluate/blur-temporary", reason: "半分辨率 evaluate 与双边模糊的私有 raw/temporary 纹理" }],
      gpuPassCount: 3,
    }, {
      passId: "apply-ambient-occlusion", executor: "AmbientOcclusionCompositePass.encode", kind: "compute",
      reads: ["opaque-hdr", "linear-depth", "view-normal", "ao-half"], writes: ["ao-hdr"],
      claims: [{ id: "opaque-hdr", access: "read", format: PBR_HDR_FORMAT, sampleCount: PBR_MAIN_SAMPLE_COUNT,
        usages: ["render-attachment", "texture-binding"], sizeRole: "surface" },
        geometryRead("linear-depth"), geometryRead("view-normal"),
        { id: "ao-half", access: "read", format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "half" },
        { id: "ao-hdr", access: "write", format: AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "render-attachment", "copy-src"], sizeRole: "surface" }],
      gpuPassCount: 1,
    });
    if (features.temporalAa) passes.push({
      passId: "temporal-aa", executor: "TemporalAaPass.encode", kind: "compute",
      reads: [temporalInput, "linear-depth", "motion"], writes: ["temporal-hdr"],
      claims: [{ id: temporalInput, access: "read", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
        usages: temporalInputUsages, sizeRole: "surface" },
        geometryRead("linear-depth"),
        { id: "motion", access: "read", format: PBR_MOTION_FORMAT, sampleCount: PBR_MAIN_SAMPLE_COUNT,
          usages: ["render-attachment", "texture-binding"], sizeRole: "surface" },
        { id: "temporal-hdr", access: "write", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "surface" }],
      unplannedAttachments: [{ id: "taa-history-depth-a/b", reason: "TAA 双帧 ping-pong 的私有深度历史" }],
      gpuPassCount: 1,
    });
    if (features.bloom) passes.push({
      passId: "bloom", executor: "BloomPass.encode", kind: "compute",
      reads: ["temporal-hdr"], writes: ["bloom-hdr"],
      claims: [{ id: "temporal-hdr", access: "read", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
        usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "surface" },
        { id: "bloom-hdr", access: "write", format: BLOOM_COLOR_FORMAT, sampleCount: 1,
          usages: ["texture-binding", "storage-binding", "render-attachment", "copy-src"], sizeRole: "surface" }],
      unplannedAttachments: [{ id: "bloom-pyramid-levels", reason: "bloom 高斯金字塔私有层级纹理" }],
      gpuPassCount: DEFAULT_PBR_BLOOM_OPTIONS.maxLevels * 4,
    });
    return passes;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runResourceCleanup("Post-process disposal failed", [() => this.authorBloom?.dispose(), () => this.bloom?.dispose(),
      () => this.temporalAa?.dispose(), () => this.ambientOcclusionComposite?.dispose(),
      () => this.ambientOcclusion?.dispose(), () => this.hiZ?.dispose()]);
  }
}
