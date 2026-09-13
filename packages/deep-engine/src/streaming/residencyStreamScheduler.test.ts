import { describe, expect, it, vi } from "vitest";
import { GpuResidencyExecutor } from "./gpuResidencyExecutor.js";
import type { GpuResidencyUploadRequest } from "./gpuResidencyExecutorTypes.js";
import { ResourceResidencyController } from "./residencyController.js";
import { ResidencyStreamScheduler } from "./residencyStreamScheduler.js";

interface Handle { readonly id: string; released: boolean }
function deferred() { let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve }; }

class Uploader {
  readonly calls: GpuResidencyUploadRequest[] = [];
  readonly gates: ReturnType<typeof deferred>[] = [];
  readonly released: Handle[] = [];
  controlled = false;
  async upload(request: GpuResidencyUploadRequest) {
    this.calls.push(request);
    if (this.controlled) { const gate = deferred(); this.gates.push(gate); await gate.promise; }
    return { handle: { id: `${request.id}:${request.level}:${this.calls.length}`, released: false },
      byteLength: request.expectedByteLength };
  }
  release(handle: Handle) { handle.released = true; this.released.push(handle); }
}

function fixture() {
  const controller = new ResourceResidencyController({ maxResidentBytes: 120, maxUploadBytesPerFrame: 120 });
  controller.register({ id: "mesh", revision: 1, kind: "geometry",
    levels: [{ level: 0, byteLength: 80 }, { level: 1, byteLength: 30 }] });
  const uploader = new Uploader(), executor = new GpuResidencyExecutor(controller, uploader,
    { maxConcurrentUploads: 1 });
  return { controller, uploader, executor, scheduler: new ResidencyStreamScheduler(controller, executor) };
}

