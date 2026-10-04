import { AmbientOcclusionPass } from "../postprocess/ambientOcclusion.js";
import { AmbientOcclusionCompositePass } from "../postprocess/ambientOcclusionComposite.js";
import { AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT } from "../postprocess/ambientOcclusionCompositeTypes.js";
import { AMBIENT_OCCLUSION_OUTPUT_FORMAT } from "../postprocess/ambientOcclusionTypes.js";
import { BloomPass } from "../postprocess/bloom.js";
import { AuthorBloomPass } from "../postprocess/authorBloom.js";
import { InstanceOutlinePass, type InstanceOutlineDrawStats } from "../postprocess/instanceOutline.js";
import { BLOOM_COLOR_FORMAT } from "../postprocess/bloomTypes.js";
import { TemporalAaPass } from "../postprocess/temporalAa.js";
import { TEMPORAL_AA_COLOR_FORMAT } from "../postprocess/temporalAaTypes.js";
import { TemporalUpscalePass, type TemporalUpscalePassSource } from "../postprocess/temporalUpscale.js";
import { TEMPORAL_UPSCALE_COLOR_FORMAT } from "../postprocess/temporalUpscaleTypes.js";
import { internalRenderSize } from "../postprocess/temporalUpscaleCpu.js";
import { ScreenSpaceReflectionPass } from "../postprocess/screenSpaceReflection.js";
import { SSR_COMPOSITE_FORMAT } from "../postprocess/screenSpaceReflectionTypes.js";
import { VolumetricFogPass } from "../fog/volumetricFogPass.js";
import { VolumetricGodRaysPass } from "../fog/volumetricGodRaysPass.js";
import type { GodRaysShadowSource } from "../fog/volumetricGodRaysPassTypes.js";
import type { VolumetricFogLight } from "../fog/volumetricFogPassTypes.js";
import { VolumetricFogCompositePass } from "../fog/volumetricFogComposite.js";
import { VOLUMETRIC_FOG_SCATTER_FORMAT } from "../fog/volumetricFogPassTypes.js";
import { VOLUMETRIC_FOG_COMPOSITE_FORMAT } from "../fog/volumetricFogCompositeTypes.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuPassTimingScope } from "./gpuTimer.js";
import { HiZPyramid, type HiZResult } from "./hiZPyramid.js";
import type { RenderTargets } from "./renderTargets.js";
import { PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_MOTION_FORMAT,
  PBR_VIEW_NORMAL_FORMAT } from "./renderTargets.js";
import type { PbrActualPassDescription, FramePlanUsage } from "./pbrFramePlanResources.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { resolvePbrPostProcessOverrides, type PbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures,
  type PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";
import type { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import { TemporalValidityProvider, type TemporalValidityPlan } from "../postprocess/temporalValidity.js";
import type { AdaptiveQualityKnobs } from "./adaptiveQuality.js";

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
  readonly surfaceWidth?: number;
  readonly surfaceHeight?: number;
  readonly materialRevision?: number;
  readonly lightRevision?: number;
  readonly exposure?: number;
  readonly disoccluded?: boolean;
  readonly reactiveMaskAvailable?: boolean;
  readonly reactiveMask?: GPUTexture;
  /** C11 SSR 物理化:主着色器同一 split-sum DFG(environment.brdf);缺省时 SSR 拒绝编码。 */
  readonly brdfLut?: GPUTextureView;
  readonly adaptiveQuality?: Readonly<AdaptiveQualityKnobs>;
  /**
   * 对象级描边帧输入。仅当 packet 含 outline 实例时由渲染器提供;缺省(绝大多数帧)时
   * InstanceOutlinePass 不构造、不编译、不分配,链路逐字节不变。
   */
  readonly outline?: {
    readonly viewProjection: ArrayLike<number>;
    readonly draw: (pass: GPURenderPassEncoder) => InstanceOutlineDrawStats;
  };
  readonly godRays?: { readonly shadows: GodRaysShadowSource; readonly viewToWorld: ArrayLike<number>; readonly light: VolumetricFogLight };
  /**
   * F1 逐 pass GPU 计时作用域(opt-in 诊断)。存在时在计划 pass 组边界发射只写
   * 时间戳的 marker pass;缺失时整条链路零额外开销、逐字节不变。
   */
  readonly passTiming?: GpuPassTimingScope;
}

