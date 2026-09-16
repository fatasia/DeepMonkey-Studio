import { prepareInstanceUpdate, prepareRenderPacket, type GeometryResource, type PreparedBatch, type PreparedPacket, type RenderPacket } from "../renderPacket.js";
import { geometryFeatureMap } from "../renderPacketGeometry.js";
import { LooseOctreeIndex } from "../spatial/looseOctree.js";
import type { SpatialAabb } from "../spatial/types.js";
import { cameraFrustum } from "../webgpu/pbrFrusta.js";
import { resolvePbrCameraProjection } from "../webgpu/pbrFrameUniforms.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import { sceneChunkBatchIdentity } from "../webgpu/sceneChunkRevision.js";
import type { SceneChunkResidencyDemand } from "../webgpu/sceneChunkResidency.js";

export const AUTHOR_CHUNK_CPU_BYTES = 128 * 1024 * 1024;
interface Chunk { readonly key: string; readonly initial: PreparedBatch; readonly packet: PreparedPacket; readonly local: SpatialAabb }

/** Derived packet catalog only; author object identity, visibility and simulation remain owned by Three. */
export class AuthorChunkCatalog {
  readonly prepared: PreparedPacket;
  readonly chunks: readonly Chunk[];
  readonly cpuBytes: number;
  private readonly features;
  private readonly textureSemantics;
  private readonly identities = new Map<string, Chunk>();
  private readonly index = new LooseOctreeIndex<string>({ bounds: { min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] }, maxEntries: 16_384 });
  private updates = new Map<string, PreparedBatch>();
  constructor(packet: RenderPacket) {
    if (packet.deformation) throw new Error("Author chunk catalog does not accept deformation.");
    const initialBytes = packet.geometries.reduce((sum, value) => sum + geometryBytes(value), 0)
      + (packet.textures ?? []).reduce((sum, value) => sum + value.data.byteLength + (value.mipmaps ?? []).reduce((total, mip) => total + mip.data.byteLength, 0), 0);
    if (initialBytes > AUTHOR_CHUNK_CPU_BYTES / 2) throw new Error("Author chunk CPU snapshot budget exceeded.");
    this.prepared = prepareRenderPacket(packet);
    this.features = geometryFeatureMap(this.prepared.geometries);
    this.textureSemantics = new Map(this.prepared.textures.map(value => [value.id, value.semantic]));
    const bounds = new Map([...this.prepared.geometries].map(([id, source]) => [id, geometryBounds(source)]));
    let bytes = initialBytes;
    this.chunks = this.prepared.batches.map((batch, ordinal) => {
      const ids = [...new Set(batch.lod?.levels.map(level => level.geometry) ?? [batch.geometry])];
      const geometries = new Map(ids.map(id => [id, this.prepared.geometries.get(id)!]));
      const textureIds = new Set(Object.values(batch.textures ?? {}).flatMap(slot => typeof slot === "object" ? [slot.texture] : []));
      const textures = this.prepared.textures.filter(value => textureIds.has(value.id));
      bytes += [...geometries.values()].reduce((sum, value) => sum + geometryBytes(value), 0)
        + textures.reduce((sum, value) => sum + value.byteLength, 0) + batch.data.byteLength * 2;
      if (bytes > AUTHOR_CHUNK_CPU_BYTES) throw new Error("Author chunk CPU snapshot budget exceeded.");
      const chunk: Chunk = { key: `author-chunk-${ordinal}`, initial: batch,
        packet: { geometries, textures, batches: [batch] }, local: union(ids.map(id => bounds.get(id)!)) };
      const identity = sceneChunkBatchIdentity(batch);
      if (this.identities.has(identity)) throw new Error("Author chunk batch identity is ambiguous.");
      this.identities.set(identity, chunk); this.index.insert(chunk.key, worldBounds(chunk.local, batch));
      this.updates.set(batch.key, batch); return chunk;
    });
    this.cpuBytes = bytes;
  }
  update(packet: RenderPacket): boolean {
    const batches = prepareInstanceUpdate(this.features, packet, this.textureSemantics);
    if (batches.length !== this.chunks.length) return false;
    const updates = new Map<string, PreparedBatch>(), boxes: [Chunk, SpatialAabb][] = [];
    for (const batch of batches) {
      const chunk = this.identities.get(sceneChunkBatchIdentity(batch));
      if (!chunk || updates.has(chunk.initial.key)) return false;
      updates.set(chunk.initial.key, batch); boxes.push([chunk, worldBounds(chunk.local, batch)]);
    }
    for (const [chunk, box] of boxes) this.index.update(chunk.key, box);
    this.updates = updates; return true;
  }
  get batchUpdates(): ReadonlyMap<string, PreparedBatch> { return this.updates; }
  restoreBatchUpdates(updates: ReadonlyMap<string, PreparedBatch>): void {
    for (const chunk of this.chunks) this.index.update(chunk.key, worldBounds(chunk.local, updates.get(chunk.initial.key)!));
    this.updates = new Map(updates);
  }
  demand(view: RenderView): readonly SceneChunkResidencyDemand[] {
    const projection = resolvePbrCameraProjection(view), aspect = view.width / view.height;
    const visible = this.index.queryFrustum(cameraFrustum(view.eye, view.target, view.up, aspect, projection));
    const ahead = this.index.queryFrustum(cameraFrustum(view.eye, view.target, view.up, aspect,
      { ...projection, verticalFovRadians: Math.min(Math.PI - 0.001, projection.verticalFovRadians * 1.25), far: projection.far * 1.25 }));
    if (visible.truncated || ahead.truncated) throw new Error("Author chunk spatial query was truncated.");
    const visibleIds = new Set(visible.ids), aheadIds = new Set(ahead.ids);
    return this.chunks.flatMap(chunk => {
      // Until light-volume residency is proven, every potential caster remains required.
      const batch = this.updates.get(chunk.initial.key)!;
      const required = batch.castShadow !== false || visibleIds.has(chunk.key);
      if (!required && !aheadIds.has(chunk.key)) return [];
      return [{ key: chunk.key, mode: required ? "visible" as const : "prefetch" as const,
        demands: [{ batchKey: chunk.initial.key }] }];
    });
  }
}

