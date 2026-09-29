// C3 矩形/带纹理面积光:合同校验(fail-closed)、打包 ABI 逐槽锁定、正交化与字节稳定。
// 与 clusterPacking.test.ts 同族纪律:布局漂移即抓红(灯区布局与 WGSL DEEP_AREA_LIGHT_ABI 逐字互钉)。
import { describe, expect, it } from "vitest";
import { AREA_LIGHT_DATA_VEC4S, AREA_LIGHT_DATA_VEC4_TOTAL, AREA_LIGHT_FLAG_TEXTURE, AREA_LIGHT_FLAG_TWO_SIDED,
  AREA_LIGHT_LUT_VEC4S, AREA_LIGHT_STRIDE_VEC4, MAX_AREA_LIGHTS, packAreaLights, validateAreaLight,
  type AreaLight } from "./areaLights.js";
import { LTC_LUT_FLOATS_PER_TEXEL, LTC_LUT_SIZE } from "./ltc.js";

const light = (overrides: Partial<AreaLight> = {}): AreaLight => ({
  positionView: [1, 2, -3], directionView: [0, 0, -1], upView: [0, 1, 0], halfExtent: [0.5, 0.25],
  range: 0, color: [1, 0.8, 0.6], intensity: 4, ...overrides,
});

describe("C3 area lights contract and packing", () => {
  it("caps the light count fail-closed and pins the ABI budget constants", () => {
    expect(() => packAreaLights(Array.from({ length: MAX_AREA_LIGHTS + 1 }, () => light()))).toThrow("exceeds 8");
    expect(packAreaLights([light()]).count).toBe(1);
    // 组合 buffer = [灯区 MAX×6][LUT 区 64×64×2];f32 预算与每 texel 8 f32 互钉。
    expect(AREA_LIGHT_STRIDE_VEC4).toBe(6);
    expect(MAX_AREA_LIGHTS).toBe(8);
    expect(AREA_LIGHT_DATA_VEC4S).toBe(48);
    expect(AREA_LIGHT_LUT_VEC4S).toBe(LTC_LUT_SIZE * LTC_LUT_SIZE * 2);
    expect(AREA_LIGHT_DATA_VEC4_TOTAL).toBe(AREA_LIGHT_DATA_VEC4S + AREA_LIGHT_LUT_VEC4S);
    expect(LTC_LUT_FLOATS_PER_TEXEL).toBe(8);
  });

  it("validates every field fail-closed", () => {
    validateAreaLight(light(), "areas[0]");
    expect(() => validateAreaLight(light({ positionView: [0, Number.NaN, 0] }), "l")).toThrow("positionView");
    expect(() => validateAreaLight(light({ directionView: [0, 0, 0] }), "l")).toThrow("directionView must be nonzero");
    expect(() => validateAreaLight(light({ upView: [0, 0, 0] }), "l")).toThrow("upView must be nonzero");
    expect(() => validateAreaLight(light({ halfExtent: [0, 1] }), "l")).toThrow("halfExtent[0]");
    expect(() => validateAreaLight(light({ halfExtent: [1, -1] }), "l")).toThrow("halfExtent[1]");
    expect(() => validateAreaLight(light({ range: -1 }), "l")).toThrow("range");
    expect(() => validateAreaLight(light({ color: [1, -0.1, 1] }), "l")).toThrow("color must be nonnegative");
    expect(() => validateAreaLight(light({ intensity: -2 }), "l")).toThrow("intensity");
    expect(() => validateAreaLight(light({ texture: { uvScale: [1], uvOffset: [0, 0] } }), "l")).toThrow("vec2 pairs");
    expect(() => validateAreaLight(light({ texture: { uvScale: [1, 1], uvOffset: [0, Number.POSITIVE_INFINITY] } }), "l")).toThrow("vec2 pairs");
  });

  it("packs the six-vec4 layout verbatim (normalize, orthonormalize, flags, radiance)", () => {
    const packed = packAreaLights([light({
      directionView: [0, 0, -2], upView: [0, 2, 0], halfExtent: [0.5, 0.25], range: 7,
      twoSided: true, texture: { uvScale: [2, 3], uvOffset: [0.1, 0.2] },
    })]);
    const floats = packed.lights;
    expect([...floats.slice(0, 4)]).toEqual([1, 2, -3, 7]);
    expect([...floats.slice(4, 8)]).toEqual([0, 0, -1, 0]); // 方向归一,decay 槽恒 0
    expect([...floats.slice(8, 12)]).toEqual([0, 1, 0, AREA_LIGHT_FLAG_TWO_SIDED | AREA_LIGHT_FLAG_TEXTURE]);
    expect([...floats.slice(12, 16)]).toEqual([0.5, 0.25, 2, 3]);
    expect([...floats.slice(16, 20)]).toEqual([Math.fround(0.1), Math.fround(0.2), 0, 0]);
    expect([...floats.slice(20, 24)]).toEqual([4, Math.fround(3.2), Math.fround(2.4), 0]); // radiance = color × intensity
  });

  it("orthonormalizes skewed up vectors and falls back when up is parallel to the normal", () => {
    const skewed = packAreaLights([light({ directionView: [0, 0, -1], upView: [1, 1, 0] })]).lights;
    expect([...skewed.slice(8, 11)].every((value, index) => Math.abs(value - [Math.SQRT1_2, Math.SQRT1_2, 0][index]!) < 1e-6)).toBe(true);
    const parallel = packAreaLights([light({ directionView: [0, 0, -1], upView: [0, 0, 5] })]).lights;
    expect([...parallel.slice(8, 11)]).toEqual([0, 1, 0]); // 退化灯打包最小可见,着色端兜底
  });

  it("keeps unused tail slots zeroed for byte-stable diffing", () => {
    const floats = packAreaLights([light()]).lights;
    expect(floats.length).toBe(MAX_AREA_LIGHTS * AREA_LIGHT_STRIDE_VEC4 * 4);
    expect(floats.slice(AREA_LIGHT_STRIDE_VEC4 * 4).every(value => value === 0)).toBe(true);
  });
});
