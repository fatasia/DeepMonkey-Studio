import { expect, it } from "vitest";
import { ShaderChunk, Vector3, Matrix4 } from "three";
import { threeDirectMaterialProfile as adapt } from "./threeDirectMaterialProfile.js";
import { threeGgxVisibilityShader } from "./threeGgxVisibilityShader.js";
const source = { lights_physical_pars_fragment: threeGgxVisibilityShader(ShaderChunk.lights_physical_pars_fragment), lights_physical_fragment: ShaderChunk.lights_physical_fragment };

it("keeps the existing production shared Smith and default Three policy", () => {
  expect(adapt(source)).toBe(source);
  const single = adapt(source, "single-scatter");
  expect(single.lights_physical_fragment).toBe(source.lights_physical_fragment);
  expect(single.lights_physical_pars_fragment).toContain("deepSharedGgxVisibility( a2, dotNV, dotNL )");
  expect(single.lights_physical_pars_fragment).toContain("irradiance * BRDF_GGX( directLight.direction");
  expect(single.lights_physical_pars_fragment).toContain("vec3 BRDF_GGX_Multiscatter(");
});
it("rejects drift, repeated adaptation and unknown policy before changing source", () => {
  expect(() => adapt(source, "unknown" as never)).toThrow("Unknown");
  expect(() => adapt({ ...source, lights_physical_pars_fragment: source.lights_physical_pars_fragment.replace("irradiance * BRDF_GGX_Multiscatter", "2.0 * irradiance * BRDF_GGX_Multiscatter") }, "single-scatter")).toThrow("drifted");
  expect(() => adapt(adapt(source, "single-scatter"), "deep-single-scatter")).toThrow("already");
});
it("max-component geometry roughness changes under camera rotation", () => {
  const derivative = new Vector3(.1, .1, 0), viewDerivative = derivative.clone().applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 4));
  expect(Math.max(...derivative.toArray().map(Math.abs))).toBeCloseTo(.1);
  expect(Math.max(...viewDerivative.toArray().map(Math.abs))).toBeCloseTo(Math.sqrt(.02));
  const result = adapt(source, "deep-single-scatter");
  expect(result.lights_physical_fragment).toContain("inverseTransformDirection( nonPerturbedNormal, viewMatrix )");
  expect(result.lights_physical_fragment).toContain("max( roughnessFactor, 0.06 )");
  expect(result.lights_physical_pars_fragment).toContain("return a2 / max(3.14159265 * denom * denom, 0.000001);");
});
