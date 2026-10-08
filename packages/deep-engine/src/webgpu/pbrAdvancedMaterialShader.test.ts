import { describe, expect, it } from "vitest";
import { composeAdvancedMaterialSceneShader } from "./pbrAdvancedMaterialShader.js";
import { sceneShader } from "./pbrShader.js";
import { deformedSceneShader } from "./pbrDeformationShader.js";
import { ADVANCED_MATERIAL_WGSL } from "../shader/materialAdvancedWgsl.js";
import { packMaterialParameters } from "./materialBindings.js";
import { MATERIAL_PARAMETER_ADVANCED_BAND_FLOAT_OFFSET, MATERIAL_PARAMETER_ADVANCED_FLOATS,
  normalizeAdvancedMaterialParameters } from "../shader/materialAdvancedParameters.js";
import type { PreparedMaterialTextures } from "../renderPacketTypes.js";

describe("advancedMaterials shader composition", () => {
  it.each([["static", sceneShader], ["deformation", deformedSceneShader]] as const)(
    "%s: patches struct + shade F0 + dispatch exactly once and keeps legacy shading reachable", (_name, source) => {
      const composed = composeAdvancedMaterialSceneShader(source);
      expect(composed).toContain("advanced0: vec4f, advanced1: vec4f, advanced2: vec4f,");
      expect(composed).toContain("deepAdvIridF0, deepAdvIridFactor");
      expect(composed.match(/fn extendedShade\(/g)).toHaveLength(1);
      expect(composed.match(/fn deepLegacyExtendedShade\(/g)).toHaveLength(1);
      expect(composed.length - source.length).toBeGreaterThan(ADVANCED_MATERIAL_WGSL.length - 200);
      expect(composeAdvancedMaterialSceneShader(source)).toBe(composed);
    });

  it("does not alter the stock shader text (opt-in variant only)", () => {
    expect(sceneShader).not.toContain("deepAdv");
    expect(deformedSceneShader).not.toContain("deepAdv");
  });
  it("routes direct, clustered, area and indirect specular through the same F0/F90", () => {
    const shader = composeAdvancedMaterialSceneShader(sceneShader);
    expect(shader).toContain("deepAdvMaterialF0(baseColor, metallic, dielectric)");
    expect(shader).toContain("deepAdvMaterialF0(max(baseColor, vec3f(0.0)), metallic, dielectric)");
    expect(shader).toContain("f0 * dfgView.x + deepAdvCurrentSpecularF90() * dfgView.y");
    expect(shader).toContain("f0 * dfg.x + deepAdvCurrentSpecularF90() * dfg.y");
    expect(shader).toContain("textureSample(deepSpecularMap, deepSpecularSampler, uv).a");
    expect(shader).toContain("textureSample(deepSpecularColorMap, deepSpecularColorSampler, uv).rgb");
    expect(shader).not.toContain("if (deepAdvSpecularActive ||");
  });

  it("packs a 320B uniform only for the advanced layout and leaves the stock 192B block untouched", () => {
    const textures = { emissiveStrength: 1, advanced: normalizeAdvancedMaterialParameters({
      sheen: { color: [0.5, 0.25, 1], roughness: 0.4 }, iridescence: { factor: 1, ior: 1.3, thickness: 400 },
      volume: { thickness: 2, attenuationColor: [0.5, 0.5, 1], attenuationDistance: 3 } }) } as PreparedMaterialTextures;
    expect(packMaterialParameters(textures)).toHaveLength(48);
    const advanced = packMaterialParameters(textures, true);
    expect(advanced).toHaveLength(MATERIAL_PARAMETER_ADVANCED_FLOATS);
    expect([...advanced.slice(MATERIAL_PARAMETER_ADVANCED_BAND_FLOAT_OFFSET, 60)]).toEqual(
      [0.5, 0.25, 1, 0.4000000059604645, 1, 1.2999999523162842, 400, 2, 0.5, 0.5, 1, 3]);
    expect([...advanced.slice(0, 48)]).toEqual([...packMaterialParameters(textures)]);
    expect([...advanced.slice(60, 64)]).toEqual([1, 1, 1, 1]);
    expect(advanced.byteLength).toBe(320);
  });
});
