import { ShaderChunk } from "three";
import { it, expect } from "vitest";
import { observeDeepFragment, observeThreeFragment } from "./c8FragmentObservablesShader.js";
import { prepareFragmentObservation } from "./c8FragmentObservablesProbe.js";

it("captures the actual default canonical operands before their original max reduction", () => {
  for (const mode of ["view-normal", "abs-dx", "abs-dy"] as const) {
    const deep = observeDeepFragment(mode);
    expect(deep.code).toContain("deepObservedNormal = normal;\n  deepObservedDx = abs(dpdx(normal));\n  deepObservedDy = abs(dpdy(normal));\n  let derivative = max(deepObservedDx, deepObservedDy);");
    expect(deep.code).not.toMatch(/dpd[xy](Fine|Coarse)\(/);
    expect(deep.code).toContain("return max(max(derivative.x, derivative.y), derivative.z);");
    expect(deep.code).toContain("return " + (mode === "view-normal" ? "deepObservedNormal * 0.5 + 0.5" : mode === "abs-dx" ? "deepObservedDx" : "deepObservedDy") + ";");
    expect(() => observeDeepFragment(mode, undefined, "fine")).toThrow("require actual default");
  }
});
it("observes original Three physical operands at their consumption point, without recomputing in RE", () => {
  const re = ShaderChunk.lights_physical_pars_fragment.match(/^void RE_Direct_Physical\([^]*?^\}/m)![0];
  for (const mode of ["view-normal", "abs-dx", "abs-dy"] as const) {
    const three = observeThreeFragment(mode, ShaderChunk);
    expect(three.lights_physical_pars_fragment).toContain(re);
    expect(three.lights_physical_fragment).toContain("vec3 deepObservedDx = abs( dFdx( nonPerturbedNormal ) );");
    expect(three.lights_physical_fragment).toContain("vec3 deepObservedDy = abs( dFdy( nonPerturbedNormal ) );");
    expect(three.lights_physical_fragment).toContain("vec3 dxy = max( deepObservedDx, deepObservedDy );");
    expect(three.lights_physical_fragment).toContain("material.roughness += geometryRoughness;");
  }
});
it("rejects missing/drifted physical source and restores all three chunks after isolated installation", async () => {
  const chunks = { lights_physical_pars_fragment: ShaderChunk.lights_physical_pars_fragment, opaque_fragment: ShaderChunk.opaque_fragment, lights_physical_fragment: ShaderChunk.lights_physical_fragment };
  expect(() => observeThreeFragment("abs-dx", { ...chunks, lights_physical_fragment: "drift" })).toThrow("seam drifted");
  const original = { ...chunks }, observer = prepareFragmentObservation("abs-dx", { requestAdapter: async () => null } as unknown as GPU, chunks);
  await observer.gpu.requestAdapter();
  expect(chunks.lights_physical_fragment).not.toBe(original.lights_physical_fragment);
  const pars = chunks.lights_physical_pars_fragment;
  expect(() => observer.recordThreeFragments([pars + "\ngl_FragColor = vec4( deepObservedFragment, diffuseColor.a )"])).toThrow("geometry derivative observation");
  observer.dispose(); observer.dispose(); expect(chunks).toEqual(original);
});
