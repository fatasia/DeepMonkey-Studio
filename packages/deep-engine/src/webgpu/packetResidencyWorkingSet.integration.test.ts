import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareRenderPacket,
  type GeometryResource,
  type PreparedPacket,
} from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { createPacketResidencyDomain } from "./packetResidencyDomain.js";
import { createPacketResidencyWorkingSet } from "./packetResidencyWorkingSet.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, triangles: number): GeometryResource {
  return { id, revision: triangles,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
      1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1].slice(0, triangles * 3)) };
}

function packet(): PreparedPacket {
  return prepareRenderPacket({
    geometries: [geometry("fine", 3), geometry("middle", 2), geometry("coarse", 1)],
    textures: [{ id: "base", revision: 4, semantic: "baseColor", width: 4, height: 4,
      data: new Uint8Array(64), mipmaps: [
        { width: 2, height: 2, data: new Uint8Array(16) },
        { width: 1, height: 1, data: new Uint8Array(4) },
      ] }],
    materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: "base" } }],
    instances: [{ id: "object", geometry: "fine", material: "material", transform: TRANSFORM,
      lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "middle", minProjectedDiameterPixels: 30, geometricError: 0.5 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
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
  return { session, device, owned };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("PacketResidencyWorkingSet domain integration", () => {
  it("loads only demanded detail plus drawable fallback and selected mip suffix", async () => {
    const gpu = gpuFixture(), prepared = packet();
    const domain = createPacketResidencyDomain(gpu.session,
      { maxResidentBytes: 1_000_000, maxUploadBytesPerFrame: 1_000_000 });
    const ticket = domain.registerPacket("scene", prepared);
    const working = createPacketResidencyWorkingSet(domain, ticket, prepared);
    const batch = prepared.batches[0]!;

    const result = await working.load({ frame: 1,
      demands: [{ batchKey: batch.key, desiredLod: 1 }],
      textureMipLevels: new Map([["base", 1]]) });

    expect(result.geometry("fine")).toBeUndefined();
    expect(result.geometry("middle")).toBeDefined();
    expect(result.geometry("coarse")).toBeDefined();
    expect(result.texture("base")).toMatchObject({ level: 1, mipLevelCount: 2, byteLength: 20 });
    expect(gpu.device.createBuffer).toHaveBeenCalledTimes(4);
    expect(gpu.device.createTexture).toHaveBeenCalledOnce();
    result.release(); working.dispose(); domain.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("rejects a ticket from another domain before creating GPU resources", async () => {
    const gpuA = gpuFixture(), gpuB = gpuFixture(), prepared = packet();
    const budgets = { maxResidentBytes: 1_000_000, maxUploadBytesPerFrame: 1_000_000 };
    const domainA = createPacketResidencyDomain(gpuA.session, budgets);
    const domainB = createPacketResidencyDomain(gpuB.session, budgets);
    const foreign = domainA.registerPacket("foreign", prepared);
    const working = createPacketResidencyWorkingSet(domainB, foreign, prepared);

    await expect(working.load({ frame: 1, demands: [] }))
      .rejects.toMatchObject({ code: "unbound-runtime" });
    expect(gpuB.device.createBuffer).not.toHaveBeenCalled();
    expect(gpuB.device.createTexture).not.toHaveBeenCalled();
    working.dispose(); domainA.dispose(); domainB.dispose();
    expect(gpuA.owned.size + gpuB.owned.size).toBe(0);
  });
});
