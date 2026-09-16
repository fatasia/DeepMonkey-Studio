import { describe, expect, it } from "vitest";
import { evaluateDiffuseIrradiance, packDiffuseIrradiance } from "./diffuseIrradiance.js";
import type { LightVector3 } from "./types.js";

const hemi = { directionWorld: [0, 2, 0] as const, skyColor: [2, 0, 0] as const,
  groundColor: [0, 0, 4] as const, intensity: 3 };
const white = [1, 1, 1] as const;
describe("authored diffuse irradiance", () => {
  it("defaults to zero with a fixed 64-byte coefficient ABI", () => {
    expect(packDiffuseIrradiance()).toEqual(new Float32Array(16));
    expect(packDiffuseIrradiance({ ambient: [], hemisphere: [] }).byteLength).toBe(64);
  });
  it.each([
    [[0, 1, 0], [6, 0, 0]], [[0, -1, 0], [0, 0, 12]], [[1, 0, 0], [3, 0, 6]],
  ])("matches Three sky/ground blend for normal %j", (normal, expected) => {
    const value = evaluateDiffuseIrradiance(packDiffuseIrradiance({ hemisphere: [hemi] }), normal as LightVector3, white, 0);
    value.forEach((channel, index) => expect(channel).toBeCloseTo(expected[index]! / Math.PI, 6));
  });
  it("sums multiple rotated hemispheres and ambient without faking directional lights", () => {
    const lights = { hemisphere: [hemi, { ...hemi, directionWorld: [1, 0, 0] as const }],
      ambient: [{ color: [1, 2, 3] as const, intensity: 2 }] };
    const value = evaluateDiffuseIrradiance(packDiffuseIrradiance(lights), [0, 1, 0], white, 0);
    [11, 4, 12].forEach((expected, index) => expect(value[index]).toBeCloseTo(expected / Math.PI, 6));
  });
  it("honors zero intensity, metalness, base reflectance and material AO", () => {
    const dark = packDiffuseIrradiance({ hemisphere: [{ ...hemi, intensity: 0 }] });
    expect(evaluateDiffuseIrradiance(dark, [0, 1, 0], white, 0)).toEqual([0, 0, 0]);
    const lit = packDiffuseIrradiance({ ambient: [{ color: white, intensity: Math.PI }] });
    expect(evaluateDiffuseIrradiance(lit, [0, 1, 0], white, 1)).toEqual([0, 0, 0]);
    expect(evaluateDiffuseIrradiance(lit, [0, 1, 0], [0.5, 0.25, 1], 0.5, 0.5)[0]).toBeCloseTo(0.125, 6);
  });
  it.each([NaN, Infinity, -1])("rejects invalid intensity %s", intensity => {
    expect(() => packDiffuseIrradiance({ hemisphere: [{ ...hemi, intensity }] })).toThrow("intensity");
  });
  it.each([[0, 0, 0], [NaN, 1, 0], [Infinity, 0, 0]])("rejects invalid direction %j", direction => {
    expect(() => packDiffuseIrradiance({ hemisphere: [{ ...hemi, directionWorld: direction as LightVector3 }] })).toThrow("direction");
  });
  it.each([[NaN, 0, 0], [-1, 0, 0], [0, Infinity, 0]])("rejects invalid linear color %j", color => {
    expect(() => packDiffuseIrradiance({ ambient: [{ color: color as LightVector3, intensity: 1 }] })).toThrow("color");
  });
  it("rejects Float32 overflow from a single light and from accumulation", () => {
    expect(() => packDiffuseIrradiance({ ambient: [{ color: white, intensity: 1e39 }] })).toThrow("Float32");
    expect(() => packDiffuseIrradiance({ ambient: Array(2).fill({ color: white, intensity: 2e38 }) })).toThrow("Float32");
    expect(() => packDiffuseIrradiance({ hemisphere: [{ ...hemi, skyColor: white,
      groundColor: [0, 0, 0], intensity: 4e38 }] })).toThrow("Float32");
  });
  it("bounds the light collection before traversing it", () => {
    expect(() => packDiffuseIrradiance({ ambient: Array(4097) })).toThrow("4096");
    expect(() => packDiffuseIrradiance({ hemisphere: {} as never })).toThrow("arrays");
  });
});
