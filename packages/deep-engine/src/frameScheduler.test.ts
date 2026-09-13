import { describe, expect, it } from "vitest";
import { FrameScheduler, FrameSchedulerError, type FrameStageDescriptor } from "./frameScheduler.js";

interface FrameContext {
  values: string[];
  animate: boolean;
  failUpdate: boolean;
}

describe("FrameScheduler", () => {
  it("orders stages by dependencies", () => {
    const stages: FrameStageDescriptor<FrameContext>[] = [
      { id: "render", dependencies: ["update"], execute: (context) => void context.values.push("render") },
      { id: "input", execute: (context) => void context.values.push("input") },
      { id: "update", dependencies: ["input"], execute: (context) => void context.values.push("update") },
    ];
    const scheduler = new FrameScheduler(stages);
    expect(scheduler.compiledOrder()).toEqual(["input", "update", "render"]);
  });

  it("skips a dirty-gated stage and blocks only its dependents", async () => {
    const context: FrameContext = { values: [], animate: false, failUpdate: false };
    const result = await new FrameScheduler<FrameContext>([
      { id: "input", execute: (frame) => void frame.values.push("input") },
      {
        id: "animate",
        dependencies: ["input"],
        shouldRun: (frame) => frame.animate,
        execute: (frame) => void frame.values.push("animate"),
      },
      { id: "animate-children", dependencies: ["animate"], execute: (frame) => void frame.values.push("children") },
      { id: "physics", dependencies: ["input"], execute: (frame) => void frame.values.push("physics") },
    ]).run(context);
    expect(result.status).toBe("completed");
    expect(result.trace.map((entry) => [entry.stage, entry.status])).toEqual([
      ["input", "completed"],
      ["animate", "skipped"],
      ["animate-children", "blocked"],
      ["physics", "completed"],
    ]);
    expect(context.values).toEqual(["input", "physics"]);
  });

  it("isolates failures to dependent branches", async () => {
    const context: FrameContext = { values: [], animate: true, failUpdate: true };
    const result = await new FrameScheduler<FrameContext>([
      { id: "input", execute: (frame) => void frame.values.push("input") },
      {
        id: "update",
        dependencies: ["input"],
        execute: (frame) => {
          frame.values.push("update");
          if (frame.failUpdate) throw new Error("integration failed");
        },
      },
      { id: "render", dependencies: ["update"], execute: (frame) => void frame.values.push("render") },
      { id: "audio", dependencies: ["input"], execute: (frame) => void frame.values.push("audio") },
    ]).run(context);
    expect(result.status).toBe("partial");
    expect(result.trace.find((entry) => entry.stage === "update")?.error).toBe("integration failed");
    expect(result.trace.map((entry) => entry.status)).toEqual([
      "completed",
      "failed",
      "blocked",
      "completed",
    ]);
    expect(context.values).toEqual(["input", "update", "audio"]);
  });

  it("rejects duplicate and cyclic configuration before a frame", () => {
    expect(() => new FrameScheduler([{ id: "same" }, { id: "same" }])).toThrow(FrameSchedulerError);
    expect(
      () =>
        new FrameScheduler([
          { id: "a", dependencies: ["b"] },
          { id: "b", dependencies: ["a"] },
        ]),
    ).toThrow(/cycle/);
  });
});
