// C3 矩形/带纹理面积光:合同校验(fail-closed)、打包 ABI 逐槽锁定、正交化与字节稳定。
// 与 clusterPacking.test.ts 同族纪律:布局漂移即抓红(灯区布局与 WGSL DEEP_AREA_LIGHT_ABI 逐字互钉)。
import { describe, expect, it } from "vitest";
import { AREA_LIGHT_DATA_VEC4S, AREA_LIGHT_DATA_VEC4_TOTAL, AREA_LIGHT_FLAG_TEXTURE, AREA_LIGHT_FLAG_TWO_SIDED,
  AREA_LIGHT_LUT_VEC4S, AREA_LIGHT_STRIDE_VEC4, MAX_AREA_LIGHTS, packAreaLights, validateAreaLight,
  type AreaLight } from "./areaLights.js";
import { LTC_LUT_FLOATS_PER_TEXEL, LTC_LUT_SIZE } from "./ltc.js";
import { evaluateAreaLightCpu } from "./ltc.js";
import { decodeLtcLut } from "./ltcTables.js";

const LTC_LUT = decodeLtcLut();

const light = (overrides: Partial<AreaLight> = {}): AreaLight => ({
  positionView: [1, 2, -3], directionView: [0, 0, -1], upView: [0, 1, 0], halfExtent: [0.5, 0.25],
  range: 0, color: [1, 0.8, 0.6], intensity: 4, ...overrides,
});

describe("C3 area lights contract and packing", () => {
  it("caps the light count fail-closed and pins the ABI budget constants", () => {
    expect(() => packAreaLights(Array.from({ length: MAX_AREA_LIGHTS + 1 }, () => light()))).toThrow("exceeds 64");
    expect(packAreaLights([light()]).count).toBe(1);
    // 组合 buffer = [灯区 MAX×6][LUT 区 64×64×2];f32 预算与每 texel 8 f32 互钉。
    // B2 MegaLights M1:8→64 扩容(与 RIS 采样同批交付,「扩容禁独立交付」定案);
    // WGSL 半由 ltcAreaLightingWgslChecksum.test.ts 以同常量逐字互钉。
    expect(AREA_LIGHT_STRIDE_VEC4).toBe(6);
    expect(MAX_AREA_LIGHTS).toBe(64);
    expect(AREA_LIGHT_DATA_VEC4S).toBe(384);
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

  it("packs and evaluates all 64 expanded slots losslessly (B2 MegaLights capacity, acceptance ④ CPU leg)", () => {
    // 64 盏确定性面积光(up 与法线预先正交 → 打包归一即语义归一)全量入池 → 从打包字
    // 重建语义 → evaluateAreaLightCpu 与原灯直评对拍(RMS ≤ 1e-6,仅 f32 fround 差)——
    // 扩容后灯区 ABI 端到端零损;GPU 腿见 lab/megaLightsGpuProbe.ts。
    const lights = Array.from({ length: MAX_AREA_LIGHTS }, (_, index) => {
      const directionView = [Math.sin(index * 0.9), 0.3 * Math.cos(index * 1.7), -1] as [number, number, number];
      const upRaw = [0, 1, 0.1 * (index % 3)] as [number, number, number];
      const dirLength = Math.hypot(...directionView);
      const dotUp = upRaw[0] * directionView[0] + upRaw[1] * directionView[1] + upRaw[2] * directionView[2];
      const upView = [upRaw[0] - dotUp * directionView[0] / dirLength ** 2,
        upRaw[1] - dotUp * directionView[1] / dirLength ** 2,
        upRaw[2] - dotUp * directionView[2] / dirLength ** 2] as [number, number, number];
      return light({
        positionView: [Math.cos(index * 0.7) * 2, Math.sin(index * 1.3) * 2, -1 - (index % 4)],
        directionView, upView,
        halfExtent: [0.2 + (index % 5) * 0.1, 0.15 + (index % 3) * 0.1],
        range: index % 4 === 0 ? 0 : 6 + index * 0.1,
        intensity: 1 + (index % 6),
        twoSided: index % 2 === 0,
      });
    });
    const packed = packAreaLights(lights);
    expect(packed.count).toBe(64);
    const stride = AREA_LIGHT_STRIDE_VEC4 * 4;
    const surface = {
      position: [0.4, -0.2, 0.5] as [number, number, number], normal: [0, 0.2, 1] as [number, number, number],
      view: [0, 0.1, 1] as [number, number, number], baseColor: [0.8, 0.75, 0.7] as [number, number, number],
      metallic: 0, roughness: 0.4,
    };
    let squares = 0;
    let nonzero = 0;
    for (let index = 0; index < MAX_AREA_LIGHTS; index++) {
      const base = index * stride;
      const words = packed.lights;
      // 灯区 ABI 只存 radiance 积(color×intensity,着色端也只消费积)——重建端
      // 以 radiance 向量 + intensity=1 复原同一发光学状态。
      const radiance = [words[base + 20]!, words[base + 21]!, words[base + 22]!];
      const fromWords = evaluateAreaLightCpu(LTC_LUT, {
        position: [words[base]!, words[base + 1]!, words[base + 2]!],
        normal: [words[base + 4]!, words[base + 5]!, words[base + 6]!],
        up: [words[base + 8]!, words[base + 9]!, words[base + 10]!],
        halfWidth: words[base + 12]!, halfHeight: words[base + 13]!,
        twoSided: (words[base + 11]! & AREA_LIGHT_FLAG_TWO_SIDED) !== 0,
        range: words[base + 3]!, intensity: 1, color: [radiance[0]!, radiance[1]!, radiance[2]!],
      }, surface);
      const original = lights[index]!;
      const direct = evaluateAreaLightCpu(LTC_LUT, {
        position: [...original.positionView] as [number, number, number],
        normal: [...original.directionView] as [number, number, number],
        up: [...original.upView] as [number, number, number],
        halfWidth: original.halfExtent[0], halfHeight: original.halfExtent[1],
        twoSided: original.twoSided === true, range: original.range,
        intensity: original.intensity, color: [...original.color] as [number, number, number],
      }, surface);
      for (let channel = 0; channel < 3; channel++) {
        squares += ((fromWords.diffuse[channel]! - direct.diffuse[channel]!) ** 2
          + (fromWords.specular[channel]! - direct.specular[channel]!) ** 2);
      }
      nonzero += Math.abs(fromWords.diffuse[0]!) + Math.abs(fromWords.specular[0]!) > 1e-9 ? 1 : 0;
      expect(Number.isFinite(fromWords.diffuse[0]! + fromWords.specular[0]!)).toBe(true);
    }
    expect(Math.sqrt(squares / (MAX_AREA_LIGHTS * 6))).toBeLessThan(1e-6);
    // 场景有效性:双面灯(32 盏)对该表面全部有非零贡献,单面灯视朝向而定。
    expect(nonzero).toBeGreaterThanOrEqual(32);
    // 槽位隔离:第 0 灯与第 63 灯的位置字不串扰。
    expect(packed.lights[63 * stride]).not.toBe(packed.lights[0]);
  });
});
