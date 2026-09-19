import { describe, expect, it } from "vitest";
import { KernelBuilder } from "./shaderCompute/kernel.js";
import { emitKernelWgsl } from "./shaderCompute/emitWgsl.js";
import { RenderGraphBuilder, type RenderGraphCompileResult } from "./renderGraph.js";
import { deserializePlan, planMatches, serializePlan } from "./renderGraphPlan.js";

function compileGraph(): RenderGraphCompileResult {
  return new RenderGraphBuilder()
    .addResource({ id: "scene", descriptor: "rgba16float", aliasKey: "hdr" })
    .addResource({ id: "bloom", descriptor: "rgba16float", aliasKey: "hdr" })
    .addResource({ id: "dead-end", descriptor: "rgba16float" })
    .addResource({ id: "output", descriptor: "swapchain", external: true })
    .addPass({ id: "gbuffer", kind: "render", outputs: ["scene"] })
    .addPass({ id: "shadow-a", kind: "render", outputs: ["dead-end"] })
    .addPass({ id: "bloom", kind: "post", inputs: ["scene"], outputs: ["bloom"] })
    .addPass({ id: "present", kind: "present", inputs: ["bloom"], outputs: ["output"] })
    .compile({ cullUnusedPasses: true });
}

function dcirKernelWgsl(): string {
  const builder = new KernelBuilder();
  const gid = builder.push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const x = builder.push({ id: "x", type: "u32", op: "component", input: gid });
  const value = builder.push({ id: "value", type: "f32", op: "literal", value: 0.5 });
  const coords = builder.push({ id: "coords", type: "vec2u", op: "make-vec2u", inputs: [x, x] });
  const guard = builder.push({ id: "guard", type: "bool", op: "literal", value: true });
  return emitKernelWgsl({
    name: "plan_round_trip_smoke",
    workgroupSize: [8, 8],
    uniforms: [],
    nodes: builder.nodes(),
    guard,
    output: { coords, value },
  }).code;
}

describe("render plan serialization (B1 slice 1)", () => {
  it("round-trips a compiled plan through serialize/deserialize with stable planHash", () => {
    const compiled = compileGraph();
    const text = serializePlan(compiled);
    const loaded = deserializePlan(text);
    expect(loaded.planHash).toBe(compiled.planHash);
    expect(loaded.order).toEqual(compiled.order);
    expect(loaded.resources).toEqual(compiled.resources);
    expect(loaded.culledPasses).toEqual(compiled.culledPasses);
    expect(loaded.parallelGroups).toEqual(compiled.parallelGroups);
  });

  it("culled passes are excluded from the persisted order", () => {
    const text = serializePlan(compileGraph());
    const loaded = deserializePlan(text);
    expect(loaded.culledPasses).toEqual(["shadow-a"]);
    expect(loaded.order).not.toContain("shadow-a");
  });

  it("rejects tampered plans via the embedded planHash", () => {
    const text = serializePlan(compileGraph());
    const parsed = JSON.parse(text) as { order: string[] };
    parsed.order = [...parsed.order].reverse();
    expect(() => deserializePlan(JSON.stringify(parsed))).toThrowError(/hash 不匹配/);
  });

  it("planMatches detects identical and divergent compiled plans", () => {
    const first = compileGraph();
    const stored = serializePlan(first);
    expect(planMatches(first.planHash, stored)).toBe(true);
    expect(planMatches("deadbeef", stored)).toBe(false);
    expect(planMatches(first.planHash, "{not json")).toBe(false);
  });

  it("serializes a plan containing a DCIR kernel artifact reference", () => {
    const wgsl = dcirKernelWgsl();
    expect(wgsl).toContain("plan_round_trip_smoke");
    const compiled = compileGraph();
    const text = serializePlan(compiled);
    expect(deserializePlan(text).planHash).toBe(compiled.planHash);
  });
});
