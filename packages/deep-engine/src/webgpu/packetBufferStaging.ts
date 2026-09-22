import {
  assertPacketDeformationSupported,
  geometryCenter,
  type GeometryResource,
  type PreparedBatch,
  type PreparedPacket,
} from "../renderPacket.js";
import { DEEP_PBR_MESH_V1_BYTE_SIZES } from "../shaderAbi/index.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  type MaterialBindingPool,
  materialBindingMatches,
  type MaterialBinding,
} from "./materialBindings.js";
import { MeshBuffers, uploadBuffer } from "./meshBuffers.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { packPreviousTransforms } from "./packetInstanceHistory.js";
import { TextureResources, type StagedTextureSet, type TextureBinding } from "./textureResources.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { PacketDeformationResources } from "./packetDeformationResources.js";
import type { DeformationStaticSources } from "./deformationStaticSources.js";
import type { DeformationSnapshot } from "../deformation/types.js";
import { assertSnapshotRevisions } from "./packetDeformationRevision.js";
import { prepareDeformationBounds, type DeformationBoundsProfile } from "./deformationBounds.js";
import { authorLodMetadataChanged } from "./authorLodMetadata.js";
import { PACKET_MESHLET_STAGE_BYTES } from "./packetMeshletSource.js";

export interface StagedPacketBuffers {
  readonly deformation?: PacketDeformationResources;
  readonly deformationSnapshot?: DeformationSnapshot;
  readonly deformationBoundsProfiles?: ReadonlyMap<string, DeformationBoundsProfile>;
  readonly geometries: Map<string, CachedPacketGeometry>;
  readonly batches: Map<string, CachedPacketBatch>;
  readonly createdMeshes: MeshBuffers[];
  readonly createdBuffers: GPUBuffer[];
  readonly acquiredMaterials: MaterialBinding[];
  readonly textures: StagedTextureSet;
  readonly changed: boolean;
  settled: boolean;
}

export interface PacketBufferStagingContext {
  readonly meshletsEnabled?: boolean;
  /** P0-2 opt-in：author 几何同时构建可见性无共享布局（默认关，零额外显存）。 */
  readonly meshletVisibility?: boolean;
  readonly deformationStaticSources?: DeformationStaticSources;
  /** Only an executor that submits deformation before drawing may opt in. */
  readonly deformationEnabled?: boolean;
  readonly deformationSnapshot?: DeformationSnapshot;
  readonly session: DeviceSession;
  readonly materials: MaterialBindingPool;
  readonly textures: TextureResources;
  readonly geometries: ReadonlyMap<string, CachedPacketGeometry>;
  readonly batches: ReadonlyMap<string, CachedPacketBatch>;
}

export function stagePacketBuffers(
  context: PacketBufferStagingContext,
  prepared: PreparedPacket,
  decorateBatches?: (textures: StagedTextureSet, batches: readonly PreparedBatch[]) => readonly PreparedBatch[],
  stagedBinding?: (textures: StagedTextureSet, id: string) => TextureBinding,
  omitTextureStorage?: ReadonlySet<string>,
): StagedPacketBuffers {
  assertPacketDeformationSupported(prepared, context?.deformationEnabled === true);
  if (prepared.deformation) assertSnapshotRevisions(prepared.deformation, context.deformationSnapshot);
  const geometries = new Map<string, CachedPacketGeometry>();
  const batches = new Map<string, CachedPacketBatch>();
  const createdMeshes: MeshBuffers[] = [];
  const createdBuffers: GPUBuffer[] = [];
  const acquiredMaterials: MaterialBinding[] = [];
  const textures = context.textures.stagePrepared(prepared.textures, omitTextureStorage);
  let deformation: PacketDeformationResources | undefined;
  const deformationBoundsProfiles = new Map<string, DeformationBoundsProfile>();
  try {
    const preparedBatches = decorateBatches?.(textures, prepared.batches) ?? prepared.batches;
    if (prepared.deformation) {
      for (const source of prepared.deformation.sources) deformationBoundsProfiles.set(source.id, prepareDeformationBounds(source));
      deformation = new PacketDeformationResources(context.session, context.deformationStaticSources);
      deformation.prepare(prepared.deformation, new Map([...prepared.geometries].map(([id, geometry]) => [id, geometry.revision])));
    }
    stageGeometries(context, prepared, geometries, createdMeshes);
    stageBatches(context, { ...prepared, batches: preparedBatches }, textures, batches, createdBuffers, acquiredMaterials,
      stagedBinding);
  } catch (error) {
    try { releaseStage(context, createdMeshes, createdBuffers, acquiredMaterials, textures, deformation); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Packet buffer staging failed.");
    }
    throw error;
  }
  return {
    ...(deformation ? { deformation, deformationSnapshot: prepared.deformation!, deformationBoundsProfiles } : {}),
    geometries,
    batches,
    createdMeshes,
    createdBuffers,
    acquiredMaterials,
    textures,
    settled: false,
    changed: deformation !== undefined || textures.changed || createdMeshes.length > 0 || createdBuffers.length > 0
      || acquiredMaterials.length > 0 || context.batches.size !== batches.size
      || context.geometries.size !== geometries.size || [...batches].some(([key, batch]) => batch !== context.batches.get(key)),
  };
}

export function discardPacketBufferStage(
  context: PacketBufferStagingContext,
  staged: StagedPacketBuffers,
): void {
  if (staged.settled) return;
  staged.settled = true;
  releaseStage(context, staged.createdMeshes, staged.createdBuffers,
    staged.acquiredMaterials, staged.textures, staged.deformation);
}

