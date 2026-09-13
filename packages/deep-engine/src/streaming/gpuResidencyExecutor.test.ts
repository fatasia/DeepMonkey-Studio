import { describe, expect, it } from "vitest";
import { GpuResidencyExecutor } from "./gpuResidencyExecutor.js";
import { GpuResidencyExecutorError, type GpuResidencyUploader, type GpuResidencyUploadRequest } from "./gpuResidencyExecutorTypes.js";
import { ResourceResidencyController } from "./residencyController.js";

interface Handle { readonly key: string; released: boolean }
interface Deferred { readonly promise: Promise<void>; resolve(): void }

class ControlledUploader implements GpuResidencyUploader<Handle> {
  readonly calls: GpuResidencyUploadRequest[] = [];
  readonly released: Handle[] = [];
  readonly pending: Deferred[] = [];
  readonly byteOverrides = new Map<string, number>();
  readonly releaseAttempts: string[] = [];
  readonly releaseFailures = new Set<string>();
  active = 0;
  maximumActive = 0;
  controlled = false;
  invalidHandle = false;

  async upload(request: GpuResidencyUploadRequest) {
    this.calls.push(request); this.active += 1; this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      if (this.controlled) { const gate = deferred(); this.pending.push(gate); await gate.promise; }
      const handle = this.invalidHandle ? null as unknown as Handle : { key: `${request.id}:${request.revision}:${request.level}:${this.calls.length}`, released: false };
      return { handle, byteLength: this.byteOverrides.get(request.id) ?? request.expectedByteLength };
    } finally { this.active -= 1; }
  }

  release(handle: Handle): void {
    this.releaseAttempts.push(handle.key);
    if (this.releaseFailures.has(handle.key)) throw new Error("injected release failure");
    if (handle.released) throw new Error("double release");
    handle.released = true; this.released.push(handle);
  }
}

const profile = (id: string, bytes = [60, 20], revision = 1) => ({
  id, revision, kind: "geometry" as const, levels: bytes.map((byteLength, level) => ({ level, byteLength })),
});

