import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneChunkResidency } from "./sceneChunkResidency.js";
import { chunkGpuFixture, chunkPacket, visible } from "./sceneChunkResidency.testUtils.js";

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("scene chunk residency lifecycle", () => {
  it("recovers after an upload failure and releases every partial allocation on dispose", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    scene.registerChunk("faulty", chunkPacket("mesh", "base", 0, "faulty"));
    gpu.failTexture(true);

    await expect(scene.update({ frame: 1, chunks: [visible("faulty")] }))
      .rejects.toMatchObject({ code: "partial-failure" });
    expect(scene.pending).toBe(false);
    gpu.failTexture(false);
    const recovered = await scene.update({ frame: 2, chunks: [visible("faulty")] });
    expect(recovered.chunk("faulty")?.geometry("mesh")).toBeDefined();
    expect(recovered.chunk("faulty")?.texture("base")).toBeDefined();
    recovered.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("fails conflicting registration without corrupting existing shared identities", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 304, maxUploadBytesPerFrame: 304 });
    scene.registerChunk("original", chunkPacket("shared", "original-base", 0, "original"));

    expect(() => scene.registerChunk("conflict",
      chunkPacket("shared", "conflict-base", 9, "conflict")))
      .toThrow("conflicts with an existing source");
    expect(scene.chunkCount).toBe(1);
    scene.registerChunk("valid", chunkPacket("valid", "valid-base", 1, "valid"));
    const frame = await scene.update({ frame: 1,
      chunks: [visible("original"), visible("valid")] });
    expect(frame.chunk("original")?.geometry("shared")?.sourceRevision).toBe(3);
    expect(frame.chunk("valid")?.geometry("valid")).toBeDefined();
    frame.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("publishes only the latest same-frame request and cleans cancelled uploads", async () => {
    const gpu = chunkGpuFixture();
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    gpu.device.popErrorScope.mockImplementation(() => gate.then(() => null));
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 304, maxUploadBytesPerFrame: 304 });
    scene.registerChunk("old", chunkPacket("old-mesh", "old-base", 0, "old"));
    scene.registerChunk("latest", chunkPacket("new-mesh", "new-base", 1, "latest"));

    const old = scene.update({ frame: 7, chunks: [visible("old")] });
    await vi.waitFor(() => expect(gpu.device.createBuffer).toHaveBeenCalled());
    const latest = scene.update({ frame: 7, chunks: [visible("latest")] });
    await expect(old).rejects.toMatchObject({ code: "superseded" });
    unlock();
    const frame = await latest;

    expect(scene.submittedFrameCount).toBe(2);
    expect(frame.chunks.map(value => value.key)).toEqual(["latest"]);
    expect(frame.chunk("old")).toBeUndefined();
    expect(frame.chunk("latest")?.geometry("new-mesh")).toBeDefined();
    expect(scene.telemetrySnapshot()).toMatchObject({ lastAppliedFrame: { frame: 7 } });
    frame.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("cancels a pending update on dispose and leaves no session-owned resource", async () => {
    const gpu = chunkGpuFixture(), onDiscardError = vi.fn();
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    gpu.device.popErrorScope.mockImplementation(() => gate.then(() => null));
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 }, { onDiscardError });
    scene.registerChunk("pending", chunkPacket());
    const pending = scene.update({ frame: 1, chunks: [visible("pending")] });
    await vi.waitFor(() => expect(gpu.device.createBuffer).toHaveBeenCalled());

    scene.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    unlock(); await vi.waitFor(() => expect(gpu.owned.size).toBe(0));
    expect(onDiscardError).not.toHaveBeenCalled();
    expect(scene).toMatchObject({ disposed: true, pending: false });
  });

  it("propagates abort into the GPU upload and publishes no late frame", async () => {
    const gpu = chunkGpuFixture();
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    gpu.device.popErrorScope.mockImplementation(() => gate.then(() => null));
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    scene.registerChunk("aborted", chunkPacket());
    const controller = new AbortController();
    const pending = scene.update({ frame: 1, chunks: [visible("aborted")], signal: controller.signal });
    await vi.waitFor(() => expect(gpu.device.createBuffer).toHaveBeenCalled());

    controller.abort("camera moved");
    await expect(pending).rejects.toMatchObject({ code: "aborted", cause: "camera moved" });
    unlock();
    await vi.waitFor(() => expect(gpu.owned.size).toBe(0));
    expect(scene.telemetrySnapshot().lastAppliedFrame).toBeUndefined();
    const empty = await scene.update({ frame: 2, chunks: [] });

    expect(scene.telemetrySnapshot()).toMatchObject({ residentBytes: 0, retiredBytes: 0,
      lastAppliedFrame: { frame: 2, uploadedResourceCount: 0 } });
    empty.release(); scene.dispose(); expect(gpu.owned.size).toBe(0);
  });

  it("reports a candidate cleanup failure that settles after cancellation", async () => {
    const gpu = chunkGpuFixture(), onDiscardError = vi.fn();
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    gpu.device.popErrorScope.mockImplementation(() => gate.then(() => null));
    const release = gpu.session.release.bind(gpu.session);
    vi.spyOn(gpu.session, "release").mockImplementation(resource => {
      release(resource); throw new Error("injected candidate release failure");
    });
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 },
      { executor: { maxConcurrentUploads: 1 }, onDiscardError });
    scene.registerChunk("aborted", chunkPacket());
    const abort = new AbortController();
    const pending = scene.update({ frame: 1, chunks: [visible("aborted")], signal: abort.signal });
    await vi.waitFor(() => expect(gpu.owned.size).toBe(1));

    abort.abort("camera moved");
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    unlock();
    await vi.waitFor(() => expect(onDiscardError).toHaveBeenCalledOnce());
    expect(scene.lastDiscardError).toMatchObject({ code: "frame-rejected" });
    expect(gpu.owned.size).toBe(0);
    scene.dispose();
  });

  it("rejects stale, duplicate, unknown, and pre-aborted inputs before GPU work", async () => {
    const gpu = chunkGpuFixture();
    const scene = createSceneChunkResidency(gpu.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    scene.registerChunk("known", chunkPacket());
    const empty = await scene.update({ frame: 3, chunks: [] }); empty.release();
    expect(scene.submittedFrameCount).toBe(1);
    await expect(scene.update({ frame: 2, chunks: [] })).rejects.toMatchObject({ code: "stale-frame" });
    await expect(scene.update({ frame: 4, chunks: [visible("known"), visible("known")] }))
      .rejects.toThrow("Duplicate");
    await expect(scene.update({ frame: 4, chunks: [visible("missing")] })).rejects.toThrow("Unknown");
    const controller = new AbortController(); controller.abort("stop");
    await expect(scene.update({ frame: 4, chunks: [], signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted", cause: "stop" });
    expect(scene.submittedFrameCount).toBe(1);
    expect(gpu.device.createBuffer).not.toHaveBeenCalled();
    scene.dispose(); expect(gpu.owned.size).toBe(0);
  });
});
