import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneChunkResidency } from "./sceneChunkResidency.js";
import { chunkGpuFixture, chunkPacket, prefetch, visible } from "./sceneChunkResidency.testUtils.js";

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("scene chunk residency integration", () => {
  it("deduplicates exact cross-chunk identities under one runtime budget", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    scene.registerChunk("west", chunkPacket("shared-mesh", "shared-base", 0, "west"));
    scene.registerChunk("east", chunkPacket("shared-mesh", "shared-base", 0, "east"));

    const frame = await scene.update({ frame: 1, chunks: [visible("west"), visible("east")] });

    expect(scene.submittedFrameCount).toBe(1);
    expect(frame.chunks.map(value => value.key)).toEqual(["west", "east"]);
    expect(frame.chunk("west")?.geometry("shared-mesh")?.mesh)
      .toBe(frame.chunk("east")?.geometry("shared-mesh")?.mesh);
    expect(frame.chunk("west")?.texture("shared-base")?.texture)
      .toBe(frame.chunk("east")?.texture("shared-base")?.texture);
    expect(gpu.device.createBuffer).toHaveBeenCalledTimes(2);
    expect(gpu.device.createTexture).toHaveBeenCalledOnce();
    expect(scene.telemetrySnapshot()).toMatchObject({ registeredResourceCount: 2,
      residentResourceCount: 2, residentBytes: 152, lastAppliedFrame: { frame: 1 } });
    frame.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("keeps required visible closure when optional prefetch exceeds the budget", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    scene.registerChunk("visible", chunkPacket("mesh-visible", "base-visible", 0, "v"));
    scene.registerChunk("nearby", chunkPacket("mesh-prefetch", "base-prefetch", 1, "p"));

    const frame = await scene.update({ frame: 4,
      chunks: [visible("visible"), prefetch("nearby")] });

    expect(scene.submittedFrameCount).toBe(1);
    expect(frame.chunks.map(value => value.key)).toEqual(["visible"]);
    expect(frame.chunk("visible")?.geometry("mesh-visible")).toBeDefined();
    expect(frame.chunk("nearby")).toBeUndefined();
    expect(scene.telemetrySnapshot()).toMatchObject({ residentBytes: 152, residentResourceCount: 2 });
    const residents = scene.telemetrySnapshot().resources.map(value => value.id);
    expect(residents).toEqual(expect.arrayContaining(["mesh-visible", "base-visible"]));
    expect(residents).not.toEqual(expect.arrayContaining(["mesh-prefetch", "base-prefetch"]));
    frame.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("warms a prefetch chunk without a lease and reuses it when the chunk becomes visible", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    scene.registerChunk("ahead", chunkPacket("ahead-mesh", "ahead-base", 0, "ahead"));
    const warm = await scene.update({ frame: 1, chunks: [prefetch("ahead")] });
    const buffers = gpu.device.createBuffer.mock.calls.length;
    const textures = gpu.device.createTexture.mock.calls.length;

    const visibleFrame = await scene.update({ frame: 2, chunks: [visible("ahead")] });

    expect(warm.chunks).toEqual([]);
    expect(visibleFrame.chunk("ahead")?.geometry("ahead-mesh")).toBeDefined();
    expect(gpu.device.createBuffer).toHaveBeenCalledTimes(buffers);
    expect(gpu.device.createTexture).toHaveBeenCalledTimes(textures);
    warm.release(); visibleFrame.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("keeps a visible projection publishable when an optional prefetch upload fails", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 304, maxUploadBytesPerFrame: 304 });
    scene.registerChunk("visible", chunkPacket("stable-mesh", "stable-base", 0, "stable"));
    scene.registerChunk("prefetch", chunkPacket("fault-mesh", "fault-base", 1, "fault"));
    const stable = await scene.update({ frame: 1, chunks: [visible("visible")] });
    stable.release(); gpu.failTexture(true);

    const frame = await scene.update({ frame: 2,
      chunks: [visible("visible"), prefetch("prefetch")] });

    expect(frame.chunk("visible")?.texture("stable-base")).toBeDefined();
    expect(frame.chunk("prefetch")).toBeUndefined();
    gpu.failTexture(false); frame.release();
    const cleanup = await scene.update({ frame: 3, chunks: [visible("visible")] });
    cleanup.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("evicts an omitted chunk and accounts its live leases as retired bytes", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 304, maxUploadBytesPerFrame: 304 });
    scene.registerChunk("old", chunkPacket("mesh-old", "base-old", 0, "old"));
    scene.registerChunk("next", chunkPacket("mesh-next", "base-next", 1, "next"));
    const old = await scene.update({ frame: 1, chunks: [visible("old")] });

    const empty = await scene.update({ frame: 2, chunks: [] });

    expect(empty.chunks).toEqual([]);
    expect(scene.telemetrySnapshot()).toMatchObject({ residentBytes: 0, retiredBytes: 152 });
    old.release(); expect(scene.telemetrySnapshot().retiredBytes).toBe(0);
    const next = await scene.update({ frame: 3, chunks: [visible("next")] });
    expect(next.chunk("next")?.geometry("mesh-next")).toBeDefined();
    empty.release(); next.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("isolates registered bytes and planning metadata from later caller mutation", async () => {
    const gpu = chunkGpuFixture(), source = chunkPacket("isolated-mesh", "isolated-base", 2, "object");
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    const batchKey = source.batches[0]!.key;
    scene.registerChunk("isolated", source);
    source.geometries.get("isolated-mesh")!.vertices[0] = 99;
    source.textures[0]!.levels[0]!.data[0] = 99;
    source.geometries.delete("isolated-mesh");

    const frame = await scene.update({ frame: 1, chunks: [{ key: "isolated", mode: "visible",
      demands: [{ batchKey }] }] });

    const vertexUpload = gpu.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array;
    const textureUpload = gpu.device.queue.writeTexture.mock.calls[0]?.[1] as Uint8Array;
    expect(vertexUpload[0]).toBe(2); expect(textureUpload[0]).toBe(13);
    expect(frame.chunk("isolated")?.batches).toHaveLength(1);
    frame.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });
});
