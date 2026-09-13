import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareRenderPacket,
  type GeometryResource,
  type PreparedPacket,
} from "../renderPacket.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuRenderResidencyFrameResult } from "./gpuRenderResidencyRuntime.js";
import {
  createPacketResidencyLoader,
  PacketResidencyLoadError,
} from "./packetResidencyLoader.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(): GeometryResource {
  return { id: "mesh", revision: 3,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}

function texture(): DecodedTexture {
  return { id: "base", revision: 7, semantic: "baseColor", width: 2, height: 2,
    data: new Uint8Array(16).fill(11),
    mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4).fill(22) }] };
}

function packet(): PreparedPacket {
  return prepareRenderPacket({ geometries: [geometry()], textures: [texture()],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: "base" } }],
    instances: [{ id: "instance", geometry: "mesh", material: "mat", transform: TRANSFORM }],
  });
}

function gpuFixture(failBuffer = false) {
  const owned = new Set<{ destroy(): void }>();
  const destroyable = () => ({ destroy: vi.fn() });
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_000_000 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn(() => {
      if (failBuffer) throw new Error("buffer allocation failed");
      return destroyable() as unknown as GPUBuffer;
    }),
    createTexture: vi.fn(() => ({ ...destroyable(), createView: vi.fn(() => ({})) }) as unknown as GPUTexture),
    createSampler: vi.fn(() => ({} as GPUSampler)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, owned };
}