/** E04 first-slice SSR tuning; derived from the scene extent like AO radius/thickness. */
export function defaultScreenSpaceReflectionOptions(extent: number): Readonly<{
  verticalFovRadians: number; maxDistance: number; thickness: number; steps: number; refines: number;
  edgeFade: number; fresnelF0: number }> {
  return Object.freeze({ verticalFovRadians: Math.PI / 3, maxDistance: Math.max(1, extent * 2), thickness: Math.max(0.01, extent * 0.01),
    steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 });
}

export interface PbrOpaqueEffectsResult {
  readonly color: GPUTexture;
  readonly hiZ?: HiZResult;
  readonly passCount: number;
}

export interface PbrFinalEffectsResult {
  readonly color: GPUTexture;
  readonly passCount: number;
  /** 描边实际绘制/跳过的批次统计;未执行描边时缺省。 */
  readonly outline?: InstanceOutlineDrawStats;
}

/** Owns the stable post-process resources used by the default PBR frame. */
export class PbrPostProcessChain {
  private readonly hiZ: HiZPyramid | undefined;
  private readonly ambientOcclusion: AmbientOcclusionPass | undefined;
  private readonly ambientOcclusionComposite: AmbientOcclusionCompositePass | undefined;
  private readonly screenSpaceReflection: ScreenSpaceReflectionPass | undefined;
  private readonly volumetricFog: VolumetricFogPass | undefined;
  private volumetricGodRays: VolumetricGodRaysPass | undefined;
  private readonly volumetricFogComposite: VolumetricFogCompositePass | undefined;
  private readonly temporalAa: TemporalAaPass | undefined;
  private readonly temporalUpscale: TemporalUpscalePass | undefined;
  private readonly bloom: BloomPass | undefined;
  private authorBloom: AuthorBloomPass | undefined;
  private instanceOutline: InstanceOutlinePass | undefined;
  private outlinePrewarm: Promise<void> | undefined;
  private readonly temporalValidity = new TemporalValidityProvider();
  private pendingTemporalRevision: number | undefined;
  private lastTemporalPlan: TemporalValidityPlan | undefined;
  private disposed = false;
  private readonly features: PbrRendererFeatures;

  constructor(private readonly session: DeviceSession, options: PbrRendererFeatureOptions = {}, private readonly pool?: PbrTransientTexturePool) {
    this.features = resolvePbrRendererFeatures(options);
    let hiZ: HiZPyramid | undefined, ambientOcclusion: AmbientOcclusionPass | undefined;
    let ambientOcclusionComposite: AmbientOcclusionCompositePass | undefined;
    let screenSpaceReflection: ScreenSpaceReflectionPass | undefined;
    let volumetricFog: VolumetricFogPass | undefined, volumetricFogComposite: VolumetricFogCompositePass | undefined;
    let temporalAa: TemporalAaPass | undefined, bloom: BloomPass | undefined;
    let temporalUpscale: TemporalUpscalePass | undefined;
    try {
      if (this.features.occlusionCulling) hiZ = new HiZPyramid(session);
      if (this.features.ambientOcclusion) {
        ambientOcclusion = new AmbientOcclusionPass(session, pool);
        ambientOcclusionComposite = new AmbientOcclusionCompositePass(session, pool);
      }
      if (this.features.screenSpaceReflection) screenSpaceReflection = new ScreenSpaceReflectionPass(session, pool);
      if (this.features.volumetricFog) {
        volumetricFog = new VolumetricFogPass(session, pool);
        volumetricFogComposite = new VolumetricFogCompositePass(session, pool);
      }
      if (this.features.temporalAa) temporalAa = new TemporalAaPass(session);
      if (this.features.temporalUpscale) temporalUpscale = new TemporalUpscalePass(session);
      if (this.features.bloom) bloom = new BloomPass(session, pool);
    } catch (error) {
      failWithResourceCleanup(error, "Post-process construction failed", [
        () => bloom?.dispose(), () => temporalUpscale?.dispose(), () => temporalAa?.dispose(), () => screenSpaceReflection?.dispose(),
        () => volumetricFogComposite?.dispose(), () => volumetricFog?.dispose(),
        () => ambientOcclusionComposite?.dispose(),
        () => ambientOcclusion?.dispose(), () => hiZ?.dispose(),
      ]);
    }
    this.hiZ = hiZ; this.ambientOcclusion = ambientOcclusion;
    this.ambientOcclusionComposite = ambientOcclusionComposite;
    this.screenSpaceReflection = screenSpaceReflection;
    this.volumetricFog = volumetricFog; this.volumetricFogComposite = volumetricFogComposite;
    this.temporalAa = temporalAa; this.temporalUpscale = temporalUpscale; this.bloom = bloom;
  }

