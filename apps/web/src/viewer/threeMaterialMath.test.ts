import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as THREE from "three";
import { installThreeMaterialMath } from "./threeMaterialMath";

it("installs once per real chunk owner and detects subsequent drift", () => {
  const a = { common: THREE.ShaderChunk.common, lights_physical_pars_fragment: THREE.ShaderChunk.lights_physical_pars_fragment }, b = { ...a };
  installThreeMaterialMath(a); const adapted = a.common;
  installThreeMaterialMath(a); expect(a.common).toBe(adapted);
  expect(b.common).toBe(THREE.ShaderChunk.common);
  installThreeMaterialMath(b); expect(b.common).toBe(adapted);
  a.common += "// unexpected change";
  expect(() => installThreeMaterialMath(a)).toThrow("source drifted");
  b.lights_physical_pars_fragment += "// unexpected edit";
  expect(() => installThreeMaterialMath(b)).toThrow("source drifted");
});
it("validates both chunks before assigning either source", () => {
  const chunks = { common: THREE.ShaderChunk.common, lights_physical_pars_fragment: "unsupported" }, original = chunks.common;
  expect(() => installThreeMaterialMath(chunks)).toThrow("Three GGX visibility source changed");
  expect(chunks.common).toBe(original);
  const epsilon = { common: THREE.ShaderChunk.common.replace("#define EPSILON 1e-6", "#define EPSILON 1e-5"),
    lights_physical_pars_fragment: THREE.ShaderChunk.lights_physical_pars_fragment };
  expect(() => installThreeMaterialMath(epsilon)).toThrow("epsilon source changed");
  expect(epsilon.lights_physical_pars_fragment).toBe(THREE.ShaderChunk.lights_physical_pars_fragment);
});
it("both production WebGL sites install before their first program", () => {
  for (const file of ["ViewerEngine.ts", "offscreenScene.worker.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source.indexOf("installThreeMaterialMath();")).toBeGreaterThan(0);
    expect(source.indexOf("installThreeMaterialMath();")).toBeLessThan(source.indexOf("new THREE.WebGLRenderer("));
  }
});
