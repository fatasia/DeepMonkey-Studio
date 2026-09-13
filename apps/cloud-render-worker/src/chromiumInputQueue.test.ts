import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { createInputQueue } from "./chromiumInputQueue.js";

function harness() {
  const events: unknown[][] = [];
  const page = {
    mouse: { move: vi.fn(async (x: number, y: number) => { events.push(["move", x, y]); }),
      down: vi.fn(async ({ button }: { button: string }) => { events.push(["down", button]); }),
      up: vi.fn(async ({ button }: { button: string }) => { events.push(["up", button]); }),
      wheel: vi.fn(async (x: number, y: number) => { events.push(["wheel", x, y]); }) },
    keyboard: { down: vi.fn(async (key: string) => { events.push(["keyDown", key]); }), up: vi.fn(async (key: string) => { events.push(["keyUp", key]); }) },
  };
  const errors = vi.fn(); const queue = createInputQueue(page as unknown as Page, 1920, 1080, errors);
  const pointer = (action: "move" | "down" | "up", x: number) => queue.enqueue({ type: "pointer", action, x, y: 0.5, button: "left" });
  return { page, events, errors, queue, pointer };
}

describe("cloud input queue", () => {
  it("coalesces 10,000 queued moves into the last position and preserves down/up ordering", async () => {
    const { queue, pointer, events } = harness();
    pointer("down", 0);
    for (let index = 1; index <= 10_000; index++) pointer("move", index / 10_000);
    pointer("up", 1);
    await queue.idle();
    expect(events).toEqual([["move", 0, 540], ["down", "left"], ["move", 1920, 540], ["move", 1920, 540], ["up", "left"]]);
    expect(queue.stats()).toMatchObject({ received: 10_002, applied: 3, coalesced: 9_999, maxPending: 3, pending: 0, overflows: 0 });
  });

  it("does not allow release to overtake a slow CDP press and preserves wheel/key barriers", async () => {
    const { queue, pointer, page, events } = harness();
    let release!: () => void;
    page.mouse.down.mockImplementationOnce(async ({ button }) => { await new Promise<void>(resolve => { release = resolve; }); events.push(["down", button]); });
    pointer("down", 0.1); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    pointer("move", 0.2); queue.enqueue({ type: "wheel", deltaX: 0, deltaY: 12 }); pointer("move", 0.3);
    queue.enqueue({ type: "key", action: "down", key: "Shift" }); pointer("up", 0.3); queue.enqueue({ type: "key", action: "up", key: "Shift" });
    expect(page.mouse.up).not.toHaveBeenCalled(); release(); await queue.idle();
    expect(events.map(event => event[0])).toEqual(["move", "down", "move", "wheel", "move", "keyDown", "move", "up", "keyUp"]);
  });

  it("bounds discrete-event pressure and releases held buttons and keys when stale work is discarded", async () => {
    const { queue, pointer, events } = harness();
    pointer("down", 0); queue.enqueue({ type: "key", action: "down", key: "Shift" }); await queue.idle();
    for (let index = 0; index < 10_000; index++) queue.enqueue({ type: "wheel", deltaX: 0, deltaY: 1 });
    pointer("up", 1); queue.enqueue({ type: "key", action: "up", key: "Shift" }); await queue.idle();
    expect(queue.stats().maxPending).toBeLessThanOrEqual(128); expect(queue.stats().overflows).toBeGreaterThan(0);
    expect(events.filter(event => event[0] === "up")).toHaveLength(2);
    expect(events.filter(event => event[0] === "keyUp")).toHaveLength(2);
    expect(events.at(-1)).toEqual(["keyUp", "Shift"]);
  });

  it("clears pressed state after a CDP failure and can accept a later gesture", async () => {
    const { queue, pointer, page, errors } = harness();
    page.mouse.down.mockRejectedValueOnce(new Error("CDP timeout"));
    pointer("down", 0.1); await queue.idle();
    expect(errors).toHaveBeenCalledTimes(1); expect(page.mouse.up).toHaveBeenCalledWith({ button: "left" });
    pointer("down", 0.2); pointer("up", 0.3); await queue.idle();
    expect(page.mouse.down).toHaveBeenCalledTimes(2); expect(page.mouse.up).toHaveBeenCalledTimes(2);
    queue.close(); pointer("down", 0.4); await queue.idle(); expect(page.mouse.down).toHaveBeenCalledTimes(2);
  });
});
