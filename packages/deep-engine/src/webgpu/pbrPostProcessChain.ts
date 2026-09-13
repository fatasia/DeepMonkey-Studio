import { AmbientOcclusionPass } from "../postprocess/ambientOcclusion.js";
import { AmbientOcclusionCompositePass } from "../postprocess/ambientOcclusionComposite.js";
import { BloomPass } from "../postprocess/bloom.js";
import { TemporalAaPass } from "../postprocess/temporalAa.js";
import type { DeviceSession } from "./deviceSession.js";
import { HiZPyramid, type HiZResult } from "./hiZPyramid.js";
import type { RenderTargets } from "./renderTargets.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures,
  type PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";

/** Soft-knee starts at linear radiance 1: SDR surfaces and backgrounds do not glow. */
export const DEFAULT_PBR_BLOOM_OPTIONS = Object.freeze({ threshold: 1.25, softKnee: 0.2, intensity: 0.55, maxLevels: 5 });

export interface PbrPostProcessInput {
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
  readonly hiZ: HiZResult;
  readonly passCount: number;
}

export interface PbrFinalEffectsResult {
  readonly color: GPUTexture;
  readonly passCount: number;
}

/** Owns the stable post-process resources used by the default PBR frame. */
export class PbrPostProcessChain {
  private readonly hiZ: HiZPyramid;
  private readonly ambientOcclusion: AmbientOcclusionPass;
  private readonly ambientOcclusionComposite: AmbientOcclusionCompositePass;
  private readonly temporalAa: TemporalAaPass;
  private readonly bloom: BloomPass;
  private readonly features: PbrRendererFeatures;

  constructor(session: DeviceSession, options: PbrRendererFeatureOptions = {}) {
    this.features = resolvePbrRendererFeatures(options);
    this.hiZ = new HiZPyramid(session);
    this.ambientOcclusion = new AmbientOcclusionPass(session);
    this.ambientOcclusionComposite = new AmbientOcclusionCompositePass(session);
    this.temporalAa = new TemporalAaPass(session);
    this.bloom = new BloomPass(session);
  }

  /** Must run after opaque depth is stored and before transparent color composition. */
  encodeOpaque(input: PbrPostProcessInput): PbrOpaqueEffectsResult {
    const { encoder, targets, revision, extent, verticalFovRadians } = input;
    const hiZ = this.hiZ.encode(encoder, { texture: targets.depthTexture, revision }, { reversedZ: false });
    if (!this.features.ambientOcclusion) return Object.freeze({ color: targets.hdrTexture, hiZ, passCount: hiZ.mipLevelCount });
    const radius = Math.min(100, Math.max(0.1, extent * 0.04));
    const thickness = Math.min(radius, Math.max(0.01, extent * 0.004));
    const ao = this.ambientOcclusion.encode(encoder, {
      depth: targets.linearDepthTexture, normal: targets.normalTexture, revision,
      depthEncoding: "linear-view-depth-positive", normalSpace: "view",
    }, { verticalFovRadians, radius, thickness, power: 1.5 });
    const composited = this.ambientOcclusionComposite.encode(encoder, {
      color: targets.hdrTexture, depth: targets.linearDepthTexture, ambientOcclusion: ao,
      revision, colorEncoding: "linear-hdr", depthEncoding: "linear-view-depth-positive",
    }, { depthSigma: Math.min(1_000_000, Math.max(0.01, extent * 0.005)), strength: 1 });
    return Object.freeze({ color: composited.texture, hiZ, passCount: hiZ.mipLevelCount + 4 });
  }

  /** Resolves temporal history after transparency, then applies real HDR bloom. */
  encodeFinal(input: PbrPostProcessInput, color: GPUTexture): PbrFinalEffectsResult {
    const { encoder, targets, revision, extent, cameraCut, currentJitter, previousJitter } = input;
    const temporal = this.features.temporalAa ? this.temporalAa.encode(encoder, {
      color, depth: targets.linearDepthTexture, motion: targets.motionTexture, revision, cameraCut,
      colorEncoding: "linear-hdr", currentJitter, previousJitter,
      depthEncoding: "linear-view-depth-positive", motionEncoding: "current-to-previous-uv",
    }, { feedback: 0.9, depthThreshold: Math.min(100, Math.max(0.01, extent * 0.001)), relativeDepthThreshold: 0.02 })
      : { texture: color };
    if (!this.features.bloom) return Object.freeze({ color: temporal.texture, passCount: this.features.temporalAa ? 1 : 0 });
    const bloom = this.bloom.encode(encoder, { color: temporal.texture, revision, colorEncoding: "linear-hdr" }, DEFAULT_PBR_BLOOM_OPTIONS);
    return Object.freeze({ color: bloom.texture, passCount: (this.features.temporalAa ? 1 : 0) + bloom.passCount });
  }

  dispose(): void {
    this.bloom.dispose();
    this.temporalAa.dispose();
    this.ambientOcclusionComposite.dispose();
    this.ambientOcclusion.dispose();
    this.hiZ.dispose();
  }
}
