import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as THREE from "three";
import { installThreeDisplayToneMapping } from "./threeDisplayToneMapping";

it("installs idempotently per chunk owner without changing material hooks or another realm", () => {
  const a = { tonemapping_pars_fragment: THREE.ShaderChunk.tonemapping_pars_fragment };
  const b = { ...a }; const original = b.tonemapping_pars_fragment;
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshStandardMaterial(), new THREE.MeshPhysicalMaterial()];
  const hooks = materials.map(material => [material.onBeforeCompile, material.onBeforeRender, material.customProgramCacheKey]);
  installThreeDisplayToneMapping(a); const adapted = a.tonemapping_pars_fragment;
  installThreeDisplayToneMapping(a); expect(a.tonemapping_pars_fragment).toBe(adapted);
  expect(b.tonemapping_pars_fragment).toBe(original);
  installThreeDisplayToneMapping(b); expect(b.tonemapping_pars_fragment).toBe(adapted);
  expect(materials.map(material => [material.onBeforeCompile, material.onBeforeRender, material.customProgramCacheKey])).toEqual(hooks);
  a.tonemapping_pars_fragment += "\n// unexpected edit";
  expect(() => installThreeDisplayToneMapping(a)).toThrow("source drifted");
  expect(() => installThreeDisplayToneMapping({ tonemapping_pars_fragment: adapted })).toThrow("already adapted");
  materials.forEach(material => material.dispose());
});

it("both existing production WebGL creation sites install before their first renderer/program", () => {
  for (const file of ["ViewerEngine.ts", "offscreenScene.worker.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source.indexOf("installThreeDisplayToneMapping();")).toBeGreaterThan(0);
    expect(source.indexOf("installThreeDisplayToneMapping();")).toBeLessThan(source.indexOf("new THREE.WebGLRenderer("));
  }
});
