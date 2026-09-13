import { describe, expect, it, vi } from "vitest";
import {
  prepareRenderPacket,
  type GeometryResource,
  type PbrMaterial,
  type PreparedPacket,
  type RenderInstance,
  type RenderPacket,
} from "../renderPacket.js";
import type { GpuResidentLease } from "../streaming/gpuResidentLease.js";
import type { DecodedTexture, TextureSemantic } from "../textures/decodedTexture.js";
import type { GpuRenderResidencyHandle } from "./gpuRenderResidencyUploader.js";
import type { MeshBuffers } from "./meshBuffers.js";
import {
  createResidentPacketProjection,
  type ResidentPacketLeaseProvider,
} from "./residentPacketProjection.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MIRRORED = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, revision = 1, triangles = 1): GeometryResource {
  const vertices = triangles === 1
    ? [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]
    : [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
      1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1];
  return { id, revision, vertices: new Float32Array(vertices),
    uv0: new Float32Array(triangles === 1 ? [0, 0, 1, 0, 0, 1] : [0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array(triangles === 1 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3]) };
}

function lodGeometry(id: string, revision: number, triangles: number): GeometryResource {
  return { ...geometry(id, revision), indices: new Uint32Array(
    Array.from({ length: triangles * 3 }, (_, index) => index % 3)) };
}

function texture(id: string, semantic: TextureSemantic, revision = 1): DecodedTexture {
  return { id, revision, semantic, width: 1, height: 1,
    data: new Uint8Array([255, 128, 64, 255]) };
}

function material(id: string, base?: string, emissive?: string): PbrMaterial {
  return { id, baseColor: [1, 1, 1], metallic: 0.2, roughness: 0.8,
    ...(base ? { baseColorTexture: { texture: base } } : {}),
    ...(emissive ? { emissiveTexture: { texture: emissive } } : {}) };
}

function instance(id: string, geometryId: string, materialId: string,
  transform: ArrayLike<number> = IDENTITY): RenderInstance {
  return { id, geometry: geometryId, material: materialId, transform };
}

function prepare(packet: RenderPacket): PreparedPacket { return prepareRenderPacket(packet); }

function handlesFor(packet: PreparedPacket): Map<string, GpuRenderResidencyHandle> {
  const result = new Map<string, GpuRenderResidencyHandle>();
  for (const source of packet.geometries.values()) result.set(`geometry:${source.id}`, {
    kind: "geometry", sourceId: source.id, sourceRevision: source.revision, level: 0,
    mesh: {} as MeshBuffers,
  });
  for (const source of packet.textures) {
    const base = source.levels[0]!;
    result.set(`texture:${source.id}`, {
      kind: "texture", id: source.id, revision: source.revision, level: 0,
      texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler,
      byteLength: source.byteLength, semantic: source.semantic, format: source.format,
      width: base.width, height: base.height, mipLevelCount: source.levels.length,
      ...(source.requiredFeature ? { requiredFeature: source.requiredFeature } : {}),
    });
  }
  return result;
}

function provider(packet: PreparedPacket): {
  readonly acquire: ResidentPacketLeaseProvider;
  readonly handles: Map<string, GpuRenderResidencyHandle>;
  readonly calls: string[];
  readonly releases: Map<string, ReturnType<typeof vi.fn>>;
} {
  const handles = handlesFor(packet), calls: string[] = [];
  const releases = new Map<string, ReturnType<typeof vi.fn>>();
  return { handles, calls, releases, acquire: (kind, id) => {
    const key = `${kind}:${id}`, resource = handles.get(key);
    calls.push(key);
    if (!resource) return undefined;
    const release = vi.fn(); releases.set(key, release);
    return { resource, release };
  } };
}

