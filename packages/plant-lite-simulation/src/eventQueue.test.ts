import { describe, expect, it } from "vitest";
import { SimulationEventQueue } from "./eventQueue.js";

describe("SimulationEventQueue", () => {
  it("keeps chronological order and sequence stability without sorting the full queue", () => {
    const queue = new SimulationEventQueue();
    queue.push({ at: 8, sequence: 3, type: "availability", id: "late" });
    queue.push({ at: 2, sequence: 2, type: "arrival", id: "second" });
    queue.push({ at: 2, sequence: 1, type: "arrival", id: "first" });

    expect(queue.peek()?.id).toBe("first");
    expect([queue.pop()?.id, queue.pop()?.id, queue.pop()?.id]).toEqual(["first", "second", "late"]);
    expect(queue.pop()).toBeUndefined();
  });
});
