import { expect, it } from "vitest";
import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "../lighting/brdfDirectLightingWgsl.js";
import { ggxVisibilityLibrary } from "./ggxVisibilityGlsl.js";

it("both language wrappers preserve every production statement and parenthesis", () => {
  const statements = PBR_BRDF_DIRECT_LIGHTING_WGSL.match(/^  let gv =[^]*?^  let visibility =[^;]+;/m)![0];
  const pair = ggxVisibilityLibrary(); expect(pair).toBe(ggxVisibilityLibrary());
  expect(pair.wgsl).toContain(statements); expect(pair.glsl).toContain(statements.replaceAll("let ", "float "));
  expect(pair.glsl).not.toContain("rough"); expect(pair.glsl).not.toContain("f0");
});
it.each([
  ["epsilon", PBR_BRDF_DIRECT_LIGHTING_WGSL.replace("max(gv + gl, 0.000001)", "max(gv + gl, 0.00001)")],
  ["product order", PBR_BRDF_DIRECT_LIGHTING_WGSL.replace("nl * sqrt(a2", "sqrt(nl * a2")],
  ["missing", PBR_BRDF_DIRECT_LIGHTING_WGSL.replace("let gv =", "let renamed =")],
  ["duplicate", PBR_BRDF_DIRECT_LIGHTING_WGSL + PBR_BRDF_DIRECT_LIGHTING_WGSL],
])("rejects %s before shader compilation", (_, source) => expect(() => ggxVisibilityLibrary(source)).toThrow("Canonical GGX visibility source changed"));
