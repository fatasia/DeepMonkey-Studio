import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "./materialInstanceAbi.js";
import { bakeRenderPacket, type DeepBakeOptions, type DeepBakeResult } from "./assetBakePlan.js";
import { prepareRenderPacket } from "./renderPacket.js";
import type { PreparedAuthorSelectedLodProfile, PreparedBatch, PreparedLodLevel, PreparedPacket, RenderPacket } from "./renderPacketTypes.js";
import { compilePacketBoundsHlod, type PacketBoundsHlodEvidence, type PacketBoundsHlodOptions } from "./packetBoundsHlod.js";

export { compilePacketBoundsHlod } from "./packetBoundsHlod.js";
export type { PacketBoundsHlodEvidence, PacketBoundsHlodOptions, PacketBoundsHlodResult } from "./packetBoundsHlod.js";

const DEFAULT_INPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MESHLETS = 4_000_000;

export interface DeepBakeResidencyOptions extends DeepBakeOptions {
  readonly boundsHlod?: PacketBoundsHlodOptions;
  readonly maxInputBytes?: number;
  readonly maxMeshlets?: number;
  readonly signal?: AbortSignal;
}
export interface DeepBakedResidencyLevel extends PreparedLodLevel {
  readonly meshletOffset: number;
  readonly meshletCount: number;
  readonly meshletHash: string;
}
export interface DeepBakedScreenSpaceResidencyBatch {
  readonly strategy?: "screen-space";
  readonly key: string;
  readonly fallbackGeometry: string;
  readonly levels: readonly DeepBakedResidencyLevel[];
}
export interface DeepBakedAuthorResidencyBatch {
  readonly strategy: "author-selected";
  readonly key: string;
  readonly revision: number;
  readonly selectedLevels: readonly number[];
  readonly fallbackGeometry?: never;
  readonly levels: readonly (PreparedAuthorSelectedLodProfile["levels"][number] & {
    readonly meshletOffset: number; readonly meshletCount: number; readonly meshletHash: string;
  })[];
}
export type DeepBakedResidencyBatch = DeepBakedScreenSpaceResidencyBatch | DeepBakedAuthorResidencyBatch;
export interface DeepBakedResidencyPacket {
  readonly packet: PreparedPacket;
  readonly bake: DeepBakeResult;
  readonly batches: readonly DeepBakedResidencyBatch[];
  readonly sourceHash: string;
  readonly cacheKey: string;
  readonly boundsHlod?: PacketBoundsHlodEvidence;
}
export interface DeepBakeCandidateBinding {
  readonly sourceHash: string;
  readonly cacheKey: string;
  readonly geometries: readonly { readonly id: string; readonly revision: number; readonly meshletHash: string; readonly meshletCount: number }[];
}
/** Stable, serializable bake identity attached to a candidate before publication. */
export function bakeCandidateBinding(value: DeepBakedResidencyPacket): DeepBakeCandidateBinding {
  return Object.freeze({ sourceHash: value.sourceHash, cacheKey: value.cacheKey,
    geometries: Object.freeze(value.bake.geometries.map(g => Object.freeze({ id: g.id, revision: g.revision,
      meshletHash: g.meshletHash, meshletCount: g.meshlets.meshletCount }))) });
}

