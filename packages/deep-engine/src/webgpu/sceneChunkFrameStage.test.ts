import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneChunkResidency } from "./sceneChunkResidency.js";
import { chunkGpuFixture, chunkPacket, visible } from "./sceneChunkResidency.testUtils.js";
import { stageSceneChunkFrame } from "./sceneChunkFrameStage.js";
import { PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, type Pipelines } from "./pipelines.js";
import { snapshotResidencyPacket } from "./packetResidencySnapshot.js";
import { mergeSceneChunkProjections } from "./sceneChunkFrameProjection.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, UNIFORM: 64 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());
async function fixture(duplicate: "batch" | "instance" | undefined = undefined) {
  const f = chunkGpuFixture();
  Object.assign(f.session.device, { createBindGroup: vi.fn(() => ({})) });
  const scene = createSceneChunkResidency(f.session, { maxResidentBytes: 1_000_000, maxUploadBytesPerFrame: 1_000_000 });
  const a = chunkPacket("shared-mesh", "shared-texture", 0, "one");
  const b = chunkPacket("shared-mesh", "shared-texture", 0, duplicate === "instance" ? "one" : "two");
  scene.registerChunk("a", { ...a, batches: a.batches.map(batch => ({ ...batch, key: "a", castShadow: false })) });
  scene.registerChunk("b", { ...b, batches: b.batches.map(batch => ({ ...batch, key: duplicate === "batch" ? "a" : "b" })) });
  const frame = await scene.update({ frame: 1, chunks: [visible("a"), visible("b")] });
  const buffers = new PacketBuffers(f.session, { material: {} as GPUBindGroupLayout });
  const target = {
    stageResidentPacketValidated: vi.fn(async (projection: ResidentPacketProjection, signal?: AbortSignal) => { await buffers.stageResidentProjectionValidated(projection, signal); }),
    cancelResidentPacketStage: () => buffers.cancelPendingPacketStage(),
  };
  return { ...f, scene, frame, buffers, target };
}

