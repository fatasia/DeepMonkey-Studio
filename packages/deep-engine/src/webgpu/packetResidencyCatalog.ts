import { geometryGpuByteLength, validateGeometries } from "../renderPacketGeometry.js";
import type { GeometryResource, PreparedPacket } from "../renderPacketTypes.js";
import type { GpuResidencyUploadRequest } from "../streaming/index.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { GpuRenderResidencySource } from "./gpuRenderResidencyUploader.js";
import type {
  GpuRenderResidencyProfile,
  GpuRenderResidencyRequest,
} from "./gpuRenderResidencyRuntime.js";

export interface PacketResidencyRegistrar {
  register(profile: GpuRenderResidencyProfile): void;
}

export interface PacketResidencyCatalog {
  readonly profiles: readonly GpuRenderResidencyProfile[];
  /** Finest complete packet dependency closure; frame-specific policy may replace it. */
  readonly requests: readonly GpuRenderResidencyRequest[];
  readonly sourceFor: (request: GpuResidencyUploadRequest) => GpuRenderResidencySource;
  registerInto(target: PacketResidencyRegistrar): void;
}

/** Snapshots one prepared packet into runtime profiles and strongly checked upload sources. */
export function createPacketResidencyCatalog(packet: PreparedPacket): PacketResidencyCatalog {
  if (!packet || typeof packet !== "object") throw new TypeError("Prepared packet is invalid.");
  const geometries = snapshotGeometries(packet.geometries);
  const textures = snapshotTextures(packet.textures);
  return catalogFromSources(packet, geometries, textures);
}

/** Internal zero-copy path for a caller-owned private snapshot. */
export function createPacketResidencyCatalogFromSnapshot(packet: PreparedPacket): PacketResidencyCatalog {
  if (!packet || typeof packet !== "object") throw new TypeError("Prepared packet is invalid.");
  if (!(packet.geometries instanceof Map)) throw new TypeError("Prepared packet geometry map is invalid.");
  for (const [key, source] of packet.geometries) {
    validateIdentity(source?.id, source?.revision, "geometry");
    if (key !== source.id) throw new Error(`Invalid prepared geometry identity: ${key}.`);
  }
  validateGeometries(packet.geometries);
  const textures = indexTrustedTextures(packet.textures);
  return catalogFromSources(packet, packet.geometries, textures);
}

function catalogFromSources(packet: PreparedPacket,
  geometries: ReadonlyMap<string, GeometryResource>,
  textures: ReadonlyMap<string, PreparedTexture>): PacketResidencyCatalog {
  validateDependencies(packet, geometries, textures);
  const profiles = Object.freeze([
    ...Array.from(geometries.values(), geometryProfile),
    ...Array.from(textures.values(), textureProfile),
  ]);
  const requests = Object.freeze(profiles.map(profile => Object.freeze({
    id: profile.id,
    kind: profile.kind,
    desiredLevel: 0,
    required: true,
  })));

  const sourceFor = (request: GpuResidencyUploadRequest): GpuRenderResidencySource => {
    validateUploadRequest(request);
    if (request.kind === "geometry") {
      const source = geometries.get(request.id);
      if (!source) throw unknownSource(request);
      const byteLength = geometryGpuByteLength(source);
      validateVariant(request, source.revision, 0, byteLength);
      return Object.freeze({ kind: "geometry", source });
    }
    const source = textures.get(request.id);
    if (!source) throw unknownSource(request);
    const suffix = textureSuffix(source, request.level);
    validateVariant(request, source.revision, request.level, suffix.byteLength);
    return Object.freeze({ kind: "texture", source: Object.freeze({ level: request.level, texture: suffix }) });
  };

  return Object.freeze({ profiles, requests, sourceFor,
    registerInto(target: PacketResidencyRegistrar): void {
      if (!target || typeof target.register !== "function") {
        throw new TypeError("Packet residency registration target is invalid.");
      }
      for (const profile of profiles) target.register(profile);
    },
  });
}