/** Publishes offline meshlet ordering and validated LOD metadata into the existing residency packet ABI. */
export function bakeRenderPacketForResidency(packet: RenderPacket,
  options: DeepBakeResidencyOptions = {}): DeepBakedResidencyPacket {
  validateOptions(options); checkAbort(options.signal);
  const hlod = options.boundsHlod === undefined ? undefined : compilePacketBoundsHlod(packet, options.boundsHlod);
  const compiledPacket = hlod?.packet ?? packet;
  const bytes = inputBytes(compiledPacket);
  const maxInputBytes = bounded(options.maxInputBytes, DEFAULT_INPUT_BYTES, "input byte");
  if (bytes > maxInputBytes) throw new RangeError(`Bake input exceeds its byte budget (${bytes} > ${maxInputBytes}).`);
  const prepared = prepareRenderPacket(compiledPacket, STOCK_MATERIAL_INSTANCE_OPTIONS); checkAbort(options.signal);
  const bake = bakeRenderPacket(compiledPacket, {
    ...(options.quality ? { quality: options.quality } : {}),
    ...(options.recipeVersion ? { recipeVersion: options.recipeVersion } : {}),
  });
  checkAbort(options.signal);
  const meshlets = bake.geometries.reduce((sum, value) => sum + value.meshlets.meshletCount, 0);
  const maxMeshlets = bounded(options.maxMeshlets, DEFAULT_MESHLETS, "meshlet");
  if (meshlets > maxMeshlets) throw new RangeError(`Bake output exceeds its meshlet budget (${meshlets} > ${maxMeshlets}).`);
  const artifacts = new Map(bake.geometries.map(value => [value.id, value]));
  const ranges = meshletRanges(bake);
  const packetGeometries = new Map([...prepared.geometries].map(([id, source]) => {
    const artifact = artifacts.get(id);
    if (!artifact || artifact.revision !== source.revision
      || artifact.indices.indices.length !== source.indices.length) {
      throw new Error(`Baked geometry differs from prepared packet: ${id}.`);
    }
    return [id, Object.freeze({ ...source, indices: artifact.indices.indices })] as const;
  }));
  const packetBatches = Object.freeze(prepared.batches.map((batch): PreparedBatch => {
    if (!batch.lod) return batch;
    if (batch.lod.strategy === "author-selected") return Object.freeze({ ...batch,
      lod: Object.freeze({ ...batch.lod, selectedLevels: Object.freeze([...batch.lod.selectedLevels]),
        levels: Object.freeze(batch.lod.levels.map(level => bakedLevel(level, artifacts, ranges))) }) });
    const levels = Object.freeze(batch.lod.levels.map(level => bakedLevel(level, artifacts, ranges)));
    return Object.freeze({ ...batch, lod: Object.freeze({ ...batch.lod, levels }) });
  }));
  const packetValue = Object.freeze({ ...prepared, geometries: packetGeometries, batches: packetBatches });
  const batches = Object.freeze(packetValue.batches.map((batch): DeepBakedResidencyBatch => {
    if (batch.lod?.strategy === "author-selected") return Object.freeze({ key: batch.key,
      strategy: "author-selected", revision: batch.lod.revision,
      selectedLevels: Object.freeze([...batch.lod.selectedLevels]),
      levels: Object.freeze(batch.lod.levels.map(level => bakedEvidence(level, artifacts, ranges))) });
    const levels = batch.lod?.levels ?? [singleLevel(batch.geometry,
      packetValue.geometries.get(batch.geometry)!.indices.length / 3)];
    const mapped = Object.freeze(levels.map(level => bakedEvidence(level, artifacts, ranges)));
    const fallback = mapped.at(-1)!;
    if (!fallback.resident) throw new Error(`Baked LOD fallback is unavailable: ${batch.key}.`);
    return Object.freeze({ key: batch.key, fallbackGeometry: fallback.geometry, levels: mapped });
  }));
  const sourceHash = hashPacket(compiledPacket);
  const planHash = hashText(`${sourceHash}\u0000${bake.cacheKey}\u0000${stableJson(batches)}`);
  return Object.freeze({ packet: packetValue, bake, batches, sourceHash,
    ...(hlod ? { boundsHlod: hlod.evidence } : {}),
    cacheKey: `deep.bake-residency.v1:${planHash}` });
}

