import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketLodDraw, PacketLodView } from "./packetLodTypes.js";
import { MeshletCuller } from "./meshletCulling.js";
import { MeshletIndirectExecutor } from "./meshletIndirectExecutor.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import type { PacketMeshletSource } from "./packetMeshletSource.js";
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MAX_TASKS = 32, MAX_COMMANDS = 8192;
interface Entry { readonly culler: MeshletCuller; readonly executor: MeshletIndirectExecutor }
/** Bounded optional acceleration; any unsupported batch retains its complete existing LOD draw. */
export class AuthorMeshletView {
  private readonly entries = new Map<string, Entry>();
  private active = new Set<string>();
  private readonly sourceIds = new WeakMap<PacketMeshletSource, number>();
  private sourceSequence = 0;
  constructor(private readonly session: DeviceSession) {}
  encode(encoder: GPUCommandEncoder, batches: readonly CachedPacketBatch[], geometries: ReadonlyMap<string, CachedPacketGeometry>, view: PacketLodView) {
    const draws = new Map<string, readonly PacketLodDraw[]>(), reasons = new Set<string>();
    let tasks = 0, commands = 0, passes = 0, dispatches = 0;
    this.active = new Set();
    for (const batch of batches) {
      const profile = batch.source.lod;
      if (profile?.strategy !== "author-selected" || !profile.selectedLevels.length) continue;
      const levels = profile.selectedLevels.map(index => geometries.get(profile.levels[index]!.geometry)!);
      if (!levels.some(geometry => geometry.mesh.meshletSource || geometry.mesh.meshletFallback)) continue;
      if (levels.some(geometry => !geometry.mesh.meshletSource)) { reasons.add(levels.find(geometry => !geometry.mesh.meshletSource)!.mesh.meshletFallback ?? "source-unavailable"); continue; }
      const taskCount = levels.length * batch.source.count, commandCount = levels.reduce((sum, geometry) => sum + 2 ** Math.ceil(Math.log2(geometry.mesh.meshletSource!.count)), 0) * batch.source.count;
      if (tasks + taskCount > MAX_TASKS || commands + commandCount > MAX_COMMANDS) { reasons.add("view-capacity"); continue; }
      const limits = this.session.device.limits;
      if (limits.maxComputeInvocationsPerWorkgroup < 256 || limits.maxComputeWorkgroupSizeX < 256 || limits.maxStorageBuffersPerShaderStage < 8) { reasons.add("device-kernel-limit"); continue; }
      tasks += taskCount; commands += commandCount;
      const selected: PacketLodDraw[] = [], encoded = new Map<string, PacketLodDraw>();
      for (const geometry of levels) for (let instance = 0; instance < batch.source.count; instance++) {
        const source = geometry.mesh.meshletSource!;
        let sourceId = this.sourceIds.get(source);
        if (sourceId === undefined) { sourceId = ++this.sourceSequence; this.sourceIds.set(source, sourceId); }
        // A reloaded resident lease may have the same revision but different GPU buffer identity.
        const key = JSON.stringify([batch.source.key, geometry.source.id, sourceId, instance]);
        const reused = encoded.get(key); if (reused) { selected.push(reused); continue; }
        let entry = this.entries.get(key);
        if (!entry) {
          const culler = new MeshletCuller(this.session);
          try { entry = { culler, executor: new MeshletIndirectExecutor(this.session) }; }
          catch (error) { culler.dispose(); throw error; }
          this.entries.set(key, entry);
        }
        this.active.add(key);
        const row = batch.source.data.subarray(instance * 36, instance * 36 + 12);
        const worldFromObject = [row[0]!, row[4]!, row[8]!, 0, row[1]!, row[5]!, row[9]!, 0, row[2]!, row[6]!, row[10]!, 0, row[3]!, row[7]!, row[11]!, 1];
        // Hi-Z is disabled here; visibility uses the actual per-view planes, not this unused projection.
        const result = entry.culler.encode(encoder, source, { viewProjection: IDENTITY, worldFromObject,
          cameraPosition: view.camera.position, frustum: view.frustum, viewport: [view.viewport.width, view.viewport.height], reversedZ: false }, { normalCone: false });
        if (result.mode !== "gpu") throw Error("Prepared packet meshlet source is below the GPU threshold.");
        const plan = entry.executor.encode(encoder, result, { expandedIndexCount: source.indices.indexCount, instanceMapping: "constant" });
        if (result.updated) { passes++; dispatches += 4; } if (plan.updated) { passes++; dispatches++; }
        const draw: PacketLodDraw = { geometry: geometry.source.id, instances: batch.buffer, previousTransforms: batch.previousBuffer,
          instanceByteOffset: instance * 144, previousByteOffset: instance * 48, indirect: plan.commands, indirectOffset: 0,
          meshlets: { indexBuffer: source.indices.buffer, commandCount: plan.capacity } };
        encoded.set(key, draw); selected.push(draw);
      }
      draws.set(batch.source.key, selected);
    }
    return { draws, passes, dispatches, fallbackReasons: [...reasons] };
  }
  commit(): void {
    const retired = [...this.entries].filter(([key]) => !this.active.has(key));
    for (const [key] of retired) this.entries.delete(key);
    runResourceCleanup("Author meshlet view retirement failed.", retired.flatMap(([, entry]) => [() => entry.executor.dispose(), () => entry.culler.dispose()]));
  }
  dispose(): void {
    const entries = [...this.entries.values()]; this.entries.clear(); this.active.clear();
    runResourceCleanup("Author meshlet view disposal failed.", entries.flatMap(entry => [() => entry.executor.dispose(), () => entry.culler.dispose()]));
  }
}
