import { describe, expect, it, vi } from "vitest";
import { runtime, deferred, view } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";
import type { FrameMetrics } from "../webgpu/pbrRenderer.js";

const stream = vi.hoisted(() => ({ sync: vi.fn(async () => true), syncView: vi.fn(async () => true) }));
vi.mock("./authorChunkStream.js", () => ({ AuthorChunkStream: class {
  hasCatalog = true;
  sync = stream.sync;
  syncView = stream.syncView;
  dispose() {}
} }));

describe("author packet replacement and camera residency", () => {
  it("draws retained frames without a camera request aborting an author replacement", async () => {
    stream.sync.mockReset().mockResolvedValue(true); stream.syncView.mockReset().mockResolvedValue(true);
    const target = Object.assign(runtime(), { session: { state: "ready", device: { lost: new Promise(() => {}) } },
      stageResidentPacketValidated: vi.fn(), cancelResidentPacketStage: vi.fn() });
    vi.mocked(target.render).mockReturnValue({ frame: 1 } as FrameMetrics);
    const packet = { geometries: [], materials: [], instances: [] };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet, authorChunks: true }, { create: vi.fn(async () => target) });
    const camera = deferred<boolean>(), author = deferred<boolean>();
    stream.syncView.mockImplementationOnce(() => camera.promise);
    backend.render({ ...view, eye: [1, 0, 4] });
    expect(stream.syncView).toHaveBeenCalledOnce();
    stream.sync.mockImplementationOnce(() => author.promise);
    const preparing = backend.prepareRenderPacket(packet, view);
    backend.render({ ...view, eye: [2, 0, 4] });
    expect(stream.syncView).toHaveBeenCalledOnce();
    camera.reject(new Error("Scene chunk residency update was aborted."));
    await Promise.resolve(); await Promise.resolve();
    expect(backend.packetViewStreamFailure).toBeUndefined();
    author.resolve(true); await preparing;
    backend.render({ ...view, eye: [3, 0, 4] });
    expect(stream.syncView).toHaveBeenCalledTimes(2);
    expect(target.render).toHaveBeenCalledTimes(3);
    backend.dispose();
  });
});