  /**
   * 空闲预热:后台编译描边管线(createRender/ComputePipelineAsync),不阻塞任何帧。首个描边帧若尚未完成则回落同步构造;
   * 抢先被同步路径创建的 pass 使预热结果作废。失败静默(回落同步路径,错误由首次真实使用暴露)。
   */
  prewarmInstanceOutline(): Promise<void> {
    if (this.disposed || this.instanceOutline || this.outlinePrewarm || !this.pool) return Promise.resolve();
    const pending = InstanceOutlinePass.createAsync(this.session, this.pool).then(pass => {
      if (this.disposed || this.instanceOutline) pass.dispose(); else this.instanceOutline = pass;
    }, () => { /* sync fallback at first use */ }).finally(() => { if (this.outlinePrewarm === pending) this.outlinePrewarm = undefined; });
    this.outlinePrewarm = pending;
    return pending;
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
    input.passTiming?.beginMarker(encoder, "ambient-occlusion");
    const ao = this.ambientOcclusion!.encode(encoder, {
      depth: targets.linearDepthTexture, normal: targets.normalTexture, revision,
      depthEncoding: "linear-view-depth-positive", normalSpace: "view",
    }, { verticalFovRadians, radius, thickness, power: 1.5 });
    input.passTiming?.endMarker(encoder, "ambient-occlusion");
    input.passTiming?.beginMarker(encoder, "apply-ambient-occlusion");
    const composited = this.ambientOcclusionComposite!.encode(encoder, {
      color: targets.hdrTexture, depth: targets.linearDepthTexture, normal: targets.normalTexture, ambientOcclusion: ao,
      revision, colorEncoding: "linear-hdr", depthEncoding: "linear-view-depth-positive",
    }, { depthSigma: Math.min(1_000_000, Math.max(0.01, extent * 0.005)), strength: 1 });
    input.passTiming?.endMarker(encoder, "apply-ambient-occlusion");
    return Object.freeze({ color: composited.texture, ...(hiZ ? { hiZ } : {}), passCount: hiZPasses + 4 });
  }

