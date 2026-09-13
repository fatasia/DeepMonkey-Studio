import type { PreparedPacket } from "../renderPacketTypes.js";
import type { ResidentResourceState, StreamedResourceKind } from "../streaming/index.js";
import type { PacketResidencyCatalog } from "./packetResidencyCatalog.js";
import type {
  GpuRenderResidencyProfile,
  GpuRenderResidencyRequest,
} from "./gpuRenderResidencyRuntime.js";

export interface PacketResidencyClosureFailure {
  readonly kind: StreamedResourceKind;
  readonly id: string;
}

interface ResidencyReader {
  get(kind: StreamedResourceKind, id: string): ResidentResourceState | undefined;
}

/** Returns the first request identity which is outside this packet catalog. */
export function foreignPacketResidencyRequest(
  catalog: PacketResidencyCatalog,
  requests: readonly GpuRenderResidencyRequest[],
): string | undefined {
  const identities = new Set(catalog.profiles.map(profile => identity(profile.kind, profile.id)));
  for (const request of requests) {
    if (!request || typeof request !== "object"
      || (request.kind !== "geometry" && request.kind !== "texture")
      || typeof request.id !== "string"
      || !identities.has(identity(request.kind, request.id))) {
      return request && typeof request === "object"
        ? `${String(request.kind)}:${String(request.id)}`
        : "invalid";
    }
  }
  return undefined;
}

/**
 * Checks actual runtime state against the immutable packet catalog. Partial LOD
 * only relaxes finer/middle geometry; textures, non-LOD meshes and every
 * coarsest fallback remain mandatory.
 */
export function incompletePacketResidency(
  packet: PreparedPacket,
  catalog: PacketResidencyCatalog,
  runtime: ResidencyReader,
  allowPartialLod: boolean,
): PacketResidencyClosureFailure | undefined {
  const required = allowPartialLod
    ? partialRequiredIdentities(packet)
    : new Set(catalog.profiles.map(profile => identity(profile.kind, profile.id)));
  for (const profile of catalog.profiles) {
    const resident = runtime.get(profile.kind, profile.id);
    if ((required.has(identity(profile.kind, profile.id)) || resident !== undefined)
      && !residentMatches(resident, profile)) {
      return Object.freeze({ kind: profile.kind, id: profile.id });
    }
  }
  return undefined;
}

function partialRequiredIdentities(packet: PreparedPacket): Set<string> {
  const required = new Set<string>();
  for (const batch of packet.batches) {
    for (const id of batchTextureIds(batch.textures)) required.add(identity("texture", id));
    if (!batch.lod) {
      required.add(identity("geometry", batch.geometry));
      continue;
    }
    const coarsest = batch.lod.levels.at(-1);
    if (!coarsest || !coarsest.resident) {
      throw new Error(`Prepared LOD coarsest fallback is unavailable: ${batch.key}.`);
    }
    required.add(identity("geometry", coarsest.geometry));
  }
  return required;
}

function batchTextureIds(textures: PreparedPacket["batches"][number]["textures"]): readonly string[] {
  if (!textures) return [];
  return [textures.baseColor, textures.metallicRoughness, textures.normal,
    textures.occlusion, textures.emissive].flatMap(slot => slot ? [slot.texture] : []);
}

function residentMatches(
  resident: ResidentResourceState | undefined,
  profile: GpuRenderResidencyProfile,
): boolean {
  return resident !== undefined
    && resident.kind === profile.kind
    && resident.id === profile.id
    && resident.revision === profile.revision
    && profile.levels.some(level => level.level === resident.level
      && level.byteLength === resident.byteLength);
}

function identity(kind: StreamedResourceKind, id: string): string {
  return `${kind}\u0000${id}`;
}
