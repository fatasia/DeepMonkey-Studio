import { describe, expect, it } from "vitest";
import type {
  ProbeClipmapGpuResource, ProbeClipmapResourceUpdate,
} from "./probeClipmapResources.js";
import { planIrradianceProbeClipmap, type ProbeClipmapPlan } from "./probeClipmapPlan.js";
import {
  ProbeClipmapCaptureExecutor,
  type ProbeCaptureAdapter, type ProbeCaptureBeginContext, type ProbeCaptureTransaction,
  type ProbeClipmapResourceOwner,
} from "./probeClipmapCaptureExecutor.js";
import { ProbeClipmapUpdateScheduler, type ProbeClipmapFrameRequest } from "./probeClipmapUpdateScheduler.js";

const scene = { min: [-100, -100, -100], max: [100, 100, 100] } as const;
const request = (frame: number, overrides: Partial<ProbeClipmapFrameRequest> = {}): ProbeClipmapFrameRequest => ({
  frame, deviceEpoch: "gpu-1", viewport: [1280, 720], cameraPosition: [0, 0, 0],
  sceneBounds: scene, options: { levelCount: 2, gridSize: [4, 2, 4] }, ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
function resource(plan: ProbeClipmapPlan, epoch: string, status: "created" | "reused"): ProbeClipmapResourceUpdate {
  return { status, resource: { deviceEpoch: epoch, plan } as ProbeClipmapGpuResource,
    evidence: { generation: 1, allocatedBytes: plan.profile.estimatedBytes, updatedBytes: 0,
      updateCount: plan.updates.length, createdBufferCount: status === "created" ? 3 : 0,
      reusedBufferCount: status === "reused" ? 3 : 0 } };
}
class FakeResources implements ProbeClipmapResourceOwner {
  readonly deviceEpoch = "gpu-1";
  readonly plans: ProbeClipmapPlan[] = [];
  disposed = false;
  failure: Error | undefined;
  async setValidated(plan: ProbeClipmapPlan, epoch: string, signal?: AbortSignal): Promise<ProbeClipmapResourceUpdate> {
    signal?.throwIfAborted(); if (this.failure) throw this.failure;
    const status = this.plans.length ? "reused" : "created"; this.plans.push(plan);
    return resource(plan, epoch, status);
  }
  dispose(): void { this.disposed = true; }
}
interface Submission { readonly id: number }
interface PublishedCapture { readonly transaction: number }
interface TransactionLog {
  readonly plan: ProbeClipmapPlan;
  readonly events: string[];
  commits: number;
  rollbacks: number;
}
class FakeAdapter implements ProbeCaptureAdapter<Submission, PublishedCapture> {
  epoch = "gpu-1";
  readonly transactions: TransactionLog[] = [];
  readonly gates: ReturnType<typeof deferred<void>>[] = [];
  manualSubmit = false;
  failPhase: "capture" | "filter" | "mip" | "finish" | "commit" | undefined;
  failIndex = 0;
  submitFailure: Error | undefined;
  get deviceEpoch(): string { return this.epoch; }
  begin(context: ProbeCaptureBeginContext): ProbeCaptureTransaction<Submission, PublishedCapture> {
    const log: TransactionLog = { plan: context.plan, events: [], commits: 0, rollbacks: 0 };
    this.transactions.push(log);
    const encode = (phase: "capture" | "filter" | "mip", index: number) => {
      if (this.failPhase === phase && index === this.failIndex) throw new Error(`${phase} failed`);
      log.events.push(`${phase}:${index}`);
    };
    return {
      encodeCapture: (_update, index) => encode("capture", index),
      encodeFilter: (_update, index) => encode("filter", index),
      encodeMips: (_update, index) => encode("mip", index),
      finish: () => {
        if (this.failPhase === "finish") throw new Error("finish failed");
        log.events.push("finish"); return { id: this.transactions.length };
      },
      commit: () => {
        if (this.failPhase === "commit") throw new Error("commit failed");
        log.commits++; return { transaction: this.transactions.length };
      },
      rollback: () => { log.rollbacks++; },
    };
  }
  submit(_submission: Submission, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (this.submitFailure) return Promise.reject(this.submitFailure);
    if (!this.manualSubmit) return Promise.resolve();
    const gate = deferred<void>(); this.gates.push(gate); return gate.promise;
  }
}
function setup(frameBudget = 4, cameraCutBudget = 6, deviceLost?: PromiseLike<unknown>) {
  const resources = new FakeResources(), adapter = new FakeAdapter();
  const executor = new ProbeClipmapCaptureExecutor(resources, adapter,
    { maxUpdatesPerBatch: cameraCutBudget, ...(deviceLost ? { deviceLost } : {}) });
  const scheduler = new ProbeClipmapUpdateScheduler(executor, { frameBudget, cameraCutBudget });
  return { resources, adapter, executor, scheduler };
}

describe("probe clipmap capture executor", () => {
  it("encodes complete capture, filter and mip phases before atomically committing", async () => {
    const { adapter, executor, scheduler } = setup();
    const result = await scheduler.submit(request(0));
    expect(result.status).toBe("committed");
    expect(adapter.transactions[0]!.events).toEqual([
      "capture:0", "capture:1", "capture:2", "capture:3",
      "filter:0", "filter:1", "filter:2", "filter:3",
      "mip:0", "mip:1", "mip:2", "mip:3", "finish",
    ]);
    expect(adapter.transactions[0]).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(executor.current).toMatchObject({ published: { transaction: 1 }, stats: {
      frame: 0, schedulerGeneration: 1, updateCount: 4, captureCount: 4,
      filterCount: 4, mipCount: 4, committedBatchCount: 1,
      committedUpdateCount: 4, resourceStatus: "created" } });
    expect(executor.current!.stats.updatesByLevel).toEqual([4, 0]);
  });

  it("rolls back partial encoding and submit failures without publishing progress", async () => {
    const { adapter, executor, scheduler } = setup();
    await scheduler.submit(request(0));
    const executorBefore = executor.current, schedulerBefore = scheduler.current;
    adapter.failPhase = "filter"; adapter.failIndex = 1;
    await expect(scheduler.submit(request(1))).rejects.toThrow("filter failed");
    expect(adapter.transactions[1]).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(executor.current).toBe(executorBefore); expect(scheduler.current).toBe(schedulerBefore);

    adapter.failPhase = undefined; adapter.submitFailure = new Error("queue rejected");
    await expect(scheduler.submit(request(1))).rejects.toThrow("queue rejected");
    expect(adapter.transactions[2]).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(executor.current).toBe(executorBefore); expect(scheduler.current).toBe(schedulerBefore);
  });

  it("uses latest-wins cancellation and rolls back the stale submitted transaction", async () => {
    const { adapter, executor, scheduler } = setup(); adapter.manualSubmit = true;
    const stale = scheduler.submit(request(0));
    await turns();
    const winner = scheduler.submit(request(1, { cameraPosition: [4, 0, 0] }));
    await expect(stale).resolves.toMatchObject({ status: "superseded" });
    await turns();
    expect(adapter.transactions[0]).toMatchObject({ commits: 0, rollbacks: 1 });
    adapter.gates[1]!.resolve();
    await expect(winner).resolves.toMatchObject({ status: "committed" });
    expect(adapter.transactions[1]).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(executor.current).toMatchObject({ stats: { frame: 1, generation: 2 } });
    adapter.gates[0]!.resolve();
  });

  it("invalidates active and committed state on device loss", async () => {
    const lost = deferred<unknown>();
    const { resources, adapter, executor, scheduler } = setup(4, 6, lost.promise);
    await scheduler.submit(request(0));
    adapter.manualSubmit = true;
    const pending = scheduler.submit(request(1));
    await turns(); lost.resolve(new Error("adapter reset")); await turns();
    await expect(pending).rejects.toThrow("device was lost");
    expect(adapter.transactions[1]).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(resources.disposed).toBe(true); expect(executor.current).toBeUndefined();
    await expect(scheduler.submit(request(2))).rejects.toThrow("device was lost");
  });

  it("allows bounded camera-cut acceleration but rejects every budget overflow", async () => {
    const { resources, adapter, executor, scheduler } = setup(4, 6);
    const normal = await scheduler.submit(request(0));
    const cut = await scheduler.submit(request(1, { cameraPosition: [20, 0, 0], cameraCut: true }));
    expect(normal.stats!.updateCount).toBe(4); expect(cut.stats!.updateCount).toBe(6);
    expect(adapter.transactions.map(item => item.plan.updates.length)).toEqual([4, 6]);
    expect(executor.current).toMatchObject({ stats: { updateCount: 6, committedUpdateCount: 10 } });

    const oversized = planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0], sceneBounds: scene,
      options: { levelCount: 2, gridSize: [4, 2, 4], updateBudget: 7 } });
    const resourceCalls = resources.plans.length;
    await expect(executor.setValidated(oversized, "gpu-1")).rejects.toThrow("budget exceeded");
    expect(resources.plans).toHaveLength(resourceCalls);
    expect(() => setup(4, 9)).toThrow("twice frameBudget");
  });

  it("rolls back commit failures and rejects epoch drift before publishing", async () => {
    const { resources, adapter, executor, scheduler } = setup();
    await scheduler.submit(request(0)); const before = executor.current;
    adapter.failPhase = "commit";
    await expect(scheduler.submit(request(1))).rejects.toThrow("commit failed");
    expect(adapter.transactions[1]).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(executor.current).toBe(before);
    adapter.failPhase = undefined; adapter.epoch = "gpu-2";
    const calls = resources.plans.length;
    await expect(scheduler.submit(request(1))).rejects.toThrow("epoch mismatch");
    expect(resources.plans).toHaveLength(calls);
  });
});