describe("scene frame loading and formal packet draw", () => {
  it.each(["success", "failure", "abort"] as const)("keeps drawing the old frame while resident validation awaits %s", async result => {
    const f = await fixture(); await stageSceneChunkFrame(f.target, f.frame); f.buffers.publishResidentProjection();
    const next = await f.scene.update({ frame: 2, chunks: [visible("a")] });
    let finish!: (value: GPUError | null) => void;
    f.device.popErrorScope.mockReturnValueOnce(new Promise<GPUError | null>(resolve => { finish = resolve; }));
    const controller = new AbortController(), pending = stageSceneChunkFrame(f.target, next, controller.signal);
    for (let index = 0; index < 3; index++) {
      expect(f.buffers.publishResidentProjection()).toBe(false);
      expect(f.frame.released).toBe(false); expect(next.released).toBe(false);
      const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn() };
      const pipelines = { mainPipelines: new Map([[mainPipelineKey("material", false, "ccw"), {}]]), shadowPipelines: new Map() } as unknown as Pipelines;
      expect(f.buffers.draw(pass as unknown as GPURenderPassEncoder, pipelines, "opaque").drawCalls).toBe(2);
    }
    if (result === "abort") controller.abort();
    finish(result === "failure" ? { message: "late validation failure" } as GPUError : null);
    if (result === "success") {
      await pending; expect(f.frame.released).toBe(false);
      expect(f.buffers.publishResidentProjection()).toBe(true); expect(f.frame.released).toBe(true);
    } else {
      await expect(pending).rejects.toThrow(); expect(next.released).toBe(true);
      expect(f.buffers.publishResidentProjection()).toBe(false); expect(f.frame.released).toBe(false);
    }
    f.buffers.dispose(); f.scene.dispose(); expect(f.owned.size).toBe(0);
  });
  it("stages both chunks once, shares leases, and publishes both into one draw pass", async () => {
    const f = await fixture();
    const shared = f.frame.chunk("a")!.geometry("shared-mesh");
    expect(shared).toBe(f.frame.chunk("b")!.geometry("shared-mesh"));
    const uploads = f.device.queue.writeTexture.mock.calls.length;
    await stageSceneChunkFrame(f.target, f.frame);
    expect(f.target.stageResidentPacketValidated).toHaveBeenCalledOnce();
    const projection = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    expect(projection.batches).toHaveLength(2); expect(projection.batches[0]!.source.castShadow).toBe(false);
    f.frame.release(); expect(projection.released).toBe(false);
    expect(() => f.frame.takeProjection()).toThrow(/transferred/);
    expect(f.buffers.publishResidentProjection()).toBe(true);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn() };
    const pipelines = { mainPipelines: new Map([[mainPipelineKey("material", false, "ccw"), {}]]), shadowPipelines: new Map() } as unknown as Pipelines;
    expect(f.buffers.draw(pass as unknown as GPURenderPassEncoder, pipelines, "opaque")).toEqual({ drawCalls: 2, triangles: 2 });
    expect(pass.drawIndexed).toHaveBeenCalledTimes(2); expect(f.device.queue.writeTexture.mock.calls.length).toBe(uploads);
    f.buffers.dispose(); expect(f.frame.released).toBe(true); f.scene.dispose(); expect(f.owned.size).toBe(0);
  });
  it.each(["batch", "instance"] as const)("rejects duplicate %s before staging and returns every lease", async duplicate => {
    const f = await fixture(duplicate);
    await expect(stageSceneChunkFrame(f.target, f.frame)).rejects.toThrow(/Duplicate scene chunk/);
    expect(f.target.stageResidentPacketValidated).not.toHaveBeenCalled(); expect(f.frame.released).toBe(true);
    f.buffers.dispose(); f.scene.dispose(); expect(f.owned.size).toBe(0);
  });
  it.each(["abort", "validation"] as const)("rolls back the complete candidate on %s", async mode => {
    const f = await fixture(), controller = new AbortController();
    if (mode === "abort") controller.abort();
    else f.device.popErrorScope.mockResolvedValueOnce({ message: "injected validation" } as GPUError);
    await expect(stageSceneChunkFrame(f.target, f.frame, controller.signal)).rejects.toThrow();
    expect(f.frame.released).toBe(true); expect(f.buffers.publishResidentProjection()).toBe(false);
    f.buffers.dispose(); f.scene.dispose(); expect(f.owned.size).toBe(0);
  });
  it("publishes an empty scene frame and retires the previous complete projection", async () => {
    const f = await fixture(); await stageSceneChunkFrame(f.target, f.frame); f.buffers.publishResidentProjection();
    const empty = await f.scene.update({ frame: 2, chunks: [] });
    await stageSceneChunkFrame(f.target, empty); f.buffers.publishResidentProjection();
    expect(f.frame.released).toBe(true); expect(empty.released).toBe(false);
    f.buffers.dispose(); f.scene.dispose(); expect(empty.released).toBe(true); expect(f.owned.size).toBe(0);
  });
  it("refuses deformation before snapshotting can erase its unsupported fields", () => {
    const packet = chunkPacket();
    expect(() => snapshotResidencyPacket({ ...packet, batches: packet.batches.map(batch => ({ ...batch, pose: "pose" })) })).toThrow();
  });
  it.each(["source", "handle"] as const)("rejects conflicting shared geometry %s and cleans up all children", async kind => {
    const f = await fixture(), first = f.frame.chunk("a")!, second = f.frame.chunk("b")!;
    const altered: ResidentPacketProjection = {
      batches: second.batches, released: false, partialLod: true,
      geometry: id => { const value = second.geometry(id); return value && kind === "handle" ? { ...value } : value; },
      geometrySource: id => { const source = second.geometrySource(id); if (source && kind === "source") source.vertices[0] = 99; return source; },
      texture: id => second.texture(id), textureSource: id => second.textureSource(id), release: () => second.release(),
    };
    expect(() => mergeSceneChunkProjections([first, altered], vi.fn())).toThrow(/Conflicting scene chunk/);
    expect(first.released).toBe(true); expect(second.released).toBe(true);
    f.buffers.dispose(); f.scene.dispose(); expect(f.owned.size).toBe(0);
  });
  it("aborts during GPU validation without publishing a partial frame", async () => {
    const f = await fixture(), controller = new AbortController();
    let resolve!: (error: GPUError | null) => void;
    f.device.popErrorScope.mockReturnValueOnce(new Promise<GPUError | null>(done => { resolve = done; }));
    const pending = stageSceneChunkFrame(f.target, f.frame, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow();
    resolve(null); await Promise.resolve();
    expect(f.frame.released).toBe(true); expect(f.buffers.publishResidentProjection()).toBe(false);
    f.buffers.dispose(); f.scene.dispose(); expect(f.owned.size).toBe(0);
  });
  it("keeps the complete active frame when replacement GPU validation fails", async () => {
    const f = await fixture(); await stageSceneChunkFrame(f.target, f.frame); f.buffers.publishResidentProjection();
    const next = await f.scene.update({ frame: 2, chunks: [visible("a")] });
    f.device.popErrorScope.mockResolvedValueOnce({ message: "replacement failed" } as GPUError);
    await expect(stageSceneChunkFrame(f.target, next)).rejects.toThrow();
    expect(next.released).toBe(true); expect(f.frame.released).toBe(false);
    expect(f.buffers.publishResidentProjection()).toBe(false);
    f.buffers.dispose(); f.scene.dispose(); expect(f.frame.released).toBe(true); expect(f.owned.size).toBe(0);
  });
});