describe("createResidentPacketProjection", () => {
  it("publishes a kind-safe shared dependency closure and releases it once", () => {
    const packet = prepare({
      geometries: [geometry("shared")],
      textures: [texture("shared", "baseColor")],
      materials: [material("mat", "shared")],
      instances: [instance("a", "shared", "mat"), instance("b", "shared", "mat", MIRRORED)],
    });
    const f = provider(packet);
    const projection = createResidentPacketProjection(packet, f.acquire);

    expect(packet.batches).toHaveLength(2);
    expect(f.calls).toEqual(["geometry:shared", "texture:shared"]);
    expect(projection.batches).toHaveLength(2);
    expect(projection.batches.every(batch => batch.geometries[0] === projection.geometry("shared"))).toBe(true);
    expect(projection.batches.every(batch => batch.textures[0]?.texture === projection.texture("shared"))).toBe(true);
    expect(projection.batches[0]?.textures[0]?.role).toBe("baseColor");
    expect(projection.released).toBe(false);

    projection.release(); projection.release();
    expect(projection.released).toBe(true);
    expect(f.releases.get("geometry:shared")).toHaveBeenCalledOnce();
    expect(f.releases.get("texture:shared")).toHaveBeenCalledOnce();
  });

  it("keeps LOD geometry handles aligned with every prepared level", () => {
    const packet = prepare({
      geometries: [geometry("fine", 3, 2), geometry("coarse", 7, 1)],
      materials: [material("mat")],
      instances: [{ ...instance("a", "fine", "mat"), lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
    });
    const f = provider(packet), projection = createResidentPacketProjection(packet, f.acquire);

    expect(f.calls).toEqual(["geometry:fine", "geometry:coarse"]);
    expect(projection.batches[0]?.geometries.map(value => value.sourceId)).toEqual(["fine", "coarse"]);
    projection.release();
  });

  it("allows only a coarsest GPU fallback while retaining every LOD source", () => {
    const packet = prepare({
      geometries: [geometry("fine", 3, 2), geometry("coarse", 7, 1)],
      materials: [material("mat")], instances: [{ ...instance("a", "fine", "mat"), lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
    });
    const f = provider(packet); f.handles.delete("geometry:fine");
    const projection = createResidentPacketProjection(packet, f.acquire, { allowPartialLod: true });

    expect(f.calls).toEqual(["geometry:fine", "geometry:coarse"]);
    expect(projection.batches[0]?.geometries.map(value => value.sourceId)).toEqual(["coarse"]);
    expect(projection.geometry("fine")).toBeUndefined();
    expect(projection.geometrySource("fine")?.revision).toBe(3);
    projection.release();
    expect(f.releases.get("geometry:coarse")).toHaveBeenCalledOnce();
  });

  it("skips author-disabled middle LODs and maps fine plus coarse handles by source ID", () => {
    const packet = prepare({
      geometries: [lodGeometry("fine", 1, 3), lodGeometry("middle", 2, 2),
        lodGeometry("coarse", 3, 1)],
      materials: [material("mat")], instances: [{ ...instance("a", "fine", "mat"), lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "middle", minProjectedDiameterPixels: 30, geometricError: 0.4, resident: false },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
    });
    const f = provider(packet);
    const projection = createResidentPacketProjection(packet, f.acquire, { allowPartialLod: true });

    expect(f.calls).toEqual(["geometry:fine", "geometry:coarse"]);
    expect(projection.batches[0]?.geometries.map(value => value.sourceId)).toEqual(["fine", "coarse"]);
    expect(projection.geometry("middle")).toBeUndefined();
    projection.release();
  });

  it("requires an exact coarsest fallback and rolls back every finer lease", () => {
    const packet = prepare({
      geometries: [geometry("fine", 1, 2), geometry("coarse", 5)],
      materials: [material("mat")], instances: [{ ...instance("a", "fine", "mat"), lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
    });
    const f = provider(packet); f.handles.delete("geometry:coarse");
    expect(() => createResidentPacketProjection(packet, f.acquire, { allowPartialLod: true }))
      .toThrow("GPU resident dependency is unavailable: geometry:coarse");
    expect(f.releases.get("geometry:fine")).toHaveBeenCalledOnce();

    const invalid = provider(packet), coarse = invalid.handles.get("geometry:coarse")!;
    invalid.handles.set("geometry:coarse", { ...coarse, sourceRevision: 4 } as GpuRenderResidencyHandle);
    expect(() => createResidentPacketProjection(packet, invalid.acquire, { allowPartialLod: true }))
      .toThrow("GPU geometry dependency differs from prepared packet: coarse");
    expect(invalid.releases.get("geometry:fine")).toHaveBeenCalledOnce();
    expect(invalid.releases.get("geometry:coarse")).toHaveBeenCalledOnce();
  });

  it("rolls back every acquired lease when a material texture is unavailable", () => {
    const packet = prepare({
      geometries: [geometry("mesh")],
      textures: [texture("base", "baseColor"), texture("glow", "emissive")],
      materials: [material("mat", "base", "glow")],
      instances: [instance("a", "mesh", "mat")],
    });
    const f = provider(packet); f.handles.delete("texture:glow");

    expect(() => createResidentPacketProjection(packet, f.acquire))
      .toThrow("GPU resident dependency is unavailable: texture:glow");
    expect(f.releases.get("geometry:mesh")).toHaveBeenCalledOnce();
    expect(f.releases.get("texture:base")).toHaveBeenCalledOnce();
  });

  it("rejects a stale handle and rolls back the complete partial transaction", () => {
    const packet = prepare({
      geometries: [geometry("mesh")], textures: [texture("base", "baseColor", 4)],
      materials: [material("mat", "base")], instances: [instance("a", "mesh", "mat")],
    });
    const f = provider(packet), current = f.handles.get("texture:base")!;
    f.handles.set("texture:base", { ...current, revision: 3 } as GpuRenderResidencyHandle);

    expect(() => createResidentPacketProjection(packet, f.acquire))
      .toThrow("GPU texture dependency differs from prepared packet: base");
    expect(f.releases.get("geometry:mesh")).toHaveBeenCalledOnce();
    expect(f.releases.get("texture:base")).toHaveBeenCalledOnce();
  });

  it("accepts a complete mip-suffix texture LOD", () => {
    const mipmapped: DecodedTexture = { id: "base", revision: 2, semantic: "baseColor",
      width: 2, height: 2, data: new Uint8Array(16),
      mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4) }] };
    const packet = prepare({ geometries: [geometry("mesh")], textures: [mipmapped],
      materials: [material("mat", "base")], instances: [instance("a", "mesh", "mat")] });
    const f = provider(packet), full = f.handles.get("texture:base")!;
    f.handles.set("texture:base", { ...full, level: 1, byteLength: 4,
      width: 1, height: 1, mipLevelCount: 1 } as GpuRenderResidencyHandle);

    const projection = createResidentPacketProjection(packet, f.acquire);
    expect(projection.texture("base")).toMatchObject({ level: 1, width: 1, mipLevelCount: 1 });
    projection.release();
  });

  it("attempts all releases and becomes released even when one release throws", () => {
    const packet = prepare({
      geometries: [geometry("mesh")], textures: [texture("base", "baseColor")],
      materials: [material("mat", "base")], instances: [instance("a", "mesh", "mat")],
    });
    const handles = handlesFor(packet), attempts: string[] = [];
    const acquire = ((kind, id) => {
      const key = `${kind}:${id}`;
      return { resource: handles.get(key)!, release: vi.fn(() => {
        attempts.push(key); if (kind === "geometry") throw new Error("retire failed");
      }) } satisfies GpuResidentLease<GpuRenderResidencyHandle>;
    }) satisfies ResidentPacketLeaseProvider;
    const projection = createResidentPacketProjection(packet, acquire);

    expect(() => projection.release()).toThrow(AggregateError);
    expect(attempts.sort()).toEqual(["geometry:mesh", "texture:base"]);
    expect(projection.released).toBe(true);
    projection.release();
    expect(attempts).toHaveLength(2);
  });

  it("releases a reused lease only once before rejecting the provider contract", () => {
    const packet = prepare({ geometries: [geometry("mesh")], textures: [texture("base", "baseColor")],
      materials: [material("mat", "base")], instances: [instance("a", "mesh", "mat")] });
    const shared = { resource: handlesFor(packet).get("geometry:mesh")!, release: vi.fn() };

    expect(() => createResidentPacketProjection(packet, () => shared))
      .toThrow("GPU resident provider reused a lease: texture:base");
    expect(shared.release).toHaveBeenCalledOnce();
  });
});
