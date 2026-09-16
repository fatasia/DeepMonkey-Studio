import { describe, expect, it } from "vitest";
import type { ProbeClipmapResourceUpdate } from "./probeClipmapResources.js";
import type { ProbeAabb, ProbeClipmapPlan, ProbeVector3 } from "./probeClipmapPlan.js";
import {
  ProbeClipmapUpdateScheduler,
  type ProbeClipmapFrameRequest, type ProbeClipmapPlanPublisher,
} from "./probeClipmapUpdateScheduler.js";

const scene = { min: [-100, -100, -100], max: [100, 100, 100] } as const;
const base = (frame: number, overrides: Partial<ProbeClipmapFrameRequest> = {}): ProbeClipmapFrameRequest => ({
  frame, deviceEpoch: "gpu-1", viewport: [1280, 720], cameraPosition: [0, 0, 0],
  sceneBounds: scene, options: { levelCount: 2, gridSize: [4, 2, 4] }, ...overrides,
});
function published(plan: ProbeClipmapPlan): ProbeClipmapResourceUpdate {
  return { status: "reused", resource: { plan }, evidence: {
    generation: 1, allocatedBytes: plan.profile.estimatedBytes, updatedBytes: 0,
    updateCount: plan.updates.length, createdBufferCount: 0, reusedBufferCount: 3,
  } } as unknown as ProbeClipmapResourceUpdate;
}
class ImmediatePublisher implements ProbeClipmapPlanPublisher {
  readonly plans: ProbeClipmapPlan[] = [];
  failure: Error | undefined;
  async setValidated(plan: ProbeClipmapPlan): Promise<ProbeClipmapResourceUpdate> {
    this.plans.push(plan);
    if (this.failure) throw this.failure;
    return published(plan);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class DeferredPublisher implements ProbeClipmapPlanPublisher {
  readonly gates: ReturnType<typeof deferred<ProbeClipmapResourceUpdate>>[] = [];
  readonly signals: AbortSignal[] = [];
  readonly plans: ProbeClipmapPlan[] = [];
  setValidated(plan: ProbeClipmapPlan, _epoch: string, signal?: AbortSignal): Promise<ProbeClipmapResourceUpdate> {
    const gate = deferred<ProbeClipmapResourceUpdate>(); this.gates.push(gate);
    this.signals.push(signal!); this.plans.push(plan); return gate.promise;
  }
}
function box(point: ProbeVector3): ProbeAabb {
  return { min: point.map(value => value - 0.01) as unknown as ProbeVector3,
    max: point.map(value => value + 0.01) as unknown as ProbeVector3 };
}
const keys = (plan: ProbeClipmapPlan) => plan.updates.map(update => `${update.level}:${update.cell.join(":")}`);

describe("probe clipmap frame scheduler", () => {
  it("uses a fixed budget and weighted near-level priority with deterministic coverage", async () => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    const result = await scheduler.submit(base(0));
    expect(result.status).toBe("committed");
    expect(result.stats).toMatchObject({ invalidation: "initial", frameBudget: 8,
      capacityBudget: 12, candidateCount: 64, updateCount: 8, deferredCount: 56,
      committedUpdateCount: 8 });
    expect(result.stats!.updatesByLevel).toEqual([6, 2]);
    expect(result.stats!.frameCoverage).toBe(8 / 64);
    expect(result.stats!.residentCoverage).toBe(1 - 56 / 64);

    const secondPublisher = new ImmediatePublisher();
    const second = new ProbeClipmapUpdateScheduler(secondPublisher, { frameBudget: 8, cameraCutBudget: 12 });
    const repeated = await second.submit(base(0));
    expect(keys(repeated.plan!)).toEqual(keys(result.plan!));
    expect(repeated.stats).toEqual(result.stats);
  });

  it("prioritizes dynamic and dirty probes while reserving progress for old pending work", async () => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    const first = await scheduler.submit(base(0));
    const dynamic = first.plan!.deferred[0]!.position;
    const dirty = first.plan!.deferred.find(update => update.position.some((value, axis) => value !== dynamic[axis]))!.position;
    const result = await scheduler.submit(base(1, { dynamicBounds: [box(dynamic)], dirtyBounds: [box(dirty)] }));
    expect(result.stats!.updatesByClass.dynamic).toBeGreaterThan(0);
    expect(result.stats!.updatesByClass.dirty).toBeGreaterThan(0);
    expect(result.stats!.updatesByClass.pending).toBeGreaterThan(0);
    expect(result.stats!.updateCount).toBe(8);
  });

  it("scrolls cascades on camera movement and bounds camera-cut acceleration", async () => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    await scheduler.submit(base(0));
    const moved = await scheduler.submit(base(1, { cameraPosition: [20, 0, 0], cameraCut: true }));
    expect(moved.stats).toMatchObject({ frameBudget: 12, capacityBudget: 12, updateCount: 12 });
    expect(moved.stats!.updatesByClass.scroll).toBeGreaterThan(0);
    expect(moved.stats!.updateCount).toBeLessThanOrEqual(8 * 2);
  });

