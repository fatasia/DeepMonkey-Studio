import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEEP_SHADER_BUDGETS } from "./constants.js";
import { compileShaderPass } from "./compiler.js";
import type { DeepShaderAsset, ShaderNode } from "./types.js";
import { validateShaderAsset } from "./validation.js";

const capabilities = {
  features: [] as const,
  limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
};

const identity4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const identity3 = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

function state() {
  return {
    topology: "triangle-list" as const, cullMode: "back" as const, frontFace: "ccw" as const,
    depthCompare: "less-equal" as const, depthWrite: true, colorWriteMask: 15,
  };
}

function pbrMathAsset(): DeepShaderAsset {
  const vertexNodes: ShaderNode[] = [
    { id: "position", op: "attribute", type: "vec3f", name: "position" },
    { id: "normal", op: "attribute", type: "vec3f", name: "normal" },
    { id: "tangent", op: "attribute", type: "vec4f", name: "tangent" },
    { id: "objectToClip", op: "property", type: "mat4x4f", name: "objectToClip" },
    { id: "normalMatrix", op: "property", type: "mat3x3f", name: "normalMatrix" },
    { id: "clipPosition", op: "transform-position", type: "vec4f", inputs: ["objectToClip", "position"] },
    { id: "normalRaw", op: "transform-direction", type: "vec3f", inputs: ["normalMatrix", "normal"] },
    { id: "normalWs", op: "normalize", type: "vec3f", inputs: ["normalRaw"] },
    { id: "tangentXyz", op: "swizzle", type: "vec3f", mask: "xyz", inputs: ["tangent"] },
    { id: "tangentRaw", op: "transform-direction", type: "vec3f", inputs: ["normalMatrix", "tangentXyz"] },
    { id: "tangentWs", op: "normalize", type: "vec3f", inputs: ["tangentRaw"] },
    { id: "bitangentRaw", op: "cross", type: "vec3f", inputs: ["normalWs", "tangentWs"] },
    { id: "handedness", op: "swizzle", type: "f32", mask: "w", inputs: ["tangent"] },
    { id: "bitangentWs", op: "scale", type: "vec3f", inputs: ["bitangentRaw", "handedness"] },
  ];
  const fragmentNodes: ShaderNode[] = [
    { id: "normalWs", op: "varying", type: "vec3f", name: "normalWs" },
    { id: "tangentWs", op: "varying", type: "vec3f", name: "tangentWs" },
    { id: "bitangentWs", op: "varying", type: "vec3f", name: "bitangentWs" },
    { id: "normalTs", op: "property", type: "vec3f", name: "normalTs" },
    { id: "normalTsX", op: "swizzle", type: "f32", mask: "x", inputs: ["normalTs"] },
    { id: "normalTsY", op: "swizzle", type: "f32", mask: "y", inputs: ["normalTs"] },
    { id: "normalTsZ", op: "swizzle", type: "f32", mask: "z", inputs: ["normalTs"] },
    { id: "normalAlongT", op: "scale", type: "vec3f", inputs: ["tangentWs", "normalTsX"] },
    { id: "normalAlongB", op: "scale", type: "vec3f", inputs: ["bitangentWs", "normalTsY"] },
    { id: "normalAlongN", op: "scale", type: "vec3f", inputs: ["normalWs", "normalTsZ"] },
    { id: "normalTb", op: "add", type: "vec3f", inputs: ["normalAlongT", "normalAlongB"] },
    { id: "normalCombined", op: "add", type: "vec3f", inputs: ["normalTb", "normalAlongN"] },
    { id: "surfaceNormal", op: "normalize", type: "vec3f", inputs: ["normalCombined"] },
    { id: "viewRaw", op: "property", type: "vec3f", name: "viewDirection" },
    { id: "lightRaw", op: "property", type: "vec3f", name: "lightDirection" },
    { id: "view", op: "normalize", type: "vec3f", inputs: ["viewRaw"] },
    { id: "light", op: "normalize", type: "vec3f", inputs: ["lightRaw"] },
    { id: "halfRaw", op: "add", type: "vec3f", inputs: ["view", "light"] },
    { id: "halfVector", op: "normalize", type: "vec3f", inputs: ["halfRaw"] },
    { id: "zero", op: "literal", type: "f32", value: 0 },
    { id: "one", op: "literal", type: "f32", value: 1 },
    { id: "five", op: "literal", type: "f32", value: 5 },
    { id: "eight", op: "literal", type: "f32", value: 8 },
    { id: "roughnessFloor", op: "literal", type: "f32", value: 0.045 },
    { id: "nDotLRaw", op: "dot", type: "f32", inputs: ["surfaceNormal", "light"] },
    { id: "nDotL", op: "max", type: "f32", inputs: ["nDotLRaw", "zero"] },
    { id: "nDotVRaw", op: "dot", type: "f32", inputs: ["surfaceNormal", "view"] },
    { id: "nDotV", op: "saturate", type: "f32", inputs: ["nDotVRaw"] },
    { id: "vDotHRaw", op: "dot", type: "f32", inputs: ["view", "halfVector"] },
    { id: "vDotH", op: "saturate", type: "f32", inputs: ["vDotHRaw"] },
    { id: "oneMinusVdotH", op: "subtract", type: "f32", inputs: ["one", "vDotH"] },
    { id: "fresnelPower", op: "pow", type: "f32", inputs: ["oneMinusVdotH", "five"] },
    { id: "baseColor", op: "property", type: "vec3f", name: "baseColor" },
    { id: "dielectricF0", op: "literal", type: "vec3f", value: [0.04, 0.04, 0.04] },
    { id: "metallic", op: "property", type: "f32", name: "metallic" },
    { id: "f0", op: "mix", type: "vec3f", inputs: ["dielectricF0", "baseColor", "metallic"] },
    { id: "oneRgb", op: "literal", type: "vec3f", value: [1, 1, 1] },
    { id: "zeroRgb", op: "literal", type: "vec3f", value: [0, 0, 0] },
    { id: "oneMinusF0", op: "subtract", type: "vec3f", inputs: ["oneRgb", "f0"] },
    { id: "fresnelDelta", op: "scale", type: "vec3f", inputs: ["oneMinusF0", "fresnelPower"] },
    { id: "fresnel", op: "add", type: "vec3f", inputs: ["f0", "fresnelDelta"] },
    { id: "roughness", op: "property", type: "f32", name: "roughness" },
    { id: "roughnessClamped", op: "clamp", type: "f32", inputs: ["roughness", "roughnessFloor", "one"] },
    { id: "roughPlusOne", op: "add", type: "f32", inputs: ["roughnessClamped", "one"] },
    { id: "roughPlusOneSq", op: "multiply", type: "f32", inputs: ["roughPlusOne", "roughPlusOne"] },
    { id: "visibilityK", op: "divide", type: "f32", inputs: ["roughPlusOneSq", "eight"] },
    { id: "oneMinusK", op: "subtract", type: "f32", inputs: ["one", "visibilityK"] },
    { id: "visibilityScaled", op: "multiply", type: "f32", inputs: ["nDotV", "oneMinusK"] },
    { id: "visibilityDenominator", op: "add", type: "f32", inputs: ["visibilityScaled", "visibilityK"] },
    { id: "visibility", op: "divide", type: "f32", inputs: ["nDotV", "visibilityDenominator"] },
    { id: "negativeMetallic", op: "negate", type: "f32", inputs: ["metallic"] },
    { id: "oneMinusMetallic", op: "add", type: "f32", inputs: ["one", "negativeMetallic"] },
    { id: "diffuse", op: "scale", type: "vec3f", inputs: ["baseColor", "oneMinusMetallic"] },
    { id: "diffuseLit", op: "scale", type: "vec3f", inputs: ["diffuse", "nDotL"] },
    { id: "specularLit", op: "scale", type: "vec3f", inputs: ["fresnel", "visibility"] },
    { id: "lighting", op: "add", type: "vec3f", inputs: ["diffuseLit", "specularLit"] },
    { id: "lightingPositive", op: "max", type: "vec3f", inputs: ["lighting", "zeroRgb"] },
    { id: "lightingBounded", op: "min", type: "vec3f", inputs: ["lightingPositive", "oneRgb"] },
    { id: "color", op: "compose-vec4", type: "vec4f", inputs: ["lightingBounded", "one"] },
  ];
  return {
    schemaVersion: 1, id: "deep.pbr-math-subset",
    properties: [
      { name: "viewDirection", type: "vec3f", scope: "frame", default: [0, 0, 1] },
      { name: "lightDirection", type: "vec3f", scope: "pass", default: [0, 1, 1] },
      { name: "baseColor", type: "vec3f", scope: "material", default: [0.8, 0.4, 0.2] },
      { name: "metallic", type: "f32", scope: "material", default: 0.5 },
      { name: "normalTs", type: "vec3f", scope: "material", default: [0, 0, 1] },
      { name: "roughness", type: "f32", scope: "material", default: 0.5 },
      { name: "normalMatrix", type: "mat3x3f", scope: "object", default: identity3 },
      { name: "objectToClip", type: "mat4x4f", scope: "object", default: identity4 },
    ], resources: [],
    attributes: [
      { name: "position", semantic: "POSITION", location: 0, format: "float32x3", type: "vec3f" },
      { name: "normal", semantic: "NORMAL", location: 1, format: "float32x3", type: "vec3f" },
      { name: "tangent", semantic: "TANGENT", location: 2, format: "float32x4", type: "vec4f" },
    ],
    varyings: [
      { name: "normalWs", location: 0, type: "vec3f" },
      { name: "tangentWs", location: 1, type: "vec3f" },
      { name: "bitangentWs", location: 2, type: "vec3f" },
    ], keywords: [], techniques: [{
      id: "webgpu", requirements: { webgpu: true }, passes: [{
        id: "forward", kind: "forward", state: state(),
        vertex: { nodes: vertexNodes, outputs: [
          { semantic: "position", node: "clipPosition" },
          { semantic: "varying", name: "normalWs", node: "normalWs" },
          { semantic: "varying", name: "tangentWs", node: "tangentWs" },
          { semantic: "varying", name: "bitangentWs", node: "bitangentWs" },
        ] },
        fragment: { nodes: fragmentNodes, outputs: [{ semantic: "color", node: "color" }] },
      }],
    }],
  };
}