describe("ResidencyStreamScheduler", () => {
  it("shares one slow active upload across equivalent requests submitted every frame", async () => {
    const { uploader, scheduler, executor } = fixture(); uploader.controlled = true;
    const submissions = [scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }])];
    await turns(); expect(uploader.calls).toHaveLength(1);
    for (let frame = 2; frame <= 61; frame++) submissions.push(scheduler.submit(frame, [{
      id: "mesh", desiredLevel: 0,
      ...(frame % 2 === 0 ? { priority: 0, required: false } : {}),
    }]));
    expect(uploader.calls).toHaveLength(1);
    expect(uploader.calls[0]!.signal.aborted).toBe(false);
    uploader.gates[0]!.resolve();
    const results = await Promise.all(submissions);
    expect(results.map(({ generation, frame, status }) => ({ generation, frame, status })))
      .toEqual(Array.from({ length: 61 }, (_, index) => ({
        generation: index + 1, frame: index + 1, status: "applied",
      })));
    expect(new Set(results.map(({ execution }) => execution))).toHaveProperty("size", 1);
    expect(uploader.calls).toHaveLength(1);
    expect(executor.get("mesh")).toMatchObject({ level: 0, byteLength: 80, lastUsedFrame: 61 });
  });

  it("coalesces equivalent pending requests at the newest frame without losing waiters", async () => {
    const { uploader, scheduler, executor } = fixture(); uploader.controlled = true;
    const first = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }]);
    await turns(); expect(uploader.calls).toHaveLength(1);
    const middle = scheduler.submit(2, [{ id: "mesh", desiredLevel: 1 }]);
    const latest = scheduler.submit(3, [{ id: "mesh", desiredLevel: 1, priority: 0, required: false }]);
    uploader.gates[0]!.resolve();
    await expect.poll(() => uploader.calls.length).toBe(2);
    uploader.gates[1]!.resolve();
    await expect(first).resolves.toMatchObject({ status: "superseded", frame: 1 });
    const [middleResult, latestResult] = await Promise.all([middle, latest]);
    expect(middleResult).toMatchObject({ generation: 2, status: "applied", frame: 2 });
    expect(latestResult).toMatchObject({ generation: 3, status: "applied", frame: 3 });
    expect(middleResult.execution).toBe(latestResult.execution);
    expect(executor.get("mesh")).toMatchObject({ level: 1, byteLength: 30, lastUsedFrame: 3 });
    expect(uploader.released).toHaveLength(1);
  });

  it("keeps latest-wins cancellation for different active and pending requests", async () => {
    const { uploader, scheduler, executor } = fixture(); uploader.controlled = true;
    const active = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }]);
    const activePeer = scheduler.submit(2, [{ id: "mesh", desiredLevel: 0 }]);
    await turns(); expect(uploader.calls).toHaveLength(1);
    const pending = scheduler.submit(3, [{ id: "mesh", desiredLevel: 1 }]);
    const latest = scheduler.submit(4, []);
    await expect(pending).resolves.toMatchObject({ generation: 3, frame: 3, status: "superseded" });
    expect(uploader.calls[0]!.signal.aborted).toBe(true);
    uploader.gates[0]!.resolve();
    await expect(active).resolves.toMatchObject({ generation: 1, frame: 1, status: "superseded" });
    await expect(activePeer).resolves.toMatchObject({ generation: 2, frame: 2, status: "superseded" });
    await expect(latest).resolves.toMatchObject({ generation: 4, frame: 4, status: "applied" });
    expect(uploader.calls).toHaveLength(1);
    expect(executor.size).toBe(0);
  });

  it("keeps a shared active upload alive while one equivalent waiter remains", async () => {
    const { uploader, scheduler, executor } = fixture(); uploader.controlled = true;
    const cancel = vi.spyOn(executor, "cancel");
    const firstAbort = new AbortController(), peerAbort = new AbortController();
    const first = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }], firstAbort.signal);
    const peer = scheduler.submit(2, [{ id: "mesh", desiredLevel: 0 }], peerAbort.signal);
    await turns(); expect(uploader.calls).toHaveLength(1);

    firstAbort.abort("camera-a-moved");
    await expect(first).resolves.toMatchObject({ status: "superseded", error: "camera-a-moved" });
    expect(uploader.calls[0]!.signal.aborted).toBe(false); expect(cancel).not.toHaveBeenCalled();
    uploader.gates[0]!.resolve();

    await expect(peer).resolves.toMatchObject({ status: "applied", frame: 2 });
    expect(executor.get("mesh")).toMatchObject({ level: 0, lastUsedFrame: 2 });
  });

  it("cancels one shared execution once after every waiter aborts", async () => {
    const { uploader, scheduler, executor } = fixture(); uploader.controlled = true;
    const cancel = vi.spyOn(executor, "cancel");
    const a = new AbortController(), b = new AbortController();
    const first = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }], a.signal);
    const peer = scheduler.submit(2, [{ id: "mesh", desiredLevel: 0 }], b.signal);
    await turns();

    a.abort("a"); expect(uploader.calls[0]!.signal.aborted).toBe(false);
    b.abort("b"); expect(uploader.calls[0]!.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(first).resolves.toMatchObject({ status: "superseded", error: "a" });
    uploader.gates[0]!.resolve();
    await expect(peer).resolves.toMatchObject({ status: "superseded", error: "b" });
    await expect.poll(() => scheduler.busy).toBe(false);
    expect(uploader.calls).toHaveLength(1); expect(uploader.released).toHaveLength(1);
    expect(executor.size).toBe(0);
  });

  it("does not forward an old waiter abort into its replacement execution", async () => {
    const { uploader, scheduler, executor } = fixture(); uploader.controlled = true;
    const oldAbort = new AbortController();
    const old = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }], oldAbort.signal);
    await turns(); oldAbort.abort("old stopped");
    const replacement = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }]);
    uploader.gates[0]!.resolve();
    await expect(old).resolves.toMatchObject({ status: "superseded" });
    await expect.poll(() => uploader.calls.length).toBe(2);
    expect(uploader.calls[1]!.signal.aborted).toBe(false);
    uploader.gates[1]!.resolve();
    await expect(replacement).resolves.toMatchObject({ status: "applied" });
    expect(executor.get("mesh")).toBeDefined();
  });

  it("snapshots caller requests and remains usable after a rejected newest frame", async () => {
    const { scheduler, executor } = fixture();
    const request = { id: "mesh", desiredLevel: 1 };
    const first = scheduler.submit(1, [request]); request.desiredLevel = 0;
    await expect(first).resolves.toMatchObject({ status: "applied" });
    expect(executor.get("mesh")?.level).toBe(1);
    await expect(scheduler.submit(2, [{ id: "missing", desiredLevel: 0 }])).resolves
      .toMatchObject({ status: "failed", frame: 2 });
    await expect(scheduler.submit(3, [{ id: "mesh", desiredLevel: 0 }])).resolves
      .toMatchObject({ status: "applied", frame: 3 });
    expect(executor.get("mesh")?.level).toBe(0);
  });

  it("settles every active and pending waiter when disposed", async () => {
    const { scheduler, uploader, executor } = fixture();
    uploader.controlled = true;
    const active = scheduler.submit(1, [{ id: "mesh", desiredLevel: 0 }]);
    const activePeer = scheduler.submit(2, [{ id: "mesh", desiredLevel: 0 }]); await turns();
    await expect.poll(() => uploader.gates.length).toBe(1);
    const pending = scheduler.submit(3, [{ id: "mesh", desiredLevel: 1 }]);
    const pendingPeer = scheduler.submit(4, [{ id: "mesh", desiredLevel: 1 }]);
    scheduler.dispose(); uploader.gates[0]!.resolve();
    const results = await Promise.all([active, activePeer, pending, pendingPeer]);
    expect(results.map(({ generation, frame, status }) => ({ generation, frame, status }))).toEqual([
      { generation: 1, frame: 1, status: "superseded" },
      { generation: 2, frame: 2, status: "superseded" },
      { generation: 3, frame: 3, status: "failed" },
      { generation: 4, frame: 4, status: "failed" },
    ]);
    expect(results[2]!.error).toBeInstanceOf(Error); expect(results[3]!.error).toBe(results[2]!.error);
    expect(executor.disposed).toBe(true);
    expect(() => scheduler.submit(5, [])).toThrow("disposed");
  });

  it("rejects frame regressions", async () => {
    const { scheduler } = fixture();
    await scheduler.submit(4, [{ id: "mesh", desiredLevel: 1 }]);
    expect(() => scheduler.submit(3, [])).toThrow("regressed");
  });
});

async function turns(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