function indexTrustedTextures(values: readonly PreparedTexture[]): ReadonlyMap<string, PreparedTexture> {
  if (!Array.isArray(values as unknown)) throw new TypeError("Prepared packet texture list is invalid.");
  const result = new Map<string, PreparedTexture>();
  for (const source of values) {
    validateIdentity(source?.id, source?.revision, "texture");
    if (result.has(source.id)) throw new Error(`Duplicate prepared texture identity: ${source.id}.`);
    validateTextureLevels(source, source.levels); result.set(source.id, source);
  }
  return result;
}

function snapshotGeometries(values: ReadonlyMap<string, GeometryResource>): ReadonlyMap<string, GeometryResource> {
  if (!(values instanceof Map)) throw new TypeError("Prepared packet geometry map is invalid.");
  const result = new Map<string, GeometryResource>();
  for (const [key, source] of values) {
    validateIdentity(source?.id, source?.revision, "geometry");
    if (key !== source.id || result.has(source.id)) throw new Error(`Invalid prepared geometry identity: ${key}.`);
    result.set(source.id, Object.freeze({ id: source.id, revision: source.revision,
      vertices: source.vertices.slice(),
      ...(source.uv0 ? { uv0: source.uv0.slice() } : {}),
      ...(source.uv1 ? { uv1: source.uv1.slice() } : {}),
      ...(source.tangents ? { tangents: source.tangents.slice() } : {}),
      indices: source.indices.slice(),
    }));
  }
  validateGeometries(result);
  return result;
}

function snapshotTextures(values: readonly PreparedTexture[]): ReadonlyMap<string, PreparedTexture> {
  if (!Array.isArray(values as unknown)) throw new TypeError("Prepared packet texture list is invalid.");
  const result = new Map<string, PreparedTexture>();
  for (const source of values) {
    validateIdentity(source?.id, source?.revision, "texture");
    if (result.has(source.id)) throw new Error(`Duplicate prepared texture identity: ${source.id}.`);
    const levels = Object.freeze(source.levels.map(level => Object.freeze({
      width: level.width, height: level.height, bytesPerRow: level.bytesPerRow,
      byteLength: level.byteLength, data: level.data.slice(),
    })));
    validateTextureLevels(source, levels);
    result.set(source.id, Object.freeze({ ...source, levels,
      sampler: Object.freeze({ ...source.sampler }),
    }));
  }
  return result;
}

function geometryProfile(source: GeometryResource): GpuRenderResidencyProfile {
  return Object.freeze({ id: source.id, revision: source.revision, kind: "geometry",
    levels: Object.freeze([Object.freeze({ level: 0, byteLength: geometryGpuByteLength(source),
      sourceId: source.id })]),
  });
}

function textureProfile(source: PreparedTexture): GpuRenderResidencyProfile {
  let suffixBytes = 0;
  const levels = new Array(source.levels.length);
  for (let level = source.levels.length - 1; level >= 0; level -= 1) {
    suffixBytes += source.levels[level]!.byteLength;
    levels[level] = Object.freeze({ level, byteLength: suffixBytes, sourceId: source.id });
  }
  return Object.freeze({ id: source.id, revision: source.revision, kind: "texture",
    levels: Object.freeze(levels.slice(0, independentTextureLevelCount(source))),
  });
}

function textureSuffix(source: PreparedTexture, level: number): PreparedTexture {
  if (!Number.isSafeInteger(level) || level < 0 || level >= independentTextureLevelCount(source)) {
    throw new Error(`Unknown texture residency level: ${source.id}:${level}.`);
  }
  const levels = Object.freeze(source.levels.slice(level));
  const byteLength = levels.reduce((sum, value) => sum + value.byteLength, 0);
  return Object.freeze({ ...source, levels, byteLength });
}