describe("GpuResidencyExecutor", () => {
  it("honors plan bytes and concurrency, caches the same plan, and skips no-op uploads", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 90, maxUploadBytesPerFrame: 90 });
    for (const id of ["a", "b", "c"]) controller.register(profile(id, [30]));
    const uploader = new ControlledUploader(); uploader.controlled = true;
    const executor = new GpuResidencyExecutor(controller, uploader, { maxConcurrentUploads: 2 });
    const plan = controller.planFrame(1, ["a", "b", "c"].map((id) => ({ id, desiredLevel: 0 })));
    const running = executor.execute(plan);
    expect(executor.execute(plan)).toBe(running);
    await turns(); expect(uploader.calls.map(({ id }) => id)).toEqual(["a", "b"]);
    uploader.pending[0]!.resolve(); await turns(); expect(uploader.calls.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    uploader.pending[1]!.resolve(); uploader.pending[2]!.resolve();
    const result = await running;
    expect(result.commit.appliedUploads).toEqual(["a", "b", "c"]);
    expect(uploader.maximumActive).toBe(2);
    expect(uploader.calls.reduce((sum, call) => sum + call.expectedByteLength, 0)).toBe(plan.uploadBytes);
    expect(executor.snapshot().map(({ id }) => id)).toEqual(["a", "b", "c"]);

    const noOp = controller.planFrame(2, ["a", "b", "c"].map((id) => ({ id, desiredLevel: 0 })));
    const noOpRun = executor.execute(noOp); expect(executor.execute(noOp)).toBe(noOpRun);
    expect((await noOpRun).commit.appliedUploads).toEqual([]);
    expect(uploader.calls).toHaveLength(3);
    expect(executor.get("a")!.lastUsedFrame).toBe(2);
  });

  it("evicts before upload, preserves failed replacements, then atomically swaps successful replacements", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 100, maxUploadBytesPerFrame: 100, retainFrames: 0 });
    controller.register(profile("asset")); controller.register(profile("old", [20]));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    await executor.execute(controller.planFrame(1, [{ id: "asset", desiredLevel: 1 }, { id: "old", desiredLevel: 0 }]));
    const oldAsset = executor.get("asset")!.handle, oldUnused = executor.get("old")!.handle;
    uploader.controlled = true; uploader.byteOverrides.set("asset", 59);
    const failedPlan = controller.planFrame(2, [{ id: "asset", desiredLevel: 0 }]);
    expect(failedPlan.evictions.map(({ id, phase }) => `${id}:${phase}`)).toEqual(["old:before-upload", "asset:after-swap"]);
    const failing = executor.execute(failedPlan); await turns();
    expect(executor.get("asset")!.handle).toBe(oldAsset); expect(oldUnused.released).toBe(true);
    uploader.pending[0]!.resolve();
    const failed = await failing;
    expect(failed.commit.failedUploads).toEqual(["asset"]);
    expect(executor.get("asset")!.handle).toBe(oldAsset); expect(oldAsset.released).toBe(false);
    expect(uploader.released.some(({ key }) => key.startsWith("asset:1:0"))).toBe(true);

    uploader.controlled = false; uploader.byteOverrides.clear();
    const upgraded = await executor.execute(controller.planFrame(3, [{ id: "asset", desiredLevel: 0 }]));
    expect(upgraded.commit.appliedUploads).toEqual(["asset"]);
    expect(executor.get("asset")!.level).toBe(0); expect(executor.get("asset")!.handle).not.toBe(oldAsset);
    expect(oldAsset.released).toBe(true);
  });

  it("cancels queued work, releases late candidates, and commits no cancelled upload", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 40, maxUploadBytesPerFrame: 40 });
    controller.register(profile("a", [20])); controller.register(profile("b", [20]));
    const uploader = new ControlledUploader(); uploader.controlled = true;
    const executor = new GpuResidencyExecutor(controller, uploader, { maxConcurrentUploads: 1 });
    const plan = controller.planFrame(1, [{ id: "a", desiredLevel: 0 }, { id: "b", desiredLevel: 0 }]);
    const running = executor.execute(plan); await turns();
    expect(() => executor.execute({ ...plan })).toThrowError(expect.objectContaining({ code: "busy" }));
    executor.cancel(); uploader.pending[0]!.resolve();
    const result = await running;
    expect(result.commit.appliedUploads).toEqual([]); expect(result.commit.failedUploads).toEqual(["a", "b"]);
    expect(result).toMatchObject({ cancelledUploadCount: 2, cancelledUploadBytes: 40,
      cancellationBoundary: "before-resident-eviction" });
    expect(uploader.calls).toHaveLength(1); expect(uploader.released).toHaveLength(1); expect(executor.size).toBe(0);
  });

  it("preserves the old resident when cancellation precedes destructive eviction", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 80, maxUploadBytesPerFrame: 80 });
    controller.register(profile("asset"));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    await executor.execute(controller.planFrame(1, [{ id: "asset", desiredLevel: 1 }]));
    const before = executor.get("asset")!, snapshot = controller.snapshot()[0]!;
    uploader.controlled = true;
    const abort = new AbortController();
    const replacing = executor.execute(controller.planFrame(2, [{ id: "asset", desiredLevel: 0 }]), abort.signal);
    await turns(); abort.abort("camera changed"); uploader.pending[0]!.resolve();

    const result = await replacing;
    expect(result).toMatchObject({ cancelledUploadCount: 1, cancelledUploadBytes: 60,
      cancellationBoundary: "before-resident-eviction",
      commit: { appliedUploads: [], failedUploads: ["asset"], evicted: [] } });
    expect(executor.get("asset")).toBe(before); expect(controller.snapshot()[0]).toEqual(snapshot);
    expect(before.handle.released).toBe(false); expect(uploader.released).toHaveLength(1);
  });

  it("records cancellation after a prerequisite eviction without restoring a destroyed resident", async () => {
    const controller = new ResourceResidencyController({
      maxResidentBytes: 60, maxUploadBytesPerFrame: 60, retainFrames: 0,
    });
    controller.register(profile("old", [20])); controller.register(profile("next", [60]));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    await executor.execute(controller.planFrame(1, [{ id: "old", desiredLevel: 0 }]));
    const old = executor.get("old")!.handle; uploader.controlled = true;
    const abort = new AbortController();
    const loading = executor.execute(controller.planFrame(2, [{ id: "next", desiredLevel: 0 }]), abort.signal);
    await turns(); expect(old.released).toBe(true);
    abort.abort("camera changed"); uploader.pending[0]!.resolve();

    const result = await loading;
    expect(result).toMatchObject({ cancelledUploadCount: 1, cancelledUploadBytes: 60,
      cancellationBoundary: "after-before-upload-eviction",
      commit: { appliedUploads: [], failedUploads: ["next"], evicted: ["old"] } });
    expect(executor.size).toBe(0); expect(controller.snapshot()).toEqual([]);
    expect(uploader.released).toHaveLength(2);
  });

  it("does no uploader or eviction work for a pre-aborted execution", async () => {
    const controller = new ResourceResidencyController({
      maxResidentBytes: 60, maxUploadBytesPerFrame: 60, retainFrames: 0,
    });
    controller.register(profile("old", [20])); controller.register(profile("next", [60]));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    await executor.execute(controller.planFrame(1, [{ id: "old", desiredLevel: 0 }]));
    const old = executor.get("old")!, snapshot = controller.snapshot()[0]!;
    const abort = new AbortController(); abort.abort("already stale");

    const result = await executor.execute(
      controller.planFrame(2, [{ id: "next", desiredLevel: 0 }]), abort.signal);
    expect(result).toMatchObject({ cancelledUploadCount: 1, cancelledUploadBytes: 60,
      cancellationBoundary: "before-resident-eviction", commit: { evicted: [] } });
    expect(uploader.calls).toHaveLength(1); expect(uploader.released).toHaveLength(0);
    expect(executor.get("old")).toBe(old); expect(controller.snapshot()[0]).toEqual(snapshot);
  });

  it("makes device loss terminal, releases residents and late uploads, and rejects stale writeback", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 80, maxUploadBytesPerFrame: 80 });
    controller.register(profile("asset"));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    await executor.execute(controller.planFrame(1, [{ id: "asset", desiredLevel: 1 }]));
    const resident = executor.get("asset")!.handle;
    uploader.controlled = true;
    const pending = executor.execute(controller.planFrame(2, [{ id: "asset", desiredLevel: 0 }]));
    await turns(); executor.handleDeviceLoss();
    expect(resident.released).toBe(true); expect(executor.size).toBe(0); expect(executor.disposed).toBe(true);
    uploader.pending[0]!.resolve();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(uploader.released).toHaveLength(2);
    expect(() => executor.execute(controller.planFrame(3, []))).toThrow();
  });

  it("rejects forged plans and invalid handles without installing them", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 20, maxUploadBytesPerFrame: 20 });
    controller.register(profile("asset", [20]));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    const plan = controller.planFrame(1, [{ id: "asset", desiredLevel: 0 }]);
    expect(() => executor.execute({ ...plan })).toThrowError(expect.objectContaining({ code: "invalid-plan" }));
    expect(() => executor.execute({ ...plan, uploadBytes: 19 })).toThrowError(expect.objectContaining({ code: "invalid-plan" }));
    expect(() => executor.execute({ ...plan, uploads: [{ ...plan.uploads[0]!, kind: "texture" }] }))
      .toThrowError(expect.objectContaining({ code: "invalid-plan" }));
    expect(() => executor.execute({ ...plan, uploads: [{ ...plan.uploads[0]!, byteLength: 19 }], uploadBytes: 19 }))
      .toThrowError(expect.objectContaining({ code: "invalid-plan" }));
    uploader.invalidHandle = true;
    const result = await executor.execute(plan);
    expect(result.commit.failedUploads).toEqual(["asset"]); expect(executor.size).toBe(0);
    expect(result.uploadFailures[0]!.reason).toMatchObject({ code: "invalid-handle" });
    executor.dispose(); expect(() => executor.dispose()).not.toThrow();
  });

  it("rejects a superseded signed plan before any GPU side effect", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 40, maxUploadBytesPerFrame: 40 });
    controller.register(profile("asset", [20]));
    const stale = controller.planFrame(1, [{ id: "asset", desiredLevel: 0 }]);
    controller.planFrame(2, [{ id: "asset", desiredLevel: 0 }]);
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    expect(() => executor.execute(stale)).toThrowError(expect.objectContaining({ code: "invalid-plan" }));
    expect(uploader.calls).toHaveLength(0); expect(uploader.releaseAttempts).toHaveLength(0);
  });

  it("locks controller mutation while GPU work owns the signed plan", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 40, maxUploadBytesPerFrame: 40 });
    controller.register(profile("asset", [20]));
    const uploader = new ControlledUploader(); uploader.controlled = true;
    const executor = new GpuResidencyExecutor(controller, uploader);
    const running = executor.execute(controller.planFrame(1, [{ id: "asset", desiredLevel: 0 }]));
    await turns();
    expect(() => controller.register(profile("peer", [20]))).toThrow("executing");
    expect(() => controller.planFrame(2, [])).toThrow("executing");
    uploader.pending[0]!.resolve(); await running;
    expect(() => controller.register(profile("peer", [20]))).not.toThrow();
  });

  it("continues terminal cleanup after one replacement release fails", async () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 160, maxUploadBytesPerFrame: 120 });
    controller.register(profile("a")); controller.register(profile("b"));
    const uploader = new ControlledUploader(), executor = new GpuResidencyExecutor(controller, uploader);
    await executor.execute(controller.planFrame(1, [{ id: "a", desiredLevel: 1 }, { id: "b", desiredLevel: 1 }]));
    const oldA = executor.get("a")!.handle, oldB = executor.get("b")!.handle;
    uploader.releaseFailures.add(oldA.key);
    await expect(executor.execute(controller.planFrame(2, [
      { id: "a", desiredLevel: 0 }, { id: "b", desiredLevel: 0 },
    ]))).rejects.toMatchObject({ code: "release-failed" });
    expect(oldA.released).toBe(false); expect(oldB.released).toBe(true);
    expect(uploader.releaseAttempts).toEqual(expect.arrayContaining([oldA.key, oldB.key]));
    expect(uploader.released.filter(handle => handle !== oldB)).toHaveLength(2);
    expect(executor.disposed).toBe(true); expect(executor.size).toBe(0); expect(controller.snapshot()).toEqual([]);
  });
});

function deferred(): Deferred {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}
async function turns(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
