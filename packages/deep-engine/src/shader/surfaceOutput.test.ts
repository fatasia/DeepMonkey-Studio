import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileShaderPass } from "./compiler.js";
import { outputNodeIds } from "./schemaValidation.js";
import {
  DEEP_STANDARD_LIGHTING_CONTEXT_V1, DEEP_STANDARD_LIGHTING_LAYOUT_V1,
  DEEP_STANDARD_SURFACE_FIELD_NAMES,
} from "./surface.js";
import type { DeepShaderAsset, ShaderStageOutput } from "./types.js";
import { validateShaderAsset } from "./validation.js";

const capabilities = {
  features: [] as const,
  limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
};

function surfaceOutput(): Extract<ShaderStageOutput, { semantic: "surface" }> {
  return {
    semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
    fields: {
      baseColor: "baseColor", normal: "normal", metallic: "metallic", roughness: "roughness",
      occlusion: "occlusion", emission: "emission", alpha: "alpha",
    },
  };
}

function fixture(): DeepShaderAsset {
  return {
    schemaVersion: 1, id: "deep.standard-surface-contract",
    properties: [
      { name: "baseColor", type: "vec3f", scope: "material", default: [1, 1, 1] },
      { name: "metallic", type: "f32", scope: "material", default: 0 },
      { name: "roughness", type: "f32", scope: "material", default: 0.5 },
      { name: "occlusion", type: "f32", scope: "material", default: 1 },
      { name: "emission", type: "vec3f", scope: "material", default: [0, 0, 0] },
      { name: "alpha", type: "f32", scope: "material", default: 1 },
    ], resources: [],
    attributes: [
      { name: "position", semantic: "POSITION", location: 0, format: "float32x3", type: "vec3f" },
      { name: "normal", semantic: "NORMAL", location: 1, format: "float32x3", type: "vec3f" },
    ],
    varyings: [
      { name: "worldPosition", location: 0, type: "vec3f" },
      { name: "normalWs", location: 1, type: "vec3f" },
    ], keywords: [],
    techniques: [{ id: "webgpu", requirements: { webgpu: true }, passes: [{
      id: "forward", kind: "forward",
      state: {
        topology: "triangle-list", cullMode: "back", frontFace: "ccw",
        depthCompare: "less-equal", depthWrite: true, colorWriteMask: 15,
      },
      vertex: {
        nodes: [
          { id: "position", op: "attribute", type: "vec3f", name: "position" },
          { id: "one", op: "literal", type: "f32", value: 1 },
          { id: "clip", op: "compose-vec4", type: "vec4f", inputs: ["position", "one"] },
          { id: "normal", op: "attribute", type: "vec3f", name: "normal" },
        ],
        outputs: [
          { semantic: "position", node: "clip" },
          { semantic: "varying", name: "worldPosition", node: "position" },
          { semantic: "varying", name: "normalWs", node: "normal" },
        ],
      },
      fragment: {
        nodes: [
          { id: "baseColor", op: "property", type: "vec3f", name: "baseColor" },
          { id: "normalRead", op: "varying", type: "vec3f", name: "normalWs" },
          { id: "normal", op: "normalize", type: "vec3f", inputs: ["normalRead"] },
          { id: "metallic", op: "property", type: "f32", name: "metallic" },
          { id: "roughness", op: "property", type: "f32", name: "roughness" },
          { id: "occlusion", op: "property", type: "f32", name: "occlusion" },
          { id: "emission", op: "property", type: "vec3f", name: "emission" },
          { id: "alpha", op: "property", type: "f32", name: "alpha" },
        ],
        outputs: [surfaceOutput()],
      },
    }] }],
  };
}

function clone(): DeepShaderAsset {
  return JSON.parse(JSON.stringify(fixture())) as DeepShaderAsset;
}

function legacyColorFixture(): DeepShaderAsset {
  const asset = clone() as { techniques: Array<{ passes: Array<{ fragment: { nodes: unknown[]; outputs: unknown[] } }> }> } & DeepShaderAsset;
  const fragment = asset.techniques[0]!.passes[0]!.fragment;
  fragment.nodes.push({ id: "legacyColor", op: "compose-vec4", type: "vec4f", inputs: ["baseColor", "alpha"] });
  fragment.outputs = [{ semantic: "color", node: "legacyColor" }];
  return asset;
}

