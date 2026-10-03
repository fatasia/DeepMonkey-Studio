import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as THREE from "three";
import { installThreeDisplayToneMapping } from "./threeDisplayToneMapping";
import { canonicalToneSource, canonicalCommonSource, canonicalPhysicalSource } from "./threeCanonicalShaderSources";

it("reconstructs the exact published Three bytes from immutable upstream source modules", () => {
  expect(canonicalToneSource).toBe(THREE.ShaderChunk.tonemapping_pars_fragment);
  expect(canonicalCommonSource).toBe(THREE.ShaderChunk.common);
  expect(canonicalPhysicalSource).toBe(THREE.ShaderChunk.lights_physical_pars_fragment);
});

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
  const clone = { tonemapping_pars_fragment: adapted };
  installThreeDisplayToneMapping(clone); expect(clone.tonemapping_pars_fragment).toBe(adapted);
  materials.forEach(material => material.dispose());
});

it("both existing production WebGL creation sites install before their first renderer/program", () => {
  for (const file of ["ViewerEngine.ts", "offscreenScene.worker.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source.indexOf("installThreeDisplayToneMapping();")).toBeGreaterThan(0);
    expect(source.indexOf("installThreeDisplayToneMapping();")).toBeLessThan(source.indexOf("new THREE.WebGLRenderer("));
  }
});

it("reclaims exactly the owned source after installer module reload", async () => {
  const chunks = { tonemapping_pars_fragment: THREE.ShaderChunk.tonemapping_pars_fragment };
  installThreeDisplayToneMapping(chunks);
  const adapted = chunks.tonemapping_pars_fragment;
  vi.resetModules();
  const reloaded = await import("./threeDisplayToneMapping");
  reloaded.installThreeDisplayToneMapping(chunks);
  expect(chunks.tonemapping_pars_fragment).toBe(adapted);
});

it.each([
  ["raw external edit", (source: string) => `${source}\n// external edit`, false],
  ["adapted external edit", (source: string) => `${source}\n// external edit`, true],
  ["adapted shared fit drift", (source: string) => source.replace("0.59719", "0.59720"), true],
])("rejects %s even after the registry is reset", async (_, mutate, adapt) => {
  const chunks = { tonemapping_pars_fragment: THREE.ShaderChunk.tonemapping_pars_fragment };
  if (adapt) installThreeDisplayToneMapping(chunks);
  chunks.tonemapping_pars_fragment = mutate(chunks.tonemapping_pars_fragment);
  const changed = chunks.tonemapping_pars_fragment;
  vi.resetModules();
  const reloaded = await import("./threeDisplayToneMapping");
  expect(() => reloaded.installThreeDisplayToneMapping(chunks)).toThrow();
  expect(chunks.tonemapping_pars_fragment).toBe(changed);
});

it("keeps exactly one adaptation across repeated scene close/open and module reload", async () => {
  const chunks = { tonemapping_pars_fragment: THREE.ShaderChunk.tonemapping_pars_fragment };
  installThreeDisplayToneMapping(chunks);
  const adapted = chunks.tonemapping_pars_fragment;
  for (let scene = 0; scene < 3; scene++) {
    vi.resetModules();
    const reloaded = await import("./threeDisplayToneMapping");
    reloaded.installThreeDisplayToneMapping(chunks);
    reloaded.installThreeDisplayToneMapping(chunks);
    expect(chunks.tonemapping_pars_fragment).toBe(adapted);
    expect(chunks.tonemapping_pars_fragment.split("// C8 paired direct tone mapping")).toHaveLength(2);
  }
});

it("keeps the shared Three realm usable across both installer reloads and scene material disposal", async () => {
  const original = { tone: THREE.ShaderChunk.tonemapping_pars_fragment, common: THREE.ShaderChunk.common,
    physical: THREE.ShaderChunk.lights_physical_pars_fragment };
  try {
    let first: typeof original | undefined;
    for (let scene = 0; scene < 3; scene++) {
      vi.resetModules();
      const tone = await import("./threeDisplayToneMapping"), material = await import("./threeMaterialMath");
      tone.installThreeDisplayToneMapping(); material.installThreeMaterialMath();
      const sources = { tone: THREE.ShaderChunk.tonemapping_pars_fragment, common: THREE.ShaderChunk.common,
        physical: THREE.ShaderChunk.lights_physical_pars_fragment };
      if (first === undefined) first = sources;
      expect(sources).toEqual(first);
      new THREE.MeshPhysicalMaterial().dispose();
    }
  } finally {
    THREE.ShaderChunk.tonemapping_pars_fragment = original.tone;
    THREE.ShaderChunk.common = original.common;
    THREE.ShaderChunk.lights_physical_pars_fragment = original.physical;
  }
});
