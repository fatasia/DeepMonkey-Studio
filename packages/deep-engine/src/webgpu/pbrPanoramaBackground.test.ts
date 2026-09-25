import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { packPanoramaBackground, validatePanoramaBackground, PBR_PANORAMA_WGSL } from "./pbrPanoramaBackground.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

const view = { eye: [0, 0, 10] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0, 0, 0] as const, floor: [0, 0, 0] as const, exposure: 1, roughness: 1, verticalFovRadians: Math.PI / 2 };
describe("HDR panorama background", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates color and MRT WGSL with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "background.wgsl", "--input-kind", "wgsl"],
      { input: PBR_PANORAMA_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("uses actual camera basis and perspective without translation", () => {
    const data = packPanoramaBackground(view, { intensity: 2 }, 2);
    expect(Array.from(data.slice(0, 8))).toEqual([1, 0, 0, 2, 0, 1, 0, 1]);
    expect(data[10]).toBe(-1); expect(data[11]).toBe(2);
    const translated = packPanoramaBackground({ ...view, eye: [10, 20, 40], target: [10, 20, 30] }, { intensity: 2 }, 2);
    expect(translated).toEqual(data);
    const turned = packPanoramaBackground({ ...view, eye: [10, 0, 0] }, {}, 1);
    expect(turned[8]).toBe(-1); expect(turned[10]).toBeCloseTo(0);
  });
  it("packs a proper rotation independently of intensity", () => {
    const rotation = [0, 0, -1, 0, 1, 0, 1, 0, 0];
    const data = packPanoramaBackground(view, { rotation, intensity: 0 }, 1);
    expect(Array.from(data.slice(12))).toEqual([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
    expect(data[11]).toBe(0);
  });
  it.each([[], [1, 0, 0, 0, 1, 0, 0, 0, 2], [-1, 0, 0, 0, 1, 0, 0, 0, 1],
    [NaN, 0, 0, 0, 1, 0, 0, 0, 1]].map(rotation => ({ rotation })))("rejects invalid rotations $rotation", ({ rotation }) => {
    expect(() => validatePanoramaBackground({ rotation })).toThrow("rotation");
  });
  it.each([-1, NaN, Infinity, 65])("rejects invalid intensity %s", intensity => {
    expect(() => validatePanoramaBackground({ intensity })).toThrow("intensity");
  });
  it("accepts explicit display-space panorama composition", () => {
    expect(() => validatePanoramaBackground({ toneMapped: false })).not.toThrow();
    expect(() => validatePanoramaBackground({ toneMapped: "false" as unknown as boolean })).toThrow("boolean");
  });
  it("excludes panorama from direct presentation even with all post effects off", () => {
    const features = resolvePbrRendererFeatures({ ambientOcclusion: false, temporalAa: false, spatialAa: false,
      occlusionCulling: false, bloom: false, vignette: false });
    expect(pbrDirectDisplayClear(view, features, false)).toBeDefined();
    expect(pbrDirectDisplayClear({ ...view, panoramaBackground: {} }, features, false)).toBeUndefined();
  });
  it("keeps background depth empty for geometry/transparent composition and avoids display encoding", () => {
    expect(PBR_PANORAMA_WGSL).toContain("Mrt(panoramaColor(v.ndc), 0.0, vec4f(0.0), vec2f(0.0))");
    expect(PBR_PANORAMA_WGSL).not.toMatch(/toneMap|exposure/);
    expect(PBR_PANORAMA_WGSL).toContain("@fragment fn display");
  });
});
