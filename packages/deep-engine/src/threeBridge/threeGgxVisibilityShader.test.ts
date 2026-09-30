import { expect, it } from "vitest";
import { ShaderChunk } from "three";
import { ggxVisibilityLibrary } from "../shader/ggxVisibilityGlsl.js";
import { threeGgxVisibilityShader } from "./threeGgxVisibilityShader.js";

const source = ShaderChunk.lights_physical_pars_fragment;
it("preserves NDF, anisotropic/clearcoat/other BRDF terms and the alpha squaring", () => {
  const result = threeGgxVisibilityShader(source);
  expect(result).toContain(ggxVisibilityLibrary().glsl);
  expect(result).toContain("float a2 = pow2( alpha );\n\treturn deepSharedGgxVisibility( a2, dotNV, dotNL );");
  const erase = (value: string) => value.replace(/(?:\/\/ C8 paired correlated Smith visibility\n[^]*?)?^float V_GGX_SmithCorrelated\([^]*?^\}/gm, "VISIBILITY");
  expect(erase(result)).toBe(erase(source));
});
it.each([
  ["epsilon", source.replace("max( gv + gl, EPSILON )", "max( gv + gl, 0.001 )")],
  ["alpha", source.replace("float a2 = pow2( alpha );", "float a2 = alpha;")],
  ["missing", source.replace("float V_GGX_SmithCorrelated(", "float renamed(")],
  ["duplicate", source + source],
  ["already adapted", threeGgxVisibilityShader(source)],
])("rejects %s", (_, value) => expect(() => threeGgxVisibilityShader(value)).toThrow("Three GGX visibility source changed"));
