import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import source from "../../wgsl/materialMetalReflection.wgsl?raw";
import checksum from "../../wgsl/materialMetalReflection.wgsl.sha256?raw";
import { MATERIAL_METAL_REFLECTION_WGSL } from "./materialMetalReflectionWgsl.js";
import { sceneShader } from "../webgpu/pbrShader.js";
import { composeLayeredMaterialSceneShader } from "../webgpu/pbrLayeredMaterialShader.js";
it("pins one pure WGSL source, generated mirror and cross-host checksum", () => {
  const [sha, length] = checksum.trim().split(/\s+/);
  expect(MATERIAL_METAL_REFLECTION_WGSL).toBe(source);
  expect(createHash("sha256").update(source).digest("hex")).toBe(sha);
  expect(new TextEncoder().encode(source).byteLength).toBe(Number(length));
  expect(source).not.toMatch(/@(group|binding|compute|vertex|fragment)/);
  expect(source).not.toContain("texture");
});
it("adds the explicit branch only to the opt-in layer composition", () => {
  const original = sceneShader;
  const composed = composeLayeredMaterialSceneShader(original);
  expect(composed).toContain("(flags & 8u) != 0u");
  expect(composed).toContain("deepMetalReflectionDirect(surface.base, surface.rough");
  expect(composed).toContain("params0.w, params1.x");
  expect(composed).toContain("original - stockDirect + reflected * visibility");
  expect(original).not.toContain("deepMetalReflection");
  expect(original).not.toContain("metalTangent");
  expect(composed).toContain("@location(13) metalTangent: vec3f");
  expect(composed).toContain("vec3f(v.row0.x, v.row1.x, v.row2.x)");
  expect(composed).toContain("v.metalTangent, frame.sunColor.rgb");
});