function runtimeFor(loader: ReturnType<typeof createPacketResidencyLoader>, fixture = gpuFixture()) {
  const runtime = loader.createRuntime(fixture.session,
    { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
  return { ...fixture, runtime };
}

function applied(frame: number): GpuRenderResidencyFrameResult {
  return Object.freeze({ generation: 1, frame, status: "applied", execution: Object.freeze({
    generation: 1, planId: 1, uploadFailures: Object.freeze([]), commit: Object.freeze({
      revision: 1, residentBytes: 0, appliedUploads: Object.freeze([]),
      failedUploads: Object.freeze([]), evicted: Object.freeze([]),
    }),
  }) });
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("createPacketResidencyLoader", () => {
  it("takes exactly one private typed-array snapshot during registration", () => {
    const prepared = packet();
    const floats = vi.spyOn(Float32Array.prototype, "slice");
    const uints = vi.spyOn(Uint32Array.prototype, "slice");
    const bytes = vi.spyOn(Uint8Array.prototype, "slice");
    createPacketResidencyLoader(prepared);
    expect(floats).toHaveBeenCalledTimes(3);
    expect(uints).toHaveBeenCalledTimes(1);
    expect(bytes).toHaveBeenCalledTimes(2);
  });

  it("loads the default closure from one private snapshot and leaves runtime ownership to the caller", async () => {
    const prepared = packet(), geometryValue = prepared.geometries.get("mesh")!.vertices[0]!;
    const textureValue = prepared.textures[0]!.levels[0]!.data[0]!;
    const batchValue = prepared.batches[0]!.data[0]!;
    const loader = createPacketResidencyLoader(prepared), f = runtimeFor(loader);
    expect(Object.isFrozen(loader)).toBe(true); expect("sourceFor" in loader).toBe(false);
    prepared.geometries.get("mesh")!.vertices[0] = 99;
    prepared.textures[0]!.levels[0]!.data[0] = 98;
    prepared.batches[0]!.data[0] = 97;

    const projection = await loader.loadInto(f.runtime, { frame: 4 });

    expect(projection.geometry("mesh")?.sourceRevision).toBe(3);
    expect(projection.texture("base")).toMatchObject({ revision: 7, level: 0, byteLength: 20 });
    expect(projection.geometrySource("mesh")?.vertices[0]).toBe(geometryValue);
    expect(projection.textureSource("base")?.levels[0]?.data[0]).toBe(textureValue);
    expect(projection.batches[0]?.source.data[0]).toBe(batchValue);
    projection.geometrySource("mesh")!.vertices[0] = 55;
    projection.batches[0]!.source.data[0] = 54;
    expect(() => {
      (projection.batches[0]!.source.textures!.baseColor!.uvTransform as unknown as number[])[0] = 53;
    }).toThrow(TypeError);
    projection.release();
    const second = await loader.loadInto(f.runtime, { frame: 5 });
    expect(second.geometrySource("mesh")?.vertices[0]).toBe(geometryValue);
    expect(second.batches[0]?.source.data[0]).toBe(batchValue);
    expect(second.batches[0]?.source.textures?.baseColor?.uvTransform[0]).toBe(1);
    second.release();
    expect(f.runtime.disposed).toBe(false);
    f.runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("accepts a custom complete closure with a coarser texture mip suffix", async () => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader);
    const projection = await loader.loadInto(f.runtime, { frame: 2, requests: [
      { id: "mesh", kind: "geometry", desiredLevel: 0, required: true },
      { id: "base", kind: "texture", desiredLevel: 1, required: true },
    ] });

    expect(projection.texture("base")).toMatchObject({ level: 1, width: 1, height: 1,
      mipLevelCount: 1, byteLength: 4 });
    projection.release(); f.runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("does not clone packet typed arrays on repeated residency frames", async () => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader);
    const floatSlices = vi.spyOn(Float32Array.prototype, "slice");
    const uintSlices = vi.spyOn(Uint32Array.prototype, "slice");
    const byteSlices = vi.spyOn(Uint8Array.prototype, "slice");
    const first = await loader.loadInto(f.runtime, { frame: 1 }); first.release();
    const second = await loader.loadInto(f.runtime, { frame: 2 }); second.release();
    expect(floatSlices).not.toHaveBeenCalled(); expect(uintSlices).not.toHaveBeenCalled();
    expect(byteSlices).not.toHaveBeenCalled();
    f.runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("rejects a custom request that leaves the packet closure incomplete without leaking a lease", async () => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader);

    await expect(loader.loadInto(f.runtime, { frame: 1, requests: [
      { id: "mesh", kind: "geometry", desiredLevel: 0, required: true },
    ] })).rejects.toMatchObject({ code: "incomplete-residency" });

    f.runtime.dispose();
    expect(f.runtime.retiredBytes).toBe(0); expect(f.owned.size).toBe(0);
  });

  it("rejects a partial GPU upload before acquiring leases", async () => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader, gpuFixture(true));

    await expect(loader.loadInto(f.runtime, { frame: 1 }))
      .rejects.toMatchObject({ code: "partial-failure" });

    f.runtime.dispose();
    expect(f.runtime.retiredBytes).toBe(0); expect(f.owned.size).toBe(0);
  });

  it("fails closed when a runtime belongs to another loader", async () => {
    const loader = createPacketResidencyLoader(packet());
    const foreignLoader = createPacketResidencyLoader(packet()), f = runtimeFor(foreignLoader);

    await expect(loader.loadInto(f.runtime, { frame: 1 }))
      .rejects.toMatchObject({ code: "unbound-runtime" });

    expect(f.runtime.resourceCount).toBe(0);
    f.runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it.each(["superseded", "failed"] as const)("rejects a %s frame before lease acquisition", async status => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader);
    const acquire = vi.spyOn(f.runtime, "acquire");
    vi.spyOn(f.runtime, "submit").mockImplementation(async (frame: number) => Object.freeze({
      generation: 1, frame, status, ...(status === "failed" ? { error: new Error("device lost") } : {}),
    }));

    await expect(loader.loadInto(f.runtime, { frame: 8 }))
      .rejects.toBeInstanceOf(PacketResidencyLoadError);
    expect(acquire).not.toHaveBeenCalled();
    f.runtime.dispose();
  });

  it("rejects a stale applied result and validates options before registration", async () => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader);
    const acquire = vi.spyOn(f.runtime, "acquire"), register = vi.spyOn(f.runtime, "register");
    vi.spyOn(f.runtime, "submit").mockResolvedValue(applied(6));

    await expect(loader.loadInto(f.runtime, { frame: 7 }))
      .rejects.toMatchObject({ code: "frame-rejected" });
    expect(acquire).not.toHaveBeenCalled();
    await expect(loader.loadInto(f.runtime, { frame: -1 })).rejects.toBeInstanceOf(TypeError);
    expect(register).toHaveBeenCalledTimes(2);
    f.runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("wraps a rejected runtime frame without acquiring a lease", async () => {
    const loader = createPacketResidencyLoader(packet()), f = runtimeFor(loader);
    const acquire = vi.spyOn(f.runtime, "acquire");
    vi.spyOn(f.runtime, "submit").mockRejectedValue(new Error("device lost"));

    await expect(loader.loadInto(f.runtime, { frame: 3 }))
      .rejects.toMatchObject({ code: "frame-rejected", cause: expect.any(Error) });
    expect(acquire).not.toHaveBeenCalled();
    f.runtime.dispose(); expect(f.owned.size).toBe(0);
  });
});