function clone(): DeepShaderAsset {
  return JSON.parse(JSON.stringify(pbrMathAsset())) as DeepShaderAsset;
}

describe("Deep Shader PBR math nodes", () => {
  it("compiles a typed TBN, Fresnel and visibility graph to deterministic WGSL", () => {
    const first = compileShaderPass(pbrMathAsset(), "webgpu", "forward", capabilities);
    const second = compileShaderPass(clone(), "webgpu", "forward", capabilities);
    expect(first).toEqual(second);
    expect(first.success).toBe(true);
    const code = first.value?.module.code ?? "";
    expect(code).toContain("n_objectToClip * vec4f(n_position, 1.0)");
    expect(code).toContain("cross(n_normalWs, n_tangentWs)");
    expect(code).toContain("mix(n_dielectricF0, n_baseColor, vec3f(n_metallic))");
    expect(code).toContain("clamp(n_nDotVRaw, 0.0, 1.0)");
    expect(code).toContain("pow(n_oneMinusVdotH, n_five)");
    expect(code).toContain("n_nDotV / n_visibilityDenominator");
    expect(first.value?.sourceMap).toHaveLength(73);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = compileShaderPass(pbrMathAsset(), "webgpu", "forward", capabilities);
    expect(result.success).toBe(true);
    const validation = spawnSync(
      process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-pbr-subset.wgsl", "--input-kind", "wgsl"],
      { input: result.value!.module.code, encoding: "utf8" },
    );
    expect(validation.status).toBe(0);
    expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("Validation successful");
  });

  it("rejects invalid types and stage access through the new math nodes", () => {
    const invalid = clone() as { techniques: Array<{ passes: Array<{ fragment: { nodes: Array<Record<string, unknown>> } }> }> } & DeepShaderAsset;
    const nodes = invalid.techniques[0]!.passes[0]!.fragment.nodes;
    const cross = nodes.find((node) => node.id === "lightingPositive")!;
    cross.op = "cross";
    cross.type = "vec4f";
    expect(validateShaderAsset(invalid).diagnostics.some((entry) => entry.code === "type-mismatch")).toBe(true);

    const wrongStage = clone() as typeof invalid;
    wrongStage.techniques[0]!.passes[0]!.fragment.nodes.push(
      { id: "fragmentNormal", op: "attribute", type: "vec3f", name: "normal" },
      { id: "fragmentNormalWs", op: "transform-direction", type: "vec3f", inputs: ["normalMatrix", "fragmentNormal"] },
    );
    expect(validateShaderAsset(wrongStage).diagnostics.some((entry) => entry.code === "invalid-stage")).toBe(true);
  });

  it("fails closed on oversized graphs and accessor-backed new-node inputs", () => {
    const oversized = clone() as { techniques: Array<{ passes: Array<{ fragment: { nodes: unknown[] } }> }> } & DeepShaderAsset;
    oversized.techniques[0]!.passes[0]!.fragment.nodes = Array.from(
      { length: DEEP_SHADER_BUDGETS.maxNodesPerStage + 1 },
      (_, index) => ({ id: `node${index}`, op: "literal", type: "f32", value: index }),
    );
    expect(validateShaderAsset(oversized).diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);

    let reads = 0;
    const accessor = clone() as { techniques: Array<{ passes: Array<{ fragment: { nodes: Array<Record<string, unknown>> } }> }> } & DeepShaderAsset;
    const mix = accessor.techniques[0]!.passes[0]!.fragment.nodes.find((node) => node.id === "f0")!;
    Object.defineProperty(mix, "inputs", { enumerable: true, get: () => { reads += 1; return []; } });
    expect(validateShaderAsset(accessor).diagnostics[0]?.code).toBe("non-deterministic");
    expect(reads).toBe(0);
  });
});
