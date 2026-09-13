import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareRenderPacket,
  type GeometryResource,
  type PreparedPacket,
  type RenderInstance,
} from "../renderPacket.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { createPacketResidencyDomain } from "./packetResidencyDomain.js";
import { createPacketResidencyLoader } from "./packetResidencyLoader.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, triangles: number): GeometryResource {
  return { id, revision: triangles,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array(Array.from({ length: triangles * 3 }, (_, index) => index % 3)) };
}

function texture(): DecodedTexture {
  return { id: "base", revision: 7, semantic: "baseColor", width: 2, height: 2,
    data: new Uint8Array(16).fill(11),
    mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4).fill(22) }] };
}

function instance(id: string, mesh: string): RenderInstance {
  return { id, geometry: mesh, material: "mat", transform: TRANSFORM };
}

function lodPacket(includeStatic = false): PreparedPacket {
  const lod = { ...instance("lod", "fine"), lod: { levels: [
    { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
    { geometry: "middle", minProjectedDiameterPixels: 30, geometricError: 0.4, resident: false },
    { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
  ] } };
  return prepareRenderPacket({
    geometries: [geometry("fine", 3), geometry("middle", 2), geometry("coarse", 1),
      ...(includeStatic ? [geometry("static", 1)] : [])],
    textures: [texture()],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: "base" } }],
    instances: [lod, ...(includeStatic ? [instance("static-instance", "static")] : [])],
  });
}

