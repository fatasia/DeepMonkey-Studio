import { packCascadedShadowUniform, CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import { CASCADED_SHADOW_QUALITY_PROFILES, resolveCascadedShadowQuality,
  type CascadedShadowQualitySelection, type CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import { estimateCascadedShadowDepthBytes } from "../shadows/shadowQuality.js";
import type { CascadedShadowPlan, ShadowVec3 } from "../shadows/types.js";
import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { PBR_FRAME_FLOAT_OFFSETS, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";

export const PBR_CASCADE_COUNT = CASCADED_SHADOW_QUALITY_PROFILES.high.options.cascadeCount;
export const PBR_CASCADE_MAP_SIZE = CASCADED_SHADOW_QUALITY_PROFILES.high.options.shadowMapSize;
export const PBR_SUN_RAY_DIRECTION: ShadowVec3 = Object.freeze([-1.6, -2.8, -1.2]);

export interface CascadedShadowResourceOptions {
  readonly requestedTier?: CascadedShadowQualityTier;
  readonly maxDepthTextureBytes?: number;
  readonly exactProfile?: Readonly<{ cascadeCount: number; shadowMapSize: number;
    splitLambda?: number; blendRatio?: number; depthBias?: number;
    receiverNormalBias?: "slope-scaled" | "constant-one-texel" }>;
}

interface ExactShadowSelection {
  readonly requestedTier: "exact"; readonly selectedTier: "exact"; readonly downgraded: false;
  readonly rejected: readonly never[];
  readonly profile: Readonly<{ tier: "exact"; options: Readonly<{ cascadeCount: number; shadowMapSize: number;
    splitLambda: number; blendRatio: number }>; estimatedDepthTextureBytes: number }>;
}

export interface CascadedShadowFrameInput {
  readonly eye: ShadowVec3;
  readonly target: ShadowVec3;
  readonly up?: ShadowVec3;
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly extent: number;
  readonly lightDirection?: ShadowVec3;
}

export interface CascadedShadowFrame {
  readonly plan: CascadedShadowPlan;
  readonly render: boolean;
}

/** Owns the array texture, fixed ABI and per-cascade shadow vertex uniforms. */
export class CascadedShadowResources {
  readonly selection: CascadedShadowQualitySelection | ExactShadowSelection;
  readonly binding: GPUBindGroup;
  readonly legacyView: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly layerViews: readonly GPUTextureView[];
  readonly frameBindings: readonly GPUBindGroup[];
  private readonly texture: GPUTexture;
  private readonly uniform: GPUBuffer;
  private readonly frameBuffers: readonly GPUBuffer[];
  private lastSignature: readonly number[] | undefined;
  private pendingSignature: readonly number[] | undefined;
  private plan: CascadedShadowPlan | undefined;
  private disposed = false;
  private readonly depthBias: number;
  private readonly constantNormalBias: boolean;

  constructor(private readonly session: DeviceSession, pipelines: Pipelines,
    options: CascadedShadowResourceOptions = {}) {
    const device = session.device;
    const validatedOptions = validateResourceOptions(options);
    this.depthBias = exactNumber(validatedOptions.exactProfile?.depthBias ?? 0.00075, 0, 0.1, "depth bias");
    const normalBias = validatedOptions.exactProfile?.receiverNormalBias ?? "slope-scaled";
    if (normalBias !== "slope-scaled" && normalBias !== "constant-one-texel") {
      throw new RangeError("Invalid exact shadow receiver normal bias.");
    }
    this.constantNormalBias = normalBias === "constant-one-texel";
    this.selection = selectProfile(validatedOptions, device.limits);
    const { cascadeCount, shadowMapSize } = this.selection.profile.options;
    const created: Array<GPUTexture | GPUBuffer> = [];
    try {
      const texture = session.own(device.createTexture({
        label: "Deep cascaded shadow map", size: [shadowMapSize, shadowMapSize, cascadeCount],
        format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }));
      created.push(texture);
      const layerViews = Object.freeze(Array.from({ length: cascadeCount }, (_, baseArrayLayer) =>
        texture.createView({ dimension: "2d", aspect: "depth-only", baseArrayLayer, arrayLayerCount: 1 })));
      const legacyView = layerViews[0]!;
      const arrayView = texture.createView({ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: cascadeCount });
      const sampler = device.createSampler({ compare: "less-equal", minFilter: "linear", magFilter: "linear" });
      const uniform = uploadBuffer(session, "Deep cascaded shadow uniform",
        new Float32Array(CASCADED_SHADOW_UNIFORM_BYTES / 4), GPUBufferUsage.UNIFORM);
      created.push(uniform);
      const binding = device.createBindGroup({ layout: pipelines.cascadedShadowLayout, entries: [
        { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: arrayView }, { binding: 2, resource: sampler },
      ] });
      const frameBuffers: GPUBuffer[] = [];
      for (let index = 0; index < cascadeCount; index += 1) {
        const buffer = uploadBuffer(session, `Deep cascade ${index} frame`,
          new Float32Array(PBR_FRAME_UNIFORM_FLOATS), GPUBufferUsage.UNIFORM);
        created.push(buffer); frameBuffers.push(buffer);
      }
      const shadowFrameLayout = pipelines.shadow.getBindGroupLayout(0);
      const frameBindings = Object.freeze(frameBuffers.map(buffer => device.createBindGroup({
        layout: shadowFrameLayout, entries: [{ binding: 0, resource: { buffer } }],
      })));
      this.texture = texture; this.layerViews = layerViews; this.legacyView = legacyView; this.sampler = sampler;
      this.uniform = uniform; this.binding = binding; this.frameBuffers = Object.freeze(frameBuffers);
      this.frameBindings = frameBindings;
    } catch (error) {
      for (const resource of created.reverse()) session.release(resource);
      throw error;
    }
  }

  prepare(input: CascadedShadowFrameInput, force: boolean): CascadedShadowFrame {
    if (this.disposed) throw new Error("Cascaded shadow resources are disposed.");
    const direction = input.lightDirection ?? PBR_SUN_RAY_DIRECTION;
    const maximum = Math.min(input.far, 1_000_000);
    const shadowFar = Math.min(maximum, Math.max(input.near + 1e-4, input.extent * 20));
    const signature = [...input.eye, ...input.target, ...(input.up ?? [0, 1, 0]), input.verticalFovRadians,
      input.aspect, input.near, shadowFar, ...direction];
    const changed = !this.lastSignature || !same(signature, this.lastSignature);
    if (changed) {
      this.plan = planCascadedShadows({ eye: input.eye, target: input.target, ...(input.up ? { up: input.up } : {}),
        verticalFovRadians: input.verticalFovRadians, aspect: input.aspect, near: input.near, far: shadowFar },
      direction, { ...this.selection.profile.options,
        maxShadowDistance: shadowFar, depthPadding: Math.max(1, input.extent * 0.2) });
      this.session.device.queue.writeBuffer(this.uniform, 0,
        packCascadedShadowUniform(this.plan, this.depthBias, this.constantNormalBias));
      this.plan.cascades.forEach((cascade, index) => {
        const data = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
        data.set(cascade.viewProjection, PBR_FRAME_FLOAT_OFFSETS.lightViewProjection);
        this.session.device.queue.writeBuffer(this.frameBuffers[index]!, 0, data);
      });
      this.pendingSignature = Object.freeze(signature);
    }
    return Object.freeze({ plan: this.plan!, render: force || changed });
  }

  /** Publishes the prepared plan only after its command buffer was accepted by the queue. */
  commit(): void {
    if (this.pendingSignature) this.lastSignature = this.pendingSignature;
    this.pendingSignature = undefined;
  }

  invalidate(): void { this.lastSignature = undefined; this.pendingSignature = undefined; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.release(this.texture);
    this.session.release(this.uniform);
    for (const buffer of this.frameBuffers) this.session.release(buffer);
    this.invalidate();
    this.plan = undefined;
  }

}

function same(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateResourceOptions(options: CascadedShadowResourceOptions): CascadedShadowResourceOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Cascaded shadow resource options must be an object.");
  }
  return options;
}

function selectProfile(options: CascadedShadowResourceOptions, limits: GPUSupportedLimits): CascadedShadowQualitySelection | ExactShadowSelection {
  if (!options.exactProfile) return resolveCascadedShadowQuality(options.requestedTier ?? "high", {
    maxTextureDimension2D: limits.maxTextureDimension2D, maxTextureArrayLayers: limits.maxTextureArrayLayers,
    ...(options.maxDepthTextureBytes === undefined ? {} : { maxDepthTextureBytes: options.maxDepthTextureBytes }),
  });
  if (options.requestedTier !== undefined) throw new Error("Exact shadows cannot also request a quality tier.");
  const { exactProfile } = options, cascadeCount = exactInteger(exactProfile.cascadeCount, 1, 8, "cascade count");
  const shadowMapSize = exactInteger(exactProfile.shadowMapSize, 64, limits.maxTextureDimension2D, "shadow map size");
  if (cascadeCount > limits.maxTextureArrayLayers) throw new RangeError("Exact shadow cascade count exceeds device limits.");
  const splitLambda = exactNumber(exactProfile.splitLambda ?? 0, 0, 1, "split lambda");
  const blendRatio = exactNumber(exactProfile.blendRatio ?? 0, 0, 0.5, "blend ratio");
  const estimatedDepthTextureBytes = estimateCascadedShadowDepthBytes(cascadeCount, shadowMapSize);
  if (options.maxDepthTextureBytes !== undefined && estimatedDepthTextureBytes > options.maxDepthTextureBytes) {
    throw new RangeError("Exact shadow profile exceeds its depth memory budget.");
  }
  return Object.freeze({ requestedTier: "exact", selectedTier: "exact", downgraded: false, rejected: Object.freeze([]),
    profile: Object.freeze({ tier: "exact", options: Object.freeze({ cascadeCount, shadowMapSize, splitLambda, blendRatio }),
      estimatedDepthTextureBytes }) });
}
function exactInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid exact shadow ${label}.`); return value;
}
function exactNumber(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`Invalid exact shadow ${label}.`); return value;
}
