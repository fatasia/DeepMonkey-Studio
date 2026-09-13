import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareRenderPacket,
  type GeometryResource,
  type PreparedPacket,
  type RenderPacket,
} from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuRenderResidencyHandle } from "./gpuRenderResidencyUploader.js";
import { MaterialBindingPool } from "./materialBindings.js";
import type { MeshBuffers } from "./meshBuffers.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import {
  createResidentPacketProjection,
  type ResidentPacketProjection,
} from "./residentPacketProjection.js";
import {
  commitResidentPacketBufferStage,
  discardResidentPacketBufferStage,
  stageResidentPacketBuffers,
  type ResidentPacketBufferPublication,
} from "./residentPacketBufferStaging.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, revision = 1): GeometryResource {
  const fine = id === "fine";
  return { id, revision,
    vertices: new Float32Array(fine
      ? [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]
      : [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array(fine ? [0, 0, 1, 0, 1, 1, 0, 1] : [0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array(fine ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]) };
}

function packet(textured = true): RenderPacket {
  return {
    geometries: [geometry("fine"), geometry("coarse", 2)],
    textures: textured ? [{ id: "base", revision: 4, semantic: "baseColor",
      width: 1, height: 1, data: new Uint8Array([255, 128, 64, 255]) }] : [],
    materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      ...(textured ? { baseColorTexture: { texture: "base" } } : {}) }],
    instances: [{ id: "object", geometry: "fine", material: "material", transform: IDENTITY,
      lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 64, geometricError: 0 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
  };
}

function gpuFixture() {
  const owned = new Set<object>();
  const buffers: Array<GPUBuffer & { label?: string; destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    limits: { maxBufferSize: 1024 * 1024 },
    createBuffer: vi.fn(({ label }: GPUBufferDescriptor) => {
      const buffer = { label, destroy: vi.fn() } as unknown as GPUBuffer
        & { label?: string; destroy: ReturnType<typeof vi.fn> };
      buffers.push(buffer); return buffer;
    }),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor }) as unknown as GPUBindGroup),
    queue: { writeBuffer: vi.fn() },
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(value: T): T { owned.add(value); return value; },
    release(value: { destroy(): void }): void { if (owned.delete(value)) value.destroy(); },
  } as unknown as DeviceSession;
  const materials = new MaterialBindingPool(session, { material: {} as GPUBindGroupLayout });
  return { buffers, device, materials, owned, session };
}

function residentFixture(prepared: PreparedPacket, shared?: ReadonlyMap<string, GpuRenderResidencyHandle>,
  partialGeometryIds?: ReadonlySet<string>) {
  const handles = new Map<string, GpuRenderResidencyHandle>();
  for (const source of prepared.geometries.values()) {
    if (partialGeometryIds && !partialGeometryIds.has(source.id)) continue;
    const key = `geometry:${source.id}`;
    handles.set(key, shared?.get(key) ?? { kind: "geometry", sourceId: source.id,
      sourceRevision: source.revision, level: 0, mesh: { id: source.id } as unknown as MeshBuffers });
  }
  for (const source of prepared.textures) {
    const key = `texture:${source.id}`, base = source.levels[0]!;
    handles.set(key, shared?.get(key) ?? { kind: "texture", id: source.id, revision: source.revision,
      level: 0, texture: { id: source.id } as unknown as GPUTexture,
      view: { id: source.id } as unknown as GPUTextureView,
      sampler: { id: source.samplerKey } as unknown as GPUSampler,
      byteLength: source.byteLength, semantic: source.semantic, format: source.format,
      width: base.width, height: base.height, mipLevelCount: source.levels.length,
      ...(source.requiredFeature ? { requiredFeature: source.requiredFeature } : {}) });
  }
  const releases = new Map<string, ReturnType<typeof vi.fn>>();
  const projection = createResidentPacketProjection(prepared, (kind, id) => {
    const key = `${kind}:${id}`, resource = handles.get(key);
    if (!resource) return undefined;
    const release = vi.fn(); releases.set(key, release);
    return { resource, release };
  }, partialGeometryIds ? { allowPartialLod: true } : undefined);
  return { handles, projection, releases };
}

function cachedGeometries(prepared: PreparedPacket,
  meshes: ReadonlyMap<string, GpuRenderResidencyHandle> = new Map()): Map<string, CachedPacketGeometry> {
  return new Map(Array.from(prepared.geometries, ([id, source]) => {
    const handle = meshes.get(`geometry:${id}`);
    return [id, { source, mesh: handle?.kind === "geometry" ? handle.mesh
      : { old: id } as unknown as MeshBuffers, center: [0.5, 0.5, 0] as const, radius: 1 }];
  }));
}

