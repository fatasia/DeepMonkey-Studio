import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketLodDraw, PacketLodFrameStats, PacketLodView } from "./packetLodTypes.js";
import { AuthorMeshletView } from "./authorMeshletView.js";
import { createGpuCullingPipelineContext, type GpuCullingPipelineContext, type Frustum } from "./gpuFrustumCulling.js";
import { AuthorLodCullingInputs } from "./authorLodCullingInputs.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
/** Selection is authoritative; only each selected real geometry's visibility is computed. */
export class AuthorSelectedLodResources {
  private current = new Map<string, AuthorLodCullingInputs>();
  private pending: Map<string, AuthorLodCullingInputs> | undefined;
  private outputs = new Map<string, readonly PacketLodDraw[]>();
  private context: GpuCullingPipelineContext | undefined;
  private disposed = false;
  private readonly meshlets: AuthorMeshletView;
  constructor(private readonly session: DeviceSession) { this.meshlets = new AuthorMeshletView(session); }
  encode(encoder: GPUCommandEncoder, frustum: Frustum, batches: readonly CachedPacketBatch[],
    geometries: ReadonlyMap<string, CachedPacketGeometry>, view?: PacketLodView): PacketLodFrameStats {
    if (this.disposed || this.session.state !== "ready") throw Error("Author LOD resources are not ready.");
    if (this.pending) throw Error("A packet LOD frame is already pending submission.");
    this.outputs.clear();
    const prepared = batches.map(batch => {
      const profile = batch.source.lod;
      if (profile?.strategy !== "author-selected") throw Error("Explicit author LOD profile required.");
      const levels = profile.levels.map(level => {
        const geometry = geometries.get(level.geometry);
        if (!level.resident || !geometry) throw Error(`Author-selected LOD geometry is not resident: ${level.geometry}.`);
        if (geometry.mesh.indexCount !== level.triangles * 3) throw Error("Author LOD geometry index count changed without updated metadata.");
        return { level, geometry, key: JSON.stringify([batch.source.key, level.geometry]) };
      });
      return { batch, profile, levels };
    });
    const next = new Map<string, AuthorLodCullingInputs>(), created: AuthorLodCullingInputs[] = [];
    const outputs = new Map<string, readonly PacketLodDraw[]>();
    let authorFrustumPasses = 0, authorFrustumDispatches = 0;
    let meshletStats: ReturnType<AuthorMeshletView["encode"]> | undefined;
    try {
      meshletStats = view ? this.meshlets.encode(encoder, batches, geometries, view) : undefined;
      for (const { batch, profile, levels } of prepared) {
        for (const { key, geometry } of levels) {
          if (next.has(key)) continue;
          let input = this.current.get(key);
          if (!input?.matches(batch, geometry)) {
            this.context ??= createGpuCullingPipelineContext(this.session.device, this.session);
            input = new AuthorLodCullingInputs(this.session, this.context, batch, geometry);
            created.push(input);
          }
          next.set(key, input);
        }
        const encoded = new Set<string>();
        const accelerated = meshletStats?.draws.get(batch.source.key);
        if (accelerated) { outputs.set(batch.source.key, accelerated); continue; }
        const draws = profile.selectedLevels.map(index => {
          const selected = levels[index];
          if (!selected) throw Error("Author-selected LOD index is unavailable.");
          const phase = next.get(selected.key)!.phase;
          if (!encoded.has(selected.key)) {
            phase.writeView(this.session.device.queue, frustum); phase.encode(encoder); encoded.add(selected.key);
            authorFrustumPasses++; authorFrustumDispatches += batch.source.count ? 2 : 1;
          }
          return Object.freeze({ geometry: selected.level.geometry, instances: phase.compacted,
            previousTransforms: phase.compactedPrevious, indirect: phase.indirect, indirectOffset: 0,
            instanceByteOffset: 0, previousByteOffset: 0 });
        });
        outputs.set(batch.source.key, Object.freeze(draws));
      }
    } catch (error) { failWithResourceCleanup(error, "Author LOD preparation failed.", [() => this.meshlets.dispose(), ...created.map(input => () => input.destroy())]); }
    this.pending = next; this.outputs = outputs;
    return { inputObjects: batches.reduce((count, batch) => count + batch.source.count, 0), selectionBatches: batches.length,
      indirectDraws: [...outputs.values()].reduce((count, draws) => count + draws.length, 0), historyReset: false,
      authorFrustumPasses, authorFrustumDispatches,
      ...(meshletStats?.passes || meshletStats?.fallbackReasons.length ? { meshletPasses: meshletStats.passes,
        meshletDispatches: meshletStats.dispatches, meshletFallbackReasons: meshletStats.fallbackReasons } : {}) };
  }
  draws(key: string): readonly PacketLodDraw[] | undefined {
    return !this.disposed && this.session.state === "ready" ? this.outputs.get(key) : undefined;
  }
  commitFrame(): void {
    if (!this.pending) return;
    const previous = this.current; this.current = this.pending; this.pending = undefined; this.releaseDifference(previous, this.current);
    this.meshlets.commit();
  }
  cancelFrame(): void {
    const pending = this.pending; this.pending = undefined;
    if (pending) { this.outputs.clear(); runResourceCleanup("Author LOD cancellation failed.", [() => this.releaseDifference(pending, this.current), () => this.meshlets.dispose()]); }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const inputs = new Set([...this.current.values(), ...(this.pending?.values() ?? [])]);
    this.current.clear(); this.pending = undefined; this.outputs.clear();
    runResourceCleanup("Author LOD disposal failed.", [...inputs].map(input => () => input.destroy()).concat([() => this.context?.dispose(), () => this.meshlets.dispose()]));
  }
  private releaseDifference(old: Map<string, AuthorLodCullingInputs>, next: Map<string, AuthorLodCullingInputs>): void {
    const retained = new Set(next.values());
    runResourceCleanup("Author LOD retirement failed.", [...old.values()].filter(input => !retained.has(input)).map(input => () => input.destroy()));
  }
}