function independentTextureLevelCount(source: PreparedTexture): number {
  if (source.format === "rgba8unorm" || source.format === "rgba8unorm-srgb") return source.levels.length;
  let count = 0;
  for (const level of source.levels) {
    if (level.width % 4 !== 0 || level.height % 4 !== 0) break;
    count += 1;
  }
  if (!count) throw new Error(`Compressed texture has no independently uploadable level: ${source.id}.`);
  return count;
}

function validateTextureLevels(source: PreparedTexture,
  levels: PreparedTexture["levels"]): void {
  if (!levels.length) throw new Error(`Prepared texture has no levels: ${source.id}.`);
  let bytes = 0;
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]!, previous = levels[index - 1];
    if (!Number.isSafeInteger(level.width) || level.width < 1
      || !Number.isSafeInteger(level.height) || level.height < 1
      || !Number.isSafeInteger(level.bytesPerRow) || level.bytesPerRow < 1
      || !Number.isSafeInteger(level.byteLength) || level.byteLength < 1
      || !(level.data instanceof Uint8Array) || !(level.data.buffer instanceof ArrayBuffer)
      || level.data.byteLength !== level.byteLength) {
      throw new Error(`Invalid prepared texture level: ${source.id}:${index}.`);
    }
    if (previous && (level.width !== Math.max(1, Math.floor(previous.width / 2))
      || level.height !== Math.max(1, Math.floor(previous.height / 2)))) {
      throw new Error(`Invalid prepared texture mip chain: ${source.id}.`);
    }
    bytes += level.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new Error(`Prepared texture is too large: ${source.id}.`);
  }
  const last = levels[levels.length - 1]!;
  if ((levels.length > 1 && (last.width !== 1 || last.height !== 1)) || bytes !== source.byteLength) {
    throw new Error(`Invalid prepared texture byte length: ${source.id}.`);
  }
}

function validateDependencies(packet: PreparedPacket, geometries: ReadonlyMap<string, GeometryResource>,
  textures: ReadonlyMap<string, PreparedTexture>): void {
  if (!Array.isArray(packet.batches as unknown)) throw new TypeError("Prepared packet batch list is invalid.");
  for (const batch of packet.batches) {
    const geometryIds = batch.lod?.levels.map(level => level.geometry) ?? [batch.geometry];
    for (const id of geometryIds) if (!geometries.has(id)) throw new Error(`Missing prepared geometry dependency: ${id}.`);
    const slots = batch.textures && [batch.textures.baseColor, batch.textures.metallicRoughness,
      batch.textures.normal, batch.textures.occlusion, batch.textures.emissive];
    for (const slot of slots || []) if (slot && !textures.has(slot.texture)) {
      throw new Error(`Missing prepared texture dependency: ${slot.texture}.`);
    }
  }
}

function validateIdentity(id: string | undefined, revision: number | undefined, kind: string): void {
  if (typeof id !== "string" || !id.trim() || id.length > 256
    || !Number.isSafeInteger(revision) || revision! < 0) throw new Error(`Invalid prepared ${kind} identity.`);
}

function validateUploadRequest(request: GpuResidencyUploadRequest): void {
  if (!request || (request.kind !== "geometry" && request.kind !== "texture")
    || typeof request.id !== "string" || !request.id.trim()
    || !Number.isSafeInteger(request.revision) || request.revision < 0
    || !Number.isSafeInteger(request.level) || request.level < 0
    || !Number.isSafeInteger(request.expectedByteLength) || request.expectedByteLength < 1) {
    throw new TypeError("GPU residency upload request is invalid.");
  }
}

function validateVariant(request: GpuResidencyUploadRequest, revision: number,
  level: number, byteLength: number): void {
  if (request.revision !== revision || request.level !== level || request.expectedByteLength !== byteLength) {
    throw new Error(`GPU residency source variant differs from request: ${request.kind}:${request.id}.`);
  }
}

function unknownSource(request: GpuResidencyUploadRequest): Error {
  return new Error(`Unknown GPU residency source: ${request.kind}:${request.id}.`);
}
