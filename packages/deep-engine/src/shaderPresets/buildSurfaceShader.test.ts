import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileShaderPass } from "../shader/compiler.js";
import { validateShaderAsset } from "../shader/validation.js";
import { planShaderVariants } from "../shader/variants.js";
import { buildStandardSurfaceShader, buildUnlitShader } from "./buildSurfaceShader.js";

const capabilities = {
  features: [] as const,
  limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
};

function accepted(result: ReturnType<typeof buildUnlitShader>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
  return result;
}

describe("Deep surface shader presets", () => {
  it("builds the minimal deterministic Unlit asset and compiles it through typed IR", () => {
    const first = accepted(buildUnlitShader());
    const second = accepted(buildUnlitShader());
    expect(first).toEqual(second);
    expect(first.issues).toEqual([]);
    expect(first.asset).toMatchObject({
      id: "deep.unlit", resources: [], varyings: [], keywords: [],
      attributes: [{ name: "position" }],
      properties: [{ name: "baseColor", default: [1, 1, 1, 1] }],
    });
    expect(first.asset.techniques[0]!.passes.map((pass) => pass.id)).toEqual(["forward"]);
    expect(validateShaderAsset(first.asset).valid).toBe(true);
    const compiled = compileShaderPass(first.asset, "webgpu", "forward", capabilities);
    expect(compiled.success).toBe(true);
    expect(compiled.value?.module.code).toContain("deepMaterial.p_baseColor");
    expect(compiled.value?.module.code).not.toContain("textureSample");
    expect(planShaderVariants(first.asset, capabilities).variants).toHaveLength(1);
  });

  it("reuses canonical vertex locations and the deep.pbr.mesh.v1 forward-frame only", () => {
    const result = accepted(buildStandardSurfaceShader({
      id: "project.brushed-metal", label: "Brushed metal", baseColor: [0.2, 0.3, 0.4, 1], metallic: 0.9, roughness: 0.25,
    }));
    expect(result.asset.properties).toEqual([
      { name: "baseColor", type: "color", scope: "material", default: [0.2, 0.3, 0.4, 1] },
      { name: "metallic", type: "f32", scope: "material", default: 0.9 },
      { name: "roughness", type: "f32", scope: "material", default: 0.25 },
    ]);
    expect(result.issues).toEqual([]);
    const forward = result.asset.techniques[0]!.passes[0]!;
    expect(forward.fragment?.outputs[0]).toMatchObject({
      semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
    });
    expect([...result.asset.attributes].sort((a, b) => a.location - b.location).map((attribute) => [attribute.location, attribute.semantic])).toEqual([
      [0, "POSITION"], [1, "NORMAL"], [2, "MODEL_ROW_0"], [3, "MODEL_ROW_1"],
      [4, "MODEL_ROW_2"], [5, "NORMAL_COLUMN_0"], [6, "NORMAL_COLUMN_1"], [7, "NORMAL_COLUMN_2"],
    ]);
    const compiled = compileShaderPass(result.asset, "webgpu", "forward", capabilities);
    expect(compiled.success).toBe(true);
    expect(compiled.value?.propertyLayout.map((entry) => entry.name)).toEqual(["baseColor", "metallic", "roughness"]);
    expect(compiled.value?.lightingContext).toMatchObject({
      frameAbi: "deep.pbr.mesh.v1/forward-frame",
      packageCompatibility: "requires-layout-adapter",
      directLightCapacity: 1,
    });
    expect(compiled.value?.propertyLayout.every((entry) => entry.group === 1 && entry.binding === 0)).toBe(true);
    expect(compiled.value?.entryPoints).toEqual({ vertex: "deepVertex", fragment: "deepFragment" });
    expect(compiled.value?.module.code).toContain("let n_pbrFrameView: mat4x4f = deepPbrFrame.view;");
    expect(compiled.value?.module.code).toContain("dot(n_modelRow0, n_position4)");
    expect(compiled.value?.module.code).toContain("n_pbrFrameView * vec4f(n_worldPosition, 1.0)");
    expect(compiled.value?.module.code).toContain("deepLowerStandardPbr(input.v_worldPosition");
  });

  it("rejects the PBR frame input outside a standard Surface forward pass", () => {
    const built = accepted(buildUnlitShader());
    const invalid = JSON.parse(JSON.stringify(built.asset)) as unknown as {
      techniques: Array<{ passes: Array<{ vertex: { nodes: Array<Record<string, unknown>> } }> }>;
    };
    invalid.techniques[0]!.passes[0]!.vertex.nodes.push({ id: "illegalFrame", op: "pbr-frame-view", type: "mat4x4f" });
    expect(validateShaderAsset(invalid).diagnostics).toMatchObject([{
      code: "invalid-stage", message: expect.stringContaining("standard Surface forward ABI"),
    }]);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("emits Naga-valid Standard Surface preset WGSL", () => {
    const built = accepted(buildStandardSurfaceShader({ baseColorTexture: true }));
    const compiled = compileShaderPass(built.asset, "webgpu", "forward", capabilities);
    expect(compiled.success).toBe(true);
    const validation = spawnSync(
      process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-standard-preset.wgsl", "--input-kind", "wgsl"],
      { input: compiled.value!.module.code, encoding: "utf8" },
    );
    expect({ status: validation.status, stderr: validation.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("adds only the resources and vertex IO used by a fixed base-color texture", () => {
    const plain = accepted(buildUnlitShader({ baseColor: [1, 0.5, 0.25, 1] }));
    const textured = accepted(buildUnlitShader({ baseColorTexture: true }));
    expect(plain.asset.resources).toHaveLength(0);
    expect(plain.asset.attributes).toHaveLength(1);
    expect(textured.asset.resources.map((resource) => resource.name)).toEqual(["baseColorTexture", "surfaceSampler"]);
    expect(textured.asset.attributes.map((attribute) => attribute.semantic)).toEqual(["POSITION", "TEXCOORD_0"]);
    expect(textured.asset.varyings).toHaveLength(1);
    expect(textured.asset.keywords).toHaveLength(0);
    expect(planShaderVariants(textured.asset, capabilities).variants).toHaveLength(1);
    expect(compileShaderPass(textured.asset, "webgpu", "forward", capabilities).value?.module.code)
      .toContain("textureSample(r_baseColorTexture, r_surfaceSampler, n_surfaceUv)");
  });

  it("emits texture variants only when the caller explicitly requests a switchable texture", () => {
    const result = accepted(buildUnlitShader({ baseColorTexture: "switchable" }));
    expect(result.asset.keywords).toEqual([{ name: "BASE_COLOR_TEXTURE", values: ["OFF", "ON"], default: "OFF" }]);
    expect(result.asset.techniques[0]!.passes.map((pass) => pass.id)).toEqual(["forwardColor", "forwardTextured"]);
    const plan = planShaderVariants(result.asset, capabilities);
    expect(plan.valid).toBe(true);
    expect(plan.variants).toHaveLength(2);
    expect(compileShaderPass(result.asset, "webgpu", "forwardColor", capabilities).value?.module.code).not.toContain("textureSample(");
    expect(compileShaderPass(result.asset, "webgpu", "forwardTextured", capabilities).value?.module.code).toContain("textureSample(");

    const combined = accepted(buildUnlitShader({ baseColorTexture: "switchable", switchableAlpha: true }));
    expect(planShaderVariants(combined.asset, capabilities).variants).toHaveLength(4);
    expect(combined.asset.techniques[0]!.passes.map((pass) => pass.id)).toEqual([
      "forwardOpaqueColor", "forwardOpaqueTextured", "forwardBlendColor", "forwardBlendTextured",
    ]);
  });

  it("encodes fixed blend and double-sided behavior directly in render state without variants", () => {
    const result = accepted(buildUnlitShader({ alphaMode: "blend", doubleSided: true }));
    const forward = result.asset.techniques[0]!.passes[0]!;
    expect(forward.state).toMatchObject({ cullMode: "none", depthWrite: false, blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    } });
    expect(result.asset.keywords).toHaveLength(0);
    expect(planShaderVariants(result.asset, capabilities).variants).toHaveLength(1);
  });

  it("fails Standard auxiliary passes closed and preserves Unlit pass variants", () => {
    expect(buildStandardSurfaceShader({ passes: { depth: true, shadow: true, picking: true } })).toMatchObject({
      ok: false, issues: [{ feature: "pbr-auxiliary-passes" }],
    });
    const result = accepted(buildUnlitShader({
      alphaMode: "blend", switchableAlpha: true, passes: { depth: true, shadow: true, picking: true },
    }));
    expect(result.asset.keywords[0]).toEqual({ name: "ALPHA_MODE", values: ["BLEND", "OPAQUE"], default: "BLEND" });
    const plan = planShaderVariants(result.asset, capabilities);
    expect(plan.valid).toBe(true);
    expect(plan.variants).toHaveLength(2);
    const blend = plan.variants.find((variant) => variant.keywords.ALPHA_MODE === "BLEND")!;
    const opaque = plan.variants.find((variant) => variant.keywords.ALPHA_MODE === "OPAQUE")!;
    expect(blend.passIds).toEqual(["forwardBlend", "picking"]);
    expect(opaque.passIds).toEqual(["forwardOpaque", "depth", "shadow", "picking"]);
    for (const pass of result.asset.techniques[0]!.passes) {
      expect(compileShaderPass(result.asset, "webgpu", pass.id, capabilities).success).toBe(true);
    }
    const picking = compileShaderPass(result.asset, "webgpu", "picking", capabilities).value?.module.code ?? "";
    expect(result.asset.properties.find((property) => property.name === "objectId")).toMatchObject({ scope: "object", type: "color" });
    expect(picking).toContain("deepObject.p_objectId");
    expect(picking).not.toContain("let n_baseColor:");
  });

  it("fails explicitly instead of fabricating unsupported texture and alpha behavior", () => {
    const unsupported = buildStandardSurfaceShader({
      alphaMode: "mask", normalTexture: true, occlusionTexture: true, metallicRoughnessTexture: true,
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.issues.map((issue) => issue.feature)).toEqual([
      "alpha-mask", "normal-texture", "occlusion-texture", "metallic-roughness-texture",
    ]);
    expect(buildUnlitShader({ alphaMode: "blend", passes: { depth: true } })).toMatchObject({
      ok: false, issues: [{ feature: "transparent-depth-shadow" }],
    });
  });

  it("rejects invalid scalar/color input before creating an IR asset", () => {
    expect(buildStandardSurfaceShader({ roughness: 1.1 }).issues).toMatchObject([{ code: "invalid-option", path: "$.roughness" }]);
    expect(buildUnlitShader({ baseColor: [1, -0, 0, 1] }).issues).toMatchObject([{ code: "invalid-option", path: "$.baseColor" }]);
    expect(buildUnlitShader({ id: "Invalid ID" }).issues).toMatchObject([{ code: "invalid-asset", path: "$.id" }]);
  });
});
