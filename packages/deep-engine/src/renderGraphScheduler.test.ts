import { describe, expect, it } from "vitest";
import { executeParallelGroups, type ParallelGroupTask } from "./renderGraphScheduler.js";

const task = (id: string, value: number, delay = 0): ParallelGroupTask<number> => ({
  id,
  run: async () => { if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay)); return value; },
});

describe("R6-3 parallel render-group scheduler", () => {
  it("runs groups in order and tasks in a group concurrently", async () => {
    const order: string[] = [];
    const result = await executeParallelGroups([
      [{ id: "a", run: async () => { order.push("a-start"); await new Promise(resolve => setTimeout(resolve, 15)); order.push("a-end"); return 1; } },
        { id: "b", run: async () => { order.push("b-start"); await new Promise(resolve => setTimeout(resolve, 1)); order.push("b-end"); return 2; } }],
      [{ id: "c", run: () => { order.push("c"); return 3; } }],
    ]);
    expect(result.completed).toEqual(["a", "b", "c"]);
    expect([...result.values.entries()]).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a-end"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b-end"));
    expect(result.groupsRun).toBe(2);
  });

  it("bounds concurrency without changing deterministic result order", async () => {
    let active = 0; let peak = 0;
    const make = (id: string): ParallelGroupTask<number> => ({ id, run: async () => {
      active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 3)); active -= 1; return Number(id.slice(1));
    } });
    const result = await executeParallelGroups([[make("t1"), make("t2"), make("t3"), make("t4")]], { maxConcurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.completed).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("stops at the failed group by default and preserves completed values", async () => {
    const result = await executeParallelGroups([
      [task("ok", 1)],
      [{ id: "bad", run: () => { throw new Error("boom"); } }, task("also", 2)],
      [task("never", 3)],
    ]);
    expect(result.completed).toEqual(["ok", "also"]);
    expect(result.failed.map(item => item.id)).toEqual(["bad"]);
    expect(result.values.get("ok")).toBe(1);
    expect(result.values.has("never")).toBe(false);
    expect(result.groupsRun).toBe(2);
  });

  it("can continue after a failed group when explicitly configured", async () => {
    const result = await executeParallelGroups([[{ id: "bad", run: () => { throw "bad"; } }], [task("next", 4)]], { stopOnError: false });
    expect(result.failed).toHaveLength(1);
    expect(result.completed).toEqual(["next"]);
    expect(result.groupsRun).toBe(2);
  });

  it("rejects duplicate ids and invalid concurrency", async () => {
    await expect(executeParallelGroups([[task("same", 1)], [task("same", 2)]])).rejects.toThrow("duplicate task");
    await expect(executeParallelGroups([], { maxConcurrency: 0 })).rejects.toThrow("maxConcurrency");
  });
});
