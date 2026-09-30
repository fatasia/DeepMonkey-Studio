import { expect, it } from "vitest";
import { ShaderChunk } from "three";
import { threeToneMappingShader } from "./threeToneMappingShader.js";
import { displayColorLibrary } from "../shader/displayColorBackends.js";

const source = ShaderChunk.tonemapping_pars_fragment;
it("reuses the existing paired fit and preserves every other actual Three tone function and exposure declaration", () => {
  const adapted = threeToneMappingShader(source);
  const fit = displayColorLibrary("glsl-es-300").code;
  expect(adapted).toContain(fit.slice(fit.indexOf("vec3 deepThreeAcesFit("), fit.indexOf("vec3 deepApplyColorGrading(")).trimEnd());
  expect(adapted).toContain("return deepThreeAcesFit( color, toneMappingExposure );");
  expect(adapted).not.toContain("DeepOutputSettings");
  expect(adapted).not.toContain("deepLinearToSrgb");
  const removeAces = (value: string) => value.replace(/(?:\/\/ C8 paired direct tone mapping\n[\s\S]*?)?vec3 ACESFilmicToneMapping\( vec3 color \) \{[\s\S]*?^\}/gm, "ACES");
  expect(removeAces(adapted)).toBe(removeAces(source));
});
it.each([
  ["matrix drift", source.replace("0.59719", "0.59720")],
  ["exposure drift", source.replace("toneMappingExposure / 0.6", "toneMappingExposure / 0.7")],
  ["missing definition", source.replace("ACESFilmicToneMapping", "ChangedToneMapping")],
  ["duplicate", `${source}\n${source}`],
  ["already adapted", threeToneMappingShader(source)],
])("rejects %s before compilation", (_, value) => expect(() => threeToneMappingShader(value)).toThrow("Three tone-mapping shader changed"));
