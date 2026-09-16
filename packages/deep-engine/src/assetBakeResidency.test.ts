import { afterEach, describe, expect, it, vi } from "vitest";
import { bakeCandidateBinding, bakeRenderPacketForResidency } from "./assetBakeResidency.js";
import type { GeometryResource, RenderPacket } from "./renderPacketTypes.js";
import type { DeviceSession } from "./webgpu/deviceSession.js";
import { createPacketResidencyCatalog } from "./webgpu/packetResidencyCatalog.js";
import { PacketLodSceneCache } from "./webgpu/packetLodSceneCache.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function geometry(id: string, triangles: 1 | 2): GeometryResource {
  return { id, revision: 1, vertices: new Float32Array([
    -1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1,
    1, 1, 0, 0, 0, 1, -1, 1, 0, 0, 0, 1,
  ]), uv0: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array(triangles === 2 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]) };
}
function packet(): RenderPacket {
  return { geometries: [geometry("high", 2), geometry("low", 1)],
    materials: [{ id: "surface", baseColor: [0.2, 0.4, 0.8], metallic: 0.1, roughness: 0.7 }],
    instances: [{ id: "object", geometry: "high", material: "surface", transform: TRANSFORM,
      lod: { levels: [
        { geometry: "high", minProjectedDiameterPixels: 96, geometricError: 0 },
        { geometry: "low", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }], textures: [] };
}
afterEach(() => vi.unstubAllGlobals());

describe("baked residency packet publication", () => {
  it("exposes immutable candidate bake identity", () => {
    const binding = bakeCandidateBinding(bakeRenderPacketForResidency(packet()));
    expect(binding.cacheKey).toContain("deep.bake-residency.v1:");
    expect(binding.geometries[0]).toMatchObject({ revision: 1, meshletCount: expect.any(Number), meshletHash: expect.any(String) });
    expect(Object.isFrozen(binding)).toBe(true);
  });
  it("publishes deterministic meshlet ranges and LOD fallback into the existing residency ABI", () => {
    const first = bakeRenderPacketForResidency(packet());
    const second = bakeRenderPacketForResidency(packet());
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.batches).toEqual(second.batches);
    expect(first.batches[0]).toMatchObject({ fallbackGeometry: "low", levels: [
      { geometry: "high", triangles: 2, resident: true, meshletOffset: 0, meshletCount: 1 },
      { geometry: "low", triangles: 1, resident: true, meshletOffset: 1, meshletCount: 1 },
    ] });
    const bakedHigh = first.bake.geometries.find(value => value.id === "high")!;
    expect(first.packet.geometries.get("high")!.indices).toBe(bakedHigh.indices.indices);
    expect(first.packet.batches[0]!.lod!.levels.map(level =>
      [level.geometry, level.meshletOffset, level.meshletCount]))
      .toEqual([["high", 0, 1], ["low", 1, 1]]);
    expect(createPacketResidencyCatalog(first.packet).requests.map(value => value.id).sort())
      .toEqual(["high", "low"]);
  });

  it("hashes material, UV, and instance LOD inputs beyond the meshlet index payload", () => {
    const base = bakeRenderPacketForResidency(packet());
    const uv = packet(); uv.geometries[0]!.uv0![0] = 0.25;
    const material = packet(); (material.materials[0]!.baseColor as number[])[0] = 0.4;
    const lod = packet(); (lod.instances[0]!.lod!.levels[0] as { geometricError: number }).geometricError = 0.2;
    expect(bakeRenderPacketForResidency(uv).cacheKey).not.toBe(base.cacheKey);
    expect(bakeRenderPacketForResidency(material).cacheKey).not.toBe(base.cacheKey);
    expect(bakeRenderPacketForResidency(lod).cacheKey).not.toBe(base.cacheKey);
  });

  it("packs baked meshlet ranges into the production GPU LOD scene input", () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_DST: 8 });
    let levelData: ArrayBuffer | undefined;
    const session = { state: "ready", device: {
      createBuffer: vi.fn(({ label }: GPUBufferDescriptor) => ({ label, destroy: vi.fn() })),
      queue: { writeBuffer: vi.fn((buffer: { label: string }, _offset: number,
        data: ArrayBuffer) => { if (buffer.label === "Deep packet LOD levels") levelData = data.slice(0); }) },
    }, own: <T>(value: T): T => value, release: vi.fn() } as unknown as DeviceSession;
    const baked = bakeRenderPacketForResidency(packet()), source = baked.packet.batches[0]!;
    const geometries = new Map([...baked.packet.geometries].map(([id, value]) => [id,
      { source: value, mesh: {} as never, center: [0, 0, 0] as const, radius: 2 }]));
    const cache = new PacketLodSceneCache(session);
    cache.prepare([{ source, buffer: {} as GPUBuffer, capacity: source.data.byteLength,
      previousBuffer: {} as GPUBuffer, previousCapacity: 48,
      previousTransforms: new Float32Array(12) }], geometries, geometries, 1);

    const words = new Uint32Array(levelData!);
    expect([words[3], words[4], words[8], words[9]]).toEqual([0, 1, 1, 1]);
    cache.clear();
  });

  it("fails closed on budgets, cancellation, and a missing coarsest fallback", () => {
    expect(() => bakeRenderPacketForResidency(packet(), { maxInputBytes: 1 })).toThrow("byte budget");
    expect(() => bakeRenderPacketForResidency(packet(), { maxMeshlets: 1 })).toThrow("meshlet budget");
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    let cancellation: unknown;
    try { bakeRenderPacketForResidency(packet(), { signal: controller.signal }); }
    catch (error) { cancellation = error; }
    expect(cancellation).toMatchObject({ name: "AbortError", message: "cancelled" });
    const invalid = packet();
    const levels = invalid.instances[0]!.lod!.levels as unknown as Array<{ geometry: string;
      minProjectedDiameterPixels: number; geometricError: number; resident?: boolean }>;
    levels[1] = { ...levels[1]!, resident: false };
    expect(() => bakeRenderPacketForResidency(invalid)).toThrow("coarsest");
  });
});
