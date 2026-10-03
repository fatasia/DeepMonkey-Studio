import { createAdmittedTexture } from "./resourceAdmission.js";
import { packCascadedShadowUniform, CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import { CASCADED_SHADOW_QUALITY_PROFILES, resolveCascadedShadowQuality,
  type CascadedShadowQualitySelection, type CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import { estimateCascadedShadowDepthBytes } from "../shadows/shadowQuality.js";
import type { CascadedShadowPlan, ShadowVec3 } from "../shadows/types.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GodRaysShadowSource } from "../fog/volumetricGodRaysPassTypes.js";
import { uploadBuffer } from "./meshBuffers.js";
import { PBR_FRAME_FLOAT_OFFSETS, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { snapshotAuthoredShadow, planAuthoredShadow, packAuthoredShadow, type AuthoredDirectionalShadow } from "../shadows/authoredDirectionalShadow.js";

export const PBR_CASCADE_COUNT = CASCADED_SHADOW_QUALITY_PROFILES.high.options.cascadeCount;
export const PBR_CASCADE_MAP_SIZE = CASCADED_SHADOW_QUALITY_PROFILES.high.options.shadowMapSize;
export const PBR_SUN_RAY_DIRECTION: ShadowVec3 = Object.freeze([-1.6, -2.8, -1.2]);

export interface CascadedShadowResourceOptions {
  readonly requestedTier?: CascadedShadowQualityTier;
  readonly maxDepthTextureBytes?: number;
  readonly exactProfile?: Readonly<{ cascadeCount: number; shadowMapSize: number;
    splitLambda?: number; blendRatio?: number; depthBias?: number;
    depthPadding?: number; maxShadowDistance?: number;
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
  readonly authored?: AuthoredDirectionalShadow;
  readonly viewportHeight?: number;
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
  private readonly arrayView: GPUTextureView;
  private readonly createdDevice: GPUDevice;
  private readonly frameBuffers: readonly GPUBuffer[];
  /** B1 Brief-VSM:级联档占位页表/atlas 资源(dispose 同步释放,防泄漏)。 */
  private readonly vsmPlaceholders: readonly (GPUTexture | GPUBuffer)[];
  private lastSignature: readonly number[] | undefined;
  private pendingSignature: readonly number[] | undefined;
  private plan: CascadedShadowPlan | undefined;
  private disposed = false;
  private renderingEnabled = true;
  private readonly depthBias: number;
  private readonly constantNormalBias: boolean;
  private readonly exactDepthPadding: number | undefined;
  private readonly exactMaxShadowDistance: number | undefined;

  constructor(private readonly session: DeviceSession, pipelines: Pipelines,
    options: CascadedShadowResourceOptions = {}) {
    const device = session.device;
    this.createdDevice = device;
    const validatedOptions = validateResourceOptions(options);
    this.depthBias = exactNumber(validatedOptions.exactProfile?.depthBias ?? 0.00075, 0, 0.1, "depth bias");
    this.exactDepthPadding = validatedOptions.exactProfile?.depthPadding === undefined ? undefined
      : exactNumber(validatedOptions.exactProfile.depthPadding, 0, 1_000_000, "depth padding");
    this.exactMaxShadowDistance = validatedOptions.exactProfile?.maxShadowDistance === undefined ? undefined
      : exactNumber(validatedOptions.exactProfile.maxShadowDistance, Number.MIN_VALUE, 1_000_000, "maximum shadow distance");
    const normalBias = validatedOptions.exactProfile?.receiverNormalBias ?? "slope-scaled";
    if (normalBias !== "slope-scaled" && normalBias !== "constant-one-texel") {
      throw new RangeError("Invalid exact shadow receiver normal bias.");
    }
    this.constantNormalBias = normalBias === "constant-one-texel";
    this.selection = selectProfile(validatedOptions, session);
    const { cascadeCount, shadowMapSize } = this.selection.profile.options;
    const created: Array<GPUTexture | GPUBuffer> = [];
    try {
      const texture = createAdmittedTexture(session, {
        label: "Deep cascaded shadow map", size: [shadowMapSize, shadowMapSize, cascadeCount],
        format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      created.push(texture);
      // B1 Brief-VSM:group 2 增补的页表/atlas 绑定在级联档用占位资源填充(着色端
      // params2.x=0 不消费),保持唯一布局形态,主/透明/display 管线无变体分叉。
      // 占位 buffer 走 uploadBuffer(会话托管),dispose/回滚同族释放。
      const vsmPlaceholderBuffers = [0, 1].map(index => uploadBuffer(session,
        `Deep cascaded vsm placeholder ${index}`, new Float32Array(4),
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST));
      created.push(...vsmPlaceholderBuffers);
      const vsmPlaceholderAtlas = createAdmittedTexture(session, {
        label: "Deep cascaded vsm placeholder atlas", size: [4, 4, 1], format: "r32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      created.push(vsmPlaceholderAtlas);
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
        { binding: 3, resource: { buffer: vsmPlaceholderBuffers[0]! } },
        { binding: 4, resource: { buffer: vsmPlaceholderBuffers[1]! } },
        { binding: 5, resource: vsmPlaceholderAtlas.createView({ dimension: "2d-array" }) },
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
      this.uniform = uniform; this.arrayView = arrayView; this.binding = binding; this.frameBuffers = Object.freeze(frameBuffers);
      this.frameBindings = frameBindings;
      this.vsmPlaceholders = Object.freeze([...vsmPlaceholderBuffers, vsmPlaceholderAtlas]);
    } catch (error) {
      for (const resource of created.reverse()) session.release(resource);
      throw error;
    }
  }

  prepare(input: CascadedShadowFrameInput, force: boolean, enabled = true): CascadedShadowFrame {
    if (this.disposed) throw new Error("Cascaded shadow resources are disposed.");
    if (enabled && !this.renderingEnabled) this.invalidate();
    this.renderingEnabled = enabled;
    const direction = input.lightDirection ?? PBR_SUN_RAY_DIRECTION;
    const authored = input.authored === undefined ? undefined : snapshotAuthoredShadow(input.authored);
    if (authored && (this.layerViews.length !== 1 || authored.mapSize !== this.selection.profile.options.shadowMapSize)) throw new Error("Authored shadow requires a matching one-layer shadow resource.");
    const maximum = Math.min(input.far, 1_000_000);
    const requestedFar = this.exactMaxShadowDistance === undefined ? Math.max(input.near + 1e-4, input.extent * 20)
      : exactNumber(this.exactMaxShadowDistance, input.near + 1e-4, 1_000_000, "maximum shadow distance");
    const shadowFar = Math.min(maximum, requestedFar);
    const depthPadding = this.exactDepthPadding ?? Math.max(1, input.extent * 0.2);
    const signature = authored ? [2, ...authored.viewProjection, ...direction, authored.mapSize, authored.bias, authored.normalBias, authored.intensity, authored.radius, input.viewportHeight ?? 0]
      : [0, ...input.eye, ...input.target, ...(input.up ?? [0, 1, 0]), input.verticalFovRadians, input.aspect, input.near, shadowFar, depthPadding, ...direction];
    const changed = !this.lastSignature || !same(signature, this.lastSignature);
    if (changed) {
      this.plan = authored ? planAuthoredShadow(authored, direction) : planCascadedShadows({ eye: input.eye, target: input.target, ...(input.up ? { up: input.up } : {}),
        verticalFovRadians: input.verticalFovRadians, aspect: input.aspect, near: input.near, far: shadowFar },
      direction, { ...this.selection.profile.options,
        maxShadowDistance: shadowFar, depthPadding });
      this.session.device.queue.writeBuffer(this.uniform, 0,
        authored ? packAuthoredShadow(this.plan, authored, input.viewportHeight) : packCascadedShadowUniform(this.plan, this.depthBias, this.constantNormalBias));
      this.plan.cascades.forEach((cascade, index) => {
        const data = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
        data.set(cascade.viewProjection, PBR_FRAME_FLOAT_OFFSETS.lightViewProjection);
        this.session.device.queue.writeBuffer(this.frameBuffers[index]!, 0, data);
      });
      this.pendingSignature = Object.freeze(signature);
    }
    return Object.freeze({ plan: this.plan!, render: enabled && (force || changed) });
  }

  get metrics() { return { shadowTier: this.selection.selectedTier, shadowDepthBytes: this.selection.profile.estimatedDepthTextureBytes,
    shadowMapSize: this.selection.profile.options.shadowMapSize, shadowCascadeCount: this.selection.profile.options.cascadeCount }; }

  /** Borrow the current CSM; the shadow owner retains every resource. Call after prepare. */
  godRaysSource(): GodRaysShadowSource {
    if (this.disposed || !this.plan) throw new Error("Cascaded shadows must be prepared before god rays.");
    if (this.session.device !== this.createdDevice) throw new Error("Cascaded shadows belong to a previous device.");
    return { uniform: this.uniform, view: this.arrayView, sampler: this.sampler, enabled: this.renderingEnabled };
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
    for (const resource of this.vsmPlaceholders) this.session.release(resource);
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

function selectProfile(options: CascadedShadowResourceOptions, session: DeviceSession): CascadedShadowQualitySelection | ExactShadowSelection {
  const limits = session.device.limits;
  const admission = session.resourceMemory?.admission;
  const fixedBytes = CASCADED_SHADOW_UNIFORM_BYTES + CASCADED_SHADOW_QUALITY_PROFILES.ultra.options.cascadeCount
    * PBR_FRAME_UNIFORM_FLOATS * 4;
  const availableDepthBytes = admission === undefined ? undefined
    : Math.max(1, admission.budgetBytes - session.resourceMemory.estimatedBytes - fixedBytes);
  const maxDepthTextureBytes = options.maxDepthTextureBytes === undefined ? availableDepthBytes
    : availableDepthBytes === undefined ? options.maxDepthTextureBytes : Math.min(options.maxDepthTextureBytes, availableDepthBytes);
  if (!options.exactProfile) return resolveCascadedShadowQuality(options.requestedTier ?? "high", {
    maxTextureDimension2D: limits.maxTextureDimension2D, maxTextureArrayLayers: limits.maxTextureArrayLayers,
    ...(maxDepthTextureBytes === undefined ? {} : { maxDepthTextureBytes }),
  });
  if (options.requestedTier !== undefined) throw new Error("Exact shadows cannot also request a quality tier.");
  const { exactProfile } = options, cascadeCount = exactInteger(exactProfile.cascadeCount, 1, 8, "cascade count");
  const shadowMapSize = exactInteger(exactProfile.shadowMapSize, 64, limits.maxTextureDimension2D, "shadow map size");
  if (cascadeCount > limits.maxTextureArrayLayers) throw new RangeError("Exact shadow cascade count exceeds device limits.");
  const splitLambda = exactNumber(exactProfile.splitLambda ?? 0, 0, 1, "split lambda");
  const blendRatio = exactNumber(exactProfile.blendRatio ?? 0, 0, 0.5, "blend ratio");
  const estimatedDepthTextureBytes = estimateCascadedShadowDepthBytes(cascadeCount, shadowMapSize);
  if (maxDepthTextureBytes !== undefined && estimatedDepthTextureBytes > maxDepthTextureBytes) {
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
