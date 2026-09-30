import { expect, it } from "vitest";
import { FORWARD_PLUS_PBR_WGSL, forwardPlusPbrLibrary, composeForwardPlusPbrShader } from "./clusterLightingPbrWgsl.js";
import { PBR_DIRECT_MULTISCATTERING_WGSL } from "../webgpu/pbrDirectMultiscatteringWgsl.js";
import { sceneShader, sceneShaderCore } from "../webgpu/pbrShader.js";

it("preserves the public standalone library while the formal host consumes canonical energy once", () => {
  expect(forwardPlusPbrLibrary()).toBe(FORWARD_PLUS_PBR_WGSL);
  expect(FORWARD_PLUS_PBR_WGSL).not.toMatch(/brdfLut|deepClusterDirectMultiscattering|deepDirectViewDfg/);
  const formal = forwardPlusPbrLibrary("direct-multiscattering");
  const changed = /  var multiple = vec3f\(0\.0\);[^]*?  return \(diffuse \+ specular \+ multiple\) \* radiance \* nDotL;/;
  expect(formal.replace(changed, "  return (diffuse + specular) * radiance * nDotL;")).toBe(FORWARD_PLUS_PBR_WGSL);
  expect(sceneShader).toContain(formal); expect(sceneShader.match(/fn deepDirectMultiscatteringEnergy\(/g)).toHaveLength(1);
  expect(sceneShader.match(/@group\(0\) @binding\(5\) var brdfLut/g)).toHaveLength(1);
});

it("fails unknown profiles and missing host sampling adapter", () => {
  expect(() => forwardPlusPbrLibrary("bad" as never)).toThrow("Unknown Forward+ material profile");
  expect(() => composeForwardPlusPbrShader("@compute fn main() {}", "direct-multiscattering")).toThrow("host adapter missing");
  expect(composeForwardPlusPbrShader("@compute fn main() {}")).toBe(`${FORWARD_PLUS_PBR_WGSL}\n@compute fn main() {}`);
});

it("local-only sampling has no primary-light gate, lazily caches view DFG and skips nonpositive contributions", () => {
  const local = PBR_DIRECT_MULTISCATTERING_WGSL.match(/fn deepClusterDirectMultiscattering\([^]*?\n\}/)![0];
  expect(local).not.toContain("sunColor"); expect(local.match(/textureSampleLevel/g)).toHaveLength(2);
  expect(local.indexOf("if (nl <= 0.0)")).toBeLessThan(local.indexOf("textureSampleLevel"));
  expect(local).toMatch(/if \(!deepDirectViewDfgReady\) \{\s*deepSeedDirectViewDfg\(textureSampleLevel/);
  expect(local).toContain("deepDirectMultiscatteringEnergy(f0, deepDirectViewDfg, dfgLight)");
  expect(forwardPlusPbrLibrary("direct-multiscattering")).toMatch(/if \(any\(radiance > vec3f\(0\.0\)\)\) \{\s*multiple = deepClusterDirectMultiscattering/);
});

it("resets each shading entry and reuses the already sampled primary/IBL view DFG", () => {
  expect(sceneShaderCore).toMatch(/applyFog: bool\) -> vec3f \{\s*deepResetDirectViewDfg\(\);/);
  expect(sceneShaderCore).toMatch(/dfg = textureSampleLevel\([^]*?\.rg;\s*deepSeedDirectViewDfg\(dfg\);/);
  expect(PBR_DIRECT_MULTISCATTERING_WGSL).toMatch(/fn deepSampleDirectMultiscattering\([^]*?deepResetDirectViewDfg\(\);\s*if \(frame.sunColor.w/);
  expect(PBR_DIRECT_MULTISCATTERING_WGSL).toMatch(/var<private> deepDirectViewDfgReady: bool/);
});
