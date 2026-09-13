import type {
  GeometryResource,
  PreparedBatch,
  PreparedMaterialTextures,
  PreparedPacket,
  PreparedTextureSlot,
} from "../renderPacketTypes.js";
import type { StreamedResourceKind } from "../streaming/index.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { GpuRenderResidencyProfile } from "./gpuRenderResidencyRuntime.js";

export type PacketResidencySourceSnapshot = Readonly<
  { kind: "geometry"; value: GeometryResource }
  | { kind: "texture"; value: PreparedTexture }
>;

/** Deep snapshots every upload payload so registered chunks never retain caller-owned bytes. */
export function snapshotResidencyPacket(packet: PreparedPacket): PreparedPacket {
  if (!packet || typeof packet !== "object") throw new TypeError("Prepared packet is invalid.");
  const geometries = new Map<string, GeometryResource>();
  for (const [key, source] of packet.geometries) geometries.set(key, Object.freeze({ ...source,
    vertices: source.vertices.slice(), indices: source.indices.slice(),
    ...(source.uv0 ? { uv0: source.uv0.slice() } : {}),
    ...(source.uv1 ? { uv1: source.uv1.slice() } : {}),
    ...(source.tangents ? { tangents: source.tangents.slice() } : {}),
  }));
  return Object.freeze({ geometries,
    textures: Object.freeze(packet.textures.map(source => Object.freeze({ ...source,
      sampler: Object.freeze({ ...source.sampler }),
      levels: Object.freeze(source.levels.map(level => Object.freeze({ ...level, data: level.data.slice() }))),
    }))),
    batches: Object.freeze(packet.batches.map(snapshotBatch)),
  });
}

export function packetResidencySource(packet: PreparedPacket,
  profile: GpuRenderResidencyProfile): PacketResidencySourceSnapshot {
  if (profile.kind === "geometry") return Object.freeze({ kind: "geometry",
    value: packet.geometries.get(profile.id)! });
  return Object.freeze({ kind: "texture", value: packet.textures.find(value => value.id === profile.id)! });
}

export function sameResidencyProfile(left: GpuRenderResidencyProfile,
  right: GpuRenderResidencyProfile): boolean {
  return left.kind === right.kind && left.id === right.id && left.revision === right.revision
    && left.levels.length === right.levels.length && left.levels.every((level, index) => {
      const other = right.levels[index]!;
      return level.level === other.level && level.byteLength === other.byteLength
        && (level.sourceId ?? left.id) === (other.sourceId ?? right.id);
    });
}

export function sameResidencySource(left: PacketResidencySourceSnapshot,
  right: PacketResidencySourceSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "geometry" && right.kind === "geometry") return left.value.revision === right.value.revision
    && bytesEqual(left.value.vertices, right.value.vertices) && bytesEqual(left.value.indices, right.value.indices)
    && optionalBytesEqual(left.value.uv0, right.value.uv0) && optionalBytesEqual(left.value.uv1, right.value.uv1)
    && optionalBytesEqual(left.value.tangents, right.value.tangents);
  if (left.kind !== "texture" || right.kind !== "texture") return false;
  const a = left.value, b = right.value;
  return a.revision === b.revision && a.semantic === b.semantic && a.format === b.format
    && a.requiredFeature === b.requiredFeature && a.samplerKey === b.samplerKey && a.byteLength === b.byteLength
    && JSON.stringify(a.sampler) === JSON.stringify(b.sampler) && a.levels.length === b.levels.length
    && a.levels.every((level, index) => { const other = b.levels[index]!;
      return level.width === other.width && level.height === other.height
        && level.bytesPerRow === other.bytesPerRow && level.byteLength === other.byteLength
        && bytesEqual(level.data, other.data); });
}

export function packetResidencyIdentity(kind: StreamedResourceKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function snapshotBatch(source: PreparedBatch): PreparedBatch {
  return Object.freeze({ key: source.key, geometry: source.geometry, mirrored: source.mirrored,
    doubleSided: source.doubleSided, alphaMode: source.alphaMode, count: source.count,
    instanceIds: Object.freeze(source.instanceIds.slice()), data: source.data.slice(),
    ...(source.sortCenter ? { sortCenter: Object.freeze([...source.sortCenter]) as readonly [number, number, number] } : {}),
    ...(source.textures ? { textures: snapshotTextures(source.textures) } : {}),
    ...(source.lod ? { lod: Object.freeze({ ...source.lod,
      levels: Object.freeze(source.lod.levels.map(level => Object.freeze({ ...level }))) }) } : {}),
  });
}

function snapshotTextures(source: PreparedMaterialTextures): PreparedMaterialTextures {
  const slot = <T extends PreparedTextureSlot>(value: T | undefined): T | undefined => value && Object.freeze({
    ...value, uvTransform: Object.freeze([...value.uvTransform]) as T["uvTransform"],
  });
  return Object.freeze({ emissiveStrength: source.emissiveStrength,
    ...(source.baseColor ? { baseColor: slot(source.baseColor)! } : {}),
    ...(source.metallicRoughness ? { metallicRoughness: slot(source.metallicRoughness)! } : {}),
    ...(source.normal ? { normal: slot(source.normal)! } : {}),
    ...(source.occlusion ? { occlusion: slot(source.occlusion)! } : {}),
    ...(source.emissive ? { emissive: slot(source.emissive)! } : {}),
  });
}

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return a.every((value, index) => value === b[index]);
}
function optionalBytesEqual(left: ArrayBufferView | undefined, right: ArrayBufferView | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && bytesEqual(left, right);
}
