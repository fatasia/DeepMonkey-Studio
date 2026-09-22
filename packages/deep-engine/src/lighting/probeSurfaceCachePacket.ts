import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "../materialInstanceAbi.js";
import { prepareRenderPacket, type GeometryResource, type RenderPacket } from "../renderPacket.js";
import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";
import { ProbeSurfaceCache, type ProbeSurfaceCacheEntry } from "./probeSurfaceCache.js";

const SURFACE_ID = /^[0-9A-Za-z][0-9A-Za-z._:/-]{0,255}$/;
const MAX_COORDINATE = 1_000_000_000;

export interface ProbeSurfaceCachePacketInput {
  readonly packet: RenderPacket;
  /** Monotonic author/runtime packet revision, including material and transform edits. */
  readonly revision: number;
  readonly dynamicInstanceIds?: ReadonlySet<string>;
}

/** Compiles validated render-packet geometry into world-space cache coverage and consumes it atomically by revision. */
export class ProbeSurfaceCachePacketConsumer {
  private packetRevision = 0;
  private packetIdentity: RenderPacket | undefined;
  private dynamicSignature = "";
  private activeIds = new Set<string>();
  private boundsValue: ProbeAabb | null = null;

  constructor(private readonly cache: ProbeSurfaceCache) {}

  get sceneBounds(): ProbeAabb | null { return this.boundsValue; }

  sync(input: ProbeSurfaceCachePacketInput): boolean {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new RangeError("Surface-cache packet revision must be a positive integer.");
    }
    if (input.revision < this.packetRevision) throw new Error("Surface-cache packet revision regressed.");
    const dynamicSignature = [...(input.dynamicInstanceIds ?? [])].sort().join("\0");
    if (input.revision === this.packetRevision) {
      if (input.packet === this.packetIdentity && dynamicSignature === this.dynamicSignature) return false;
      throw new Error("Surface-cache packet identity changed without advancing revision.");
    }
    const entries = compilePacketEntries(input);
    const nextIds = new Set(entries.map(entry => entry.id));
    for (const entry of entries) this.cache.upsert(entry);
    for (const id of this.activeIds) if (!nextIds.has(id)) this.cache.remove(id);
    this.activeIds = nextIds;
    this.packetRevision = input.revision;
    this.packetIdentity = input.packet;
    this.dynamicSignature = dynamicSignature;
    this.boundsValue = entries.length ? entries.slice(1).reduce(
      (bounds, entry) => unionBounds(bounds, entry.bounds), entries[0]!.bounds) : null;
    return true;
  }
}

export function compilePacketSurfaceCacheEntries(input: ProbeSurfaceCachePacketInput): readonly ProbeSurfaceCacheEntry[] {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new RangeError("Surface-cache packet revision must be a positive integer.");
  }
  return compilePacketEntries(input);
}

function compilePacketEntries(input: ProbeSurfaceCachePacketInput): readonly ProbeSurfaceCacheEntry[] {
  // Reuse the renderer's authoritative resource/reference/finite-value validation before deriving coverage.
  prepareRenderPacket(input.packet, STOCK_MATERIAL_INSTANCE_OPTIONS);
  const geometries = new Map(input.packet.geometries.map(geometry => [geometry.id, geometry]));
  const localBounds = new Map<string, ProbeAabb>();
  const dynamicIds = input.dynamicInstanceIds ?? new Set<string>();
  const instanceIds = new Set(input.packet.instances.map(instance => instance.id));
  for (const id of dynamicIds) if (!instanceIds.has(id)) throw new Error(`Dynamic surface instance does not exist: ${id}.`);
  const entries = input.packet.instances.map(instance => {
    const ids = [instance.geometry, ...(instance.lod?.levels.map(level => level.geometry) ?? [])];
    let bounds: ProbeAabb | undefined;
    for (const geometryId of new Set(ids)) {
      const geometry = geometries.get(geometryId);
      if (!geometry) throw new Error(`Surface-cache geometry does not exist: ${geometryId}.`);
      const local = localBounds.get(geometryId) ?? geometryBounds(geometry);
      localBounds.set(geometryId, local);
      const transformed = transformBounds(local, instance.transform);
      bounds = bounds ? unionBounds(bounds, transformed) : transformed;
    }
    return Object.freeze({ id: surfaceId(instance.id), revision: input.revision, bounds: bounds!,
      ...(dynamicIds.has(instance.id) ? { dynamic: true } : {}) });
  });
  entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return Object.freeze(entries);
}

function geometryBounds(geometry: GeometryResource): ProbeAabb {
  const vertices = geometry.vertices;
  if (vertices.length < 6 || vertices.length % 6 !== 0) throw new Error(`Surface-cache geometry is empty or malformed: ${geometry.id}.`);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < vertices.length; offset += 6) for (let axis = 0; axis < 3; axis += 1) {
    const value = vertices[offset + axis]!;
    if (!Number.isFinite(value)) throw new Error(`Surface-cache geometry contains a non-finite position: ${geometry.id}.`);
    min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
  }
  return Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) });
}

function transformBounds(bounds: ProbeAabb, matrix: ArrayLike<number>): ProbeAabb {
  if (matrix.length !== 16) throw new Error("Surface-cache instance transform must contain 16 values.");
  const values = Array.from(matrix);
  if (values.some(value => !Number.isFinite(value))) throw new Error("Surface-cache instance transform must be finite.");
  let result: ProbeAabb | undefined;
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) {
    for (const z of [bounds.min[2], bounds.max[2]]) {
      const w = values[3]! * x + values[7]! * y + values[11]! * z + values[15]!;
      if (!Number.isFinite(w) || Math.abs(w) < 1e-12) throw new Error("Surface-cache transform produced an invalid homogeneous coordinate.");
      const point: ProbeVector3 = [(values[0]! * x + values[4]! * y + values[8]! * z + values[12]!) / w,
        (values[1]! * x + values[5]! * y + values[9]! * z + values[13]!) / w,
        (values[2]! * x + values[6]! * y + values[10]! * z + values[14]!) / w];
      if (point.some(value => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)) {
        throw new Error("Surface-cache transform produced an out-of-range point.");
      }
      const pointBounds = { min: point, max: point };
      result = result ? unionBounds(result, pointBounds) : pointBounds;
    }
  }
  return result!;
}

function unionBounds(left: ProbeAabb, right: ProbeAabb): ProbeAabb {
  return {
    min: [Math.min(left.min[0], right.min[0]), Math.min(left.min[1], right.min[1]), Math.min(left.min[2], right.min[2])],
    max: [Math.max(left.max[0], right.max[0]), Math.max(left.max[1], right.max[1]), Math.max(left.max[2], right.max[2])],
  };
}

function surfaceId(instanceId: string): string {
  const id = `packet/${instanceId}`;
  if (!SURFACE_ID.test(id)) throw new Error(`Surface-cache instance id is not canonical: ${instanceId}.`);
  return id;
}
