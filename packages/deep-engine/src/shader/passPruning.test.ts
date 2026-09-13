import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileShaderPass } from "./compiler.js";
import type { DeepShaderAsset, ShaderStageGraph } from "./types.js";

const capabilities = {
  features: [] as const,
  limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
};

function state(color: boolean) {
  return {
    topology: "triangle-list" as const, cullMode: "back" as const, frontFace: "ccw" as const,
    depthCompare: "less-equal" as const, depthWrite: true, colorWriteMask: color ? 15 : 0,
  };
}

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

function sampledColorGraph(texture: string, sampler: string, property: string): ShaderStageGraph {
  return {
    nodes: [
      { id: "uv", op: "varying", type: "vec2f", name: "surfaceUv" },
      { id: "sample", op: "texture-sample", type: "color", texture, sampler, inputs: ["uv"] },
      { id: "tint", op: "property", type: "color", name: property },
      { id: "color", op: "multiply", type: "color", inputs: ["sample", "tint"] },
    ],
    outputs: [{ semantic: "color", node: "color" }],
  };
}

function fixture(): DeepShaderAsset {
  return {
    schemaVersion: 1, id: "deep.pass-pruning",
    properties: [
      { name: "baseColor", type: "color", scope: "material", default: [1, 1, 1, 1] },
      { name: "roughness", type: "f32", scope: "material", default: 0.5 },
      { name: "objectId", type: "color", scope: "object", default: [0, 0, 0, 1] },
      { name: "shadowClip", type: "vec4f", scope: "pass", default: [0, 0, 0, 1] },
    ],
    resources: [
      { name: "baseTexture", scope: "material", binding: 1, kind: "texture-2d-f32", visibility: ["fragment"] },
      { name: "baseSampler", scope: "material", binding: 2, kind: "sampler", visibility: ["fragment"] },
      { name: "idTexture", scope: "object", binding: 1, kind: "texture-2d-f32", visibility: ["fragment"] },
      { name: "idSampler", scope: "object", binding: 2, kind: "sampler", visibility: ["fragment"] },
      { name: "unusedDepth", scope: "frame", binding: 1, kind: "texture-depth-2d", visibility: ["fragment"] },
    ],
    attributes: [
      { name: "position", semantic: "POSITION", location: 0, format: "float32x3", type: "vec3f" },
      { name: "uv", semantic: "TEXCOORD_0", location: 1, format: "float32x2", type: "vec2f" },
    ],
    varyings: [{ name: "surfaceUv", location: 0, type: "vec2f" }], keywords: [],
    techniques: [{ id: "webgpu", requirements: { webgpu: true }, passes: [
      {
        id: "forward", kind: "forward", state: state(true), vertex: vertexGraph(),
        fragment: sampledColorGraph("baseTexture", "baseSampler", "baseColor"),
      },
      {
        id: "picking", kind: "picking", state: state(true), vertex: vertexGraph(),
        fragment: sampledColorGraph("idTexture", "idSampler", "objectId"),
      },
      {
        id: "shadow", kind: "shadow", state: state(false),
        vertex: {
          nodes: [{ id: "shadowClip", op: "property", type: "vec4f", name: "shadowClip" }],
          outputs: [{ semantic: "position", node: "shadowClip" }],
        },
      },
    ] }],
  };
}

function clone(): DeepShaderAsset {
  return JSON.parse(JSON.stringify(fixture())) as DeepShaderAsset;
}

describe("Deep Shader pass-local bindings", () => {
  it("omits scopes and resources used only by other passes while preserving a used scope ABI", () => {
    const forward = compileShaderPass(fixture(), "webgpu", "forward", capabilities);
    expect(forward.success).toBe(true);
    const code = forward.value?.module.code ?? "";
    expect(code).toContain("p_baseColor: vec4f");
    expect(code).toContain("p_roughness: f32");
    expect(code).toContain("r_baseTexture");
    expect(code).toContain("r_baseSampler");
    expect(code).not.toMatch(/p_objectId|p_shadowClip|r_idTexture|r_idSampler|r_unusedDepth/);
    expect(forward.value?.propertyLayout.map((property) => property.name)).toEqual(["baseColor", "roughness"]);

    const picking = compileShaderPass(fixture(), "webgpu", "picking", capabilities);
    expect(picking.value?.module.code).toMatch(/p_objectId|r_idTexture|r_idSampler/);
    expect(picking.value?.module.code).not.toMatch(/p_baseColor|p_roughness|r_baseTexture|r_baseSampler/);
    expect(picking.value?.propertyLayout.map((property) => property.name)).toEqual(["objectId"]);

    const shadow = compileShaderPass(fixture(), "webgpu", "shadow", capabilities);
    expect(shadow.value?.module.code).toContain("p_shadowClip");
    expect(shadow.value?.module.code).not.toMatch(/DeepMaterialProperties|DeepObjectProperties|@binding\(1\)/);
  });

  it("keeps unrelated-pass bindings out of cache keys and capability checks", () => {
    const baseline = compileShaderPass(fixture(), "webgpu", "forward", capabilities);
    const changed = clone() as { resources: Array<{ name: string; binding: number }> } & DeepShaderAsset;
    changed.resources.find((resource) => resource.name === "idTexture")!.binding = 3;
    const forward = compileShaderPass(changed, "webgpu", "forward", capabilities);
    const picking = compileShaderPass(changed, "webgpu", "picking", capabilities);
    expect(forward.value?.cacheKey).toBe(baseline.value?.cacheKey);
    expect(picking.value?.cacheKey).not.toBe(compileShaderPass(fixture(), "webgpu", "picking", capabilities).value?.cacheKey);

    const twoGroups = {
      features: [] as const,
      limits: { maxBindGroups: 2, maxBindingsPerBindGroup: 3, maxInterStageShaderVariables: 16 },
    };
    expect(compileShaderPass(fixture(), "webgpu", "forward", twoGroups).success).toBe(true);
    expect(compileShaderPass(fixture(), "webgpu", "picking", twoGroups).diagnostics)
      .toMatchObject([{ code: "unsupported-capability", path: "capabilities.limits.maxBindGroups" }]);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates every pruned pass with Naga", () => {
    for (const passId of ["forward", "picking", "shadow"]) {
      const compiled = compileShaderPass(fixture(), "webgpu", passId, capabilities);
      expect(compiled.success).toBe(true);
      const validation = spawnSync(
        process.env.DEEP_SHADER_NAGA_BIN!,
        ["--stdin-file-path", `${passId}.wgsl`, "--input-kind", "wgsl"],
        { input: compiled.value!.module.code, encoding: "utf8" },
      );
      expect({ passId, status: validation.status, stderr: validation.stderr })
        .toEqual({ passId, status: 0, stderr: "" });
    }
  });
});