  /** Resolves temporal history after transparency, then applies real HDR bloom. */
  encodeFinal(input: PbrPostProcessInput, color: GPUTexture): PbrFinalEffectsResult {
    if (this.disposed) throw new Error("Post-process chain is disposed.");
    const active = resolvePbrPostProcessOverrides(input.postProcess, this.features);
    const { encoder, targets, revision, extent, verticalFovRadians, cameraCut, currentJitter, previousJitter } = input;
    if (this.pendingTemporalRevision !== undefined) this.temporalValidity.cancelFrame(this.pendingTemporalRevision);
    const temporalPlan = this.temporalValidity.beginFrame({ revision,
      width: input.surfaceWidth ?? color.width ?? 1, height: input.surfaceHeight ?? color.height ?? 1,
      cameraCut, motionAvailable: true, depthAvailable: true,
      ...(input.disoccluded === undefined ? {} : { disoccluded: input.disoccluded }),
      ...(input.materialRevision === undefined ? {} : { materialRevision: input.materialRevision }),
      ...(input.lightRevision === undefined ? {} : { lightRevision: input.lightRevision }),
      ...(input.exposure === undefined ? {} : { exposure: input.exposure }),
      ...(input.reactiveMaskAvailable === undefined ? {} : { reactiveMaskAvailable: input.reactiveMaskAvailable }) });
    this.pendingTemporalRevision = revision; this.lastTemporalPlan = temporalPlan;
    let marched = color;
    let effectPasses = 0;
    if (active.volumetricFog && this.volumetricFog && this.volumetricFogComposite) {
      const profile = active.volumetricFogProfile;
      input.passTiming?.beginMarker(encoder, "volumetric-fog-march");
      const source = {
        depth: targets.linearDepthTexture, revision, depthEncoding: "linear-view-depth-positive",
      } as const;
      const fogOptions = { verticalFovRadians, steps: Math.min(profile.steps ?? 48, input.adaptiveQuality?.fogSteps ?? 64),
        maxDistance: profile.maxDistance ?? Math.max(1, Math.min(100_000, extent * 4)),
        medium: profile.medium, light: profile.light };
      if (profile.godRaysStrength !== undefined && !input.godRays) throw new Error("God rays requires the current primary light and prepared CSM.");
      const scatter = profile.godRaysStrength === undefined ? this.volumetricFog.encode(encoder, source, fogOptions)
        : (this.volumetricGodRays ??= new VolumetricGodRaysPass(this.session, this.pool)).encode(encoder, source,
          input.godRays!.shadows, { ...fogOptions, maxDistance: Math.min(1000, fogOptions.maxDistance),
            light: input.godRays!.light, viewToWorld: input.godRays!.viewToWorld, strength: profile.godRaysStrength });
      input.passTiming?.endMarker(encoder, "volumetric-fog-march");
      input.passTiming?.beginMarker(encoder, "volumetric-fog-composite");
      marched = this.volumetricFogComposite.encode(encoder, {
        color: marched, scatter, revision, colorEncoding: "linear-hdr",
      }).texture;
      input.passTiming?.endMarker(encoder, "volumetric-fog-composite");
      effectPasses += 2;
    }
    if (active.screenSpaceReflection && this.screenSpaceReflection) {
      // E04 首切片:SSR 在 TAA 前,TAA 顺带平滑半分辨率步进痕迹;顺序与 Babylon SSR→TAA 一致。
      if (input.brdfLut === undefined) throw new Error("Screen-space reflection requires the environment BRDF LUT (C11 physical mask).");
      const reflected = this.screenSpaceReflection.encode(encoder, {
        color: marched, depth: targets.linearDepthTexture, normal: targets.normalTexture, revision,
        brdfLut: input.brdfLut,
        depthEncoding: "linear-view-depth-positive", normalSpace: "view", colorEncoding: "linear-hdr",
      }, { ...defaultScreenSpaceReflectionOptions(extent),
        ...(active.screenSpaceReflectionProfile ? {
          steps: active.screenSpaceReflectionProfile.steps,
          thickness: Math.max(0.001, extent * active.screenSpaceReflectionProfile.thicknessScale),
          maxDistance: Math.max(0.25, extent * active.screenSpaceReflectionProfile.maxDistanceScale),
        } : {}), ...(input.adaptiveQuality ? { coneMipLevels: input.adaptiveQuality.ssrConeLevels } : {}),
        verticalFovRadians, ...(input.passTiming ? { passTiming: input.passTiming } : {}) });
      marched = reflected.texture; effectPasses += reflected.passCount;
    }
    let temporal: { readonly texture: GPUTexture } = { texture: marched };
    if (this.features.temporalAa) {
      if (this.features.debugForceFullRender) this.temporalAa!.reset();
      input.passTiming?.beginMarker(encoder, "temporal-aa");
      temporal = this.temporalAa!.encode(encoder, {
        color: marched, depth: targets.linearDepthTexture, motion: targets.motionTexture, revision,
        ...(input.reactiveMask ? { reactiveMask: input.reactiveMask } : {}),
        cameraCut: cameraCut || !temporalPlan.decisions.taa.valid,
        colorEncoding: "linear-hdr", currentJitter, previousJitter,
        depthEncoding: "linear-view-depth-positive", motionEncoding: "current-to-previous-uv",
      }, { feedback: 0.9, depthThreshold: Math.min(100, Math.max(0.01, extent * 0.001)), relativeDepthThreshold: 0.02 });
      input.passTiming?.endMarker(encoder, "temporal-aa");
    }
    // 对象级描边在 TAA 之后、bloom 之前(同作者 EffectComposer:Outline → Bloom → Output),写入新的瞬态纹理,
    // 不污染 TAA 历史。
    let graded = temporal.texture, outline: InstanceOutlineDrawStats | undefined;
    if (input.outline) {
      if (!this.pool) throw new Error("Instance outline requires the transient texture pool.");
      const outlined = (this.instanceOutline ??= new InstanceOutlinePass(this.session, this.pool)).encode(encoder, {
        color: graded, depthView: targets.depth, viewProjection: input.outline.viewProjection,
        ...(active.instanceOutline ? { options: active.instanceOutline } : {}), draw: input.outline.draw });
      graded = outlined.texture; effectPasses += outlined.passCount;
      outline = Object.freeze({ drawCalls: outlined.drawCalls, skippedBatches: outlined.skippedBatches });
    }
    if (!active.bloom) return Object.freeze({ color: graded, passCount: effectPasses + (this.features.temporalAa ? 1 : 0),
      ...(outline ? { outline } : {}) });
    const source = { color: graded, revision, colorEncoding: "linear-hdr" as const };
    input.passTiming?.beginMarker(encoder, "bloom");
    const bloom = active.authorBloom
      ? (this.authorBloom ??= new AuthorBloomPass(this.session, this.pool)).encode(encoder, source, active.authorBloom)
      : this.bloom!.encode(encoder, source, DEFAULT_PBR_BLOOM_OPTIONS);
    input.passTiming?.endMarker(encoder, "bloom");
    return Object.freeze({ color: bloom.texture, passCount: effectPasses + (this.features.temporalAa ? 1 : 0) + bloom.passCount,
      ...(outline ? { outline } : {}) });
  }

