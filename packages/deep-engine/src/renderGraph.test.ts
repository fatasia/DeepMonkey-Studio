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

  it("does not alias resources owned by independently encodable passes", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "left", descriptor: "rgba16float", aliasKey: "hdr" })
      .addResource({ id: "right", descriptor: "rgba16float", aliasKey: "hdr" })
      .addResource({ id: "left-out", descriptor: "swapchain", external: true })
      .addResource({ id: "right-out", descriptor: "swapchain", external: true })
      .addPass({ id: "left", kind: "render", outputs: ["left"] })
      .addPass({ id: "right", kind: "render", outputs: ["right"] })
      .addPass({ id: "left-present", kind: "render", inputs: ["left"], outputs: ["left-out"] })
      .addPass({ id: "right-present", kind: "render", inputs: ["right"], outputs: ["right-out"] })
      .compile();
    const slots = new Map(result.resources.map(resource => [resource.id, resource.transientSlot]));
    expect(result.parallelGroups?.[0]).toEqual(["left", "right"]);
    expect(slots.get("left")).not.toBe(slots.get("right"));
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
describe("RenderGraphBuilder culling/parallel/hash (#18)", () => {
  function deadChain() {
    return new RenderGraphBuilder()
      .addResource({ id: "raw", descriptor: "rgba16float" })
      .addResource({ id: "mid", descriptor: "rgba16float" })
      .addResource({ id: "dead-end", descriptor: "rgba16float" })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "scene", kind: "render", outputs: ["raw", "output"] })
      .addPass({ id: "mid", kind: "post", inputs: ["raw"], outputs: ["mid"] })
      .addPass({ id: "tail", kind: "post", inputs: ["mid"], outputs: ["dead-end"] });
  }

  it("culls transitively dead passes only under the explicit option", () => {
    // 缺省:未读资源仍是合同失败(向后兼容)。
    expect(deadChain().compile().valid).toBe(false);
    // 开启剔除:tail 与 mid 传递性死亡,scene 保留。
    const culled = deadChain().compile({ cullUnusedPasses: true });
    expect(culled.valid).toBe(true);
    expect(culled.culledPasses).toEqual(["mid", "tail"]);
    expect(culled.order).toEqual(["scene"]);
    expect(culled.resources.map((r) => r.id)).toEqual(["raw", "output"]);
  });

  it("keeps dependency-only passes alive when culling", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "upload", descriptor: "upload-buffer" })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "upload", kind: "upload", outputs: ["upload"] })
      .addPass({ id: "scene", kind: "render", dependencies: ["upload"], outputs: ["output"] })
      .compile({ cullUnusedPasses: true });
    expect(result.valid).toBe(true);
    expect(result.culledPasses).toEqual([]);
    expect(result.order).toEqual(["upload", "scene"]);
  });

  it("derives deterministic parallel groups from longest-path levels", () => {
    const result = new RenderGraphBuilder()
      .addResource({ id: "gbuffer", descriptor: "rgba16float" })
      .addResource({ id: "shadow-a", descriptor: "rgba16float", external: true })
      .addResource({ id: "shadow-b", descriptor: "rgba16float", external: true })
      .addResource({ id: "shaded", descriptor: "rgba16float", external: true })
      .addResource({ id: "output", descriptor: "swapchain", external: true })
      .addPass({ id: "gbuffer", kind: "render", outputs: ["gbuffer", "output"] })
      .addPass({ id: "shadow-a", kind: "render", outputs: ["shadow-a"] })
      .addPass({ id: "shadow-b", kind: "render", outputs: ["shadow-b"] })
      .addPass({ id: "shading", kind: "render", inputs: ["gbuffer", "shadow-a", "shadow-b"], outputs: ["shaded"] })
      .compile();
    expect(result.valid).toBe(true);
    // 三个无前驱 pass 同深度 ⇒ 可并发 encode;shading 依赖三者 ⇒ 下一层;组序按深度,组内按拓扑序。
    expect(result.parallelGroups).toEqual([["gbuffer", "shadow-a", "shadow-b"], ["shading"]]);
  });

  it("produces a stable planHash that changes with the plan", () => {
    const build = () =>
      graph()
        .addPass({ id: "scene", kind: "forward", outputs: ["scene-color"] })
        .addPass({ id: "bloom", kind: "post", inputs: ["scene-color"], outputs: ["bloom"] })
        .addPass({ id: "present", kind: "present", inputs: ["bloom"], outputs: ["output"] });
    const first = build().compile();
    const second = build().compile();
    expect(first.planHash).toBeDefined();
    expect(first.planHash).toBe(second.planHash);
    const extended = build()
      .addResource({ id: "extra", descriptor: "rgba16float" })
      .addPass({ id: "extra", kind: "post", inputs: ["bloom"], outputs: ["extra"] })
      .compile();
    expect(extended.planHash).not.toBe(first.planHash);
  });
});
