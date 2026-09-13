import type { DeviceSession } from "./deviceSession.js";
import type { MaterialBindingPool } from "./materialBindings.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { createPacketGeometryBounds, type PacketGeometryBounds } from "./packetGeometryBounds.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import type { TextureResources } from "./textureResources.js";

export interface PacketBufferRetirementContext {
  readonly session: DeviceSession;
  readonly materials: MaterialBindingPool;
}

export interface PacketBufferRetirementOptions {
  readonly ownMeshes: boolean;
  readonly projection?: ResidentPacketProjection;
  readonly clearTextures?: TextureResources;
}

/** Retires every superseded owner best-effort after the replacement is already installed. */
export function retirePacketBuffers(
  context: PacketBufferRetirementContext,
  previousGeometries: ReadonlyMap<string, CachedPacketGeometry>,
  previousBatches: ReadonlyMap<string, CachedPacketBatch>,
  nextGeometries: ReadonlyMap<string, CachedPacketGeometry>,
  nextBatches: ReadonlyMap<string, CachedPacketBatch>,
  options: PacketBufferRetirementOptions,
): void {
  const failures: unknown[] = [];
  if (options.clearTextures) attempt(failures, () => {
    const staged = options.clearTextures!.stagePrepared([]);
    options.clearTextures!.publishPrepared(staged);
  });
  if (options.ownMeshes) for (const [id, value] of previousGeometries) {
    if (nextGeometries.get(id) !== value) attempt(failures, () => value.mesh.dispose());
  }
  for (const [key, value] of previousBatches) {
    const next = nextBatches.get(key);
    if (next?.buffer !== value.buffer) attempt(failures, () => context.session.release(value.buffer));
    if (next?.previousBuffer !== value.previousBuffer) {
      attempt(failures, () => context.session.release(value.previousBuffer));
    }
    if (next?.material !== value.material) {
      attempt(failures, () => context.materials.release(value.material));
    }
  }
  if (options.projection) attempt(failures, () => options.projection!.release());
  if (failures.length) throw new AggregateError(failures, "Superseded packet resource retirement failed.");
}

export function packetGeometryBounds(
  geometries: ReadonlyMap<string, CachedPacketGeometry>,
): ReadonlyMap<string, PacketGeometryBounds> {
  return createPacketGeometryBounds(new Map(
    Array.from(geometries, ([id, value]) => [id, value.source]),
  ));
}

function attempt(failures: unknown[], operation: () => void): void {
  try { operation(); } catch (error) { failures.push(error); }
}