  it("uses a stable low-budget fairness cycle instead of starving pending probes", async () => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 1, cameraCutBudget: 2 });
    const first = await scheduler.submit(base(0));
    const dynamicBounds = [box(first.plan!.updates[0]!.position)];
    const one = await scheduler.submit(base(1, { dynamicBounds }));
    const two = await scheduler.submit(base(2, { dynamicBounds }));
    const three = await scheduler.submit(base(3, { dynamicBounds }));
    expect(one.stats!.updatesByClass.dynamic).toBe(1);
    expect(two.stats!.updatesByClass.dynamic).toBe(1);
    expect(three.stats!.updatesByClass.pending).toBe(1);
  });

  it("lets the latest request win and never commits an aborted generation", async () => {
    const publisher = new DeferredPublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 4, cameraCutBudget: 6 });
    const stale = scheduler.submit(base(0));
    const invalid = base(1, { sceneBounds: { min: [1, 0, 0], max: [0, 0, 0] } });
    await expect(scheduler.submit(invalid)).rejects.toThrow("min must not exceed max");
    expect(publisher.signals[0]!.aborted).toBe(false);
    const winner = scheduler.submit(base(1, { cameraPosition: [4, 0, 0] }));
    expect(publisher.signals[0]!.aborted).toBe(true);
    await expect(stale).resolves.toMatchObject({ status: "superseded" });
    publisher.gates[1]!.resolve(published(publisher.plans[1]!));
    const committed = await winner;
    expect(committed.status).toBe("committed");
    expect(scheduler.current).toBe(committed.stats);
    publisher.gates[0]!.resolve(published(committed.plan!));
  });

  it("does not publish progress on failure or caller cancellation", async () => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    await scheduler.submit(base(0)); const before = scheduler.current;
    publisher.failure = new Error("validation failed");
    await expect(scheduler.submit(base(1))).rejects.toThrow("validation failed");
    expect(scheduler.current).toBe(before);
    publisher.failure = undefined;
    const retried = await scheduler.submit(base(1));
    expect(retried.stats!.committedUpdateCount).toBe(16);

    const delayed = new DeferredPublisher();
    const cancellable = new ProbeClipmapUpdateScheduler(delayed, { frameBudget: 4, cameraCutBudget: 6 });
    const controller = new AbortController(), pending = cancellable.submit(base(0), controller.signal);
    controller.abort(new Error("caller stopped"));
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(cancellable.current).toBeUndefined();
  });

  it("fully invalidates history on viewport resize and device epoch changes", async () => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    await scheduler.submit(base(0));
    const steady = await scheduler.submit(base(1));
    expect(steady.stats!.invalidation).toBe("none");
    expect(steady.stats!.updatesByClass.pending).toBe(8);
    const resized = await scheduler.submit(base(2, { viewport: [1920, 1080] }));
    expect(resized.stats).toMatchObject({ invalidation: "resize", committedUpdateCount: 8 });
    expect(resized.stats!.updatesByClass.initial).toBe(8);
    const recovered = await scheduler.submit(base(3, { deviceEpoch: "gpu-2", viewport: [1920, 1080] }));
    expect(recovered.stats).toMatchObject({ invalidation: "device-epoch", committedUpdateCount: 8 });
    expect(recovered.stats!.updatesByClass.initial).toBe(8);
  });

  it("validates budgets and request ordering, and aborts active work on dispose", async () => {
    expect(() => new ProbeClipmapUpdateScheduler(new ImmediatePublisher(),
      { frameBudget: 8, cameraCutBudget: 17 })).toThrow("twice frameBudget");
    const publisher = new DeferredPublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 4, cameraCutBudget: 6 });
    const pending = scheduler.submit(base(2));
    await expect(scheduler.submit(base(1))).rejects.toThrow("regressed");
    scheduler.dispose(); expect(publisher.signals[0]!.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "superseded" });
    await expect(scheduler.submit(base(3))).rejects.toThrow("disposed");
  });
});
