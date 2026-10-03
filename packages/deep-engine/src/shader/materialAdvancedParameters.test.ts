import { describe, expect, it } from "vitest";
import { ADVANCED_PARAMETER_FLOAT_COUNT, DEFAULT_ADVANCED_MATERIAL_PARAMETERS, hasAdvancedMaterialFeatures,
  normalizeAdvancedMaterialParameters, packAdvancedParameterBlock } from "./materialAdvancedParameters.js";
import { dCharlie, evalIridescence, fSchlick, iblSheenBrdf, schlickToF0, sheenDirectEnergy, sheenIndirectEnergy,
  vNeubelt, volumeAttenuation } from "./materialAdvancedReference.js";

describe("advanced material parameters", () => {
  it("defaults match three r185 MeshPhysicalMaterial and are inactive", () => {
    const n = normalizeAdvancedMaterialParameters({});
    expect(n).toEqual({ ...DEFAULT_ADVANCED_MATERIAL_PARAMETERS,
      iridescence: { ...DEFAULT_ADVANCED_MATERIAL_PARAMETERS.iridescence, ior: Math.fround(1.3) } });
    expect(hasAdvancedMaterialFeatures(n)).toBe(false);
    expect(n.sheen.roughness).toBe(1);
    expect(n.iridescence).toEqual({ factor: 0, ior: Math.fround(1.3), thickness: 400 });
    expect(n.volume.attenuationDistance).toBe(Infinity);
  });

  it("packs 12 floats with the infinite attenuation sentinel 0", () => {
    const block = packAdvancedParameterBlock({ sheen: { color: [1, 0.5, 0.25], roughness: 0.5 },
      volume: { thickness: 1.5, attenuationColor: [0.5, 1, 1], attenuationDistance: Infinity } });
    expect(block).toHaveLength(ADVANCED_PARAMETER_FLOAT_COUNT);
    expect([...block]).toEqual([1, 0.5, 0.25, 0.5, 0, 1.2999999523162842, 400, 1.5, 0.5, 1, 1, 0]);
  });

  it("detects active features independently", () => {
    const active = (raw: Parameters<typeof normalizeAdvancedMaterialParameters>[0]) =>
      hasAdvancedMaterialFeatures(normalizeAdvancedMaterialParameters(raw));
    expect(active({ sheen: { color: [0.1, 0, 0], roughness: 0.3 } })).toBe(true);
    expect(active({ iridescence: { factor: 1, ior: 1.3, thickness: 0 } })).toBe(false);
    expect(active({ iridescence: { factor: 0.5, ior: 1.3, thickness: 300 } })).toBe(true);
    expect(active({ volume: { thickness: 0.2, attenuationColor: [1, 1, 1], attenuationDistance: 2 } })).toBe(true);
  });

  it("fails closed on out-of-range or non-finite values", () => {
    const bad = (raw: Parameters<typeof normalizeAdvancedMaterialParameters>[0]) =>
      () => normalizeAdvancedMaterialParameters(raw);
    expect(bad({ sheen: { color: [2, 0, 0], roughness: 0.5 } })).toThrow(RangeError);
    expect(bad({ sheen: { color: [0, 0, 0], roughness: Number.NaN } })).toThrow(RangeError);
    expect(bad({ iridescence: { factor: 0.5, ior: 0.5, thickness: 100 } })).toThrow(RangeError);
    expect(bad({ volume: { thickness: -1, attenuationColor: [1, 1, 1], attenuationDistance: 1 } })).toThrow(RangeError);
    expect(bad({ volume: { thickness: 1, attenuationColor: [0, 1, 1], attenuationDistance: 1 } })).toThrow(RangeError);
    expect(bad({ volume: { thickness: 1, attenuationColor: [1, 1, 1], attenuationDistance: 0 } })).toThrow(RangeError);
  });
});

