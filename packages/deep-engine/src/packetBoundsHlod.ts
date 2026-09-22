import type { GeometryResource, RenderInstance, RenderPacket } from "./renderPacketTypes.js";

const DEFAULT_MIN_SOURCE_TRIANGLES = 256;
const DEFAULT_SWITCH_PIXELS = 48;
const DEFAULT_HYSTERESIS = 0.12;
const PROXY_TRIANGLES = 12;
const PROXY_SUFFIX = "#deep-hlod-bounds-v1";

export interface PacketBoundsHlodOptions {
  readonly minSourceTriangles?: number;
  readonly switchProjectedDiameterPixels?: number;
  readonly hysteresisRatio?: number;
  /** Opt-in spatial boxes inside one normal LOD geometry; 1 preserves the original single proxy. */
  readonly spatialPartitions?: number;
}

export interface PacketBoundsHlodEvidence {
  readonly generatedGeometries: number;
  readonly attachedInstances: number;
  readonly sourceTriangles: number;
  readonly proxyTriangles: number;
  readonly generatedPartitions: number;
}

export interface PacketBoundsHlodResult {
  readonly packet: RenderPacket;
  readonly evidence: PacketBoundsHlodEvidence;
}

/**
 * Builds deterministic, conservative far-distance geometry before the normal
 * meshlet/residency bake. Existing authored LOD and deformed instances remain
 * authoritative and are never rewritten.
 */
export function compilePacketBoundsHlod(packet: RenderPacket,
  options: PacketBoundsHlodOptions = {}): PacketBoundsHlodResult {
  const config = validateOptions(options);
  const geometries = new Map(packet.geometries.map(value => [value.id, value]));
  const proxies = new Map<string, { readonly geometry: GeometryResource; readonly partitions: number }>();
  let attachedInstances = 0, sourceTriangles = 0;
  const instances = packet.instances.map((instance): RenderInstance => {
    if (instance.lod !== undefined || instance.pose !== undefined) return instance;
    const source = geometries.get(instance.geometry);
    if (!source) return instance;
    const triangles = source.indices.length / 3;
    if (triangles < config.minSourceTriangles || triangles <= PROXY_TRIANGLES) return instance;
    const spatialPartitions = Math.min(config.spatialPartitions, Math.floor((triangles - 1) / PROXY_TRIANGLES));
    const proxyId = `${source.id}${PROXY_SUFFIX}${spatialPartitions === 1 ? "" : `-p${spatialPartitions}`}`;
    if (geometries.has(proxyId)) throw new Error(`HLOD proxy geometry ID collides with source packet: ${proxyId}.`);
    let proxy = proxies.get(proxyId);
    if (!proxy) { proxy = boundsProxy(source, proxyId, spatialPartitions); proxies.set(proxyId, proxy); sourceTriangles += triangles; }
    attachedInstances += 1;
    return Object.freeze({ ...instance, lod: Object.freeze({ strategy: "screen-space" as const,
      hysteresisRatio: config.hysteresisRatio, levels: Object.freeze([
        Object.freeze({ geometry: source.id, minProjectedDiameterPixels: config.switchPixels, geometricError: 0 }),
        Object.freeze({ geometry: proxy.geometry.id, minProjectedDiameterPixels: 0, geometricError: boundsDiagonal(source) }),
      ]) }) });
  });
  const evidence = Object.freeze({ generatedGeometries: proxies.size, attachedInstances,
    sourceTriangles, proxyTriangles: [...proxies.values()].reduce((sum, value) => sum + value.geometry.indices.length / 3, 0),
    generatedPartitions: [...proxies.values()].reduce((sum, value) => sum + value.partitions, 0) });
  if (!proxies.size) return Object.freeze({ packet, evidence });
  return Object.freeze({ packet: Object.freeze({ ...packet,
    geometries: Object.freeze([...packet.geometries, ...[...proxies.values()].map(value => value.geometry)]),
    instances: Object.freeze(instances) }), evidence });
}

function validateOptions(options: PacketBoundsHlodOptions): Readonly<{ minSourceTriangles: number;
  switchPixels: number; hysteresisRatio: number; spatialPartitions: number }> {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["minSourceTriangles", "switchProjectedDiameterPixels", "hysteresisRatio", "spatialPartitions"].includes(key))) {
    throw new TypeError("Invalid bounds HLOD options.");
  }
  const minSourceTriangles = options.minSourceTriangles ?? DEFAULT_MIN_SOURCE_TRIANGLES;
  const switchPixels = options.switchProjectedDiameterPixels ?? DEFAULT_SWITCH_PIXELS;
  const hysteresisRatio = options.hysteresisRatio ?? DEFAULT_HYSTERESIS;
  const spatialPartitions = options.spatialPartitions ?? 1;
  if (!Number.isSafeInteger(minSourceTriangles) || minSourceTriangles < 13) throw new RangeError("HLOD source triangle threshold must be at least 13.");
  if (!Number.isFinite(switchPixels) || switchPixels <= 0 || switchPixels > 1e9
    || Math.fround(switchPixels) <= 0) throw new RangeError("HLOD switch threshold is invalid.");
  if (!Number.isFinite(hysteresisRatio) || hysteresisRatio < 0 || hysteresisRatio > 0.49) throw new RangeError("HLOD hysteresis ratio is invalid.");
  if (!Number.isSafeInteger(spatialPartitions) || spatialPartitions < 1 || spatialPartitions > 64) throw new RangeError("HLOD spatial partition count must be between 1 and 64.");
  return Object.freeze({ minSourceTriangles, switchPixels, hysteresisRatio, spatialPartitions });
}

