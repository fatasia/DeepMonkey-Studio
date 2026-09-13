import { geometryCenter } from "../renderPacket.js";
import { validateGeometries } from "../renderPacketGeometry.js";
import type { GeometryResource, PreparedPacket } from "../renderPacketTypes.js";

export interface PacketGeometryBounds {
  readonly kind: "geometry";
  readonly id: string;
  readonly revision: number;
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly triangleCount: number;
}

export type PacketGeometryBoundsSource =
  | Pick<PreparedPacket, "geometries">
  | ReadonlyMap<string, GeometryResource>;

/**
 * Computes immutable CPU metadata for every packet geometry without retaining
 * mesh buffers or copying source vertex/index arrays.
 */
export function createPacketGeometryBounds(
  source: PacketGeometryBoundsSource,
): ReadonlyMap<string, PacketGeometryBounds> {
  const input = geometryMap(source);
  const geometries = new Map<string, GeometryResource>();
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("Packet geometry map entry is invalid.");
    }
    const [key, geometry] = entry;
    validateIdentity(key, geometry);
    if (geometries.has(key)) throw new Error(`Duplicate packet geometry identity: ${key}.`);
    geometries.set(key, geometry);
  }
  validateGeometries(geometries);

  const bounds = new Map<string, PacketGeometryBounds>();
  for (const [id, geometry] of geometries) {
    const center = Object.freeze([...geometryCenter(geometry)] as [number, number, number]);
    let radius = 0;
    for (const index of geometry.indices) {
      const offset = index * 6;
      const distance = Math.hypot(
        geometry.vertices[offset]! - center[0],
        geometry.vertices[offset + 1]! - center[1],
        geometry.vertices[offset + 2]! - center[2],
      );
      if (!Number.isFinite(distance)) throw new Error(`Packet geometry bounds are not finite: ${id}.`);
      radius = Math.max(radius, distance);
    }
    radius = Math.max(radius, 1e-6);
    if (!center.every(Number.isFinite) || !Number.isFinite(radius)) {
      throw new Error(`Packet geometry bounds are not finite: ${id}.`);
    }
    bounds.set(id, Object.freeze({
      kind: "geometry",
      id,
      revision: geometry.revision,
      center,
      radius,
      triangleCount: geometry.indices.length / 3,
    }));
  }
  return new ImmutableBoundsMap(bounds);
}

function geometryMap(source: PacketGeometryBoundsSource): ReadonlyMap<string, GeometryResource> {
  if (isReadonlyMap(source)) return source;
  if (!source || typeof source !== "object" || !isReadonlyMap(source.geometries)) {
    throw new TypeError("Packet geometry bounds source is invalid.");
  }
  return source.geometries;
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<string, GeometryResource> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReadonlyMap<string, GeometryResource>>;
  return Number.isSafeInteger(candidate.size)
    && typeof candidate.get === "function"
    && typeof candidate[Symbol.iterator] === "function";
}

function validateIdentity(key: unknown, source: unknown): asserts source is GeometryResource {
  if (!source || typeof source !== "object") throw new TypeError("Packet geometry resource is invalid.");
  const geometry = source as GeometryResource & { readonly kind?: unknown };
  if (typeof key !== "string" || typeof geometry.id !== "string"
    || !geometry.id.trim() || geometry.id.length > 256 || key !== geometry.id
    || (geometry.kind !== undefined && geometry.kind !== "geometry")) {
    throw new Error(`Invalid packet geometry identity: ${String(key)}.`);
  }
}

class ImmutableBoundsMap implements ReadonlyMap<string, PacketGeometryBounds> {
  readonly #values: ReadonlyMap<string, PacketGeometryBounds>;

  constructor(values: ReadonlyMap<string, PacketGeometryBounds>) {
    this.#values = values;
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get [Symbol.toStringTag](): string { return "PacketGeometryBounds"; }
  get(key: string): PacketGeometryBounds | undefined { return this.#values.get(key); }
  has(key: string): boolean { return this.#values.has(key); }
  entries(): MapIterator<[string, PacketGeometryBounds]> { return this.#values.entries(); }
  keys(): MapIterator<string> { return this.#values.keys(); }
  values(): MapIterator<PacketGeometryBounds> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[string, PacketGeometryBounds]> { return this.entries(); }
  forEach(callbackfn: (value: PacketGeometryBounds, key: string,
    map: ReadonlyMap<string, PacketGeometryBounds>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
}