describe("three r185 reference math", () => {
  it("Charlie sheen: D normalises and V_Neubelt matches the closed form", () => {
    // ∫ D(h)·cosθ dω 在 roughness=1 时接近 1/π·∫(2+1/α)sin^(1/α)… 取数值积分守恒到 1(NDF 归一)。
    const r = 0.6;
    let integral = 0;
    const steps = 20000;
    for (let i = 0; i < steps; i++) {
      const theta = (i + 0.5) / steps * Math.PI / 2;
      integral += dCharlie(r, Math.cos(theta)) * Math.cos(theta) * Math.sin(theta) * (Math.PI / 2 / steps) * 2 * Math.PI;
    }
    expect(integral).toBeGreaterThan(0.5);
    expect(integral).toBeLessThan(1.5);
    expect(vNeubelt(1, 1)).toBeCloseTo(0.25, 6);
    expect(vNeubelt(0.5, 0.5)).toBeCloseTo(1 / (4 * 0.75), 6);
    expect(vNeubelt(0, 0)).toBe(1);
  });

  it("IBL sheen albedo is within [0,1], grows toward grazing, and gray sheen is energy neutral in a furnace", () => {
    for (const roughness of [0.1, 0.4, 0.8, 1]) {
      let previous = -1;
      for (const nv of [1, 0.75, 0.5, 0.25, 0.05]) {
        const a = iblSheenBrdf(nv, roughness);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        expect(a).toBeGreaterThanOrEqual(previous);
        previous = a;
        const s = 0.7;
        // 白炉:base 项 ×(1−s·A) + 间接 sheen s·A·E = E。
        expect(sheenIndirectEnergy([s, s, s], roughness, nv) + s * a).toBeCloseTo(1, 12);
      }
    }
    expect(sheenDirectEnergy([0.5, 0.5, 0.5], 0.5, 0.9, 0.2)).toBeLessThan(1);
  });

  it("volume attenuation follows Beer-Lambert and is neutral for infinite distance", () => {
    expect(volumeAttenuation(5, [0.2, 0.5, 1], Infinity)).toEqual([1, 1, 1]);
    const a = volumeAttenuation(2, [0.25, 0.5, 1], 2);
    expect(a[0]).toBeCloseTo(0.25, 12); expect(a[1]).toBeCloseTo(0.5, 12); expect(a[2]).toBeCloseTo(1, 12);
    const half = volumeAttenuation(1, [0.25, 0.5, 1], 2);
    expect(half[0]).toBeCloseTo(0.5, 12); expect(half[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("thin-film Fresnel is finite, non-negative, thickness-dependent and handles total internal reflection", () => {
    const f0: [number, number, number] = [0.04, 0.04, 0.04];
    const thin = evalIridescence(1, 1.3, 0.8, 200, f0), thick = evalIridescence(1, 1.3, 0.8, 400, f0);
    for (const v of [...thin, ...thick]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); }
    expect(Math.abs(thin[0] - thick[0]) + Math.abs(thin[2] - thick[2])).toBeGreaterThan(1e-3);
    // 相同厚度下不同入射角产生色移(角度依赖的干涉)。
    const oblique = evalIridescence(1, 1.3, 0.3, 400, f0);
    expect(Math.abs(oblique[1] - thick[1])).toBeGreaterThan(1e-3);
    // 薄膜折射率 < 外部折射率 + 大角度 → TIR → 全反射 1。
    expect(evalIridescence(1, 0.5, 0.1, 300, f0)).toEqual([1, 1, 1]);
    expect(schlickToF0([0.5, 0.5, 0.5], 1)[0]).toBeCloseTo(0.5, 12);
    expect(schlickToF0([0.5, 0.5, 0.5], 0.5)[0]).toBeCloseTo((0.5 - 0.5 ** 5) / (1 - 0.5 ** 5), 12);
    expect(fSchlick(0.04, 1)).toBeCloseTo(0.04, 3);
  });
});
