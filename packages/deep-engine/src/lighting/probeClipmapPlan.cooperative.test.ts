import { describe, expect, it, vi } from "vitest";
import { planIrradianceProbeClipmap, planIrradianceProbeClipmapCooperative } from "./probeClipmapPlan.js";
import { ProbeClipmapUpdateScheduler, type ProbeClipmapPlanPublisher } from "./probeClipmapUpdateScheduler.js";

const request = { cameraPosition: [0, 0, 0], sceneBounds: { min: [-100, -100, -100], max: [100, 100, 100] },
  options: { levelCount: 4, gridSize: [20, 10, 20] } } as const;

describe("cooperative GI planning", () => {
  it("preserves the exact synchronous plan across initial, pending, scroll and dirty work", async () => {
    const initial = planIrradianceProbeClipmap(request);
    const cases = [request, { ...request, previous: initial.history },
      { ...request, previous: initial.history, cameraPosition: [7, 1, -3] as const,
        dirtyBounds: [{ min: [-3, -2, -1], max: [5, 4, 3] } as const] }];
    for (const value of cases) expect(await planIrradianceProbeClipmapCooperative(value))
      .toEqual(planIrradianceProbeClipmap(value));
  });

  it("yields to queued host work before publishing a large cold plan", async () => {
    let responded = false;
    const pending = planIrradianceProbeClipmapCooperative(request);
    expect(pending).toBeInstanceOf(Promise);
    queueMicrotask(() => { responded = true; });
    await pending;
    expect(responded).toBe(true);
  });

  it("cancels during planning and never calls the GPU publisher", async () => {
    const publisher = { setValidated: vi.fn() } as ProbeClipmapPlanPublisher;
    const scheduler = new ProbeClipmapUpdateScheduler(publisher);
    const abort = new AbortController();
    const pending = scheduler.submit({ ...request, frame: 0, deviceEpoch: "gpu-1", viewport: [1920, 1080] }, abort.signal);
    abort.abort(new Error("cancel cold initialization"));
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(publisher.setValidated).not.toHaveBeenCalled();
    expect(scheduler.current).toBeUndefined();
  });

  it("drains a stable view with the same coverage and priority as full replanning", async () => {
    const publisher = { setValidated: vi.fn(async () => ({ status: "reused" })) } as unknown as ProbeClipmapPlanPublisher;
    const cached = new ProbeClipmapUpdateScheduler(publisher), replanned = new ProbeClipmapUpdateScheduler(publisher);
    const outside = { min: [1000, 1000, 1000], max: [1001, 1001, 1001] } as const;
    for (let frame = 0; frame < 3; frame++) {
      const input = { ...request, frame, deviceEpoch: "gpu-1", viewport: [1920, 1080] as const };
      const left = await cached.submit(input);
      const right = await replanned.submit({ ...input, dirtyBounds: [outside] });
      expect(left.plan).toEqual(right.plan);
      expect(left.stats).toEqual(right.stats);
    }
  });

  it("does not publish a large plan after a newer frame or disposal wins", async () => {
    const publisher = { setValidated: vi.fn(async () => ({ status: "reused" })) } as unknown as ProbeClipmapPlanPublisher;
    const scheduler = new ProbeClipmapUpdateScheduler(publisher);
    const pending = scheduler.submit({ ...request, frame: 0, deviceEpoch: "gpu-1", viewport: [1920, 1080] });
    const winner = scheduler.submit({ ...request, sceneBounds: null, frame: 1, deviceEpoch: "gpu-1", viewport: [1920, 1080] });
    expect(await winner).toMatchObject({ status: "committed", frame: 1 });
    expect(await pending).toMatchObject({ status: "superseded" });
    expect(publisher.setValidated).toHaveBeenCalledTimes(1);
    const disposed = scheduler.submit({ ...request, frame: 2, deviceEpoch: "gpu-2", viewport: [1920, 1080] });
    scheduler.dispose();
    expect(await disposed).toMatchObject({ status: "superseded" });
    expect(publisher.setValidated).toHaveBeenCalledTimes(1);
  });
});
