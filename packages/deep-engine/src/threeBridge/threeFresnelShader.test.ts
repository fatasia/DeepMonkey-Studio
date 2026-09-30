import { expect, it } from "vitest";
import { ShaderChunk } from "three";
import { schlickFactorGlsl } from "../shader/schlickFactorGlsl.js";
import { threeFresnelShader } from "./threeFresnelShader.js";

const source = ShaderChunk.common;
it("adapts both real Three overloads, preserving every other line and F0/F90 mixing", () => {
  const adapted = threeFresnelShader(source);
  expect(adapted.split("float fresnel = deepSharedSchlickFactor( dotVH );").length - 1).toBe(2);
  const restored = adapted.replace(`// C8 paired material Fresnel factor\n${schlickFactorGlsl()}\n`, "")
    .replaceAll("float fresnel = deepSharedSchlickFactor( dotVH );", "float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );");
  expect(restored).toBe(source);
});
it.each([
  ["coefficient", source.replace("5.55473", "5.55472")],
  ["F90", source.replace("( f90 * fresnel )", "fresnel")],
  ["missing overload", source.replace("float F_Schlick(", "float renamed(")],
  ["duplicate", source + source],
  ["already adapted", threeFresnelShader(source)],
])("rejects %s", (_, value) => expect(() => threeFresnelShader(value)).toThrow("Three material Fresnel source changed"));
