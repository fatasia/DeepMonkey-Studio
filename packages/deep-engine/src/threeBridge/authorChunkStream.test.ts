import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import { chunkGeometry, chunkGpuFixture, chunkTexture } from "../webgpu/sceneChunkResidency.testUtils.js";
import { PacketBuffers } from "../webgpu/packetBuffers.js";
import type { ResidentPacketProjection } from "../webgpu/residentPacketProjection.js";
import { AuthorChunkCatalog } from "./authorChunkCatalog.js";
import { AuthorChunkStream } from "./authorChunkStream.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";
import { bridge, mesh } from "./testFixture.js";

const view: RenderView = { width: 100, height: 100, pixelRatio: 1, eye: [0, 0, 5], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };
function packet(x = 0, revision = 3): RenderPacket {
  return { geometries: [{ ...chunkGeometry("mesh"), revision }], textures: [chunkTexture("texture")],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1, baseColorTexture: { texture: "texture" } }],
    instances: [{ id: "one", geometry: "mesh", material: "mat", castShadow: false,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] }] };
}
function fixture(meshlets = false) {
  const f = chunkGpuFixture(); Object.assign(f.session.device, { createBindGroup: vi.fn(() => ({})) });
  const buffers = new PacketBuffers(f.session, { material: {} as GPUBindGroupLayout });
  const target = { session: f.session,
    stageResidentPacketValidated: vi.fn(async (projection: ResidentPacketProjection, signal?: AbortSignal) => {
      await buffers.stageResidentProjectionValidated(projection, signal);
    }), cancelResidentPacketStage: vi.fn(() => buffers.cancelPendingPacketStage()) };
  const stream = new AuthorChunkStream(target, meshlets);
  return { ...f, buffers, target, stream, clean() { stream.dispose(); buffers.dispose(); expect(f.owned.size).toBe(0); } };
}
beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, UNIFORM: 64 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());
describe("author chunk formal staging", () => {
  it.each([false, true])("forwards meshlets=%s through the resident geometry uploader", async enabled => {
    const f = fixture(enabled); await f.stream.sync(packet(), true, view);
    const mesh = f.target.stageResidentPacketValidated.mock.calls[0]![0].geometry("mesh")!.mesh;
    expect(mesh.meshletFallback).toBe(enabled ? "small-geometry" : undefined); f.clean();
  });
  it("accepts an entirely empty author packet without Infinity bounds or static allocations", async () => {
    const f = fixture(); await f.stream.sync({ geometries: [], materials: [], instances: [] }, true, view);
    expect(f.stream.diagnostics).toMatchObject({ chunkCount: 0, visibleChunks: 0, residentGpuBytes: 0 });
    f.buffers.publishResidentProjection();
    expect(f.target.stageResidentPacketValidated.mock.calls[0]![0].batches).toEqual([]);
    expect(f.target.stageResidentPacketValidated.mock.calls[0]![0].released).toBe(false);
    expect(f.device.createTexture).not.toHaveBeenCalled(); f.clean();
  });
  it("updates transforms with existing geometry and texture handles and no static uploads", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    const first = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    const geometry = first.geometry("mesh"), texture = first.texture("texture");
    const textureUploads = f.device.queue.writeTexture.mock.calls.length;
    const staticBuffers = [geometry!.mesh.vertices, geometry!.mesh.indices, geometry!.mesh.tangents];
    const staticWrites = f.device.queue.writeBuffer.mock.calls.filter(call => staticBuffers.includes(call[0])).length;
    expect(staticWrites).toBeGreaterThan(0);
    await f.stream.sync(packet(1), false, view);
    const next = f.target.stageResidentPacketValidated.mock.calls[1]![0];
    expect(next.geometry("mesh")).toBe(geometry); expect(next.texture("texture")).toBe(texture);
    expect(next.batches[0]!.source.data[3]).toBe(1);
    expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(textureUploads);
    expect(f.device.queue.writeBuffer.mock.calls.filter(call => staticBuffers.includes(call[0]))).toHaveLength(staticWrites);
    f.buffers.publishResidentProjection(); expect(first.released).toBe(true); f.clean();
  });
  it("retains every real author LOD level while selection revisions update only frame metadata", async () => {
    const f = fixture();
    const source = (revision: number, selectedLevels: readonly number[]): RenderPacket => {
      const base = packet(); return { ...base, geometries: [...base.geometries, chunkGeometry("low")],
        instances: base.instances.map(instance => ({ ...instance, lod: { strategy: "author-selected", revision,
          levels: [{ geometry: "mesh", distance: 0, hysteresis: 0 }, { geometry: "low", distance: 10, hysteresis: 0 }], selectedLevels } })) };
    };
    await f.stream.sync(source(1, [0]), true, view); f.buffers.publishResidentProjection();
    const first = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    for (const selected of [[], [1], [0, 1]]) {
      await f.stream.sync(source(selected.length + 2, selected), false, view);
      const next = f.target.stageResidentPacketValidated.mock.calls.at(-1)![0];
      expect(next.geometry("mesh")).toBe(first.geometry("mesh")); expect(next.geometry("low")).toBe(first.geometry("low"));
      expect(next.batches[0]!.source.lod).toMatchObject({ strategy: "author-selected", selectedLevels: selected });
      f.buffers.publishResidentProjection();
    }
    f.clean();
  });
  it("keeps active catalog and projection after candidate upload failure, then retries", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    const active = f.target.stageResidentPacketValidated.mock.calls[0]![0], before = f.stream.diagnostics;
    f.failTexture(true); await expect(f.stream.sync(packet(1, 4), true, view)).rejects.toThrow();
    expect(active.released).toBe(false); expect(f.stream.diagnostics).toBe(before);
    expect(f.buffers.publishResidentProjection()).toBe(false);
    f.failTexture(false); await f.stream.sync(packet(1, 4), true, view); f.buffers.publishResidentProjection();
    expect(active.released).toBe(true); f.clean();
  });
  it("releases a staged candidate cancelled immediately after validation", async () => {
    const f = fixture(), controller = new AbortController();
    const original = f.target.stageResidentPacketValidated.getMockImplementation()!;
    f.target.stageResidentPacketValidated.mockImplementationOnce(async (...args) => { await original(...args); controller.abort(); });
    await expect(f.stream.sync(packet(), true, view, controller.signal)).rejects.toThrow();
    expect(f.buffers.publishResidentProjection()).toBe(false); expect(f.stream.hasCatalog).toBe(false); f.clean();
  });
  it("does not build a static catalog for deformation and preserves active leases until full publication", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    expect(await f.stream.sync({ ...packet(), deformation: {} as never }, true, view)).toBe(false);
    expect(f.stream.hasCatalog).toBe(true); f.stream.fullPacketPublished("deformation");
    expect(f.stream.diagnostics.path).toBe("full-packet"); f.clean();
  });
  it("rejects pre-aborted work without allocations and permits a subsequent frame", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.stream.sync(packet(), true, view, controller.signal)).rejects.toThrow();
    expect(f.owned.size).toBe(0); await f.stream.sync(packet(), true, view); f.clean();
  });
  it("cancels queued work on dispose and never touches borrowed author arrays", async () => {
    const f = fixture(), source = packet(), before = source.geometries[0]!.vertices.slice();
    const pending = f.stream.sync(source, true, view); f.stream.dispose();
    await expect(pending).rejects.toThrow(); expect(source.geometries[0]!.vertices).toEqual(before); f.clean();
  });
  it("streams an empty required set and restores visibility on camera return", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    await f.stream.sync(packet(100), false, view); f.buffers.publishResidentProjection();
    expect(f.stream.diagnostics.visibleChunks).toBe(0);
    await f.stream.sync(packet(), false, view); f.buffers.publishResidentProjection();
    expect(f.stream.diagnostics.visibleChunks).toBe(1); f.clean();
  });
  it("connects the real Three backend sync to a single resident stage and preserves ordinary legacy default", async () => {
    const f = fixture(), author = mesh(); author.updateMatrixWorld(true);
    const runtime = { ...f.target, id: "deep-webgpu", setPacketValidated: vi.fn(async () => {}),
      updateInstances: vi.fn(), render: vi.fn(), validateFrame: vi.fn(), dispose: vi.fn(() => f.buffers.dispose()) };
    const backend = new DeepWebGpuBackend(runtime, bridge(), { authorChunks: true });
    await backend.sync(author, 1, undefined, view); f.buffers.publishResidentProjection();
    expect(runtime.setPacketValidated).not.toHaveBeenCalled(); expect(backend.chunkStreaming?.chunkCount).toBe(1);
    author.position.x = 1; author.updateMatrixWorld(true); await backend.sync(author, 1, undefined, view);
    expect(f.target.stageResidentPacketValidated).toHaveBeenCalledTimes(2); expect(runtime.updateInstances).not.toHaveBeenCalled();
    backend.dispose(); expect(f.owned.size).toBe(0);
    const legacy = new DeepWebGpuBackend({ ...runtime, dispose: vi.fn() }, bridge());
    await legacy.sync(author, 1, undefined, view); expect(runtime.setPacketValidated).toHaveBeenCalledOnce(); legacy.dispose();
  });
  it("restores demand metadata after validation failure and supersedes concurrent queued updates", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    f.device.popErrorScope.mockResolvedValueOnce({ message: "validation" } as GPUError);
    await expect(f.stream.sync(packet(100), false, view)).rejects.toThrow();
    expect(f.stream.diagnostics.visibleChunks).toBe(1);
    const superseded = f.stream.sync(packet(2), false, view);
    const newest = f.stream.sync(packet(1), false, view);
    await expect(superseded).rejects.toThrow(); await newest;
    expect(f.target.stageResidentPacketValidated.mock.calls.at(-1)![0].batches[0]!.source.data[3]).toBe(1); f.clean();
  });
});
describe("author chunk spatial demand", () => {
  it("omits remote non-casters but keeps remote shadow casters required", () => {
    expect(new AuthorChunkCatalog(packet(100)).demand(view)).toEqual([]);
    const source = packet(100);
    const catalog = new AuthorChunkCatalog({ ...source, instances: source.instances.map(value => ({ ...value, castShadow: true })) });
    expect(catalog.demand(view)).toMatchObject([{ mode: "visible" }]);
  });
  it("keeps author data unchanged and stable chunk identity across transforms", () => {
    const source = packet(), snapshot = source.geometries[0]!.vertices.slice(), catalog = new AuthorChunkCatalog(source);
    expect(catalog.update(packet(2))).toBe(true); expect(catalog.chunks[0]!.key).toBe("author-chunk-0");
    expect(source.geometries[0]!.vertices).toEqual(snapshot); expect(source.instances[0]!.transform[12]).toBe(0);
  });
});