function bakedLevel<T extends { readonly geometry: string }>(level: T,
  artifacts: ReadonlyMap<string, DeepBakeResult["geometries"][number]>,
  ranges: ReadonlyMap<string, { readonly offset: number }>): T & { readonly meshletOffset: number; readonly meshletCount: number } {
  const artifact = artifacts.get(level.geometry), range = ranges.get(level.geometry);
  if (!artifact || !range) throw new Error(`Baked LOD geometry is unavailable: ${level.geometry}.`);
  return Object.freeze({ ...level, meshletOffset: range.offset,
    meshletCount: artifact.meshlets.meshletCount });
}
function bakedEvidence<T extends { readonly geometry: string }>(level: T,
  artifacts: ReadonlyMap<string, DeepBakeResult["geometries"][number]>,
  ranges: ReadonlyMap<string, { readonly offset: number }>): T & { readonly meshletOffset: number; readonly meshletCount: number; readonly meshletHash: string } {
  const artifact = artifacts.get(level.geometry);
  if (!artifact) throw new Error(`Baked LOD geometry is unavailable: ${level.geometry}.`);
  return Object.freeze({ ...bakedLevel(level, artifacts, ranges), meshletHash: artifact.meshletHash });
}

function meshletRanges(bake: DeepBakeResult): ReadonlyMap<string, { readonly offset: number }> {
  const result = new Map<string, { readonly offset: number }>(); let offset = 0;
  for (const item of [...bake.geometries].sort((a, b) => compare(a.id, b.id))) {
    result.set(item.id, Object.freeze({ offset })); offset += item.meshlets.meshletCount;
  }
  return result;
}
function singleLevel(geometry: string, triangles: number): PreparedLodLevel {
  return Object.freeze({ geometry, minProjectedDiameterPixels: 0,
    geometricError: 0, triangles, resident: true });
}
function validateOptions(options: DeepBakeResidencyOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Invalid bake residency options.");
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== "boolean"
    || typeof options.signal.addEventListener !== "function")) throw new TypeError("Invalid bake AbortSignal.");
}
function bounded(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Bake ${label} budget must be a positive safe integer.`);
  }
  return result;
}
function checkAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : "Asset bake was aborted.",
    signal.reason === undefined ? undefined : { cause: signal.reason });
  error.name = "AbortError"; throw error;
}

function inputBytes(packet: RenderPacket): number {
  let bytes = 0;
  for (const value of packet.geometries) bytes += value.vertices.byteLength + value.indices.byteLength
    + (value.uv0?.byteLength ?? 0) + (value.uv1?.byteLength ?? 0) + (value.tangents?.byteLength ?? 0);
  for (const value of packet.textures ?? []) {
    bytes += value.data.byteLength;
    for (const mip of value.mipmaps ?? []) bytes += mip.data.byteLength;
  }
  for (const value of packet.instances) bytes += value.transform.length * 8;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Bake input byte count overflowed.");
  return bytes;
}

function hashPacket(packet: RenderPacket): string {
  let hash = 0xcbf29ce484222325n;
  const byte = (value: number): void => { hash ^= BigInt(value); hash = BigInt.asUintN(64, hash * 0x100000001b3n); };
  const word = (value: number): void => { for (let shift = 0; shift < 8; shift++) byte(Math.floor(value / 2 ** (shift * 8)) & 255); };
  const text = (value: string): void => { const data = new TextEncoder().encode(value); word(data.length); data.forEach(byte); };
  const view = (value: ArrayBufferView): void => { word(value.byteLength);
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).forEach(byte); };
  for (const geometry of packet.geometries) { text(geometry.id); word(geometry.revision); view(geometry.vertices);
    view(geometry.indices); for (const value of [geometry.uv0, geometry.uv1, geometry.tangents, geometry.colors]) value ? view(value) : word(0); }
  text(stableJson(packet.materials));
  for (const instance of packet.instances) { text(instance.id); text(instance.geometry); text(instance.material);
    text(stableJson(Array.from(instance.transform))); text(stableJson(instance.lod ?? null)); }
  for (const texture of packet.textures ?? []) { text(texture.id); word(texture.revision); text(texture.semantic);
    text(texture.compression ?? ""); word(texture.width); word(texture.height); word(texture.bytesPerRow ?? 0);
    text(stableJson(texture.sampler ?? null)); view(texture.data);
    for (const mip of texture.mipmaps ?? []) { word(mip.width); word(mip.height);
      word(mip.bytesPerRow ?? 0); view(mip.data); } }
  return hash.toString(16).padStart(16, "0");
}
function hashText(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return hash.toString(16).padStart(16, "0");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
