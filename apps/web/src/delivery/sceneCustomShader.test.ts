import { describe, expect, it } from "vitest";
import { inspectSceneCustomShader, compileSceneCustomShaders } from "./sceneCustomShader";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { adaptDeepSlToShaderPackage } from "@bim-studio/deep-engine/shader-authoring";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";

const SOURCE = `shader deep.material {
  surface standard;
  baseColor [0.12, 0.42, 0.9, 1];
  metallic 0.65;
  roughness 0.24;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;

describe("scene custom shader authoring", () => {
  it("returns executable package evidence and deterministic pass keys", () => {
    const first = inspectSceneCustomShader(SOURCE);
    const second = inspectSceneCustomShader(SOURCE);
    expect(first.success).toBe(true);
    expect(second).toEqual(first);
    if (first.success) {
      expect(first.shader.shaderAbi.id).toBe("deep.pbr.mesh.v2");
      expect(first.cacheKeys.length).toBeGreaterThan(0);
    }
  });

  it("selects the existing clearcoat v3 profile instead of incorrectly pinning new author source to v2", () => {
    const coated = SOURCE.replace("roughness 0.24;", "roughness 0.24;\n  clearcoatFactor 0.85;\n  clearcoatRoughness 0.08;");
    const result = inspectSceneCustomShader(coated);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.diagnostics.join("; "));
    expect(result.shader.shaderAbi.id).toBe("deep.pbr.mesh.v3");
    expect(result.shader.modules[0]!.source).toContain("deepClearcoatDirectSpecular");
    expect(inspectSceneCustomShader(coated)).toEqual(result);
  });

  it("preserves the original v2 package bytes and refuses v3 in a declared v2-only consumer", () => {
    const legacy = adaptDeepSlToShaderPackage({ schemaVersion: 1, source: SOURCE,
      packageId: `deep.scene.${runtimeContentSha256(SOURCE).slice(0, 32)}`, packageVersion: "1.0.0", compilerVersion: "1.0.0",
      targetAbi: "deep.pbr.mesh.v2", capabilities: { features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 } } });
    const original = inspectSceneCustomShader(SOURCE);
    expect(legacy.success && original.success).toBe(true);
    if (!legacy.success || !original.success) throw new Error("v2 regression");
    expect(original.shader).toEqual(legacy.package);
    const zero = SOURCE.replace("metallic 0.65;", "metallic 0.65;\n clearcoatFactor 0;\n clearcoatRoughness 0.8;");
    const plainV3 = adaptDeepSlToShaderPackage({ schemaVersion: 1, source: SOURCE,
      packageId: "neutral", packageVersion: "1.0.0", compilerVersion: "1.0.0", targetAbi: "deep.pbr.mesh.v3",
      capabilities: { features: [], limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 } } });
    const neutral = inspectSceneCustomShader(zero);
    if (!neutral.success || !plainV3.success) throw new Error("zero rejected");
    expect(neutral.shader.modules.map(m => m.source)).toEqual(plainV3.package.modules.map(m => m.source));
    expect(inspectSceneCustomShader(zero, { shaderAbis: ["deep.pbr.mesh.v2"] })).toMatchObject({ success: false,
      diagnostics: [expect.stringContaining("当前宿主尚未连接 deep.pbr.mesh.v3")] });
  });

  it("keeps production defaults v2-only and round-trips author source into v3 only for an explicit consuming profile", () => {
    const source = SOURCE.replace("metallic 0.65;", "metallic 0.65;\n clearcoatFactor 0.85;\n clearcoatRoughness 0.08;");
    const scene = { models: [], primitives: [{ modelId: "object", visible: true, material: { customShader: { source } } }] } as unknown as SceneSnapshot;
    const packet: RenderPacket = { geometries: [], materials: [{ id: "surface", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
      instances: [{ id: "instance", geometry: "fixture", material: "surface", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
      objectBindings: [{ nodeId: "object", instanceIds: ["instance"] }] };
    expect(() => compileSceneCustomShaders(scene, packet)).toThrow("当前宿主尚未连接");
    const first = compileSceneCustomShaders(scene, packet, { shaderAbis: ["deep.pbr.mesh.v2", "deep.pbr.mesh.v3"] });
    const restored = compileSceneCustomShaders(JSON.parse(JSON.stringify(scene)), packet, { shaderAbis: ["deep.pbr.mesh.v3"] });
    expect(restored).toEqual(first);
    expect(first.shaderPackages[0]!.value.shaderAbi.id).toBe("deep.pbr.mesh.v3");
    expect(first.materialBindings).toHaveLength(1);
    expect(scene.primitives[0]!.material?.customShader?.source).toBe(source);
  });

  it("keeps malformed and out-of-range clearcoat sources fail-closed", () => {
    const invalid = SOURCE.replace("roughness 0.24;", "roughness 0.24;\n  clearcoatFactor 1.5;");
    const result = inspectSceneCustomShader(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("invalid coat accepted");
    expect(result.diagnostics.join(" ")).toContain("between 0 and 1");
    expect(inspectSceneCustomShader(SOURCE.replace("roughness 0.24;", "clearcoatFoo 1;"))).toMatchObject({ success: false });
  });

  it("fails closed on invalid DeepSL instead of emitting a preview", () => {
    const result = inspectSceneCustomShader("shader broken { surface standard;");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
