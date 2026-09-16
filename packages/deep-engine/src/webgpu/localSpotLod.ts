import type { PacketBuffers } from "./packetBuffers.js";
import type { PacketLodResources } from "./packetLodResources.js";
import type { PacketLodView } from "./packetLodTypes.js";
import type { SelectedLocalSpotShadow } from "./localSpotShadowSelection.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

/** Each spot owns its own view/output; neither CSM nor camera visibility is borrowed. */
export class LocalSpotLod {
  private current = new Map<string, PacketLodResources>();
  private pending: Map<string, PacketLodResources> | undefined;
  encode(encoder: GPUCommandEncoder, packets: PacketBuffers, selected: readonly SelectedLocalSpotShadow[]) {
    if (this.pending) throw Error("Local spot LOD frame is pending submission.");
    const next = new Map<string, PacketLodResources>();
    let authorFrustumPasses = 0, authorFrustumDispatches = 0;
    let meshletPasses = 0, meshletDispatches = 0; const meshletFallbackReasons = new Set<string>();
    try {
      for (const spot of selected) {
        const key = spot.light.shadow!.key;
        const result = packets.encodeIndependentLod(encoder, localSpotLodView(spot), this.current.get(key));
        if (!result) continue;
        next.set(key, result.resources);
        authorFrustumPasses += result.stats.authorFrustumPasses ?? 0;
        authorFrustumDispatches += result.stats.authorFrustumDispatches ?? 0;
        meshletPasses += result.stats.meshletPasses ?? 0; meshletDispatches += result.stats.meshletDispatches ?? 0;
        result.stats.meshletFallbackReasons?.forEach(reason => meshletFallbackReasons.add(reason));
      }
    } catch (error) {
      failWithResourceCleanup(error, "Local spot LOD preparation failed.", [...next].map(([key, resources]) =>
        () => resources === this.current.get(key) ? resources.cancelFrame() : resources.dispose()));
    }
    this.pending = next;
    return { authorFrustumPasses, authorFrustumDispatches,
      ...(meshletPasses || meshletFallbackReasons.size ? { meshletPasses, meshletDispatches, meshletFallbackReasons: [...meshletFallbackReasons] } : {}) };
  }
  view(spot: SelectedLocalSpotShadow): PacketLodResources | null {
    return (this.pending ?? this.current).get(spot.light.shadow!.key) ?? null;
  }
  commit(): void {
    if (!this.pending) return;
    const old = this.current; this.current = this.pending; this.pending = undefined;
    runResourceCleanup("Local spot LOD commit failed.", [
      ...[...this.current.values()].map(resources => () => resources.commitFrame()),
      ...[...old].filter(([key]) => !this.current.has(key)).map(([, resources]) => () => resources.dispose()),
    ]);
  }
  fail(): void {
    const pending = this.pending; this.pending = undefined;
    if (pending) runResourceCleanup("Local spot LOD cancellation failed.", [...pending].map(([key, resources]) =>
      () => resources === this.current.get(key) ? resources.failFrame() : resources.dispose()));
  }
  dispose(): void {
    const resources = new Set([...this.current.values(), ...(this.pending?.values() ?? [])]);
    this.current.clear(); this.pending = undefined;
    runResourceCleanup("Local spot LOD disposal failed.", [...resources].map(resource => () => resource.dispose()));
  }
}

export function localSpotLodView(spot: SelectedLocalSpotShadow): PacketLodView {
  const light = spot.light, length = Math.hypot(...light.directionWorld);
  return { frustum: viewProjectionFrustum(spot.matrix), viewport: { width: spot.tile.size, height: spot.tile.size },
    camera: { projection: "perspective", position: light.positionWorld,
      forward: light.directionWorld.map(value => value / length) as [number, number, number],
      verticalFovRadians: Math.min(Math.PI - 1e-4, 2 * Math.acos(light.outerConeCos)),
      near: Math.min(Math.max(light.range * .001, .01), light.range * .5), far: light.range } };
}