  /**
   * F4 时域上采样:超分激活时把链尾 HDR(接触阴影或 bloom/TAA 输出)从内部渲染
   * 分辨率重建到画布全分辨率;未激活(特性关或 scale=1)返回 undefined 保持直通。
   * 输入合同与 TAA 同族;displayScale 由画布/内部尺寸比导出,历史失效 fail-closed
   * 退化为纯 Catmull-Rom。reactiveMask(可选,内部分辨率 r8unorm):透明/粒子
   * reactive 覆盖随 source 透传给 upscale 历史降权,缺省不供给 = 零行为变化
   * (渲染器侧供给接线:pbrRenderer encodeUpscale 调用点,模式同 encodeFinal)。
   */
  encodeUpscale(input: {
    readonly encoder: GPUCommandEncoder;
    readonly targets: RenderTargets;
    readonly revision: number;
    readonly extent: number;
    readonly cameraCut: boolean;
    readonly currentJitter: readonly [number, number];
    readonly previousJitter: readonly [number, number];
    /** 显示画布尺寸(session resize 后的全分辨率)。 */
    readonly displayWidth: number;
    readonly displayHeight: number;
    /** 内部分辨率 reactive 覆盖(透明/粒子);缺省 = upscale 历史权重不变。 */
    readonly reactiveMask?: GPUTexture;
  }, color: GPUTexture): { readonly texture: GPUTexture; readonly width: number;
    readonly height: number; readonly historyUsed: boolean; readonly invalidation: string } | undefined {
    if (this.disposed) throw new Error("Post-process chain is disposed.");
    if (!this.temporalUpscale) return undefined;
    if (color.width >= input.displayWidth && color.height >= input.displayHeight) return undefined;
    if (this.features.debugForceFullRender) this.temporalUpscale.reset();
    const source: TemporalUpscalePassSource = {
      color, depth: input.targets.linearDepthTexture, motion: input.targets.motionTexture,
      revision: input.revision, cameraCut: input.cameraCut,
      ...(input.reactiveMask === undefined ? {} : { reactiveMask: input.reactiveMask }),
      currentJitter: input.currentJitter, previousJitter: input.previousJitter,
      colorEncoding: "linear-hdr", depthEncoding: "linear-view-depth-positive",
      motionEncoding: "current-to-previous-uv",
      displayScale: input.displayWidth / color.width,
    };
    const result = this.temporalUpscale.encode(input.encoder, source, {
      feedback: 0.9, depthThreshold: Math.min(100, Math.max(0.01, input.extent * 0.001)),
      relativeDepthThreshold: 0.02 });
    return Object.freeze({ texture: result.texture, width: result.width, height: result.height,
      historyUsed: result.historyUsed, invalidation: result.historyInvalidation ?? "none" });
  }

