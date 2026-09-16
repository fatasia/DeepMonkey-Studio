import type { CascadedShadowPlan, CascadedShadowSlice } from "../shadows/types.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { PacketLodResources } from "./packetLodResources.js";
import type { PacketGeometryBoundsMap, PacketLodSceneCache } from "./packetLodSceneCache.js";
import type { PacketLodFrameStats, PacketLodView } from "./packetLodTypes.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

/** Shadow LOD uses light texels, independent of color visibility, budgets, and temporal history. */
export class PacketShadowLodResources {
  private readonly cascades = new Map<number, PacketLodResources>();
  constructor(private readonly session: DeviceSession, private readonly inputs: PacketLodSceneCache) {}

  encode(encoder: GPUCommandEncoder, batches: ReadonlyMap<string, CachedPacketBatch>,
    geometries: ReadonlyMap<string, CachedPacketGeometry>, revision: number,
    plan: CascadedShadowPlan, bounds: PacketGeometryBoundsMap = geometries): PacketLodFrameStats {
    const stats = { inputObjects: 0, selectionBatches: 0, indirectDraws: 0, historyReset: false, authorFrustumPasses: 0, authorFrustumDispatches: 0 };
    let meshletPasses = 0, meshletDispatches = 0; const meshletFallbackReasons = new Set<string>();
    try {
      for (const cascade of plan.cascades) {
        let resources = this.cascades.get(cascade.index);
        if (!resources) {
          resources = new PacketLodResources(this.session, this.inputs); this.cascades.set(cascade.index, resources);
        }
        const result = resources.encode(encoder, batches, geometries, revision,
          shadowLodView(plan, cascade), bounds);
        stats.inputObjects = Math.max(stats.inputObjects, result.inputObjects);
        stats.selectionBatches += result.selectionBatches; stats.indirectDraws += result.indirectDraws;
        stats.historyReset ||= result.historyReset;
        stats.authorFrustumPasses += result.authorFrustumPasses ?? 0;
        stats.authorFrustumDispatches += result.authorFrustumDispatches ?? 0;
        meshletPasses += result.meshletPasses ?? 0; meshletDispatches += result.meshletDispatches ?? 0;
        result.meshletFallbackReasons?.forEach(reason => meshletFallbackReasons.add(reason));
      }
      const retired = [...this.cascades].filter(([index]) => !plan.cascades.some(cascade => cascade.index === index));
      for (const [index] of retired) this.cascades.delete(index);
      runResourceCleanup("Superseded shadow LOD cascade retirement failed.",
        retired.map(([, resources]) => () => resources.dispose()));
      return meshletPasses || meshletFallbackReasons.size ? { ...stats, meshletPasses, meshletDispatches, meshletFallbackReasons: [...meshletFallbackReasons] } : stats;
    } catch (error) { failWithResourceCleanup(error, "Shadow LOD encoding failed.",
      [...this.cascades.values()].map(resources => () => resources.cancelFrame())); }
  }

  cascade(index: number): PacketLodResources | undefined { return this.cascades.get(index); }
  commitFrame(): void { runResourceCleanup("Shadow LOD frame commit failed.",
    [...this.cascades.values()].map(resources => () => resources.commitFrame())); }
  cancelFrame(): void { runResourceCleanup("Shadow LOD frame cancellation failed.",
    [...this.cascades.values()].map(resources => () => resources.cancelFrame())); }
  failFrame(): void { runResourceCleanup("Shadow LOD frame failure cleanup failed.",
    [...this.cascades.values()].map(resources => () => resources.failFrame())); }
  dispose(): void {
    const cascades = [...this.cascades.values()]; this.cascades.clear();
    runResourceCleanup("Shadow LOD resource disposal failed.", cascades.map(resources => () => resources.dispose()));
  }
}

export function shadowLodView(plan: CascadedShadowPlan, cascade: CascadedShadowSlice): PacketLodView {
  const m = cascade.viewProjection;
  const depthSpan = 1 / Math.hypot(m[2]!, m[6]!, m[10]!);
  const padding = Math.max(1e-4, depthSpan * 1e-6);
  const distance = depthSpan / 2 + padding;
  return { camera: { projection: "orthographic", forward: plan.lightDirection,
    position: [cascade.center[0] - plan.lightDirection[0] * distance,
      cascade.center[1] - plan.lightDirection[1] * distance,
      cascade.center[2] - plan.lightDirection[2] * distance],
    verticalSize: 2 / Math.hypot(m[1]!, m[5]!, m[9]!), near: padding / 2, far: depthSpan + padding * 2 },
    viewport: { width: plan.shadowMapSize, height: plan.shadowMapSize },
    frustum: viewProjectionFrustum(cascade.viewProjection) };
}
