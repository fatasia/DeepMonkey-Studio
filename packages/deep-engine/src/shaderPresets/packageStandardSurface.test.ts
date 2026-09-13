import { describe, expect, it } from "vitest";
import { compileShaderPass } from "../shader/compiler.js";
import type { ShaderCompileCapabilities } from "../shader/types.js";
import { buildDeepPbrMeshV1StandardShader } from "./packageStandardSurface.js";

const CAPABILITIES: ShaderCompileCapabilities = {
  features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 },
};

describe("deep.pbr.mesh.v1 Standard Surface preset", () => {
  it("lowers material values from canonical instance attributes without generic properties", () => {
    const built = buildDeepPbrMeshV1StandardShader({ id: "deep.package", alphaMode: "opaque" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.asset.properties).toEqual([]);
    expect(built.asset.attributes.map((entry) => [entry.location, entry.semantic])).toEqual([
      [0, "POSITION"], [1, "NORMAL"], [2, "MODEL_ROW_0"], [3, "MODEL_ROW_1"], [4, "MODEL_ROW_2"],
      [5, "NORMAL_COLUMN_0"], [6, "NORMAL_COLUMN_1"], [7, "NORMAL_COLUMN_2"],
      [8, "BASE_COLOR_METALLIC"], [9, "ROUGHNESS_ALPHA_CUTOFF_HANDEDNESS_FLAGS"], [12, "EMISSIVE_ALPHA"],
    ]);
    const compiled = compileShaderPass(built.asset, "webgpu", "forward", CAPABILITIES);
    expect(compiled.success).toBe(true);
    expect(compiled.value).toMatchObject({
      propertyLayout: [], lightingContext: { frameAbi: "deep.pbr.mesh.v1/forward-frame" },
    });
    expect(compiled.value?.module.code).not.toContain("@group(1)");
    expect(compiled.value?.module.code).toContain("let n_alpha: f32 = 1.0;");
  });

  it("uses instance alpha only for the ABI blend pipeline and rejects non-ABI alpha values", () => {
    const blended = buildDeepPbrMeshV1StandardShader({ id: "deep.package", alphaMode: "blend" });
    expect(blended.ok).toBe(true);
    if (!blended.ok) return;
    const compiled = compileShaderPass(blended.asset, "webgpu", "forward", CAPABILITIES);
    expect(compiled.value?.module.code).toContain("let n_alpha: f32 = n_emissiveAlpha.a;");
    expect(buildDeepPbrMeshV1StandardShader({ id: "deep.package", alphaMode: "mask" as never }))
      .toMatchObject({ ok: false, issues: [{ path: "$.alphaMode", feature: "deep-pbr-mesh-v1" }] });
  });

  it("adds only canonical UV0/UV1 inputs for the fixed base-color texture adapter", () => {
    const built = buildDeepPbrMeshV1StandardShader({
      id: "deep.package", alphaMode: "opaque", materialMode: "base-color-texture",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.asset.attributes.filter((entry) => entry.semantic.startsWith("TEXCOORD")))
      .toEqual([
        { name: "uv0", semantic: "TEXCOORD_0", location: 10, format: "float32x2", type: "vec2f" },
        { name: "uv1", semantic: "TEXCOORD_1", location: 13, format: "float32x2", type: "vec2f" },
      ]);
    expect(built.asset.varyings.slice(-2)).toEqual([
      { name: "surfaceUv0", location: 5, type: "vec2f" },
      { name: "surfaceUv1", location: 6, type: "vec2f" },
    ]);
    const compiled = compileShaderPass(built.asset, "webgpu", "forward", CAPABILITIES);
    expect(compiled.success).toBe(true);
    expect(compiled.value?.module.code).toContain("@location(10) a_uv0: vec2f");
    expect(compiled.value?.module.code).toContain("@location(13) a_uv1: vec2f");
    expect(compiled.value?.module.code).toContain("output.v_surfaceUv0 = n_uv0;");
    expect(compiled.value?.module.code).toContain("output.v_surfaceUv1 = n_uv1;");
    expect(buildDeepPbrMeshV1StandardShader({
      id: "deep.package", alphaMode: "opaque", materialMode: "other" as never,
    })).toMatchObject({ ok: false, issues: [{ path: "$.materialMode" }] });
  });

  it("adds the canonical tangent stream only when normal mapping is enabled", () => {
    const built = buildDeepPbrMeshV1StandardShader({
      id: "deep.package", alphaMode: "opaque", materialMode: "base-color-texture", normalMapped: true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.asset.attributes.find((entry) => entry.semantic === "TANGENT"))
      .toEqual({ name: "tangent", semantic: "TANGENT", location: 11, format: "float32x4", type: "vec4f" });
    expect(built.asset.varyings.at(-1)).toEqual({ name: "surfaceTangent", location: 7, type: "vec4f" });
    const compiled = compileShaderPass(built.asset, "webgpu", "forward", CAPABILITIES);
    expect(compiled.success).toBe(true);
    expect(compiled.value?.module.code).toContain("@location(11) a_tangent: vec4f");
    expect(compiled.value?.module.code).toContain("output.v_surfaceTangent = n_tangentWorld;");
    expect(buildDeepPbrMeshV1StandardShader({
      id: "deep.package", alphaMode: "opaque", normalMapped: true,
    })).toMatchObject({ ok: false, issues: [{ path: "$.normalMapped" }] });
  });
});