  /** Publish validity inputs only after the renderer's queue submission succeeds. */
  commitFrame(revision: number): void {
    if (this.pendingTemporalRevision !== revision) return;
    this.temporalValidity.commitFrame(revision); this.pendingTemporalRevision = undefined;
  }

  cancelFrame(revision: number): void {
    if (this.pendingTemporalRevision !== revision) return;
    this.temporalValidity.cancelFrame(revision); this.pendingTemporalRevision = undefined;
  }

  temporalPlan(): TemporalValidityPlan | undefined { return this.lastTemporalPlan; }

  /**
   * 第一切片计划对拍声明(DE26/B03):逐 pass 描述本类 encode 路径的实际读写、格式与尺寸角色,
   * 供 pbrFramePlanExecutor 与编译计划对拍;纯静态、不触 GPU、不改变执行。
   */
  static describePasses(features: PbrRendererFeatures, transparency: boolean,
    options: { readonly opaqueColorResource?: string; readonly godRays?: boolean } = {}): readonly PbrActualPassDescription[] {
    const opaqueColorResource = options.opaqueColorResource ?? (features.ambientOcclusion ? "ao-hdr" : "opaque-hdr");
    const opaqueDomain = transparency ? "composited-hdr" : opaqueColorResource;
    const fogInput = opaqueDomain;
    const reflectionInput = features.volumetricFog ? "volumetric-fog-hdr" : fogInput;
    // E04:SSR 插在透明合成之后、TAA 之前;启用时 TAA 的输入域改为 ssr-hdr。
    const temporalInput = features.screenSpaceReflection ? "ssr-hdr" : reflectionInput;
    // 输入资源的创建 usage 随生产者不同:composited-hdr 来自 OIT scratch;ao-hdr 来自 AO composite 输出。
    const opaqueInputUsages: readonly FramePlanUsage[] = transparency || opaqueColorResource === "opaque-hdr"
      ? ["render-attachment", "texture-binding", "storage-binding", "copy-src"]
      : ["storage-binding", "texture-binding", "render-attachment", "copy-src"];
    const reflectionInputUsages: readonly FramePlanUsage[] = features.volumetricFog
      ? ["storage-binding", "texture-binding", "copy-src"] : opaqueInputUsages;
    // ssr-hdr 自 C12 起带 COPY_SRC(present-color 读回链落点);其余输入域不变。
    const temporalInputUsages: readonly FramePlanUsage[] = features.screenSpaceReflection
      ? ["storage-binding", "texture-binding", "copy-src"] : reflectionInputUsages;
    const bloomInput = features.temporalAa ? "temporal-hdr" : temporalInput;
    const bloomInputUsages: readonly FramePlanUsage[] = features.temporalAa
      ? ["storage-binding", "texture-binding", "copy-src"] : temporalInputUsages;
    const geometryRead = (id: string): PbrActualPassDescription["claims"][number] => ({
      id, access: "read", format: id === "linear-depth" ? PBR_LINEAR_DEPTH_FORMAT : PBR_VIEW_NORMAL_FORMAT,
      // linear-depth 带 COPY_SRC（R12 白名单诊断快照），读侧 claim 与资源实际 usage 一致。
      // AA-M1:主帧目标合同为单采样(MSAA 的 resolve 产物),采样链只见这一层。
      sampleCount: 1,
      usages: id === "linear-depth" ? ["render-attachment", "texture-binding", "copy-src", "storage-binding"]
        : ["render-attachment", "texture-binding"], sizeRole: "surface",
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
      claims: [{ id: "opaque-hdr", access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
        usages: ["render-attachment", "texture-binding", "storage-binding", "copy-src"], sizeRole: "surface" },
        geometryRead("linear-depth"), geometryRead("view-normal"),
        { id: "ao-half", access: "read", format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "half" },
        { id: "ao-hdr", access: "write", format: AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "render-attachment", "copy-src"], sizeRole: "surface" }],
      gpuPassCount: 1,
    });
    if (features.volumetricFog) passes.push({
      passId: "volumetric-fog-march", executor: options.godRays ? "VolumetricGodRaysPass.encode" : "VolumetricFogPass.encode", kind: "compute",
      reads: ["linear-depth", ...(options.godRays ? ["shadow-atlas"] : [])], writes: ["volumetric-fog-scatter"],
      claims: [geometryRead("linear-depth"),
        ...(options.godRays ? [{ id: "shadow-atlas", access: "read" as const, format: "depth32float", sampleCount: 1,
          usages: ["render-attachment", "texture-binding"] as const, sizeRole: "independent" as const }] : []),
        { id: "volumetric-fog-scatter", access: "write", format: VOLUMETRIC_FOG_SCATTER_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding"], sizeRole: "half" }],
      gpuPassCount: 1,
      ...(options.godRays ? { unplannedAttachments: [{ id: "borrowed-csm-uniform/sampler", reason: "复用主光 CSM 的 624B uniform 与 sampler，由原 shadow owner 回收" }] } : {}),
    }, {
      passId: "volumetric-fog-composite", executor: "VolumetricFogCompositePass.encode", kind: "compute",
      reads: [fogInput, "volumetric-fog-scatter"], writes: ["volumetric-fog-hdr"],
      claims: [{ id: fogInput, access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
        usages: opaqueInputUsages, sizeRole: "surface" },
      { id: "volumetric-fog-scatter", access: "read", format: VOLUMETRIC_FOG_SCATTER_FORMAT, sampleCount: 1,
        usages: ["storage-binding", "texture-binding"], sizeRole: "half" },
      { id: "volumetric-fog-hdr", access: "write", format: VOLUMETRIC_FOG_COMPOSITE_FORMAT, sampleCount: 1,
        usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "surface" }],
      unplannedAttachments: [{ id: "volumetric-fog-sampler", reason: "半分辨率散射上采样的私有 filtering sampler" }],
      gpuPassCount: 1,
    });
    if (features.screenSpaceReflection) passes.push({
      passId: "screen-space-reflection-trace", executor: "ScreenSpaceReflectionPass.encode/trace", kind: "compute",
      reads: [reflectionInput, "linear-depth", "view-normal"], writes: ["ssr-trace"],
      claims: [{ id: reflectionInput, access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
        usages: reflectionInputUsages, sizeRole: "surface" },
        geometryRead("linear-depth"), geometryRead("view-normal"),
        { id: "ssr-trace", access: "write", format: SSR_COMPOSITE_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding"], sizeRole: "half" }],
      unplannedAttachments: [
        { id: "ssr-sampler", reason: "trace 双线性采样的私有 filtering sampler" },
        { id: "ssr-radiance-mips", reason: "trace 前最多 6 层、受预算约束的私有粗糙度锥追踪辐射层级" },
      ],
      gpuPassCount: 7,
    }, {
      passId: "screen-space-reflection-composite", executor: "ScreenSpaceReflectionPass.encode/composite", kind: "compute",
      reads: [reflectionInput, "ssr-trace"], writes: ["ssr-hdr"],
      claims: [{ id: reflectionInput, access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
        usages: reflectionInputUsages, sizeRole: "surface" },
        { id: "ssr-trace", access: "read", format: SSR_COMPOSITE_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding"], sizeRole: "half" },
        // copy-src: R12 白名单读回链(present-color 在 SSR 开启时就是本输出,对齐 ao/temporal 合同)。
        { id: "ssr-hdr", access: "write", format: SSR_COMPOSITE_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "surface" }],
      unplannedAttachments: [{ id: "ssr-composite-sampler", reason: "composite 双线性采样的私有 filtering sampler" }],
      gpuPassCount: 1,
    });
    if (features.temporalAa) passes.push({
      passId: "temporal-aa", executor: "TemporalAaPass.encode", kind: "compute",
      reads: [temporalInput, "linear-depth", "motion"], writes: ["temporal-hdr"],
      claims: [{ id: temporalInput, access: "read", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
        usages: temporalInputUsages, sizeRole: "surface" },
        geometryRead("linear-depth"),
        { id: "motion", access: "read", format: PBR_MOTION_FORMAT, sampleCount: 1,
          usages: ["render-attachment", "texture-binding"], sizeRole: "surface" },
        { id: "temporal-hdr", access: "write", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
          usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "surface" }],
      unplannedAttachments: [{ id: "taa-history-depth-a/b", reason: "TAA 双帧 ping-pong 的私有深度历史" }],
      gpuPassCount: 1,
    });
    if (features.bloom) passes.push({
      passId: "bloom", executor: "BloomPass.encode", kind: "compute",
      reads: [bloomInput], writes: ["bloom-hdr"],
      claims: [{ id: bloomInput, access: "read", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
        usages: bloomInputUsages, sizeRole: "surface" },
        { id: "bloom-hdr", access: "write", format: BLOOM_COLOR_FORMAT, sampleCount: 1,
          usages: ["texture-binding", "storage-binding", "render-attachment", "copy-src"], sizeRole: "surface" }],
      unplannedAttachments: [{ id: "bloom-pyramid-levels", reason: "bloom 高斯金字塔私有层级纹理" }],
      gpuPassCount: DEFAULT_PBR_BLOOM_OPTIONS.maxLevels * 4,
    });
    // F4 时域上采样:链尾 display 输出。输入取 contact-hdr(开启时)否则 bloom/taa 链尾,
    // 与渲染器实际 encodeUpscale 调用的输入同源;usages 按资源合同逐 id 精确声明。
    if (features.temporalUpscale) {
      const upscaleInput = features.contactShadows ? "contact-hdr" : bloomInput;
      const upscaleInputUsages: readonly FramePlanUsage[] =
        upscaleInput === "contact-hdr"
          // contact-hdr 真实生产是 compute storage 写(contactShadowResources.encode),
          // 与 ssr/temporal/fog/upscale 同合同,无渲染附件用途。
          ? ["storage-binding", "texture-binding", "copy-src"]
          : upscaleInput === "ao-hdr"
            ? ["storage-binding", "texture-binding", "render-attachment", "copy-src"]
            : upscaleInput === "bloom-hdr" ? ["texture-binding", "storage-binding", "render-attachment", "copy-src"]
            : upscaleInput === "composited-hdr" || upscaleInput === "opaque-hdr"
              ? ["render-attachment", "texture-binding", "storage-binding", "copy-src"]
              : upscaleInput === "volumetric-fog-hdr" ? ["storage-binding", "texture-binding", "copy-src"]
              : ["storage-binding", "texture-binding", "copy-src"];
      passes.push({
        passId: "temporal-upscale", executor: "TemporalUpscalePass.encode", kind: "compute",
        reads: [upscaleInput, "motion", "linear-depth"], writes: ["upscale-hdr"],
        claims: [{ id: upscaleInput, access: "read", format: TEMPORAL_AA_COLOR_FORMAT, sampleCount: 1,
          usages: upscaleInputUsages, sizeRole: "surface" },
          { id: "motion", access: "read", format: PBR_MOTION_FORMAT, sampleCount: 1,
            usages: ["render-attachment", "texture-binding"], sizeRole: "surface" },
          geometryRead("linear-depth"),
          { id: "upscale-hdr", access: "write", format: TEMPORAL_UPSCALE_COLOR_FORMAT, sampleCount: 1,
            usages: ["storage-binding", "texture-binding", "copy-src"], sizeRole: "display" }],
        unplannedAttachments: [{ id: "upscale-history-color/depth-a/b", reason: "全分辨率时域重建双缓冲历史" }],
        gpuPassCount: 1,
      });
    }
    return passes;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runResourceCleanup("Post-process disposal failed", [() => this.instanceOutline?.dispose(), () => this.authorBloom?.dispose(), () => this.bloom?.dispose(),
      () => this.temporalAa?.dispose(), () => this.temporalUpscale?.dispose(), () => this.screenSpaceReflection?.dispose(),
      () => this.volumetricFogComposite?.dispose(), () => this.volumetricGodRays?.dispose(), () => this.volumetricFog?.dispose(),
      () => this.ambientOcclusionComposite?.dispose(),
      () => this.ambientOcclusion?.dispose(), () => this.hiZ?.dispose()]);
  }
}
