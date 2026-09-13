import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalShaderJson, sha256Hex } from "./canonical.js";
import { compileShaderPass } from "./compiler.js";
import type { DeepShaderAsset, ShaderPass, ShaderStageGraph } from "./types.js";
import { validateShaderAsset } from "./validation.js";
import { planShaderVariants } from "./variants.js";

const capabilities = {
  features: [] as const,
  limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
};

function vertexGraph(): ShaderStageGraph {
  return {
    nodes: [
      { id: "position", op: "attribute", type: "vec3f", name: "position" },
      { id: "one", op: "literal", type: "f32", value: 1 },
      { id: "clip", op: "compose-vec4", type: "vec4f", inputs: ["position", "one"] },
      { id: "uv", op: "attribute", type: "vec2f", name: "uv" },
    ],
    outputs: [
      { semantic: "position", node: "clip" },
      { semantic: "varying", name: "surfaceUv", node: "uv" },
    ],
  };
}

function colorGraph(textured = true): ShaderStageGraph {
  if (!textured) return {
    nodes: [{ id: "objectId", op: "literal", type: "vec4f", value: [1, 0, 0, 1] }],
    outputs: [{ semantic: "color", node: "objectId" }],
  };
  return {
    nodes: [
      { id: "uv", op: "varying", type: "vec2f", name: "surfaceUv" },
      { id: "sample", op: "texture-sample", type: "vec4f", texture: "baseColor", sampler: "linearSampler", inputs: ["uv"] },
      { id: "tint", op: "property", type: "vec4f", name: "tint" },
      { id: "shaded", op: "multiply", type: "vec4f", inputs: ["sample", "tint"] },
      { id: "black", op: "literal", type: "vec4f", value: [0, 0, 0, 1] },
      { id: "enabled", op: "property", type: "bool", name: "enabled" },
      { id: "selected", op: "select", type: "vec4f", inputs: ["black", "shaded", "enabled"] },
    ],
    outputs: [{ semantic: "color", node: "selected" }],
  };
}

function state(color: boolean) {
  return {
    topology: "triangle-list" as const, cullMode: "back" as const, frontFace: "ccw" as const,
    depthCompare: "less-equal" as const, depthWrite: true, colorWriteMask: color ? 15 : 0,
  };
}

function pass(id: string, kind: ShaderPass["kind"], fragment: boolean, predicate?: ShaderPass["predicate"]): ShaderPass {
  return {
    id, kind, ...(predicate ? { predicate } : {}), state: state(fragment), vertex: vertexGraph(),
    ...(fragment ? { fragment: colorGraph(kind !== "picking") } : {}),
  };
}

