import { retainPacketSkinningInputs } from "./packetPreparationOwnership.js";
import { prepareRenderPacket, type PreparedPacket, type RenderPacket } from "./renderPacket.js";
import type { MaterialInstanceOptions } from "./materialInstanceAbi.js";
import { prepareSkinningInput } from "./webgpu/gpuSkinningPacking.js";
import type { PreparedSkinningInput } from "./webgpu/gpuSkinningTypes.js";
import { prepareDeformationBounds, type DeformationBoundsProfile } from "./webgpu/deformationBounds.js";
import { interleaveUvSets } from "./webgpu/meshBuffers.js";
import { createPacketGeometryBounds, type PacketGeometryBounds } from "./webgpu/packetGeometryBounds.js";

export interface PacketPreparationWork {
  readonly prepared: PreparedPacket;
  readonly skinInputs: ReadonlyMap<string, PreparedSkinningInput>;
  readonly geometryInputs: ReadonlyMap<string, Float32Array<ArrayBuffer>>;
  readonly deformationBounds?: ReadonlyMap<string, DeformationBoundsProfile>;
  readonly geometryBounds?: ReadonlyMap<string, PacketGeometryBounds>;
}

/** Same validator and packer as synchronous SDK clients; no GPU objects cross this seam. */
export function buildPacketPreparationWork(packet: RenderPacket, options: MaterialInstanceOptions,
  skinInputs = false): PacketPreparationWork {
  const prepared = prepareRenderPacket(packet, options), packed = new Map<string, PreparedSkinningInput>();
  if (skinInputs && prepared.deformation) for (const pose of prepared.deformation.poses) {
    const source = prepared.deformation.sources.find(source => source.id === pose.source)!;
    if (source.kind === "skin") packed.set(pose.id, prepareSkinningInput(source.skinning!, pose.palette!));
  }
  return retainPacketSkinningInputs({ prepared, skinInputs: packed, geometryInputs: skinInputs
    ? new Map([...prepared.geometries].map(([id, geometry]) => [id, interleaveUvSets(geometry)])) : new Map(),
    ...(skinInputs ? { deformationBounds: new Map((prepared.deformation?.sources ?? []).map(source => [source.id, prepareDeformationBounds(source)])), geometryBounds: new Map(createPacketGeometryBounds(prepared)) } : {}) });
}

/** Check before structuredClone can erase illegal prototypes or execute getters. */
export function assertPacketCloneSafe(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") throw Error("Packet preparation requires plain data.");
    return;
  }
  if (seen.has(value)) return; seen.add(value);
  if (value instanceof ArrayBuffer) return;
  if (ArrayBuffer.isView(value)) {
    if (!(value.buffer instanceof ArrayBuffer)) throw Error("Packet preparation requires unshared arrays.");
    return;
  }
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw Error("Packet preparation requires plain data objects.");
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw Error("Packet preparation requires enumerable data properties.");
    assertPacketCloneSafe(descriptor.value, seen);
  }
}

export function preparationTransferables(value: unknown, buffers = new Set<ArrayBuffer>(), seen = new Set<object>()): ArrayBuffer[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [...buffers];
  seen.add(value);
  if (value instanceof ArrayBuffer) buffers.add(value);
  else if (ArrayBuffer.isView(value)) { if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer); }
  else if (value instanceof Map) for (const item of value.values()) preparationTransferables(item, buffers, seen);
  else for (const item of Object.values(value)) preparationTransferables(item, buffers, seen);
  return [...buffers];
}