function boundsProxy(source: GeometryResource, id: string, partitionCount: number): Readonly<{ geometry: GeometryResource; partitions: number }> {
  const vertices: number[] = [], uv: number[] = [], tangents: number[] = [], colors: number[] = [];
  const face = (normal: readonly [number, number, number], tangent: readonly [number, number, number],
    corners: readonly (readonly [number, number, number])[]): void => {
    for (const [index, corner] of corners.entries()) {
      vertices.push(...corner, ...normal); uv.push(index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0);
      tangents.push(...tangent, 1); colors.push(1, 1, 1, 1);
    }
  };
  const indices: number[] = [];
  const appendBox = ([minX, minY, minZ, maxX, maxY, maxZ]: readonly number[]): void => {
    const first = vertices.length / 6;
    face([1, 0, 0], [0, 0, -1], [[maxX!, minY!, maxZ!], [maxX!, minY!, minZ!], [maxX!, maxY!, minZ!], [maxX!, maxY!, maxZ!]]);
    face([-1, 0, 0], [0, 0, 1], [[minX!, minY!, minZ!], [minX!, minY!, maxZ!], [minX!, maxY!, maxZ!], [minX!, maxY!, minZ!]]);
    face([0, 1, 0], [1, 0, 0], [[minX!, maxY!, maxZ!], [maxX!, maxY!, maxZ!], [maxX!, maxY!, minZ!], [minX!, maxY!, minZ!]]);
    face([0, -1, 0], [1, 0, 0], [[minX!, minY!, minZ!], [maxX!, minY!, minZ!], [maxX!, minY!, maxZ!], [minX!, minY!, maxZ!]]);
    face([0, 0, 1], [1, 0, 0], [[minX!, minY!, maxZ!], [maxX!, minY!, maxZ!], [maxX!, maxY!, maxZ!], [minX!, maxY!, maxZ!]]);
    face([0, 0, -1], [-1, 0, 0], [[maxX!, minY!, minZ!], [minX!, minY!, minZ!], [minX!, maxY!, minZ!], [maxX!, maxY!, minZ!]]);
    for (let offset = first; offset < first + 24; offset += 4) indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  };
  const partitions = partitionBounds(source, partitionCount); partitions.forEach(appendBox);
  const geometry = Object.freeze({ id, revision: source.revision, vertices: new Float32Array(vertices),
    ...(source.uv0 ? { uv0: new Float32Array(uv) } : {}), ...(source.uv1 ? { uv1: new Float32Array(uv) } : {}),
    ...(source.tangents ? { tangents: new Float32Array(tangents) } : {}),
    ...(source.colors ? { colors: new Float32Array(colors) } : {}), indices: new Uint32Array(indices) });
  return Object.freeze({ geometry, partitions: partitions.length });
}

function partitionBounds(source: GeometryResource, count: number): readonly (readonly number[])[] {
  const global = bounds(source), spans = [global[3] - global[0], global[4] - global[1], global[5] - global[2]];
  const axis = spans[1]! > spans[0]! ? spans[2]! > spans[1]! ? 2 : 1 : spans[2]! > spans[0]! ? 2 : 0;
  const bins = Array.from({ length: count }, () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const span = spans[axis]!;
  for (let triangle = 0; triangle < source.indices.length; triangle += 3) {
    const indices = [source.indices[triangle]!, source.indices[triangle + 1]!, source.indices[triangle + 2]!];
    const center = indices.reduce((sum, index) => sum + source.vertices[index * 6 + axis]!, 0) / 3;
    const binIndex = span <= 1e-12 ? 0 : Math.min(count - 1, Math.floor((center - global[axis]!) / span * count));
    const bin = bins[binIndex]!;
    for (const index of indices) { const offset = index * 6;
      for (let component = 0; component < 3; component++) { const value = source.vertices[offset + component]!;
        bin[component] = Math.min(bin[component]!, value); bin[component + 3] = Math.max(bin[component + 3]!, value); }
    }
  }
  return Object.freeze(bins.filter(value => Number.isFinite(value[0])).map(value => Object.freeze(value)));
}

function boundsDiagonal(source: GeometryResource): number {
  const value = bounds(source); return Math.fround(Math.hypot(value[3] - value[0], value[4] - value[1], value[5] - value[2]));
}
function bounds(source: GeometryResource): readonly [number, number, number, number, number, number] {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const index of source.indices) { const offset = index * 6;
    const x = source.vertices[offset]!, y = source.vertices[offset + 1]!, z = source.vertices[offset + 2]!;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z); }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}
