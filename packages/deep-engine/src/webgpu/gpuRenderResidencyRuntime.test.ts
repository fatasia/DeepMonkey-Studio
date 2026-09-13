import { describe, expect, it, vi } from "vitest";
import type { GeometryResource } from "../renderPacketTypes.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuRenderResidencyRuntime } from "./gpuRenderResidencyRuntime.js";

const geometry: GeometryResource = { id: "mesh", revision: 1,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) };
const texture: DecodedTexture = { id: "albedo", revision: 1, semantic: "baseColor",
  width: 1, height: 1, data: new Uint8Array([255, 128, 64, 255]) };

function fixture() {
  const owned = new Set<object>(), destroyed: Array<ReturnType<typeof vi.fn>> = [];
  const destroyable = () => { const destroy = vi.fn(); destroyed.push(destroy); return { destroy }; };
  const lost = new Promise<void>(() => {});
  const device = { lost, features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn(() => destroyable() as unknown as GPUBuffer),
    createTexture: vi.fn(() => ({ ...destroyable(), createView: vi.fn(() => ({})) }) as unknown as GPUTexture),
    createSampler: vi.fn(() => ({} as GPUSampler)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, device, owned, destroyed };
}

describe("GpuRenderResidencyRuntime", () => {
  it("shares one byte budget across draw-ready geometry and texture resources", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), sourceCalls: string[] = [];
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 136, maxUploadBytesPerFrame: 136 }, request => {
          sourceCalls.push(`${request.kind}:${request.id}`);
          return request.kind === "geometry" ? { kind: "geometry", source: geometry }
            : { kind: "texture", source: { level: request.level, texture } };
        }, { maxConcurrentUploads: 2 });
      runtime.register({ id: "mesh", revision: 1, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      runtime.register({ id: "albedo", revision: 1, kind: "texture",
        levels: [{ level: 0, byteLength: 4 }] });
      const result = await runtime.submit(1, [
        { id: "mesh", kind: "geometry", desiredLevel: 0, required: true },
        { id: "albedo", kind: "texture", desiredLevel: 0, required: true },
      ]);
      expect(result).toMatchObject({ status: "applied", execution: { commit: { residentBytes: 136 } } });
      expect(runtime.get("geometry", "mesh")?.kind).toBe("geometry");
      expect(runtime.get("texture", "albedo")?.kind).toBe("texture");
      const meshLease = runtime.acquire("geometry", "mesh"), textureLease = runtime.acquire("texture", "albedo");
      expect(meshLease?.resource.kind).toBe("geometry"); expect(textureLease?.resource.kind).toBe("texture");
      meshLease?.release(); textureLease?.release();
      expect(sourceCalls.sort()).toEqual(["geometry:mesh", "texture:albedo"]);
      expect(f.owned.size).toBe(3);
      runtime.dispose(); expect(f.owned.size).toBe(0);
      for (const destroy of f.destroyed) expect(destroy).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("fails one mismatched source without publishing it", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture();
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 132, maxUploadBytesPerFrame: 132 }, request => ({ kind: "texture",
          source: { level: request.level, texture } }));
      runtime.register({ id: "mesh", revision: 1, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      const result = await runtime.submit(1, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]);
      expect(result.execution?.commit.failedUploads).toEqual([{ id: "mesh", kind: "geometry" }]);
      expect(result.execution?.uploadFailures[0]?.reason).toBeInstanceOf(TypeError);
      expect(result.execution?.uploadFailures[0]?.resource).toEqual({ id: "mesh", kind: "geometry" });
      expect(runtime.residentCount).toBe(0); expect(f.owned.size).toBe(0);
      runtime.dispose();
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps equal public geometry and texture ids independent and leases alive across retirement", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), sharedGeometry = { ...geometry, id: "shared" }, sharedTexture = { ...texture, id: "shared" };
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 136, maxUploadBytesPerFrame: 136 }, request => request.kind === "geometry"
          ? { kind: "geometry", source: sharedGeometry }
          : { kind: "texture", source: { level: request.level, texture: sharedTexture } });
      runtime.register({ id: "shared", revision: 1, kind: "geometry", levels: [{ level: 0, byteLength: 132 }] });
      runtime.register({ id: "shared", revision: 1, kind: "texture", levels: [{ level: 0, byteLength: 4 }] });
      const result = await runtime.submit(1, [
        { id: "shared", kind: "geometry", desiredLevel: 0, required: true },
        { id: "shared", kind: "texture", desiredLevel: 0, required: true },
      ]);
      expect(result.execution?.commit.appliedUploads).toHaveLength(2);
      expect(result.execution?.commit.appliedUploads).toEqual(expect.arrayContaining([
        { id: "shared", kind: "geometry" }, { id: "shared", kind: "texture" },
      ]));
      expect(runtime.residentCount).toBe(2);
      const lease = runtime.acquire("geometry", "shared");
      expect(lease?.resource.kind).toBe("geometry");
      runtime.dispose();
      expect(f.owned.size).toBe(2); expect(runtime.retiredBytes).toBe(132);
      lease?.release(); expect(f.owned.size).toBe(0); expect(runtime.retiredBytes).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("maps logical geometry levels to distinct physical payload ids", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), sourceIds: string[] = [];
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 132, maxUploadBytesPerFrame: 132 }, request => {
          sourceIds.push(request.id);
          return { kind: "geometry", source: { ...geometry, id: request.id } };
        });
      runtime.register({ id: "hero", revision: 1, kind: "geometry", levels: [
        { level: 0, byteLength: 132, sourceId: "hero-high" },
        { level: 1, byteLength: 132, sourceId: "hero-low" },
      ] });
      const result = await runtime.submit(1, [
        { id: "hero", kind: "geometry", desiredLevel: 1, required: true },
      ]);
      expect(result.execution?.commit.appliedUploads).toEqual([{ id: "hero", kind: "geometry" }]);
      expect(sourceIds).toEqual(["hero-low"]); expect(runtime.get("geometry", "hero")?.level).toBe(1);
      const lease = runtime.acquire("geometry", "hero");
      expect(lease?.resource.kind === "geometry" && lease.resource.sourceId).toBe("hero-low");
      lease?.release(); runtime.dispose(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("accounts retired leased bytes before accepting another streaming frame", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture();
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 264, maxUploadBytesPerFrame: 132 }, request => ({
          kind: "geometry", source: { ...geometry, revision: request.revision },
        }));
      runtime.register({ id: "mesh", revision: 1, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      await runtime.submit(1, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]);
      const old = runtime.acquire("geometry", "mesh");
      runtime.register({ id: "mesh", revision: 2, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      await runtime.submit(2, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]);
      expect(runtime.retiredBytes).toBe(132); expect(runtime.get("geometry", "mesh")?.revision).toBe(2);
      await expect(runtime.submit(3, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]))
        .rejects.toThrow("must be released");
      old?.release(); expect(runtime.retiredBytes).toBe(0);
      await expect(runtime.submit(3, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]))
        .resolves.toMatchObject({ status: "applied" });
      runtime.dispose(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects oversized public identities before allocating internal keys", () => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 132, maxUploadBytesPerFrame: 132 }, () => {
          throw new Error("source must not be requested");
        });
      const id = "x".repeat(257);
      expect(() => runtime.register({ id, revision: 1, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] })).toThrow("identity is invalid");
      expect(() => runtime.get("geometry", id)).toThrow("identity is invalid");
      expect(runtime.resourceCount).toBe(0);
      runtime.dispose();
    } finally { vi.unstubAllGlobals(); }
  });

  it("blocks an upload when its prerequisite eviction retires a leased resource", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const f = fixture(), runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 132, maxUploadBytesPerFrame: 132 }, request => ({
          kind: "geometry", source: { ...geometry, id: request.id },
        }));
      for (const id of ["first", "second"]) runtime.register({
        id, revision: 1, kind: "geometry", levels: [{ level: 0, byteLength: 132 }],
      });
      await runtime.submit(1, [{ id: "first", kind: "geometry", desiredLevel: 0 }]);
      const lease = runtime.acquire("geometry", "first")!;
      const blocked = await runtime.submit(2, [
        { id: "second", kind: "geometry", desiredLevel: 0, required: true },
      ]);
      expect(blocked.execution?.commit.failedUploads).toEqual([{ id: "second", kind: "geometry" }]);
      expect(blocked.execution?.uploadFailures[0]?.reason).toMatchObject({
        message: "GPU upload is blocked by leased resources retired before upload.",
      });
      expect(runtime.get("geometry", "first")).toBeUndefined();
      expect(runtime.get("geometry", "second")).toBeUndefined();
      expect(runtime.retiredBytes).toBe(132);
      lease.release();
      await expect(runtime.submit(3, [
        { id: "second", kind: "geometry", desiredLevel: 0, required: true },
      ])).resolves.toMatchObject({ status: "applied" });
      runtime.dispose(); expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
