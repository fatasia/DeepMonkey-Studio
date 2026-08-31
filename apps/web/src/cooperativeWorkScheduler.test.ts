import { describe, expect, it, vi } from "vitest";
import { CooperativeWorkScheduler } from "./cooperativeWorkScheduler";

describe("CooperativeWorkScheduler", () => {
  it("keeps short batches synchronous and yields after the time budget", async () => {
    let now = 0;
    const yieldControl = vi.fn(async () => { now += 1; });
    const scheduler = new CooperativeWorkScheduler(() => now, yieldControl, 8);

    now = 7;
    expect(await scheduler.checkpoint()).toBe(false);
    now = 9;
    expect(await scheduler.checkpoint()).toBe(true);
    expect(yieldControl).toHaveBeenCalledOnce();
    now = 15;
    expect(await scheduler.checkpoint()).toBe(false);
  });
});