function context(f: ReturnType<typeof gpuFixture>, geometries: ReadonlyMap<string, CachedPacketGeometry>,
  batches: ReadonlyMap<string, CachedPacketBatch> = new Map()) {
  return { session: f.session, materials: f.materials, geometries, batches };
}

function releasePublication(f: ReturnType<typeof gpuFixture>, value: ResidentPacketBufferPublication): void {
  for (const batch of value.batches.values()) {
    f.session.release(batch.buffer); f.session.release(batch.previousBuffer);
    f.materials.release(batch.material);
  }
  value.projection.release();
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, STORAGE: 128, COPY_DST: 8, UNIFORM: 64 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("resident packet buffer staging", () => {
  it("borrows the complete streamed LOD and texture closure while uploading only packet-local buffers", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet()), resident = residentFixture(prepared);
    const current = new Map<string, CachedPacketGeometry>();
    const staged = stageResidentPacketBuffers(context(f, current), resident.projection);

    expect(staged.geometries.get("fine")?.mesh).toBe(resident.handles.get("geometry:fine")!.mesh);
    expect(staged.geometries.get("coarse")?.mesh).toBe(resident.handles.get("geometry:coarse")!.mesh);
    expect(staged.createdBuffers.map(value => (value as { label?: string }).label)).toEqual([
      "Deep packet instances", "Deep packet previous transforms",
    ]);
    expect(staged.acquiredMaterials).toHaveLength(1);
    expect(staged.batches.values().next().value?.material?.base)
      .toBe(resident.handles.get("texture:base"));
    expect(f.device.createBuffer).toHaveBeenCalledTimes(3);
    expect(resident.projection.released).toBe(false);

    const publication = commitResidentPacketBufferStage(context(f, current), staged);
    expect(publication.changed).toBe(true);
    expect(publication.projection).toBe(resident.projection);
    expect(() => commitResidentPacketBufferStage(context(f, current), staged)).toThrow("already settled");
    discardResidentPacketBufferStage(context(f, current), staged);
    expect(resident.projection.released).toBe(false);
    releasePublication(f, publication);
    expect(f.owned.size).toBe(0);
  });

  it("stages only leased meshes but keeps CPU bounds for nonresident finer LODs", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet(false));
    const resident = residentFixture(prepared, undefined, new Set(["coarse"]));
    const staged = stageResidentPacketBuffers(context(f, new Map()), resident.projection);

    expect([...staged.geometries]).toEqual([["coarse", expect.objectContaining({
      mesh: resident.handles.get("geometry:coarse")!.mesh,
    })]]);
    expect([...staged.geometryBounds.keys()]).toEqual(["fine", "coarse"]);
    expect(staged.geometryBounds.get("fine")).toMatchObject({ revision: 1, triangleCount: 2 });
    expect(staged.geometryBounds.get("fine")).not.toHaveProperty("mesh");
    discardResidentPacketBufferStage(context(f, new Map()), staged);
    expect(resident.projection.released).toBe(true);
  });

  it("maps resident LOD handles by source identity instead of array position", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet(false));
    const resident = residentFixture(prepared), source = resident.projection.batches[0]!;
    const release = vi.fn(() => resident.projection.release());
    const reordered = {
      batches: [{ ...source, geometries: [...source.geometries].reverse() }], released: false,
      geometry: resident.projection.geometry.bind(resident.projection),
      geometrySource: resident.projection.geometrySource.bind(resident.projection),
      texture: resident.projection.texture.bind(resident.projection),
      textureSource: resident.projection.textureSource.bind(resident.projection), release,
    } as ResidentPacketProjection;
    const staged = stageResidentPacketBuffers(context(f, new Map()), reordered);
    expect([...staged.geometries.keys()]).toEqual(["coarse", "fine"]);
    discardResidentPacketBufferStage(context(f, new Map()), staged);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reuses steady instance, history, material and geometry caches without taking extra ownership", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet()), first = residentFixture(prepared);
    const initial = context(f, cachedGeometries(prepared));
    const active = commitResidentPacketBufferStage(initial,
      stageResidentPacketBuffers(initial, first.projection));
    const second = residentFixture(prepared, first.handles);
    const activeContext = context(f, active.geometries, active.batches);
    f.device.createBuffer.mockClear();

    const staged = stageResidentPacketBuffers(activeContext, second.projection);
    expect(staged.changed).toBe(false);
    expect(staged.createdBuffers).toHaveLength(0);
    expect(staged.acquiredMaterials).toHaveLength(0);
    expect(staged.batches.values().next().value).toBe(active.batches.values().next().value);
    discardResidentPacketBufferStage(activeContext, staged);
    expect(second.projection.released).toBe(true);
    expect(first.projection.released).toBe(false);
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.owned.size).toBe(3);
    releasePublication(f, active);
  });

  it("rejects incomplete texture bindings and duplicate geometry handles before auxiliary allocation", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet()), resident = residentFixture(prepared);
    const current = cachedGeometries(prepared), batch = resident.projection.batches[0]!;
    const release = vi.fn(() => resident.projection.release());
    const incomplete = { batches: [{ ...batch, textures: [] }], released: false,
      geometry: resident.projection.geometry.bind(resident.projection),
      geometrySource: resident.projection.geometrySource.bind(resident.projection),
      texture: resident.projection.texture.bind(resident.projection),
      textureSource: resident.projection.textureSource.bind(resident.projection),
      release } as ResidentPacketProjection;
    expect(() => stageResidentPacketBuffers(context(f, current), incomplete))
      .toThrow("texture closure is incomplete");
    expect(release).toHaveBeenCalledOnce();
    expect(f.device.createBuffer).not.toHaveBeenCalled();

    const next = residentFixture(prepared), nextBatch = next.projection.batches[0]!;
    const wrongRelease = vi.fn(() => next.projection.release());
    const duplicate = { batches: [{ ...nextBatch,
      geometries: [nextBatch.geometries[0]!, nextBatch.geometries[0]!] }], released: false,
      geometry: next.projection.geometry.bind(next.projection),
      geometrySource: next.projection.geometrySource.bind(next.projection),
      texture: next.projection.texture.bind(next.projection),
      textureSource: next.projection.textureSource.bind(next.projection),
      release: wrongRelease } as ResidentPacketProjection;
    expect(() => stageResidentPacketBuffers(context(f, current), duplicate))
      .toThrow("geometry LOD binding is invalid");
    expect(wrongRelease).toHaveBeenCalledOnce();
  });

  it("rejects unavailable source revisions and releases the candidate projection", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet(false));
    const resident = residentFixture(prepared), release = vi.fn(() => resident.projection.release());
    const fine = resident.projection.geometrySource("fine")!;
    const wrongSource = { batches: resident.projection.batches, released: false,
      geometry: resident.projection.geometry.bind(resident.projection),
      geometrySource: (id: string) => id === "fine" ? { ...fine, revision: 0 }
        : resident.projection.geometrySource(id),
      texture: resident.projection.texture.bind(resident.projection),
      textureSource: resident.projection.textureSource.bind(resident.projection), release } as ResidentPacketProjection;
    expect(() => stageResidentPacketBuffers(context(f, new Map()), wrongSource))
      .toThrow("source revision is unavailable: fine");
    expect(resident.projection.released).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(f.device.createBuffer).not.toHaveBeenCalled();
  });

  it("rolls back material and both instance allocations after a late upload failure", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet()), resident = residentFixture(prepared);
    f.device.queue.writeBuffer.mockImplementationOnce(() => {}).mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error("history upload failed"); });
    expect(() => stageResidentPacketBuffers(context(f, cachedGeometries(prepared)), resident.projection))
      .toThrow("history upload failed");
    expect(resident.projection.released).toBe(true);
    expect(f.owned.size).toBe(0);
    expect(f.buffers).toHaveLength(3);
    for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("discards a candidate if publication loses the device and never destroys borrowed handles directly", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet(false));
    const resident = residentFixture(prepared), current = cachedGeometries(prepared);
    const staged = stageResidentPacketBuffers(context(f, current), resident.projection);
    (f.session as unknown as { state: string }).state = "lost";
    expect(() => commitResidentPacketBufferStage(context(f, current), staged))
      .toThrow("cannot be published");
    expect(staged.settled).toBe(true);
    expect(resident.projection.released).toBe(true);
    expect(f.owned.size).toBe(0);
    for (const release of resident.releases.values()) expect(release).toHaveBeenCalledOnce();
  });

  it("finishes auxiliary cleanup when one projection lease release fails", () => {
    const f = gpuFixture(), prepared = prepareRenderPacket(packet()), resident = residentFixture(prepared);
    resident.releases.get("geometry:fine")!.mockImplementation(() => { throw new Error("lease failed"); });
    const staged = stageResidentPacketBuffers(context(f, cachedGeometries(prepared)), resident.projection);
    expect(() => discardResidentPacketBufferStage(
      context(f, cachedGeometries(prepared)), staged)).toThrow(AggregateError);
    expect(f.owned.size).toBe(0);
    for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    for (const release of resident.releases.values()) expect(release).toHaveBeenCalledOnce();
    expect(resident.projection.released).toBe(true);
  });
});
