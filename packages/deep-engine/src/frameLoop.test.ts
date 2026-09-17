import { describe, expect, it } from "vitest";
import { FrameLoop, type FrameLoopStage } from "./frameLoop.js";

describe("FrameLoop", () => {
  it("keeps an idle demand loop from executing stages", async () => {
    let executions = 0;
    const loop = new FrameLoop("demand", [
      { id: "render", execute: () => { executions += 1; } },
    ]);

    expect(loop.shouldRequestFrame()).toBe(false);
    await expect(loop.advance(10, undefined)).resolves.toMatchObject({
      status: "idle",
      frameIndex: null,
      invalidationReasons: [],
      trace: [],
    });
    expect(executions).toBe(0);
    expect(loop.diagnostics()).toMatchObject({ attemptedFrames: 0, renderedFrames: 0 });
  });

  it("coalesces demand reasons and runs stable priority stages with injected time", async () => {
    const calls: string[] = [];
    const stages: FrameLoopStage<string[]>[] = [
      { id: "render", priority: 20, execute: ({ context }) => { context.push("render"); } },
      { id: "update-a", priority: -10, execute: ({ context }) => { context.push("update-a"); } },
      { id: "update-b", priority: -10, execute: ({ context }) => { context.push("update-b"); } },
    ];
    const loop = new FrameLoop("demand", stages);

    expect(loop.invalidate("camera")).toBe(true);
    expect(loop.invalidate("camera")).toBe(false);
    expect(loop.invalidate("resource-ready")).toBe(false);
    expect(loop.shouldRequestFrame()).toBe(true);

    const first = await loop.advance(100, calls);
    expect(first).toMatchObject({
      status: "rendered",
      frameIndex: 0,
      timeMs: 100,
      deltaMs: 0,
      invalidationReasons: ["camera", "resource-ready"],
    });
    expect(first.trace.map(({ id, priority, order }) => [id, priority, order])).toEqual([
      ["update-a", -10, 0],
      ["update-b", -10, 1],
      ["render", 20, 2],
    ]);
    expect(calls).toEqual(["update-a", "update-b", "render"]);

    loop.invalidate("animation");
    await expect(loop.advance(116, calls)).resolves.toMatchObject({ deltaMs: 16, frameIndex: 1 });
    expect(loop.diagnostics()).toMatchObject({ attemptedFrames: 2, renderedFrames: 2 });
  });

  it("keeps invalidations raised during a frame for the next demand frame", async () => {
    const loop = new FrameLoop("demand", [
      {
        id: "update",
        execute: ({ frameIndex, invalidate }) => {
          if (frameIndex === 0) invalidate("async-resource-ready");
        },
      },
    ]);

    loop.invalidate("initial");
    const first = await loop.advance(1, undefined);
    expect(first.invalidationReasons).toEqual(["initial"]);
    expect(loop.diagnostics()).toMatchObject({
      frameRequested: true,
      pendingInvalidationReasons: ["async-resource-ready"],
    });
    const second = await loop.advance(2, undefined);
    expect(second.invalidationReasons).toEqual(["async-resource-ready"]);
    expect(loop.shouldRequestFrame()).toBe(false);
  });

  it("bounds diagnostic reason growth without losing the dirty signal", () => {
    const loop = new FrameLoop("demand", []);
    for (let index = 0; index < 100; index += 1) loop.invalidate(`source-${index}`);

    const reasons = loop.diagnostics().pendingInvalidationReasons;
    expect(reasons).toHaveLength(64);
    expect(reasons.at(-1)).toBe("frame-loop:additional-invalidations");
    expect(loop.shouldRequestFrame()).toBe(true);
    expect(() => loop.invalidate("x".repeat(129))).toThrow("exceeds 128 UTF-16 code units");
  });

  it("runs always and manual modes without inventing invalidation reasons", async () => {
    let executions = 0;
    const loop = new FrameLoop("always", [
      { id: "render", execute: () => { executions += 1; } },
    ]);

    expect(loop.shouldRequestFrame()).toBe(true);
    expect((await loop.advance(5, undefined)).status).toBe("rendered");
    expect((await loop.advance(6, undefined)).status).toBe("rendered");
    loop.setMode("manual");
    expect(loop.shouldRequestFrame()).toBe(false);
    expect((await loop.advance(7, undefined)).status).toBe("rendered");
    expect(executions).toBe(3);
  });

  it("rejects reentrant advance without consuming the next invalidation", async () => {
    let nestedStatus: string | undefined;
    let loop: FrameLoop<void>;
    loop = new FrameLoop("demand", [
      {
        id: "update",
        execute: async ({ timeMs, invalidate }) => {
          invalidate("next-frame");
          nestedStatus = (await loop.advance(timeMs, undefined)).status;
        },
      },
    ]);

    loop.invalidate("initial");
    expect((await loop.advance(10, undefined)).status).toBe("rendered");
    expect(nestedStatus).toBe("reentrant");
    expect(loop.diagnostics().pendingInvalidationReasons).toEqual(["next-frame"]);
    expect((await loop.advance(11, undefined)).status).toBe("rendered");
  });

  it("records stage failure, stops unsafe later stages, and releases the running guard", async () => {
    const calls: string[] = [];
    let fail = true;
    const loop = new FrameLoop("manual", [
      {
        id: "update",
        execute: () => {
          calls.push("update");
          if (fail) throw new Error("update failed");
        },
      },
      { id: "render", priority: 10, execute: () => { calls.push("render"); } },
    ]);

    const failed = await loop.advance(1, undefined);
    expect(failed).toMatchObject({
      status: "failed",
      frameIndex: 0,
      trace: [{ id: "update", status: "failed", error: "update failed" }],
    });
    expect(loop.diagnostics()).toMatchObject({ running: false, attemptedFrames: 1, renderedFrames: 0 });

    fail = false;
    expect((await loop.advance(2, undefined)).status).toBe("rendered");
    expect(calls).toEqual(["update", "update", "render"]);
  });

  it("rejects ambiguous configuration and non-monotonic time before mutating state", async () => {
    expect(() => new FrameLoop("manual", [
      { id: "same", execute: () => undefined },
      { id: "same", execute: () => undefined },
    ])).toThrow("Duplicate frame loop stage");
    expect(() => new FrameLoop("manual", [
      { id: "bad-priority", priority: Number.NaN, execute: () => undefined },
    ])).toThrow("priority must be finite");

    const loop = new FrameLoop("demand", []);
    loop.invalidate("scene-change");
    await loop.advance(10, undefined);
    loop.invalidate("camera-change");
    await expect(loop.advance(9, undefined)).rejects.toThrow("precedes the last frame time");
    expect(loop.diagnostics().pendingInvalidationReasons).toEqual(["camera-change"]);
  });
});
