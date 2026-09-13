import { describe, expect, it } from "vitest";
import { RenderGraphBuilder, type RenderResourceLifetime } from "./renderGraph.js";

function graph() {
  return new RenderGraphBuilder()
    .addResource({ id: "scene-color", descriptor: "rgba16float" })
    .addResource({ id: "bloom", descriptor: "rgba16float" })
    .addResource({ id: "output", descriptor: "swapchain", external: true });
}

describe("RenderGraphBuilder", () => {
  it("revalidates after a missing producer arrives and protects the compiled plan", () => {
    const graph = new RenderGraphBuilder()
      .addResource({ id: "color", descriptor: "rgba16float" })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "present", kind: "present", inputs: ["color"], outputs: ["output"] });
    expect(graph.compile().valid).toBe(false);
    graph.addPass({ id: "scene", kind: "render", outputs: ["color"] });
    const result = graph.compile();
    expect(result.order).toEqual(["scene", "present"]);
    expect(() => (result.order as string[]).reverse()).toThrow();
    expect(graph.compile().order).toEqual(["scene", "present"]);
  });
  it("compiles a deterministic forward-plus post chain", () => {
    const result = graph()
      .addPass({ id: "scene", kind: "forward", outputs: ["scene-color"] })
      .addPass({ id: "bloom", kind: "post", inputs: ["scene-color"], outputs: ["bloom"] })
      .addPass({ id: "present", kind: "present", inputs: ["bloom"], outputs: ["output"] })
      .compile();
    expect(result).toMatchObject({ valid: true, order: ["scene", "bloom", "present"] });
    expect(result.resources).toEqual([
      { id: "scene-color", descriptor: "rgba16float", external: false, firstUse: 0, lastUse: 1, transientSlot: 0 },
      { id: "bloom", descriptor: "rgba16float", external: false, firstUse: 1, lastUse: 2, transientSlot: 1 },
      { id: "output", descriptor: "swapchain", external: true, firstUse: 2, lastUse: 2 },
    ]);
  });

  it("aliases compatible transient resources only after their last use", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "scene", descriptor: "rgba16float", aliasKey: "hdr-64x64-s4-render-sample" })
      .addResource({ id: "bloom-a", descriptor: "rgba16float", aliasKey: "hdr-64x64-s4-render-sample" })
      .addResource({ id: "bloom-b", descriptor: "rgba16float", aliasKey: "hdr-64x64-s4-render-sample" })
      .addResource({ id: "depth", descriptor: "depth24plus" })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "geometry", kind: "render", outputs: ["scene", "depth"] })
      .addPass({ id: "downsample", kind: "compute", inputs: ["scene"], outputs: ["bloom-a"] })
      .addPass({ id: "blur", kind: "compute", inputs: ["bloom-a"], outputs: ["bloom-b"] })
      .addPass({ id: "present", kind: "render", inputs: ["bloom-b", "depth"], outputs: ["output"] })
      .compile();
    expect(result.valid).toBe(true);
    expect(result.resources.map(({ id, transientSlot }) => [id, transientSlot])).toEqual([
      ["scene", 0], ["bloom-a", 2], ["bloom-b", 0], ["depth", 1], ["output", undefined],
    ]);
    expect(() => (result.resources as RenderResourceLifetime[]).pop()).toThrow();
  });

  it("plans aliases by execution lifetime instead of declaration order", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "late", descriptor: "rgba16float", aliasKey: "hdr" })
      .addResource({ id: "handoff", descriptor: "rgba16float", aliasKey: "hdr" })
      .addResource({ id: "early", descriptor: "rgba16float", aliasKey: "hdr" })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "early-pass", kind: "render", outputs: ["early"] })
      .addPass({ id: "handoff-pass", kind: "compute", inputs: ["early"], outputs: ["handoff"] })
      .addPass({ id: "late-pass", kind: "compute", inputs: ["handoff"], outputs: ["late"] })
      .addPass({ id: "present", kind: "render", inputs: ["late"], outputs: ["output"] })
      .compile();
    const slots = new Map(result.resources.map((resource) => [resource.id, resource.transientSlot]));
    expect(result.valid).toBe(true);
    expect(slots.get("early")).toBe(slots.get("late"));
    expect(slots.get("handoff")).not.toBe(slots.get("early"));
  });

  it("reports missing resources and empty outputs", () => {
    const result = graph()
      .addPass({ id: "scene", kind: "forward", inputs: ["missing"], outputs: [] })
      .compile();
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing-resource",
      "empty-outputs",
    ]);
  });

  it("requires explicit complete alias compatibility and rejects it on external resources", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "early", descriptor: "rgba16float" })
      .addResource({ id: "late", descriptor: "rgba16float" })
      .addResource({ id: "handoff", descriptor: "rgba16float" })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "early-pass", kind: "render", outputs: ["early"] })
      .addPass({ id: "handoff-pass", kind: "render", inputs: ["early"], outputs: ["handoff"] })
      .addPass({ id: "late-pass", kind: "render", inputs: ["handoff"], outputs: ["late"] })
      .addPass({ id: "present", kind: "present", inputs: ["late"], outputs: ["output"] })
      .compile();
    const slots = new Map(result.resources.map((resource) => [resource.id, resource.transientSlot]));
    expect(slots.get("early")).not.toBe(slots.get("late"));
    expect(() => new RenderGraphBuilder().addResource({
      id: "screen", descriptor: "swapchain", external: true, aliasKey: "unsafe",
    })).toThrow("External render resource");
  });

  it("rejects duplicate writers and unread outputs", () => {
    const result = graph()
      .addPass({ id: "scene", kind: "forward", outputs: ["scene-color"] })
      .addPass({ id: "debug", kind: "debug", outputs: ["scene-color"] })
      .addPass({ id: "unused", kind: "debug", outputs: ["bloom"] })
      .compile();
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "duplicate-resource",
      "unread-resource",
      "unread-resource",
    ]);
  });

  it("detects explicit pass cycles", () => {
    const result = graph()
      .addPass({ id: "a", kind: "debug", outputs: ["scene-color"], dependencies: ["b"] })
      .addPass({ id: "b", kind: "debug", inputs: ["scene-color"], outputs: ["bloom"], dependencies: ["a"] })
      .compile();
    expect(result.valid).toBe(false);
    expect(result.order).toEqual([]);
    expect(result.issues.some((issue) => issue.code === "cycle")).toBe(true);
  });
});
