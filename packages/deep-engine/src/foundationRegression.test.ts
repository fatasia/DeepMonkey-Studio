import { describe, expect, it } from "vitest";
import { DeepSceneState } from "./sceneState.js";
import { FrameScheduler } from "./frameScheduler.js";
import { RenderGraphBuilder } from "./renderGraph.js";

describe("scene mutation invariants", () => {
  it("moves a subtree once and invalidates both ancestry and descendants", () => {
    const scene = new DeepSceneState();
    const a = scene.createObject({ id: "a" });
    const b = scene.createObject({ id: "b" });
    const child = scene.createObject({ id: "child", parent: a });
    const leaf = scene.createObject({ id: "leaf", parent: child });
    scene.clearDirty([a, b, child, leaf]);
    scene.attach(child, b);
    expect(scene.snapshot().objects[a]!.children).toEqual([]);
    expect(scene.snapshot().rootIds).toEqual([a, b]);
    const visited: string[] = [];
    scene.traverse((id) => visited.push(id));
    expect(visited).toEqual([a, b, child, leaf]);
    expect([a, b, child, leaf].every((id) => scene.isDirty(id))).toBe(true);
    scene.clearDirty([a, b, child, leaf]);
    scene.setTransform(b, { position: [2, 3, 4] });
    expect(scene.isDirty(leaf)).toBe(true);
  });

  it("failed creation and reparenting leave the snapshot unchanged", () => {
    const scene = new DeepSceneState();
    const root = scene.createObject();
    const child = scene.createObject({ parent: root });
    const before = scene.snapshot();
    expect(() => scene.createObject({ parent: "absent" })).toThrow();
    expect(scene.snapshot()).toEqual(before);
    expect(() => scene.attach(child, root, 9)).toThrow();
    expect(scene.snapshot()).toEqual(before);
    expect(scene.createObject()).toBe("object-3");
  });

  it("acknowledges removals and avoids generated ID collisions", () => {
    const scene = new DeepSceneState();
    scene.createObject({ id: "object-1" });
    const child = scene.createObject();
    expect(child).toBe("object-2");
    scene.remove(child, { dispose: true });
    scene.clearDirty(["object-1", child]);
    expect(scene.stats.dirtyCount).toBe(0);
    expect(() => scene.createObject({ id: child })).toThrow();
  });

  it("rejects non-finite transforms without committing partial state", () => {
    const scene = new DeepSceneState();
    const id = scene.createObject();
    const before = scene.snapshot();
    expect(() => scene.setTransform(id, { scale: [1, Number.NaN, 1] })).toThrow();
    expect(scene.snapshot()).toEqual(before);
  });
});

describe("frame failure propagation", () => {
  it.each(["execute", "predicate", "skip"])("blocks every descendant of %s", async (failure) => {
    const executed: string[] = [];
    const result = await new FrameScheduler([
      { id: "source", shouldRun: () => {
        if (failure === "predicate") throw new Error("predicate failed");
        return failure !== "skip";
      }, execute: () => { throw new Error("execute failed"); } },
      { id: "child", dependencies: ["source"] },
      { id: "grandchild", dependencies: ["child"], execute: () => { executed.push("bad"); } },
      { id: "independent", execute: () => { executed.push("good"); } },
    ]).run({});
    expect(executed).toEqual(["good"]);
    expect(result.trace[2]!.status).toBe("blocked");
    expect(result.status).toBe(failure === "skip" ? "completed" : "partial");
  });
});

describe("render graph execution safety", () => {
  it("rejects transient reads without a producer and returns no executable plan", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "uninitialized", descriptor: "rgba16float" })
      .addResource({ id: "screen", descriptor: "swapchain", external: true })
      .addPass({ id: "present", kind: "render", inputs: ["uninitialized"], outputs: ["screen"] })
      .compile();
    expect(result.valid).toBe(false);
    expect(result.order).toEqual([]);
  });

  it("rejects implicit in-place read/write feedback", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "color", descriptor: "rgba16float", external: true })
      .addPass({ id: "post", kind: "render", inputs: ["color"], outputs: ["color"] })
      .compile();
    expect(result.valid).toBe(false);
  });

  it("owns pass descriptors rather than retaining mutable author arrays", () => {
    const outputs = ["screen"];
    const graph = new RenderGraphBuilder()
      .addResource({ id: "screen", descriptor: "swapchain", external: true })
      .addPass({ id: "present", kind: "render", outputs });
    outputs[0] = "missing";
    expect(graph.compile().valid).toBe(true);
  });
});