function geometryBytes(source: GeometryResource): number {
  return source.vertices.byteLength + source.indices.byteLength + (source.uv0?.byteLength ?? 0)
    + (source.uv1?.byteLength ?? 0) + (source.tangents?.byteLength ?? 0);
}
function geometryBounds(source: GeometryResource): SpatialAabb {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const index of source.indices) for (let axis = 0; axis < 3; axis++) {
    const value = source.vertices[index * 6 + axis]!; min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
  }
  return { min: min as [number, number, number], max: max as [number, number, number] };
}
function union(values: readonly SpatialAabb[]): SpatialAabb {
  return { min: [0, 1, 2].map(axis => Math.min(...values.map(value => value.min[axis]!))) as [number, number, number],
    max: [0, 1, 2].map(axis => Math.max(...values.map(value => value.max[axis]!))) as [number, number, number] };
}
function worldBounds(local: SpatialAabb, batch: PreparedBatch): SpatialAabb {
  const center = local.min.map((value, axis) => (value + local.max[axis]!) / 2);
  const half = local.min.map((value, axis) => (local.max[axis]! - value) / 2);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let instance = 0; instance < batch.count; instance++) for (let axis = 0; axis < 3; axis++) {
    const offset = instance * 36 + axis * 4, row = batch.data;
    const c = row[offset]! * center[0]! + row[offset + 1]! * center[1]! + row[offset + 2]! * center[2]! + row[offset + 3]!;
    const h = Math.abs(row[offset]!) * half[0]! + Math.abs(row[offset + 1]!) * half[1]! + Math.abs(row[offset + 2]!) * half[2]!;
    min[axis] = Math.min(min[axis]!, c - h); max[axis] = Math.max(max[axis]!, c + h);
  }
  return { min: min as [number, number, number], max: max as [number, number, number] };
}