function stageGeometries(
  context: PacketBufferStagingContext,
  prepared: PreparedPacket,
  target: Map<string, CachedPacketGeometry>,
  created: MeshBuffers[],
): void {
  const meshletBudget: { remainingBytes: number; visibility?: boolean } = { remainingBytes: PACKET_MESHLET_STAGE_BYTES };
  if (context.meshletVisibility) meshletBudget.visibility = true;
  for (const [id, source] of prepared.geometries) {
    const prior = context.geometries.get(id);
    if (prior?.source.revision === source.revision) meshletBudget.remainingBytes -= prior.mesh.meshletSource?.budgetBytes ?? 0;
  }
  const authorGeometries = new Set(prepared.batches.flatMap(batch => batch.lod?.strategy === "author-selected" ? batch.lod.levels.map(level => level.geometry) : []));
  for (const [id, source] of prepared.geometries) {
    const previous = context.geometries.get(id);
    if (previous && source.revision < previous.source.revision) {
      throw new Error(`Stale geometry revision: ${id}`);
    }
    if (previous && source.revision === previous.source.revision) {
      if (source !== previous.source && !sameGeometry(source, previous.source)) {
        throw new Error(`Geometry content changed without a revision: ${id}`);
      }
      target.set(id, previous);
      continue;
    }
    validateGeometrySize(context.session, source);
    const mesh = new MeshBuffers(context.session, source, context.meshletsEnabled && authorGeometries.has(id) ? meshletBudget : undefined);
    created.push(mesh);
    target.set(id, { source, mesh, ...geometryBounds(source) });
  }
}

function stageBatches(
  context: PacketBufferStagingContext,
  prepared: PreparedPacket,
  textures: StagedTextureSet,
  target: Map<string, CachedPacketBatch>,
  createdBuffers: GPUBuffer[],
  acquiredMaterials: MaterialBinding[],
  stagedBinding?: (textures: StagedTextureSet, id: string) => TextureBinding,
): void {
  for (const source of prepared.batches) {
    const previous = context.batches.get(source.key);
    const metadataChanged = authorLodMetadataChanged(previous?.source, source);
    const lookup = (id: string) => stagedBinding?.(textures, id) ?? context.textures.stagedBinding(textures, id);
    const sameMaterial = materialBindingMatches(previous?.material, source.textures, lookup);
    if (previous && equal(previous.source.data, source.data) && sameMaterial) {
      target.set(source.key, metadataChanged ? { ...previous, source } : previous);
      continue;
    }
    const material = sameMaterial
      ? previous?.material
      : context.materials.acquire(source.textures, lookup);
    if (material && material !== previous?.material) acquiredMaterials.push(material);
    if (source.data.byteLength > context.session.device.limits.maxBufferSize) {
      throw new Error("Instances exceed device buffer limit.");
    }
    const buffer = uploadBuffer(context.session, "Deep packet instances", source.data,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    createdBuffers.push(buffer);
    const previousTransforms = packPreviousTransforms(source);
    const previousBuffer = uploadBuffer(
      context.session,
      "Deep packet previous transforms",
      previousTransforms,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
    );
    createdBuffers.push(previousBuffer);
    target.set(source.key, {
      source,
      buffer,
      capacity: source.data.byteLength,
      previousBuffer,
      previousCapacity: previousTransforms.byteLength,
      previousTransforms,
      ...(material ? { material } : {}),
    });
  }
}

function validateGeometrySize(session: DeviceSession, source: GeometryResource): void {
  const max = session.device.limits.maxBufferSize;
  const maxVertices = Math.floor(max / DEEP_PBR_MESH_V1_BYTE_SIZES.geometryVertex);
  if (source.vertices.length / 6 > maxVertices
    || (source.tangents?.byteLength ?? 0) > max
    || (source.colors?.byteLength ?? 0) > max
    || source.indices.byteLength > max) {
    throw new Error("Geometry exceeds device buffer limit.");
  }
}

function sameGeometry(a: GeometryResource, b: GeometryResource): boolean {
  return equal(a.vertices, b.vertices)
    && equalOptional(a.uv0, b.uv0)
    && equalOptional(a.uv1, b.uv1)
    && equalOptional(a.tangents, b.tangents)
    && equalOptional(a.colors, b.colors)
    && equal(a.indices, b.indices);
}

function geometryBounds(geometry: GeometryResource): {
  center: readonly [number, number, number];
  radius: number;
} {
  const center = geometryCenter(geometry);
  let radius = 0;
  for (const index of geometry.indices) {
    const offset = index * 6;
    radius = Math.max(radius, Math.hypot(
      geometry.vertices[offset]! - center[0],
      geometry.vertices[offset + 1]! - center[1],
      geometry.vertices[offset + 2]! - center[2],
    ));
  }
  return { center, radius: Math.max(radius, 1e-6) };
}

function releaseStage(
  context: PacketBufferStagingContext,
  meshes: readonly MeshBuffers[],
  buffers: readonly GPUBuffer[],
  materials: readonly MaterialBinding[],
  textures: StagedTextureSet,
  deformation?: PacketDeformationResources,
): void {
  runResourceCleanup("Packet buffer stage rollback failed.", [
    () => deformation?.dispose(),
    ...meshes.map(mesh => () => mesh.dispose()),
    ...buffers.map(buffer => () => context.session.release(buffer)),
    ...materials.map(material => () => context.materials.release(material)),
    () => context.textures.discardPrepared(textures),
  ]);
}

const equal = (a: Float32Array | Uint32Array, b: Float32Array | Uint32Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function equalOptional(
  a: Float32Array<ArrayBuffer> | undefined,
  b: Float32Array<ArrayBuffer> | undefined,
): boolean {
  return a === undefined ? b === undefined : b !== undefined && equal(a, b);
}
