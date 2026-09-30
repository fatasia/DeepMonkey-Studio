import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as THREE from "three";
import { installThreeMaterialMath } from "./threeMaterialMath";

it("installs once per real chunk owner and detects subsequent drift", () => {
  const a = { common: THREE.ShaderChunk.common }, b = { ...a };
  installThreeMaterialMath(a); const adapted = a.common;
  installThreeMaterialMath(a); expect(a.common).toBe(adapted);
  expect(b.common).toBe(THREE.ShaderChunk.common);
  installThreeMaterialMath(b); expect(b.common).toBe(adapted);
  a.common += "// unexpected change";
  expect(() => installThreeMaterialMath(a)).toThrow("source drifted");
});
it("both production WebGL sites install before their first program", () => {
  for (const file of ["ViewerEngine.ts", "offscreenScene.worker.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source.indexOf("installThreeMaterialMath();")).toBeGreaterThan(0);
    expect(source.indexOf("installThreeMaterialMath();")).toBeLessThan(source.indexOf("new THREE.WebGLRenderer("));
  }
});
