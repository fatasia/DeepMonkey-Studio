import { describe, expect, it } from "vitest";
import { PriorityEventQueue } from "./priorityEventQueue.js";

describe("PriorityEventQueue", () => {
  it("dispatches discrete work before continuous and background work", () => {
    const queue = new PriorityEventQueue<number>();
    queue.enqueue({ id: "telemetry", priority: "background", payload: 1 });
    queue.enqueue({ id: "pointer", priority: "continuous", coalesceKey: "viewport.pointer", payload: 2 });
    queue.enqueue({ id: "click", priority: "discrete", payload: 3 });
    expect(queue.drain().map(event => event.id)).toEqual(["click", "pointer", "telemetry"]);
  });

  it("coalesces continuous events to the newest payload without dropping discrete events", () => {
    const queue = new PriorityEventQueue<{ x: number }>();
    expect(queue.enqueue({ id: "move.1", priority: "continuous", coalesceKey: "viewport.pointer", payload: { x: 1 } }).status).toBe("queued");
    queue.enqueue({ id: "click", priority: "discrete", payload: { x: 2 } });
    expect(queue.enqueue({ id: "move.2", priority: "continuous", coalesceKey: "viewport.pointer", payload: { x: 3 } }).status).toBe("coalesced");
    const drained = queue.drain();
    expect(drained.map(event => [event.id, event.payload.x])).toEqual([["click", 2], ["move.2", 3]]);
    expect(queue.diagnostics()).toMatchObject({ pending: 0, coalesced: 1, rejected: 0 });
  });

  it("drains bounded slices and preserves deterministic order among equal priorities", () => {
    const queue = new PriorityEventQueue<number>(4);
    queue.enqueue({ id: "a", priority: "discrete", payload: 1 });
    queue.enqueue({ id: "b", priority: "discrete", payload: 2 });
    queue.enqueue({ id: "c", priority: "background", payload: 3 });
    expect(queue.drain(1).map(event => event.id)).toEqual(["a"]);
    expect(queue.drain(2).map(event => event.id)).toEqual(["b", "c"]);
  });

  it("fails closed at capacity while an existing continuous slot may still coalesce", () => {
    const queue = new PriorityEventQueue<number>(2);
    queue.enqueue({ id: "move.1", priority: "continuous", coalesceKey: "viewport.pointer", payload: 1 });
    queue.enqueue({ id: "click", priority: "discrete", payload: 2 });
    expect(queue.enqueue({ id: "extra", priority: "discrete", payload: 3 })).toMatchObject({ status: "rejected", reason: "capacity", pending: 2 });
    expect(queue.enqueue({ id: "move.2", priority: "continuous", coalesceKey: "viewport.pointer", payload: 4 })).toMatchObject({ status: "coalesced", pending: 2 });
    expect(queue.diagnostics()).toMatchObject({ pending: 2, discrete: 1, continuous: 1, rejected: 1 });
  });

  it("rejects ambiguous events and invalid limits without mutating pending work", () => {
    const queue = new PriorityEventQueue<number>(2);
    expect(queue.enqueue({ id: "bad space", priority: "discrete", payload: 1 })).toMatchObject({ status: "rejected", reason: "invalid-event" });
    expect(queue.enqueue({ id: "move", priority: "continuous", payload: 2 })).toMatchObject({ status: "rejected", reason: "invalid-event" });
    expect(queue.enqueue({ id: "click", priority: "discrete", coalesceKey: "unexpected", payload: 3 })).toMatchObject({ status: "rejected", reason: "invalid-event" });
    expect(queue.diagnostics().pending).toBe(0);
    expect(() => queue.drain(0)).toThrow("Event drain limit");
  });
});
