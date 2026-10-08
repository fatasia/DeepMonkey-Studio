import { expect, it } from "vitest";
import { advancedMaterialFeatures, assertAdvancedMaterialFeatures, resolveAdvancedMaterialFeatures,
  specializeAdvancedMaterialShader } from "./advancedMaterialFeatures.js";
import { snapshotRendererOptions } from "../threeBridge/deepWebGpuOptions.js";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS } from "../shader/materialParameters.js";

it("retains IOR/specular and only specializes actually used advanced lobes", () => {
  const glass = { extendedParameters: { ...DEFAULT_EXTENDED_MATERIAL_PARAMETERS, transmission: { factor: 1 } } };
  expect(advancedMaterialFeatures([glass])).toBe(8);
  expect(() => assertAdvancedMaterialFeatures([glass], 0)).toThrow("advanced-materials/not-enabled");
  expect(() => assertAdvancedMaterialFeatures([glass], 8)).not.toThrow();
  expect(advancedMaterialFeatures([{ advancedParameters: { sheen: { color: [1,0,0], roughness: 1 },
    iridescence: { factor: 1, ior: 1.3, thickness: 0 } } }])).toBe(2);
  const source = "materialTextures.extended0 materialTextures.extended1 materialTextures.advanced0 materialTextures.advanced1";
  expect(specializeAdvancedMaterialShader(source, undefined)).toBe(source);
  expect(specializeAdvancedMaterialShader(source, 8)).toContain("materialTextures.extended1");
  expect(specializeAdvancedMaterialShader(source, 8)).toContain("vec4f(0.0)");
  expect(snapshotRendererOptions({ advancedMaterials: true, advancedMaterialFeatures: 8 }).advancedMaterialFeatures).toBe(8);
  for (const value of [-1, 32, NaN, 1.5]) expect(() => resolveAdvancedMaterialFeatures(value)).toThrow();
});
