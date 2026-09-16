import { prepareRenderPacket, type InstanceUpdate, type PreparedPacket,
  type RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import { DeformationStaticSources } from "./deformationStaticSources.js";
import { MaterialBindingPool, type MaterialLayouts } from "./materialBindings.js";
import { TextureResources } from "./textureResources.js";
import type { Frustum } from "./gpuFrustumCulling.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { PacketCullingResources, type PacketCullingStats, type PacketCullingView } from "./packetCulling.js";
import type { CascadedShadowPlan } from "../shadows/types.js";
import { PacketLodSceneCache } from "./packetLodSceneCache.js";
import { PacketShadowLodResources } from "./packetShadowLodResources.js";
import { PacketLodResources } from "./packetLodResources.js";
import type { PacketLodFrameStats, PacketLodView } from "./packetLodTypes.js";
import { drawPacketBatches } from "./packetDraw.js";
import { discardPacketBufferStage, stagePacketBuffers, type PacketBufferStagingContext,
  type StagedPacketBuffers } from "./packetBufferStaging.js";
import { commitPacketInstanceFrame, PacketInstanceRollbackError,
  updatePacketInstances } from "./packetInstanceUpdate.js";
import type { PacketGeometryBounds } from "./packetGeometryBounds.js";
import type { DeformationBoundsEnvelope } from "./deformationBounds.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { ResidentPacketBufferState } from "./residentPacketBufferState.js";
import type { ResidentPacketBufferStagingContext } from "./residentPacketBufferStaging.js";
import type { PacketTextureLookup } from "./packetTextureLookup.js";
import { packetGeometryBounds, retirePacketBuffers } from "./packetBufferRetirement.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { PacketDeformationState } from "./packetDeformationState.js";
import { PacketValidatedPublication } from "./packetValidatedPublication.js";

const cancelled = (): DOMException => new DOMException("Packet update cancelled or superseded.", "AbortError");
export { GPU_CULLING_MIN_INSTANCES } from "./packetCulling.js";
/** 投影资源事务；异步载入校验后发布，同步低层入口只保证同步异常回滚。 */
export class PacketBuffers {
  private geometries = new Map<string, CachedPacketGeometry>();
  private geometryBounds: ReadonlyMap<string, PacketGeometryBounds> = new Map();
  private batches = new Map<string, CachedPacketBatch>();
  private disposed = false;
  private generation = 0;
  private sceneRevision = 0;
  private motionHistory = new Map<string, Float32Array<ArrayBuffer>>();
  private readonly validation = new PacketValidatedPublication();
  private readonly deformation: PacketDeformationState;
  private readonly deformationStaticSources: DeformationStaticSources;
  private readonly culling: PacketCullingResources;
  private readonly textures: TextureResources;
  private textureLookup: PacketTextureLookup;
  private readonly materials: MaterialBindingPool;
  private lod: PacketLodResources | undefined;
  private readonly lodInputs: PacketLodSceneCache;
  private shadowLod: PacketShadowLodResources | undefined;
  private readonly resident = new ResidentPacketBufferState();
  constructor(private readonly session: DeviceSession, materialLayout?: MaterialLayouts, deformationPipelines?: Pipelines, private readonly meshletsEnabled = false) {
    this.deformation = new PacketDeformationState(session, deformationPipelines);
    this.deformationStaticSources = new DeformationStaticSources(session);
    this.lodInputs = new PacketLodSceneCache(session);
    this.textures = new TextureResources(session);
    this.textureLookup = this.textures;
    this.culling = new PacketCullingResources(session);
    this.materials = new MaterialBindingPool(session, materialLayout);
  }

  /** Monotonic revision of successfully published visibility-affecting author state. */
  get visibilityRevision(): number { return this.sceneRevision; }
  set(packet: RenderPacket): boolean {
    const generation = this.beginMutation();
    return this.commit(this.stage(prepareRenderPacket(packet)), generation);
  }
  /** Takes projection ownership; publication is deferred to the next frame boundary. */
  stageResidentProjection(projection: ResidentPacketProjection): boolean {
    return this.resident.stage(this.residentContext(), projection, this.beginMutation());
  }

  async stageResidentProjectionValidated(projection: ResidentPacketProjection,
    signal?: AbortSignal): Promise<boolean> {
    return this.resident.stageValidated(this.residentContext(), projection,
      this.beginMutation(), signal);
  }

  /** Invalidates a prepared packet candidate while preserving the active drawable packet. */
  cancelPendingPacketStage(): void {
    if (this.disposed) return; this.generation++;
    runResourceCleanup("Pending packet cancellation failed.", [() => this.validation.cancel(),
      () => this.resident.cancel(this.residentContext())]);
  }

  /** Installs a complete streamed packet before command encoding and retires old leases after the swap. */
  publishResidentProjection(): boolean {
    const transition = this.resident.publish(this.residentContext(), this.generation);
    if (!transition) return false;
    const { current, previous } = transition;
    this.deformation.publish(undefined, undefined);
    const oldGeometries = this.geometries, oldBatches = this.batches;
    this.geometries = current.geometries; this.geometryBounds = current.geometryBounds;
    this.batches = current.batches; this.textureLookup = current.textureLookup;
    this.pruneCullingResources(); this.pruneLodInputs();
    this.motionHistory = new Map();
    if (current.changed) this.sceneRevision++;
    retirePacketBuffers(this.residentContext(), oldGeometries, oldBatches,
      current.geometries, current.batches, { ownMeshes: previous === undefined,
        ...(previous ? { projection: previous.projection } : {}), clearTextures: this.textures });
    return current.changed;
  }

  /** 动画快路径不等待 GPU；异步设备错误仍交给 DeviceSession，不能作为载入成功门禁。 */
  updateInstances(update: InstanceUpdate): boolean {
    const generation = this.beginMutation();
    const deformation = this.deformation.validateUpdate(update);
    try {
      const result = updatePacketInstances({
        ...this.residentContext(), textures: this.textureLookup,
        ...(this.deformation.snapshot ? { deformation: this.deformation.snapshot } : {}),
        ...(this.deformation.enabled ? {
          commitDeformation: () => this.deformation.update(deformation) } : {}),
        assertCurrent: () => {
          if (generation !== this.generation || this.disposed || this.session.state !== "ready") throw cancelled();
        },
      }, update);
      this.batches = result.batches;
      this.motionHistory = new Map(result.historyUpdates);
      this.pruneCullingResources(); this.pruneLodInputs();
      if (result.changed) this.sceneRevision++;
      return result.changed;
    } catch (error) {
      if (error instanceof PacketInstanceRollbackError || this.deformation.requiresRebuild) this.dispose();
      throw error;
    }
  }

  /** Advances object motion history after queue.submit completed without a synchronous error. */
  commitFrame(): boolean {
    if (this.disposed || this.session.state !== "ready") throw new Error("Packet resources are not ready.");
    try {
      const deformationChanged = this.deformation.commitFrame();
      if (!this.motionHistory.size) return deformationChanged;
      const changed = commitPacketInstanceFrame(
        this.session,
        this.batches,
        this.motionHistory,
        updates => this.culling.commitPrevious(updates),
      );
      this.motionHistory = new Map();
      return changed;
    } catch (error) {
      if (error instanceof PacketInstanceRollbackError || this.deformation.hasDeformation) this.dispose();
      throw error;
    }
  }
  /** 返回前等待创建/上传的 GPU 错误；等待期间旧投影可绘制，后发修改使旧候选失效。 */
  async setValidated(packet: RenderPacket, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw cancelled();
    const generation = this.beginMutation();
    const prepared = prepareRenderPacket(packet);
    const { staged, checked } = this.stageValidated(prepared);
    return this.validation.run(checked, signal, () => this.commit(staged, generation, true),
      () => this.rollback(staged), () => generation === this.generation && !this.disposed, cancelled);
  }
  private beginMutation(): number {
    if (this.disposed || this.session.state !== "ready") throw new Error("Packet resources are not ready.");
    this.deformation.assertIdle();
    this.cancelPendingPacketStage();
    return this.generation;
  }

  private stageValidated(prepared: PreparedPacket): { staged: StagedPacketBuffers; checked: Promise<void> } {
    const result = gpuValidatedStage(this.session.device, () => this.stage(prepared),
      "GPU packet preparation failed");
    return { staged: result.value, checked: result.checked };
  }

  private stage(prepared: PreparedPacket): StagedPacketBuffers {
    return stagePacketBuffers(this.stagingContext(), prepared);
  }
  private rollback(staged: StagedPacketBuffers): void {
    discardPacketBufferStage(this.stagingContext(), staged);
  }

  private commit(staged: StagedPacketBuffers, generation: number, gpuValidated = false): boolean {
    if (staged.settled || generation !== this.generation || this.disposed || this.session.state !== "ready") {
      this.rollback(staged); throw cancelled();
    }
    const bounds = packetGeometryBounds(staged.geometries);
    this.textures.publishPrepared(staged.textures);
    this.deformation.publish(staged.deformation, staged.deformationSnapshot, staged.deformationBoundsProfiles);
    if (gpuValidated) staged.deformation?.publishValidatedSources();
    this.textureLookup = this.textures;
    staged.settled = true;
    const previousResident = this.resident.detachActive();
    const oldGeometries = this.geometries, oldBatches = this.batches;
    this.geometries = staged.geometries; this.geometryBounds = bounds; this.batches = staged.batches;
    this.pruneCullingResources(); this.pruneLodInputs();
    this.motionHistory = new Map();
    if (staged.changed) this.sceneRevision++;
    retirePacketBuffers(this.residentContext(), oldGeometries, oldBatches,
      staged.geometries, staged.batches, { ownMeshes: previousResident === undefined,
        ...(previousResident ? { projection: previousResident.projection } : {}) });
    return staged.changed;
  }

  drawProfile(): { readonly hasTransparent: boolean; readonly hasMaterialTextures: boolean; readonly hasDeformation: boolean } {
    let hasTransparent = false, hasMaterialTextures = false;
    for (const { source } of this.batches.values()) { hasTransparent ||= source.alphaMode === "BLEND"; hasMaterialTextures ||= source.textures !== undefined; }
    return { hasTransparent, hasMaterialTextures, hasDeformation: this.deformation.hasDeformation };
  }

  encodeDeformation(encoder: GPUCommandEncoder): void { this.deformation.encode(encoder, this.batches, this.geometries); }
  cancelDeformationFrame(): void { this.deformation.cancelFrame(); }

  /** Encode GPU culling before the corresponding render pass. The output is consumed by draw(). */
  encodeCulling(encoder: GPUCommandEncoder, frustum: Frustum, phase: "shadow" | "opaque",
    view?: PacketCullingView, shadowCascade = 0,
    dynamicBounds?: ReadonlyMap<string, DeformationBoundsEnvelope>): PacketCullingStats {
    if (this.disposed) throw new Error("Packet resources are disposed.");
    return this.culling.encode(encoder, frustum, phase, this.batches, this.geometries, view, shadowCascade,
      dynamicBounds ?? this.deformation.dynamicBounds);
  }

  /** Encodes selection, stable global budgets, compaction, and indirect commands for packet LOD batches. */
  encodeLod(encoder: GPUCommandEncoder, view: PacketLodView): PacketLodFrameStats {
    const result = this.encodeIndependentLod(encoder, view, this.lod);
    this.lod = result?.resources;
    return result?.stats ?? { inputObjects: 0, selectionBatches: 0, indirectDraws: 0, historyReset: false };
  }

  /** The caller owns this view's submission, cancellation, and disposal. */
  encodeIndependentLod(encoder: GPUCommandEncoder, view: PacketLodView, existing?: PacketLodResources) {
    if (this.disposed) throw new Error("Packet resources are disposed.");
    const hasLod = Array.from(this.batches.values()).some(batch => batch.source.lod !== undefined);
    if (!existing && !hasLod) return undefined;
    const resources = existing ?? new PacketLodResources(this.session, this.lodInputs);
    try { return { resources, stats: resources.encode(encoder, this.batches, this.geometries, this.sceneRevision, view, this.geometryBounds) }; }
    catch (error) { failWithResourceCleanup(error, "Independent LOD encoding failed.", [() => existing ? resources.cancelFrame() : resources.dispose()]); }
  }

  encodeShadowLod(encoder: GPUCommandEncoder, plan: CascadedShadowPlan): PacketLodFrameStats {
    if (this.disposed) throw new Error("Packet resources are disposed.");
    if (!this.shadowLod && !Array.from(this.batches.values()).some(batch => batch.source.lod)) {
      return { inputObjects: 0, selectionBatches: 0, indirectDraws: 0, historyReset: false };
    }
    this.shadowLod ??= new PacketShadowLodResources(this.session, this.lodInputs);
    return this.shadowLod.encode(encoder, this.batches, this.geometries,
      this.sceneRevision, plan, this.geometryBounds);
  }

  /** Publishes LOD history only after queue.submit accepted this frame. */
  commitLodFrame(): void { this.lod?.commitFrame(); this.shadowLod?.commitFrame(); }

  /** Cancels LOD work when its command encoder is known not to have been submitted. */
  cancelLodFrame(): void { this.lod?.cancelFrame(); this.shadowLod?.cancelFrame(); }

  /** Fails closed after an uncertain submit and resets LOD history for the retry. */
  failLodFrame(): void { this.lod?.failFrame(); this.shadowLod?.failFrame(); }

  draw(pass: GPURenderPassEncoder, pipelines: Pipelines, phase: "shadow" | "opaque" | "transparent" | "display",
    view?: { readonly eye: readonly [number, number, number]; readonly target: readonly [number, number, number] }, useIndirect = false, shadowCascade = 0, directionalOnly = false, authorShadow = false, lodOverride?: PacketLodResources | null): { drawCalls: number; triangles: number } {
    if (this.disposed) throw new Error("Packet resources are disposed.");
    return drawPacketBatches(pass, pipelines, phase, this.batches, this.geometries, this.culling, lodOverride !== undefined ? lodOverride ?? undefined : phase === "shadow" ? this.shadowLod?.cascade(shadowCascade) : this.lod, view, useIndirect, shadowCascade, directionalOnly, authorShadow,
      this.deformation.drawContext(this.batches, this.culling));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    const context = this.residentContext();
    const geometries = [...this.geometries.values()], batches = [...this.batches.values()];
    const lod = this.lod, shadowLod = this.shadowLod; this.lod = undefined; this.shadowLod = undefined;
    let activeResident: ReturnType<ResidentPacketBufferState["detachActive"]>;
    runResourceCleanup("Packet buffer disposal failed.", [() => this.validation.cancel(), () => this.deformation.dispose(),
      () => this.resident.cancel(context), () => { activeResident = this.resident.detachActive();
        this.geometries = new Map(); this.geometryBounds = new Map(); this.batches = new Map();
        this.motionHistory = new Map(); this.textureLookup = this.textures; },
      ...geometries.map(value => () => { if (!activeResident) value.mesh.dispose(); }),
      ...batches.flatMap(value => [() => this.session.release(value.buffer),
        () => this.session.release(value.previousBuffer), () => this.materials.release(value.material)]),
      () => this.culling.dispose(), () => lod?.dispose(), () => shadowLod?.dispose(),
      () => this.lodInputs.clear(), () => this.textures.dispose(), () => activeResident?.projection.release()]);
  }

  private pruneCullingResources(): void { this.culling.prune(this.batches); }
  private pruneLodInputs(): void { if (![...this.batches.values()].some(batch => batch.source.lod)) this.lodInputs.clear(); }
  private stagingContext(): PacketBufferStagingContext {
    const resident = this.resident.active !== undefined;
    return {
      deformationEnabled: this.deformation.enabled, meshletsEnabled: this.meshletsEnabled,
      deformationStaticSources: this.deformationStaticSources,
      ...(this.deformation.snapshot ? { deformationSnapshot: this.deformation.snapshot } : {}),
      session: this.session,
      materials: this.materials,
      textures: this.textures,
      geometries: resident ? new Map() : this.geometries,
      batches: resident ? new Map() : this.batches,
    };
  }
  private residentContext(): ResidentPacketBufferStagingContext {
    return { session: this.session, materials: this.materials, geometries: this.geometries,
      batches: this.batches };
  }
}
