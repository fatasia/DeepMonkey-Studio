import { createAdmittedTexture } from "./resourceAdmission.js";
import { DeviceResourceBudgetError } from "./deviceResourceMemory.js";
import type { WorldClusteredLights } from "../lighting/worldLights.js";
import { planSharedShadowAtlas, type SharedShadowAtlasPlan } from "../shadows/sharedShadowAtlas.js";
import { LOCAL_SPOT_SHADOW_ENTRY_BYTES, LOCAL_SPOT_SHADOW_MAX_LIGHTS,
  LOCAL_SPOT_SHADOW_UNIFORM_BYTES } from "../shadows/localSpotShadowShader.js";
import type { DeviceSession } from "./deviceSession.js";
import { LOCAL_SPOT_SHADOW_ATLAS_OPTIONS, selectLocalSpotShadows,
  type SelectedLocalSpotShadow } from "./localSpotShadowSelection.js";
import { uploadBuffer } from "./meshBuffers.js";
import type { PacketBuffers } from "./packetBuffers.js";
import { PBR_FRAME_FLOAT_OFFSETS, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { LocalSpotLod } from "./localSpotLod.js";
import { SharedShadowAtlasResources, type SharedShadowAtlasBudgetEvidence,
  type SharedShadowAtlasGpuResource } from "./sharedShadowAtlasResources.js";

const DEPTH_BUDGET = 4 * 1024 * 1024;
const DEPTH_BIAS = 0.001;
const deviceEpochs = new WeakMap<object, string>();
let nextDeviceEpoch = 0;

export interface LocalSpotShadowBindings {
  readonly uniform: GPUBuffer;
  readonly atlasView: GPUTextureView;
  readonly sampler: GPUSampler;
}

export interface LocalSpotShadowFrame {
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
  readonly authorFrustumPasses?: number;
  readonly authorFrustumDispatches?: number;
  readonly rendered: boolean;
  readonly drawCalls: number;
  readonly triangles: number;
  /** Compatibility alias for the first allocated spot. */
  readonly shadowedSpotIndex: number | undefined;
  readonly shadowedSpotIndices: readonly number[];
  readonly plan: SharedShadowAtlasPlan | undefined;
  readonly degraded: boolean;
}

/** Owns a 4 MiB Browser atlas and at most four importance-ranked spot views. */
export class LocalSpotShadowRuntime {
  readonly bindings: LocalSpotShadowBindings;
  get deviceEpoch(): string { return this.atlasOwner.deviceEpoch; }
  get budget(): SharedShadowAtlasBudgetEvidence | undefined { return this.atlasOwner.budget; }
  private readonly committedMetadata = new Float32Array(LOCAL_SPOT_SHADOW_UNIFORM_BYTES / 4);
  private readonly frameGroups = new WeakMap<GPURenderPipeline, readonly GPUBindGroup[]>();
  private lastSignature: string | undefined;
  private pendingSignature: string | undefined;
  private pendingMetadata: Float32Array<ArrayBuffer> | undefined;
  private disposed = false;
  private readonly lod = new LocalSpotLod();

  private constructor(private readonly session: DeviceSession,
    private readonly atlasOwner: SharedShadowAtlasResources, private readonly atlas: SharedShadowAtlasGpuResource | undefined,
    private readonly fallback: GPUTexture | undefined, private readonly uniform: GPUBuffer,
    private readonly shadowFrames: readonly GPUBuffer[], sampler: GPUSampler, readonly degraded: boolean) {
    const atlasView = atlas?.view ?? fallback!.createView({ dimension: "2d", aspect: "depth-only" });
    this.bindings = Object.freeze({ uniform, atlasView, sampler });
  }

  static async create(session: DeviceSession, signal?: AbortSignal): Promise<LocalSpotShadowRuntime> {
    const epoch = deviceEpoch(session.device), atlasOwner = new SharedShadowAtlasResources(session, epoch);
    let atlas: SharedShadowAtlasGpuResource | undefined, fallback: GPUTexture | undefined, degraded = false;
    try {
      const plan = planSharedShadowAtlas([], { maxTextureDimension2D: session.device.limits.maxTextureDimension2D,
        maxDepthTextureBytes: DEPTH_BUDGET }, LOCAL_SPOT_SHADOW_ATLAS_OPTIONS);
      atlas = (await atlasOwner.setValidated(plan, epoch, signal)).resource;
      degraded = atlas.plan.downgraded;
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || error instanceof DeviceResourceBudgetError) {
        atlasOwner.dispose(); throw error;
      }
      degraded = true; atlasOwner.dispose();
      fallback = createAdmittedTexture(session, { label: "Deep disabled local shadow fallback",
        size: [1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    }
    let uniform: GPUBuffer | undefined;
    const shadowFrames: GPUBuffer[] = [];
    try {
      uniform = uploadBuffer(session, "Deep local spot shadow data",
        new Float32Array(LOCAL_SPOT_SHADOW_UNIFORM_BYTES / 4), GPUBufferUsage.UNIFORM);
      for (let index = 0; index < LOCAL_SPOT_SHADOW_MAX_LIGHTS; index++) {
        shadowFrames.push(uploadBuffer(session, `Deep local spot shadow frame ${index}`,
          new Float32Array(PBR_FRAME_UNIFORM_FLOATS), GPUBufferUsage.UNIFORM));
      }
      const sampler = session.device.createSampler({ label: "Deep local spot shadow PCF", compare: "less-equal",
        minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
      return new LocalSpotShadowRuntime(session, atlasOwner, atlas, fallback, uniform,
        Object.freeze(shadowFrames), sampler, degraded);
    } catch (error) {
      runResourceCleanup("Local spot shadow construction rollback failed.", [
        () => { if (uniform) session.release(uniform); },
        ...shadowFrames.map(frame => () => session.release(frame)),
        () => { if (fallback) session.release(fallback); }, () => atlasOwner.dispose(),
      ]);
      throw error;
    }
  }

  prepareAndEncode(encoder: GPUCommandEncoder, packets: PacketBuffers, pipelines: Pipelines,
    lights: WorldClusteredLights, force: boolean,
    timestampWrites?: GPURenderPassTimestampWrites): LocalSpotShadowFrame {
    this.assertReady();
    const selection = this.atlas ? selectLocalSpotShadows(lights, this.atlas.plan)
      : Object.freeze({ spots: Object.freeze([]), plan: undefined });
    const selected = selection.spots;
    const signature = selected.length ? JSON.stringify(selected.map(value => value.signature)) : "disabled";
    const changed = signature !== this.lastSignature;
    this.pendingSignature = signature;
    if (!selected.length) {
      this.lod.encode(encoder, packets, []);
      if (changed) this.stageMetadata([]);
      return frame(false, 0, 0, selected, selection.plan ?? this.atlas?.plan,
        this.degraded || selection.plan === undefined);
    }
    if (!force && !changed) return frame(false, 0, 0, selected, selection.plan,
      this.degraded || selection.plan?.downgraded === true);

    try {
      // Moving casters require a redraw, not another upload of unchanged light matrices.
      if (changed) this.stageMetadata(selected);
      const lodStats = this.lod.encode(encoder, packets, selected);
      const pass = encoder.beginRenderPass({ label: `Deep local spot shadows (${selected.length})`,
        ...(timestampWrites ? { timestampWrites } : {}), colorAttachments: [], depthStencilAttachment: {
          view: this.atlas!.view, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
        } });
      let drawCalls = 0, triangles = 0;
      try {
        pass.setPipeline(pipelines.shadow);
        selected.forEach((spot, ordinal) => {
          pass.setViewport(spot.tile.x, spot.tile.y, spot.tile.size, spot.tile.size, 0, 1);
          pass.setScissorRect(spot.tile.x, spot.tile.y, spot.tile.size, spot.tile.size);
          pass.setBindGroup(0, this.shadowFrameBindings(pipelines)[ordinal]!);
          const stats = packets.draw(pass, pipelines, "shadow", { eye: spot.light.positionWorld,
            target: add(spot.light.positionWorld, spot.light.directionWorld) }, false, 0, false, false, this.lod.view(spot));
          drawCalls += stats.drawCalls; triangles += stats.triangles;
        });
      } catch (error) { failWithResourceCleanup(error, "Local spot shadow draw failed.", [() => pass.end()]); }
      pass.end();
      return { ...frame(true, drawCalls, triangles, selected, selection.plan,
        this.degraded || selection.plan?.downgraded === true), ...lodStats };
    } catch (error) { failWithResourceCleanup(error, "Local spot shadow encoding failed.", [() => this.failFrame()]); }
  }

  commit(): void {
    this.lod.commit();
    if (this.pendingSignature !== undefined) this.lastSignature = this.pendingSignature;
    if (this.pendingMetadata) this.committedMetadata.set(this.pendingMetadata);
    this.pendingSignature = undefined; this.pendingMetadata = undefined;
  }

  failFrame(): void {
    if (this.pendingMetadata && this.session.state === "ready") {
      try { this.session.device.queue.writeBuffer(this.uniform, 0, this.committedMetadata); }
      catch { /* Device loss makes the old binding unusable too. */ }
    }
    this.lastSignature = undefined; this.pendingSignature = undefined; this.pendingMetadata = undefined;
    this.lod.fail();
  }

  invalidate(): void { this.lastSignature = undefined; this.pendingSignature = undefined; this.pendingMetadata = undefined; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.invalidate();
    runResourceCleanup("Local spot shadow disposal failed.", [() => this.session.release(this.uniform),
      ...this.shadowFrames.map(frameBuffer => () => this.session.release(frameBuffer)),
      () => { if (this.fallback) this.session.release(this.fallback); }, () => this.atlasOwner.dispose(), () => this.lod.dispose()]);
  }

  private stageMetadata(selected: readonly SelectedLocalSpotShadow[]): void {
    const metadata = new Float32Array(LOCAL_SPOT_SHADOW_UNIFORM_BYTES / 4);
    selected.forEach((spot, ordinal) => {
      const offset = ordinal * LOCAL_SPOT_SHADOW_ENTRY_BYTES / 4;
      metadata.set(spot.matrix, offset); metadata.set([...spot.tile.uvOffset, ...spot.tile.uvScale], offset + 16);
      metadata.set([spot.index, DEPTH_BIAS, 1 / this.atlas!.plan.atlasSize, 1], offset + 20);
      const frameData = new Float32Array(PBR_FRAME_UNIFORM_FLOATS); frameData.set(spot.matrix, PBR_FRAME_FLOAT_OFFSETS.lightViewProjection);
      this.session.device.queue.writeBuffer(this.shadowFrames[ordinal]!, 0, frameData);
    });
    this.session.device.queue.writeBuffer(this.uniform, 0, metadata);
    this.pendingMetadata = metadata;
  }

  private shadowFrameBindings(pipelines: Pipelines): readonly GPUBindGroup[] {
    const cached = this.frameGroups.get(pipelines.shadow); if (cached) return cached;
    const layout = pipelines.shadow.getBindGroupLayout(0);
    const created = Object.freeze(this.shadowFrames.map((buffer, index) => this.session.device.createBindGroup({
      label: `Deep local spot shadow frame binding ${index}`, layout,
      entries: [{ binding: 0, resource: { buffer } }],
    })));
    this.frameGroups.set(pipelines.shadow, created); return created;
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Local spot shadow runtime is disposed.");
    if (this.session.state !== "ready") throw new Error(`Local spot shadows cannot use a ${this.session.state} GPU session.`);
  }
}

function frame(rendered: boolean, drawCalls: number, triangles: number,
  selected: readonly SelectedLocalSpotShadow[], plan: SharedShadowAtlasPlan | undefined,
  degraded: boolean): LocalSpotShadowFrame {
  const indices = Object.freeze(selected.map(value => value.index));
  return Object.freeze({ rendered, drawCalls, triangles, shadowedSpotIndex: indices[0],
    shadowedSpotIndices: indices, plan, degraded });
}
function isAbortError(value: unknown): boolean { return value instanceof Error && value.name === "AbortError"; }
function add(left: readonly [number, number, number], right: readonly [number, number, number]): readonly [number, number, number] {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}
function deviceEpoch(device: GPUDevice): string {
  const cached = deviceEpochs.get(device); if (cached) return cached;
  const created = `browser-local-shadow-${++nextDeviceEpoch}`; deviceEpochs.set(device, created); return created;
}
