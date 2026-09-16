import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { DeformationBoundsEnvelope } from "./deformationBounds.js";

/** Validate every eligible batch before the first upload or compute dispatch. */
export function preflightCullingBounds(batches: readonly CachedPacketBatch[],
  geometries: ReadonlyMap<string, CachedPacketGeometry>, dynamic?: ReadonlyMap<string, DeformationBoundsEnvelope>): void {
  for (const batch of batches) {
    const geometry = geometries.get(batch.source.geometry);
    if (!geometry) throw new Error(`Culling geometry is not resident: ${batch.source.geometry}.`);
    const bounds = dynamic?.get(batch.source.key);
    if (batch.source.pose !== undefined && !bounds)
      throw new Error(`Missing deformed culling bounds: ${batch.source.key}.`);
    cullingBounds(geometry, bounds);
  }
}

export function cullingBounds(geometry: CachedPacketGeometry, dynamic?: DeformationBoundsEnvelope): [number, number, number, number] {
  if (dynamic && dynamic.conservative !== true) throw new Error("Culling bounds must be conservative.");
  const bounds = (dynamic ? [...dynamic.center, dynamic.radius]
    : [...geometry.center, geometry.radius]) as [number, number, number, number];
  if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)
    || !Number.isFinite(Math.fround(value))) || bounds[3] <= 0)
    throw new Error("Culling bounds must contain a finite center and positive float32 radius.");
  return bounds;
}