function fixture(): DeepShaderAsset {
  return {
    schemaVersion: 1, id: "deep.standard-surface", label: "Deep Standard Surface",
    properties: [
      { name: "enabled", type: "bool", scope: "material", default: true },
      { name: "model", type: "mat4x4f", scope: "object", default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { name: "roughness", type: "f32", scope: "material", default: 0.5 },
      { name: "tint", type: "vec4f", scope: "material", default: [1, 1, 1, 1] },
    ],
    resources: [
      { name: "baseColor", scope: "material", binding: 1, kind: "texture-2d-f32", visibility: ["fragment"] },
      { name: "linearSampler", scope: "material", binding: 2, kind: "sampler", visibility: ["fragment"] },
    ],
    attributes: [
      { name: "position", semantic: "POSITION", location: 0, format: "float32x3", type: "vec3f" },
      { name: "uv", semantic: "TEXCOORD_0", location: 1, format: "float32x2", type: "vec2f" },
    ],
    varyings: [{ name: "surfaceUv", location: 0, type: "vec2f" }],
    keywords: [
      { name: "ALPHA_MODE", values: ["MASK", "OPAQUE"], default: "OPAQUE" },
      { name: "UNUSED_DETAIL", values: ["OFF", "ON"], default: "OFF" },
    ],
    techniques: [{
      id: "webgpu", requirements: { webgpu: true },
      passes: [
        pass("forward", "forward", true, { op: "keyword", name: "ALPHA_MODE", equals: "OPAQUE" }),
        pass("depth", "depth", false), pass("shadow", "shadow", false), pass("picking", "picking", true),
      ],
    }],
  };
}

function clone(): DeepShaderAsset { return JSON.parse(JSON.stringify(fixture())) as DeepShaderAsset; }

describe("Deep Shader IR", () => {
  it("validates and snapshots an immutable Shader -> Technique -> Pass asset", () => {
    const result = validateShaderAsset(fixture());
    expect(result.valid).toBe(true);
    expect(result.value?.techniques[0]?.passes.map((entry) => entry.kind)).toEqual(["forward", "depth", "shadow", "picking"]);
    expect(() => (result.value!.properties as unknown[]).pop()).toThrow();
  });

  it("compiles a typed graph to deterministic WGSL, layouts, cache key and source map", () => {
    const first = compileShaderPass(fixture(), "webgpu", "forward", capabilities);
    const second = compileShaderPass(clone(), "webgpu", "forward", capabilities);
    expect(first).toEqual(second);
    expect(first.success).toBe(true);
    expect(first.value?.cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value?.module.code).toContain("@group(1) @binding(0) var<uniform> deepMaterial");
    expect(first.value?.module.code).toContain("textureSample(r_baseColor, r_linearSampler, n_uv)");
    expect(first.value?.module.code).toContain("let n_enabled: bool = (deepMaterial.p_enabled != 0u)");
    expect(first.value?.entryPoints).toEqual({ vertex: "deepVertex", fragment: "deepFragment" });
    expect(first.value?.propertyLayout.filter((entry) => entry.group === 1)).toEqual([
      { name: "enabled", type: "bool", group: 1, binding: 0, offset: 0, byteSize: 4 },
      { name: "roughness", type: "f32", group: 1, binding: 0, offset: 4, byteSize: 4 },
      { name: "tint", type: "vec4f", group: 1, binding: 0, offset: 16, byteSize: 16 },
    ]);
    for (const mapping of first.value!.sourceMap) {
      expect(first.value!.module.code.split("\n")[mapping.generatedLine - 1]).toContain(`n_${mapping.nodeId}`);
    }
    const shadow = compileShaderPass(fixture(), "webgpu", "shadow", capabilities);
    expect(shadow.value?.entryPoints).toEqual({ vertex: "deepVertex" });
    expect(shadow.value?.module.code).not.toContain("@fragment");
    const visibilityChanged = clone() as { resources: Array<{ visibility: string[] }> } & DeepShaderAsset;
    visibilityChanged.resources[0]!.visibility = ["fragment", "vertex"];
    const changed = compileShaderPass(visibilityChanged, "webgpu", "forward", capabilities);
    expect(changed.value?.module.code).toBe(first.value?.module.code);
    expect(changed.value?.cacheKey).not.toBe(first.value?.cacheKey);
  });

  it("emits a valid no-input vertex entry point when a shader has no attributes", () => {
    const asset: DeepShaderAsset = {
      schemaVersion: 1,
      id: "deep.fullscreen-clear",
      properties: [], resources: [], attributes: [], varyings: [], keywords: [],
      techniques: [{
        id: "webgpu", requirements: { webgpu: true },
        passes: [{
          id: "forward", kind: "forward", state: state(true),
          vertex: {
            nodes: [{ id: "clip", op: "literal", type: "vec4f", value: [0, 0, 0, 1] }],
            outputs: [{ semantic: "position", node: "clip" }],
          },
          fragment: {
            nodes: [{ id: "color", op: "literal", type: "vec4f", value: [0, 0, 0, 1] }],
            outputs: [{ semantic: "color", node: "color" }],
          },
        }],
      }],
    };
    const result = compileShaderPass(asset, "webgpu", "forward", capabilities);
    expect(result.success).toBe(true);
    expect(result.value?.module.code).toContain("@vertex fn deepVertex() -> DeepVertexOut");
    expect(result.value?.module.code).not.toContain("struct DeepVertexInput");
  });

  it("uses canonical SHA-256 rather than insertion-order dependent serialization", () => {
    const left = { z: 1, a: [true, "值"] };
    const right = { a: [true, "值"], z: 1 };
    expect(sha256Hex(left)).toBe(sha256Hex(right));
    expect(sha256Hex(left)).toBe(createHash("sha256").update(canonicalShaderJson(left)).digest("hex"));
  });

  it("prunes unused keyword dimensions and duplicate pass selections", () => {
    const plan = planShaderVariants(fixture(), capabilities);
    expect(plan.valid).toBe(true);
    expect(plan.variants).toHaveLength(2);
    expect(plan.variants.map((entry) => entry.passIds.includes("forward"))).toEqual([false, true]);
    expect(planShaderVariants(fixture(), capabilities, 1).diagnostics[0]?.code).toBe("variant-budget");
  });

  it("preserves an explicit source-over blend contract in the compiled pass", () => {
    const asset = clone() as { techniques: Array<{ passes: Array<{ state: Record<string, unknown> }> }> } & DeepShaderAsset;
    const forward = asset.techniques[0]!.passes[0]!;
    forward.state.depthWrite = false;
    forward.state.blend = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const result = compileShaderPass(asset, "webgpu", "forward", capabilities);
    expect(result.success).toBe(true);
    expect(result.value?.renderState.blend?.color.srcFactor).toBe("src-alpha");
    expect(result.value?.renderState.depthWrite).toBe(false);
  });

  it("rejects unknown fields, duplicate symbols/bindings and illegal pass state", () => {
    const unknown = clone() as DeepShaderAsset & { legacyShaderLab?: string };
    unknown.legacyShaderLab = "unsupported";
    expect(validateShaderAsset(unknown).diagnostics.some((entry) => entry.code === "unknown-field")).toBe(true);
    const duplicate = clone() as { resources: Array<{ binding: number; name: string }> } & DeepShaderAsset;
    duplicate.resources[1]!.binding = 1;
    duplicate.resources[1]!.name = "baseColor";
    const codes = validateShaderAsset(duplicate).diagnostics.map((entry) => entry.code);
    expect(codes).toContain("duplicate-symbol");
    expect(codes).toContain("duplicate-binding");
    const badState = clone() as { techniques: Array<{ passes: Array<{ state: { colorWriteMask: number } }> }> } & DeepShaderAsset;
    badState.techniques[0]!.passes[1]!.state.colorWriteMask = 15;
    expect(validateShaderAsset(badState).diagnostics.some((entry) => entry.code === "invalid-state")).toBe(true);
  });

  it("rejects wrong stages, graph cycles and missing varying producers", () => {
    const cyclic = clone() as { techniques: Array<{ passes: Array<{ vertex: { nodes: unknown[]; outputs: Array<{ node: string }> } }> }> } & DeepShaderAsset;
    const vertex = cyclic.techniques[0]!.passes[0]!.vertex;
    vertex.nodes.push(
      { id: "cycleA", op: "add", type: "vec3f", inputs: ["cycleB", "cycleB"] },
      { id: "cycleB", op: "add", type: "vec3f", inputs: ["cycleA", "cycleA"] },
      { id: "cycleClip", op: "compose-vec4", type: "vec4f", inputs: ["cycleA", "one"] },
    );
    vertex.outputs[0]!.node = "cycleClip";
    expect(validateShaderAsset(cyclic).diagnostics.some((entry) => entry.code === "graph-cycle")).toBe(true);
    const missingVarying = clone() as { techniques: Array<{ passes: Array<{ vertex: { outputs: unknown[] } }> }> } & DeepShaderAsset;
    missingVarying.techniques[0]!.passes[0]!.vertex.outputs.pop();
    expect(validateShaderAsset(missingVarying).diagnostics.some((entry) => entry.code === "missing-symbol")).toBe(true);
  });

  it("fails closed on accessors, non-canonical numbers and global input budget abuse", () => {
    let reads = 0;
    const accessor = clone() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "id", { enumerable: true, get: () => { reads += 1; return "evil"; } });
    expect(validateShaderAsset(accessor).diagnostics[0]?.code).toBe("non-deterministic");
    expect(reads).toBe(0);
    const negativeZero = clone() as { properties: Array<{ default: number }> } & DeepShaderAsset;
    negativeZero.properties[1]!.default = -0;
    expect(validateShaderAsset(negativeZero).diagnostics.some((entry) => entry.code === "non-deterministic")).toBe(true);
    const oversized = { ...clone(), payload: Array.from({ length: 21_000 }, (_, index) => index) };
    expect(validateShaderAsset(oversized).diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);
    const issueFlood = clone() as unknown as Record<string, unknown>;
    for (let index = 0; index < 300; index += 1) issueFlood[`unknown${index}`] = true;
    expect(validateShaderAsset(issueFlood).diagnostics).toHaveLength(128);
  });

  it("rejects referenced keyword explosion before enumeration and unsupported targets", () => {
    const asset = clone() as { keywords: Array<{ name: string; values: string[]; default: string }>; techniques: Array<{ passes: Array<{ predicate?: unknown }> }> } & DeepShaderAsset;
    asset.keywords = Array.from({ length: 13 }, (_, index) => ({ name: `K${index}`, values: ["OFF", "ON"], default: "OFF" }));
    asset.techniques[0]!.passes[0]!.predicate = { op: "all", terms: asset.keywords.map((keyword) => ({ op: "keyword", name: keyword.name, equals: "ON" })) };
    expect(planShaderVariants(asset, capabilities).diagnostics[0]?.code).toBe("variant-budget");
    const tinyTarget = { features: [] as const, limits: { maxBindGroups: 1, maxBindingsPerBindGroup: 2, maxInterStageShaderVariables: 1 } };
    expect(compileShaderPass(fixture(), "webgpu", "forward", tinyTarget).diagnostics.some((entry) => entry.code === "unsupported-capability")).toBe(true);
    const legacyTarget = { ...capabilities, legacyWebgl: true };
    expect(compileShaderPass(fixture(), "webgpu", "forward", legacyTarget).diagnostics.some((entry) => entry.code === "unknown-field")).toBe(true);
  });
});
