import { expect, it } from "vitest";
import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "../lighting/brdfDirectLightingWgsl.js";
import { schlickFactorGlsl } from "./schlickFactorGlsl.js";

it("extracts the production canonical scalar expression without duplicating its math", () => {
  const factor = PBR_BRDF_DIRECT_LIGHTING_WGSL.match(/let factor = ([^;]+);/)![1]!;
  expect(schlickFactorGlsl()).toContain(`return ${factor};`);
  expect(schlickFactorGlsl()).toBe(schlickFactorGlsl());
  expect(schlickFactorGlsl()).not.toContain("rough");
  expect(schlickFactorGlsl()).not.toContain("f0");
});
it.each([
  ["coefficient", PBR_BRDF_DIRECT_LIGHTING_WGSL.replace("-5.55473", "-5.55472")],
  ["multiply ordering", PBR_BRDF_DIRECT_LIGHTING_WGSL.replace("* cosine - 6.98316", "- 6.98316 * cosine")],
  ["missing", PBR_BRDF_DIRECT_LIGHTING_WGSL.replace("fn fresnel(", "fn renamed(")],
  ["duplicate", PBR_BRDF_DIRECT_LIGHTING_WGSL + PBR_BRDF_DIRECT_LIGHTING_WGSL],
])("rejects canonical %s drift", (_, source) => expect(() => schlickFactorGlsl(source)).toThrow("Canonical direct Fresnel source changed"));
