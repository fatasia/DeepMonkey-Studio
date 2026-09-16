import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { PacketLodSceneCache, type PacketGeometryBoundsMap } from "./packetLodSceneCache.js";
import type { PacketLodDraw, PacketLodFrameStats, PacketLodView } from "./packetLodTypes.js";
import { ScreenSpacePacketLodResources } from "./screenSpacePacketLodResources.js";
import { AuthorSelectedLodResources } from "./authorSelectedLodResources.js";
import { runResourceCleanup } from "./resourceCleanup.js";

/** Explicit author selection never enters the view-dependent selector. */
export class PacketLodResources {
  private readonly screen: ScreenSpacePacketLodResources;
  private readonly author: AuthorSelectedLodResources;
  constructor(session: DeviceSession, sharedInputs?: PacketLodSceneCache) {
    this.screen = new ScreenSpacePacketLodResources(session, sharedInputs);
    this.author = new AuthorSelectedLodResources(session);
  }
  encode(encoder: GPUCommandEncoder, batches: ReadonlyMap<string, CachedPacketBatch>,
    geometries: ReadonlyMap<string, CachedPacketGeometry>, revision: number, view: PacketLodView,
    bounds: PacketGeometryBoundsMap = geometries): PacketLodFrameStats {
    const authorBatches = [...batches.values()].filter(batch => batch.source.lod?.strategy === "author-selected");
    if (authorBatches.length && (view.budget?.maxObjects !== undefined || view.budget?.maxTriangles !== undefined))
      throw Error("Author-selected LOD with explicit global budgets is not supported.");
    const author = this.author.encode(encoder, view.frustum, authorBatches, geometries, view);
    try {
      const screenBatches = new Map([...batches].filter(([, batch]) => batch.source.lod?.strategy !== "author-selected"));
      const screen = this.screen.encode(encoder, screenBatches, geometries, revision, view, bounds);
      return { inputObjects: author.inputObjects + screen.inputObjects, selectionBatches: author.selectionBatches + screen.selectionBatches,
        indirectDraws: author.indirectDraws + screen.indirectDraws, historyReset: screen.historyReset,
        authorFrustumPasses: author.authorFrustumPasses ?? 0, authorFrustumDispatches: author.authorFrustumDispatches ?? 0,
        ...(author.meshletPasses !== undefined ? { meshletPasses: author.meshletPasses, meshletDispatches: author.meshletDispatches!, meshletFallbackReasons: author.meshletFallbackReasons! } : {}) };
    } catch (error) { this.author.cancelFrame(); throw error; }
  }
  draws(key: string): readonly PacketLodDraw[] | undefined { return this.author.draws(key) ?? this.screen.draws(key); }
  commitFrame(): void { runResourceCleanup("Packet LOD commit failed.", [() => this.screen.commitFrame(), () => this.author.commitFrame()]); }
  cancelFrame(): void { runResourceCleanup("Packet LOD cancel failed.", [() => this.screen.cancelFrame(), () => this.author.cancelFrame()]); }
  failFrame(): void { runResourceCleanup("Packet LOD failure cleanup failed.", [() => this.screen.failFrame(), () => this.author.cancelFrame()]); }
  dispose(): void { runResourceCleanup("Packet LOD disposal failed.", [() => this.screen.dispose(), () => this.author.dispose()]); }
}
