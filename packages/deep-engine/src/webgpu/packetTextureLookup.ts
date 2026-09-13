import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { GpuTextureResidencyHandle } from "./gpuTextureResidencyUploader.js";
import type {
  ResidentPacketProjection,
  ResidentPacketTextureRole,
} from "./residentPacketProjection.js";
import { residentPacketProjectionBatches,
  residentPacketProjectionTextureSource } from "./residentPacketProjectionView.js";
import type { TextureBinding } from "./textureResources.js";

/** Minimal texture access used by packet material preparation and updates. */
export interface PacketTextureLookup {
  semanticMap(): ReadonlyMap<string, PreparedTexture["semantic"]>;
  get(id: string): TextureBinding | undefined;
}

const ROLES = Object.freeze([
  "baseColor", "metallicRoughness", "normal", "occlusion", "emissive",
] as const satisfies readonly ResidentPacketTextureRole[]);

const ROLE_SEMANTICS = Object.freeze({
  baseColor: "baseColor",
  metallicRoughness: "metallicRoughness",
  normal: "normal",
  occlusion: "occlusion",
  emissive: "emissive",
} as const satisfies Record<ResidentPacketTextureRole, PreparedTexture["semantic"]>);

/**
 * Snapshots a projection's resident texture bindings. The returned handles are
 * borrowed and remain valid only while the projection keeps its leases.
 */
export function createResidentPacketTextureLookup(
  projection: ResidentPacketProjection,
): PacketTextureLookup {
  if (projection.released) throw new Error("Resident packet projection is already released.");
  const entries = new Map<string, {
    readonly source: PreparedTexture;
    readonly handle: GpuTextureResidencyHandle;
  }>();
  const semantics = new Map<string, PreparedTexture["semantic"]>();

  for (const batch of residentPacketProjectionBatches(projection)) {
    const expected = batch.source.textures;
    const expectedCount = ROLES.reduce((count, role) => count + (expected?.[role] ? 1 : 0), 0);
    if (batch.textures.length !== expectedCount) {
      throw new Error(`Resident packet texture closure is incomplete: ${batch.source.key}.`);
    }
    const seenRoles = new Set<ResidentPacketTextureRole>();
    for (const binding of batch.textures) {
      const role = binding.role;
      const slot = ROLES.includes(role) ? expected?.[role] : undefined;
      if (!slot || slot !== binding.slot || seenRoles.has(role)) {
        throw new Error(`Resident packet texture role is inconsistent: ${batch.source.key}.`);
      }
      seenRoles.add(role);
      const handle = binding.texture;
      const source = residentPacketProjectionTextureSource(projection, handle.id);
      if (!source) throw new Error(`Resident packet texture source is unavailable: ${handle.id}.`);
      const previous = entries.get(handle.id);
      if (previous && (previous.source !== source || previous.handle !== handle)) {
        throw new Error(`Resident packet texture binding is inconsistent: ${handle.id}.`);
      }
      validateBinding(projection, role, slot.texture, source, handle);
      if (!previous) {
        entries.set(handle.id, { source, handle });
        semantics.set(handle.id, source.semantic);
      }
    }
  }
  if (projection.released) throw new Error("Resident packet projection was released while building texture lookup.");

  return Object.freeze({
    semanticMap: (): ReadonlyMap<string, PreparedTexture["semantic"]> => new Map(semantics),
    get: (id: string): TextureBinding | undefined => entries.get(id)?.handle,
  });
}

function validateBinding(
  projection: ResidentPacketProjection,
  role: ResidentPacketTextureRole,
  slotId: string,
  source: PreparedTexture,
  handle: GpuTextureResidencyHandle,
): void {
  const level = handle.level;
  const suffix = Number.isSafeInteger(level) && level >= 0 ? source.levels.slice(level) : [];
  const base = suffix[0];
  let bytes = 0;
  for (let index = 0; index < suffix.length; index += 1) {
    const mip = suffix[index]!;
    const prior = suffix[index - 1];
    if (!Number.isSafeInteger(mip.width) || mip.width < 1
      || !Number.isSafeInteger(mip.height) || mip.height < 1
      || !Number.isSafeInteger(mip.byteLength) || mip.byteLength < 1
      || mip.data.byteLength !== mip.byteLength
      || (prior && (mip.width !== Math.max(1, Math.floor(prior.width / 2))
        || mip.height !== Math.max(1, Math.floor(prior.height / 2))))) {
      throw new Error(`Resident packet texture mip suffix is invalid: ${handle.id}.`);
    }
    bytes += mip.byteLength;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error(`Resident packet texture mip byte length is invalid: ${handle.id}.`);
    }
  }
  if (handle.kind !== "texture" || handle.id !== slotId || source.id !== handle.id
    || projection.texture(handle.id) !== handle
    || handle.revision !== source.revision || handle.semantic !== source.semantic
    || handle.semantic !== ROLE_SEMANTICS[role] || handle.format !== source.format
    || handle.requiredFeature !== source.requiredFeature || !base
    || handle.width !== base.width || handle.height !== base.height
    || handle.mipLevelCount !== suffix.length || handle.byteLength !== bytes
    || !gpuObject(handle.texture) || !gpuObject(handle.view) || !gpuObject(handle.sampler)) {
    throw new Error(`Resident packet texture differs from its prepared source: ${handle.id}.`);
  }
}

function gpuObject(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