function sharedLodPacket(): PreparedPacket {
  return prepareRenderPacket({
    geometries: [geometry("fine-b", 3), geometry("shared", 2), geometry("coarse-a", 1)],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [
      { ...instance("a", "shared"), lod: { levels: [
        { geometry: "shared", minProjectedDiameterPixels: 80, geometricError: 0 },
        { geometry: "coarse-a", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } },
      { ...instance("b", "fine-b"), lod: { levels: [
        { geometry: "fine-b", minProjectedDiameterPixels: 80, geometricError: 0 },
        { geometry: "shared", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } },
    ],
  });
}

function gpuFixture() {
  const owned = new Set<{ destroy(): void }>();
  const destroyable = () => ({ destroy: vi.fn() });
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_000_000 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn(() => destroyable() as unknown as GPUBuffer),
    createTexture: vi.fn(() => ({ ...destroyable(), createView: vi.fn(() => ({})) }) as unknown as GPUTexture),
    createSampler: vi.fn(() => ({} as GPUSampler)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, owned };
}

const partialRequests = Object.freeze([
  { id: "coarse", kind: "geometry" as const, desiredLevel: 0, required: true },
  { id: "base", kind: "texture" as const, desiredLevel: 1, required: true },
]);

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("partial packet residency", () => {
  it("keeps loader strict by default and permits only explicit partial LOD", async () => {
    const fixture = gpuFixture(), loader = createPacketResidencyLoader(lodPacket());
    const runtime = loader.createRuntime(fixture.session,
      { maxResidentBytes: 136, maxUploadBytesPerFrame: 136 });

    await expect(loader.loadInto(runtime, { frame: 1, requests: partialRequests }))
      .rejects.toMatchObject({ code: "incomplete-residency" });
    const projection = await loader.loadInto(runtime,
      { frame: 2, requests: partialRequests, allowPartialLod: true });

    expect(projection.partialLod).toBe(true);
    expect(projection.geometry("fine")).toBeUndefined();
    expect(projection.geometry("middle")).toBeUndefined();
    expect(projection.geometry("coarse")?.sourceRevision).toBe(1);
    expect(projection.texture("base")).toMatchObject({ revision: 7, level: 1, byteLength: 4 });
    projection.release(); runtime.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("requires non-LOD geometry and every material texture from actual runtime state", async () => {
    const fixture = gpuFixture(), loader = createPacketResidencyLoader(lodPacket(true));
    const runtime = loader.createRuntime(fixture.session,
      { maxResidentBytes: 300, maxUploadBytesPerFrame: 300 });
    const coarse = partialRequests.slice(0, 1);
    await expect(loader.loadInto(runtime,
      { frame: 1, requests: coarse, allowPartialLod: true }))
      .rejects.toThrow("geometry:static");
    await expect(loader.loadInto(runtime, { frame: 2, allowPartialLod: true, requests: [
      ...coarse, { id: "static", kind: "geometry", desiredLevel: 0, required: true },
    ] })).rejects.toThrow("texture:base");
    runtime.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("treats geometry shared across batches as required when it is any coarsest fallback", async () => {
    const fixture = gpuFixture(), loader = createPacketResidencyLoader(sharedLodPacket());
    const runtime = loader.createRuntime(fixture.session,
      { maxResidentBytes: 276, maxUploadBytesPerFrame: 276 });
    const coarseA = { id: "coarse-a", kind: "geometry" as const, desiredLevel: 0, required: true };
    await expect(loader.loadInto(runtime,
      { frame: 1, requests: [coarseA], allowPartialLod: true })).rejects.toThrow("geometry:shared");
    const projection = await loader.loadInto(runtime, { frame: 2, allowPartialLod: true,
      requests: [coarseA, { id: "shared", kind: "geometry", desiredLevel: 0, required: true }] });
    const a = projection.batches.find(batch => batch.source.geometry === "shared")!;
    const b = projection.batches.find(batch => batch.source.geometry === "fine-b")!;
    expect(a.geometries[0]).toBe(b.geometries[0]);
    expect(projection.geometry("fine-b")).toBeUndefined();
    projection.release(); runtime.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("rejects budget-incomplete domain closure and foreign ticket requests", async () => {
    const fixture = gpuFixture(), domain = createPacketResidencyDomain(fixture.session,
      { maxResidentBytes: 135, maxUploadBytesPerFrame: 135 });
    const ticket = domain.registerPacket("lod", lodPacket());
    await expect(domain.load(ticket, { frame: 1, requests: partialRequests,
      allowPartialLod: true })).rejects.toMatchObject({ code: "incomplete-residency" });
    await expect(domain.load(ticket, { frame: 2, allowPartialLod: true, requests: [
      { id: "foreign", kind: "geometry", desiredLevel: 0 },
    ] })).rejects.toMatchObject({ code: "unbound-runtime" });
    domain.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("publishes a partial projection through the shared domain", async () => {
    const fixture = gpuFixture(), domain = createPacketResidencyDomain(fixture.session,
      { maxResidentBytes: 136, maxUploadBytesPerFrame: 136 });
    const ticket = domain.registerPacket("lod", lodPacket());
    const projection = await domain.load(ticket,
      { frame: 1, requests: partialRequests, allowPartialLod: true });
    expect(projection.partialLod).toBe(true);
    expect(projection.geometry("fine")).toBeUndefined();
    expect(projection.geometry("coarse")?.sourceRevision).toBe(1);
    projection.release(); domain.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("does not require an unreferenced packet texture in a partial projection", async () => {
    const fixture = gpuFixture(), source = lodPacket(), base = source.textures[0]!;
    const withUnused = Object.freeze({ ...source,
      textures: Object.freeze([...source.textures, Object.freeze({ ...base, id: "unused" })]),
    });
    const loader = createPacketResidencyLoader(withUnused);
    const runtime = loader.createRuntime(fixture.session,
      { maxResidentBytes: 136, maxUploadBytesPerFrame: 136 });
    const projection = await loader.loadInto(runtime,
      { frame: 1, requests: partialRequests, allowPartialLod: true });
    expect(projection.texture("base")).toBeDefined();
    expect(projection.texture("unused")).toBeUndefined();
    projection.release(); runtime.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("rolls back finer leases if a required fallback disappears during projection", async () => {
    const fixture = gpuFixture(), loader = createPacketResidencyLoader(lodPacket());
    const runtime = loader.createRuntime(fixture.session,
      { maxResidentBytes: 444, maxUploadBytesPerFrame: 444 });
    const originalAcquire = runtime.acquire.bind(runtime), releaseFine = vi.fn();
    vi.spyOn(runtime, "acquire").mockImplementation((kind, id) => {
      if (kind === "geometry" && id === "coarse") return undefined;
      const lease = originalAcquire(kind, id);
      if (kind !== "geometry" || id !== "fine" || !lease) return lease;
      return Object.freeze({ resource: lease.resource, release: () => {
        releaseFine(); lease.release();
      } });
    });
    await expect(loader.loadInto(runtime, { frame: 1, allowPartialLod: true }))
      .rejects.toThrow("GPU resident dependency is unavailable: geometry:coarse");
    expect(releaseFine).toHaveBeenCalledOnce(); expect(runtime.retiredBytes).toBe(0);
    runtime.dispose(); expect(fixture.owned.size).toBe(0);
  });
});
