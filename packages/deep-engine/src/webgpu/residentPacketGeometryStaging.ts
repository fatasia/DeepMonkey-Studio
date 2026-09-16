import type { GeometryResource } from "../renderPacket.js";
import type { CachedPacketGeometry } from "./packetBufferTypes.js";
import { createPacketGeometryBounds, type PacketGeometryBounds } from "./packetGeometryBounds.js";
import type {
  ResidentPacketBatch,
  ResidentPacketProjection,
} from "./residentPacketProjection.js";
import { residentPacketProjectionBatches,
  residentPacketProjectionGeometrySource } from "./residentPacketProjectionView.js";

export interface ResidentPacketGeometryStage {
  readonly geometries: Map<string, CachedPacketGeometry>;
  readonly geometryBounds: ReadonlyMap<string, PacketGeometryBounds>;
}

/** Separates complete CPU bounds metadata from the subset with leased GPU meshes. */
export function stageResidentPacketGeometries(
  current: ReadonlyMap<string, CachedPacketGeometry>,
  projection: ResidentPacketProjection,
): ResidentPacketGeometryStage {
  const sources = new Map<string, GeometryResource>();
  const batches = residentPacketProjectionBatches(projection);
  for (const batch of batches) collectSources(projection, batch, sources);
  const geometryBounds = createPacketGeometryBounds(sources);
  const geometries = new Map<string, CachedPacketGeometry>();
  for (const batch of batches) {
    stageResidentBatch(current, projection, batch, geometryBounds, geometries);
  }
  return { geometries, geometryBounds };
}

function collectSources(projection: ResidentPacketProjection, batch: ResidentPacketBatch,
  target: Map<string, GeometryResource>): void {
  for (const id of geometryIds(batch)) {
    const source = residentPacketProjectionGeometrySource(projection, id);
    if (!source || source.id !== id) {
      throw new Error(`Resident geometry source revision is unavailable: ${id}.`);
    }
    const existing = target.get(id);
    if (existing && (source.revision !== existing.revision || !sameGeometry(source, existing))) {
      throw new Error(`Resident geometry source is inconsistent: ${id}.`);
    }
    target.set(id, source);
  }
}

function stageResidentBatch(current: ReadonlyMap<string, CachedPacketGeometry>,
  projection: ResidentPacketProjection, batch: ResidentPacketBatch,
  bounds: ReadonlyMap<string, PacketGeometryBounds>,
  target: Map<string, CachedPacketGeometry>): void {
  const ids = geometryIds(batch), expected = new Set(ids);
  const handles = new Set<object>(), residentIds = new Set<string>();
  for (const handle of batch.geometries) {
    const id = handle?.sourceId;
    if (!handle || handle.kind !== "geometry" || !expected.has(id)
      || residentIds.has(id) || handles.has(handle) || projection.geometry(id) !== handle
      || !handle.mesh || !Number.isSafeInteger(handle.level) || handle.level < 0) {
      throw new Error(`Resident geometry LOD binding is invalid: ${id ?? "unknown"}.`);
    }
    const source = residentPacketProjectionGeometrySource(projection, id);
    if (!source || source.id !== id || source.revision !== handle.sourceRevision) {
      throw new Error(`Resident geometry source revision is unavailable: ${id}.`);
    }
    residentIds.add(id); handles.add(handle);
    stageHandle(current, source, handle.mesh, bounds.get(id)!, target);
  }
  const lod = batch.source.lod;
  if (!projection.partialLod) {
    const missing = ids.find(id => !residentIds.has(id));
    if (missing) throw new Error(`Resident geometry LOD closure is incomplete: ${missing}.`);
  } else {
    const levels = lod?.levels ?? [{ geometry: batch.source.geometry, resident: true }];
    const omitted = levels.find(level => level.resident
      && projection.geometry(level.geometry) !== undefined && !residentIds.has(level.geometry));
    if (omitted) {
      throw new Error(`Resident geometry LOD closure is inconsistent: ${omitted.geometry}.`);
    }
    const fallback = lod?.levels.at(-1);
    const required = fallback?.geometry ?? batch.source.geometry;
    if (fallback?.resident === false || !residentIds.has(required)) {
      throw new Error(`Resident geometry coarsest fallback is unavailable: ${required}.`);
    }
  }
}

function geometryIds(batch: ResidentPacketBatch): readonly string[] {
  const levels = batch.source.lod?.levels;
  if (!levels) return [batch.source.geometry];
  if (!levels.length || levels[0]?.geometry !== batch.source.geometry) {
    throw new Error(`Resident geometry LOD closure is invalid: ${batch.source.key}.`);
  }
  return levels.map(level => level.geometry);
}

function stageHandle(current: ReadonlyMap<string, CachedPacketGeometry>, source: GeometryResource,
  mesh: CachedPacketGeometry["mesh"], bounds: PacketGeometryBounds,
  target: Map<string, CachedPacketGeometry>): void {
  const previous = current.get(source.id);
  if (previous && (source.revision < previous.source.revision
    || (source.revision === previous.source.revision && !sameGeometry(source, previous.source)))) {
    throw new Error(`Resident geometry source conflicts with the current cache: ${source.id}.`);
  }
  const existing = target.get(source.id);
  if (existing && existing.mesh !== mesh) {
    throw new Error(`Resident geometry binding is inconsistent: ${source.id}.`);
  }
  target.set(source.id, previous?.mesh === mesh && previous.source.revision === source.revision
    ? previous : { source, mesh, center: bounds.center, radius: bounds.radius });
}

function sameGeometry(left: GeometryResource, right: GeometryResource): boolean {
  return equal(left.vertices, right.vertices) && equal(left.indices, right.indices)
    && optionalEqual(left.uv0, right.uv0) && optionalEqual(left.uv1, right.uv1)
    && optionalEqual(left.tangents, right.tangents) && optionalEqual(left.colors, right.colors);
}

const equal = (left: ArrayLike<number>, right: ArrayLike<number>): boolean =>
  left.length === right.length && Array.from(left).every((value, index) => value === right[index]);
const optionalEqual = (left: ArrayLike<number> | undefined,
  right: ArrayLike<number> | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && equal(left, right);