describe("Deep Shader standard Surface Output", () => {
  it("validates and snapshots every required typed field as a reachable output root", () => {
    const first = validateShaderAsset(fixture());
    const second = validateShaderAsset(clone());
    expect(first).toEqual(second);
    expect(first.valid).toBe(true);
    const output = first.value!.techniques[0]!.passes[0]!.fragment!.outputs[0]!;
    expect(outputNodeIds(output)).toEqual([
      "baseColor", "normal", "metallic", "roughness", "occlusion", "emission", "alpha",
    ]);
    expect(Object.isFrozen((output as Extract<ShaderStageOutput, { semantic: "surface" }>).fields)).toBe(true);
  });

  it("defines an immutable, executable world-space lighting boundary", () => {
    expect(DEEP_STANDARD_LIGHTING_CONTEXT_V1).toMatchObject({
      id: "deep-lighting-v1", surfaceModel: "standard-pbr", coordinateSpace: "world",
      colorSpace: "linear", normalPolicy: "backend-normalizes",
      compilerSupport: "wgsl-standard-pbr-v1",
    });
    expect(DEEP_STANDARD_LIGHTING_CONTEXT_V1.inputs.map((input) => input.name)).toEqual([
      "worldPosition", "viewDirection", "directLights", "indirectDiffuse", "indirectSpecular",
    ]);
    expect(Object.isFrozen(DEEP_STANDARD_LIGHTING_CONTEXT_V1.inputs)).toBe(true);
    expect(Object.isFrozen(DEEP_STANDARD_LIGHTING_CONTEXT_V1.directLightFields)).toBe(true);
    expect(DEEP_STANDARD_LIGHTING_LAYOUT_V1).toMatchObject({
      frameAbi: "deep.pbr.mesh.v1/forward-frame",
      packageCompatibility: "requires-layout-adapter",
      directLightCapacity: 1, worldPositionVarying: "worldPosition",
    });
    expect(DEEP_STANDARD_LIGHTING_LAYOUT_V1.bindings.map((binding) => [binding.group, binding.binding, binding.name])).toEqual([
      [0, 0, "frame"], [0, 1, "shadowMap"], [0, 2, "shadowSampler"],
      [0, 3, "specularEnvironment"], [0, 4, "diffuseEnvironment"], [0, 5, "brdfLut"],
      [0, 6, "environmentSampler"],
    ]);
    expect(DEEP_STANDARD_LIGHTING_CONTEXT_V1.implementationLimits).toEqual({
      directLightCapacity: 1,
      directRadiance: "engine-calibrated-linear-v1",
      indirectLighting: "prefiltered-environment-and-brdf-lut",
    });
  });

  it("lowers every surface field through real GGX direct and IBL inputs", () => {
    const first = compileShaderPass(fixture(), "webgpu", "forward", capabilities);
    const second = compileShaderPass(clone(), "webgpu", "forward", capabilities);
    expect(first).toEqual(second);
    expect(first.success).toBe(true);
    expect(first.value?.lightingContext).toEqual(DEEP_STANDARD_LIGHTING_LAYOUT_V1);
    const code = first.value?.module.code ?? "";
    expect(code).toContain("fn deepDistributionGgx");
    expect(code).toContain("fn deepSafeNormalize(value: vec3f, fallback: vec3f)");
    expect(code).toContain("let halfVector = deepSafeNormalize(view + light, normal)");
    expect(code).toContain("let nDotV = clamp(dot(normal, view), 0.0001, 1.0)");
    expect(code).toContain("let vDotH = clamp(dot(view, halfVector), 0.0, 1.0)");
    expect(code).toContain("deepGeometrySchlickGgx(nDotV, roughness) * deepGeometrySchlickGgx(nDotL, roughness)");
    expect(code).toContain("textureSampleCompareLevel(deepShadowMap, deepShadowSampler");
    expect(code).toContain("let visible = select(1.0, sampled / 9.0, inside)");
    expect(code).toContain("textureSampleLevel(deepDiffuseEnvironment, deepEnvironmentSampler, normal, 0.0).rgb");
    expect(code).toContain("textureSampleLevel(deepSpecularEnvironment, deepEnvironmentSampler, reflection");
    expect(code).toContain("let indirectDiffuse = (vec3f(1.0) - indirectFresnel) * (1.0 - metallic)");
    expect(code).toContain("textureNumLevels(deepSpecularEnvironment) - 1u");
    expect(code).toContain("let energyCompensation = vec3f(1.0) + f0");
    expect(code).toContain("* energyCompensation");
    expect(code).toContain("deepLowerStandardPbr(input.v_worldPosition, n_baseColor, n_normal, n_metallic, n_roughness, n_occlusion, n_emission, n_alpha)");
  });

  it("keeps legacy color output deterministic and Naga-valid", () => {
    const first = compileShaderPass(legacyColorFixture(), "webgpu", "forward", capabilities);
    const second = compileShaderPass(legacyColorFixture(), "webgpu", "forward", capabilities);
    expect(first).toEqual(second);
    expect(first.success).toBe(true);
    expect(first.value?.module.code).toContain("return n_legacyColor;");
    expect(first.value?.module.code).not.toContain("deepLowerStandardPbr");
    expect(first.value?.lightingContext).toBeUndefined();
    if (!process.env.DEEP_SHADER_NAGA_BIN) return;
    const validation = spawnSync(
      process.env.DEEP_SHADER_NAGA_BIN,
      ["--stdin-file-path", "legacy-color.wgsl", "--input-kind", "wgsl"],
      { input: first.value!.module.code, encoding: "utf8" },
    );
    expect({ status: validation.status, stderr: validation.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("fails closed when the executable lighting ABI is missing or exceeds the target", () => {
    const missing = clone() as unknown as {
      varyings: Array<{ name: string; location: number; type: string }>;
      techniques: Array<{ passes: Array<{ vertex: { outputs: Array<Record<string, unknown>> } }> }>;
    };
    missing.varyings = missing.varyings.filter((varying) => varying.name !== "worldPosition");
    missing.techniques[0]!.passes[0]!.vertex.outputs = missing.techniques[0]!.passes[0]!.vertex.outputs
      .filter((output) => output.name !== "worldPosition");
    expect(compileShaderPass(missing, "webgpu", "forward", capabilities).diagnostics)
      .toMatchObject([{ code: "unsupported-surface-lighting", path: "pass.vertex.outputs" }]);

    const tooFewBindings = { ...capabilities, limits: { ...capabilities.limits, maxBindingsPerBindGroup: 6 } };
    expect(compileShaderPass(fixture(), "webgpu", "forward", tooFewBindings).diagnostics)
      .toMatchObject([{ code: "unsupported-capability", path: "capabilities.limits.maxBindingsPerBindGroup" }]);

    const frameProperty = clone() as unknown as {
      properties: Array<Record<string, unknown>>;
      techniques: Array<{ passes: Array<{ fragment: {
        nodes: Array<Record<string, unknown>>;
        outputs: Array<{ fields: Record<string, string> }>;
      } }> }>;
    };
    frameProperty.properties.push({ name: "frameAlpha", type: "f32", scope: "frame", default: 1 });
    frameProperty.techniques[0]!.passes[0]!.fragment.nodes.push({ id: "frameAlpha", op: "property", type: "f32", name: "frameAlpha" });
    frameProperty.techniques[0]!.passes[0]!.fragment.outputs[0]!.fields.alpha = "frameAlpha";
    expect(compileShaderPass(frameProperty, "webgpu", "forward", capabilities).diagnostics)
      .toMatchObject([{ code: "duplicate-binding", path: "pass.fragment" }]);

    const resourceCollision = clone() as unknown as {
      resources: Array<Record<string, unknown>>;
      techniques: Array<{ passes: Array<{ fragment: {
        nodes: Array<Record<string, unknown>>;
        outputs: Array<{ fields: Record<string, string> }>;
      } }> }>;
    };
    resourceCollision.resources.push(
      { name: "collidingTexture", scope: "frame", binding: 1, kind: "texture-2d-f32", visibility: ["fragment"] },
      { name: "collidingSampler", scope: "frame", binding: 8, kind: "sampler", visibility: ["fragment"] },
    );
    resourceCollision.techniques[0]!.passes[0]!.fragment.nodes.push(
      { id: "collisionUv", op: "literal", type: "vec2f", value: [0, 0] },
      { id: "collisionSample", op: "texture-sample", type: "color", texture: "collidingTexture", sampler: "collidingSampler", inputs: ["collisionUv"] },
      { id: "collisionRgb", op: "swizzle", type: "vec3f", mask: "rgb", inputs: ["collisionSample"] },
    );
    resourceCollision.techniques[0]!.passes[0]!.fragment.outputs[0]!.fields.baseColor = "collisionRgb";
    expect(compileShaderPass(resourceCollision, "webgpu", "forward", capabilities).diagnostics)
      .toMatchObject([{ code: "duplicate-binding", path: "resources.collidingTexture" }]);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("emits Naga-valid standard Surface WGSL", () => {
    const result = compileShaderPass(fixture(), "webgpu", "forward", capabilities);
    expect(result.success).toBe(true);
    const validation = spawnSync(
      process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-standard-surface.wgsl", "--input-kind", "wgsl"],
      { input: result.value!.module.code, encoding: "utf8" },
    );
    expect({ status: validation.status, stderr: validation.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("rejects missing, mistyped, unknown, duplicate and vertex-stage surfaces", () => {
    const missing = clone() as { techniques: Array<{ passes: Array<{ fragment: { outputs: Array<Record<string, unknown>> } }> }> } & DeepShaderAsset;
    delete (missing.techniques[0]!.passes[0]!.fragment.outputs[0]!.fields as Record<string, unknown>).alpha;
    expect(validateShaderAsset(missing).diagnostics).toMatchObject([{ code: "invalid-value", path: expect.stringContaining("fields.alpha") }]);

    const mistyped = clone() as typeof missing;
    (mistyped.techniques[0]!.passes[0]!.fragment.outputs[0]!.fields as Record<string, unknown>).baseColor = "alpha";
    expect(validateShaderAsset(mistyped).diagnostics).toMatchObject([{ code: "type-mismatch", path: expect.stringContaining("fields.baseColor") }]);

    const unknown = clone() as typeof missing;
    (unknown.techniques[0]!.passes[0]!.fragment.outputs[0]!.fields as Record<string, unknown>).clearcoat = "roughness";
    expect(validateShaderAsset(unknown).diagnostics.some((entry) => entry.code === "unknown-field")).toBe(true);

    const duplicate = clone() as typeof missing;
    duplicate.techniques[0]!.passes[0]!.fragment.outputs.push({ semantic: "color", node: "baseColor" });
    expect(validateShaderAsset(duplicate).diagnostics.some((entry) => entry.code === "invalid-stage")).toBe(true);

    const vertexSurface = clone() as unknown as { techniques: Array<{ passes: Array<{ vertex: { outputs: unknown[] } }> }> };
    vertexSurface.techniques[0]!.passes[0]!.vertex.outputs = [surfaceOutput()];
    expect(validateShaderAsset(vertexSurface).diagnostics.some((entry) => entry.code === "invalid-stage")).toBe(true);
  });

  it("fails closed on output budget abuse and accessor-backed surface fields", () => {
    const oversized = clone() as { techniques: Array<{ passes: Array<{ fragment: { outputs: unknown[] } }> }> } & DeepShaderAsset;
    oversized.techniques[0]!.passes[0]!.fragment.outputs = Array.from(
      { length: 33 },
      () => surfaceOutput(),
    );
    expect(validateShaderAsset(oversized).diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);

    let reads = 0;
    const accessor = clone() as { techniques: Array<{ passes: Array<{ fragment: { outputs: Array<{ fields: object }> } }> }> } & DeepShaderAsset;
    Object.defineProperty(accessor.techniques[0]!.passes[0]!.fragment.outputs[0]!.fields, "alpha", {
      enumerable: true, get: () => { reads += 1; return "alpha"; },
    });
    expect(validateShaderAsset(accessor).diagnostics[0]?.code).toBe("non-deterministic");
    expect(reads).toBe(0);
    expect(DEEP_STANDARD_SURFACE_FIELD_NAMES).toHaveLength(7);
  });
});
