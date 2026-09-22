import type { DeformationSnapshot } from "../deformation/types.js";
import type { InstanceUpdate } from "../renderPacket.js";
import { prepareDeformationPoseUpdate } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketDeformationResources } from "./packetDeformationResources.js";
import type { PacketDeformationDrawContext } from "./packetDeformationDraw.js";
import type { PacketCullingResources } from "./packetCulling.js";
import { DeformationDrawBindings } from "./deformationDrawBindings.js";
import { deformationBoundsEnvelope, type DeformationBoundsEnvelope, type DeformationBoundsProfile } from "./deformationBounds.js";
import { authoredShadowPipelines, type Pipelines } from "./pipelines.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import type { MaterialBinding } from "./materialBindings.js";

/** 包发布和成功提交是两个边界：被替换的姿态资源保留到新帧提交。 */
export class PacketDeformationState {
  private active: PacketDeformationResources | undefined;
  private retired: PacketDeformationResources[] = [];
  private current: DeformationSnapshot | undefined;
  private encoded = false;
  private disposed = false;
  private failedUpload = false;
  private readonly bindings: DeformationDrawBindings | undefined;
  private bounds = new Map<string, DeformationBoundsEnvelope>();
  private profiles: ReadonlyMap<string, DeformationBoundsProfile> = new Map();

  constructor(session: DeviceSession, private readonly pipelines?: Pipelines) {
    this.bindings = pipelines ? new DeformationDrawBindings(session.device, pipelines) : undefined;
  }

  get enabled(): boolean { return this.pipelines !== undefined; }
  get snapshot(): DeformationSnapshot | undefined { return this.current; }
  get hasDeformation(): boolean { return this.active !== undefined; }
  get requiresRebuild(): boolean { return this.failedUpload; }
  get dynamicBounds(): ReadonlyMap<string, DeformationBoundsEnvelope> { return this.bounds; }

  assertIdle(): void {
    if (this.disposed || this.encoded) throw new Error("Packet deformation frame is not idle.");
  }

  /** 调用前候选必须通过整包 GPU 校验；本步只交换所有权，不分配 GPU 资源。 */
  publish(resources: PacketDeformationResources | undefined, snapshot: DeformationSnapshot | undefined,
    profiles: ReadonlyMap<string, DeformationBoundsProfile> = new Map()): void {
    if (this.disposed || this.encoded) throw new Error("Cannot publish deformation during a frame or after disposal.");
    if (Boolean(resources) !== Boolean(snapshot) || (resources && !this.enabled))
      throw new Error("Packet deformation candidate is incomplete.");
    if (this.active) this.retired.push(this.active);
    this.active = resources; this.current = snapshot; this.bounds = new Map();
    this.profiles = profiles;
    this.bindings?.retain(new Map());
  }

  validateUpdate(update: InstanceUpdate): DeformationSnapshot | undefined {
    if (this.disposed || this.encoded) throw new Error("Cannot update deformation during a frame or after disposal.");
    return prepareDeformationPoseUpdate(this.current, update.poses, update.instances);
  }

  /** 在实例写入事务的最后一步执行；部分 GPU 写入失败后 drawStreams 会拒绝旧姿态。 */
  update(candidate: DeformationSnapshot | undefined): boolean {
    if (!candidate) return false;
    if (!this.active) throw new Error("Packet deformation is not prepared.");
    const previous = new Map(this.current?.poses.map(pose => [pose.id, pose.revision]));
    const changed = candidate.poses.some(pose => previous.get(pose.id) !== pose.revision);
    try { this.active.updatePoses(candidate.poses); }
    catch (error) { this.failedUpload = this.active.hasIncompleteUploads; throw error; }
    this.current = candidate;
    return changed;
  }

  encode(encoder: GPUCommandEncoder, batches: ReadonlyMap<string, CachedPacketBatch>,
    geometries: ReadonlyMap<string, CachedPacketGeometry>): void {
    if (this.disposed || this.encoded) throw new Error("Packet deformation frame is not idle.");
    if (!this.active) return;
    const sources = new Map(this.current!.sources.map(source => [source.id, source]));
    const poses = new Map(this.current!.poses.map(pose => [pose.id, pose]));
    const bounds = new Map<string, DeformationBoundsEnvelope>();
    const retained = new Map<string, Set<MaterialBinding | GPUBindGroup | undefined>>();
    for (const { source: batch, material, arrayMaterial } of batches.values()) {
      if (batch.pose === undefined) continue;
      const pose = poses.get(batch.pose), geometry = geometries.get(batch.geometry);
      const source = pose && sources.get(pose.source);
      if (!source || !geometry || source.geometry !== batch.geometry) throw new Error("Deformation bounds source is missing.");
      bounds.set(batch.key, deformationBoundsEnvelope(source, pose!, geometry.center, geometry.radius, this.profiles.get(source.id)));
      const materials = retained.get(batch.pose) ?? new Set<MaterialBinding | GPUBindGroup | undefined>();
      materials.add(material); if (arrayMaterial) materials.add(arrayMaterial.group);
      materials.add(undefined); retained.set(batch.pose, materials);
    }
    this.bindings!.retain(retained);
    this.active.encode(encoder);
    this.bounds = bounds; this.encoded = true;
  }

  drawContext(batches: ReadonlyMap<string, CachedPacketBatch>, culling: PacketCullingResources): PacketDeformationDrawContext | undefined {
    if (!this.active) return undefined;
    return {
      resolve: (batch, phase, authorShadow) => {
        if (!this.encoded || this.disposed) throw new Error("Deformation must be encoded before drawing.");
        const streams = this.active!.drawStreams(batch.pose!);
        if (!streams) throw new Error("Deformation draw streams are missing.");
        const cached = batches.get(batch.key);
        const materialNeeded = (phase !== "shadow" && batch.textures !== undefined)
          || (batch.alphaMode === "MASK" && batch.textures?.baseColor !== undefined);
        const arrayMaterial = materialNeeded ? cached?.arrayMaterial : undefined;
        const material = arrayMaterial ?? (materialNeeded ? cached?.material : undefined);
        const selected = arrayMaterial ? this.pipelines! : this.pipelines!.textureArrayFallback ?? this.pipelines!;
        return { pose: batch.pose!, stale: streams.stale,
          pipelines: authorShadow ? authoredShadowPipelines(selected) : selected,
          group: this.bindings!.get(batch.pose!, streams, material) };
      },
      dynamicCulling: (batch, phase, cascade) => culling.dynamicPhase(batch, phase, cascade),
    };
  }

  commitFrame(): boolean {
    const encoded = this.encoded; this.encoded = false;
    const retired = this.retired; this.retired = [];
    runResourceCleanup("Packet deformation frame commit failed.", [
      () => { if (encoded) this.active!.commitFrame(); }, ...retired.map(resource => () => resource.dispose()),
    ]);
    return encoded;
  }

  cancelFrame(): void { this.encoded = false; this.active?.cancelFrame(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const resources = [...this.retired, ...(this.active ? [this.active] : [])];
    this.retired = []; this.active = undefined; this.current = undefined; this.encoded = false; this.bounds.clear();
    this.profiles = new Map();
    runResourceCleanup("Packet deformation state disposal failed.", [
      () => this.bindings?.dispose(), ...resources.map(resource => () => resource.dispose()),
    ]);
  }
}
