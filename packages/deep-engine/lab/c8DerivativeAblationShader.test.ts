import { ShaderChunk } from "three";
import { it, expect } from "vitest";
import { observeDeepFragment, observeThreeFragment, type FragmentDerivative } from "./c8FragmentObservablesShader.js";

it("only replaces the canonical geometry derivative operators for each explicit candidate", () => {
  const baseline = observeDeepFragment("rough-single");
  for (const derivative of ["fine", "coarse"] as const) {
    const candidate = observeDeepFragment("rough-single", undefined, derivative), suffix = derivative === "fine" ? "Fine" : "Coarse";
    expect(candidate.originalHash).toBe(baseline.originalHash);
    expect(candidate.instrumentedHash).not.toBe(baseline.instrumentedHash);
    expect(candidate.code.replace(`dpdx${suffix}(normal)`, "dpdx(normal)").replace(`dpdy${suffix}(normal)`, "dpdy(normal)")).toBe(baseline.code);
    expect(candidate.code).toContain("return vec3f(rough, deepObservedSingle.rg);");
  }
});
it("keeps original Three derivative and BRDF math while packing actual response", () => {
  const baseline = observeThreeFragment("single", ShaderChunk), packed = observeThreeFragment("rough-single", ShaderChunk);
  const re = ShaderChunk.lights_physical_pars_fragment.match(/^void RE_Direct_Physical\([^]*?^\}/m)![0];
  expect(packed.originalHash).toBe(baseline.originalHash);
  expect(packed.lights_physical_pars_fragment).toContain(re.slice(0, -1));
  expect(packed.lights_physical_pars_fragment).toContain("vec3( material.roughness, ( irradiance * ( BRDF_GGX(");
  expect(ShaderChunk.lights_physical_fragment).toContain("dFdx( nonPerturbedNormal )");
});
it("rejects unknown derivative policies before runtime or chunk mutation", () => {
  expect(() => observeDeepFragment("rough-single", undefined, "automatic" as FragmentDerivative)).toThrow("Unknown fragment derivative");
  expect(() => observeDeepFragment("rough-single", "not actual production", "fine")).toThrow("production Deep source drifted");
});
