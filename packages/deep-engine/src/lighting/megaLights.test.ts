// B2 MegaLights M1 灯光池:64B/灯 显式 ABI 逐槽锁定(与 WGSL DEEP_MEGA_LIGHT_ABI 互钉,
// 漂移由 megaLightsRisWgslChecksum.test.ts 同步抓红)、fail-closed 合同、场景适配
// (ClusteredLights→池,IES 行号与 packIesShading 对齐)与直射通路选择决策表。
import { describe, expect, it } from "vitest";
import { MAX_MEGA_LIGHTS, MEGA_LIGHT_KIND_AREA_RECT, MEGA_LIGHT_KIND_POINT, MEGA_LIGHT_KIND_SPOT,
  MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET, MEGA_LIGHT_STRIDE_BYTES, MEGA_LIGHT_STRIDE_VEC4,
  MEGA_LIGHT_WORDS, megaLightFromArea, megaLightFromPoint, megaLightFromSpot,
  megaLightsFromClustered, megaAreaLightExtentFactor, packMegaLights, resolveDirectLightingPath,
  validateMegaLight, type MegaLight } from "./megaLights.js";
import type { AreaLight } from "./areaLights.js";
import type { ClusteredLights } from "./types.js";

const point = (overrides: Partial<Extract<MegaLight, { kind: "point" }>> = {}): MegaLight => ({
  kind: "point", positionView: [1, 2, 3], range: 10, color: [1, 0.9, 0.8], intensity: 4, decay: 2, ...overrides,
});

describe("MegaLights M1 light pool", () => {
  it("pins the 64-byte-per-light ABI budget constants", () => {
    expect(MEGA_LIGHT_STRIDE_BYTES).toBe(64);
    expect(MEGA_LIGHT_STRIDE_VEC4).toBe(4);
    expect(MEGA_LIGHT_WORDS).toBe(16);
    expect(MAX_MEGA_LIGHTS).toBe(65_535);
    expect(MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET).toBe(64);
  });

  it("packs the four-vec4 layout verbatim (kind/radiance/direction/params)", () => {
    const packed = packMegaLights([
      point({ intensity: 4 }),
      { kind: "spot", positionView: [0, 5, 0], range: 12, color: [1, 1, 1], intensity: 8, decay: 2,
        directionView: [0, -2, 0], innerConeCos: 0.9, outerConeCos: 0.7, iesSpotIndex: 3 },
      { kind: "area", positionView: [0, 3, -2], range: 0, color: [2, 1, 0.5], intensity: 3, decay: 2,
        directionView: [0, 0, -1], upView: [0, 1, 0], halfExtent: [0.5, 0.25], twoSided: true },
    ]);
    expect(packed.count).toBe(3);
    expect(packed.pointCount).toBe(1);
    expect(packed.spotCount).toBe(1);
    expect(packed.areaCount).toBe(1);
    expect(packed.iesReferenceCount).toBe(4);
    const floats = packed.data;
    // point:[0] position|kind
    expect([...floats.slice(0, 4)]).toEqual([1, 2, 3, MEGA_LIGHT_KIND_POINT]);
    // [1] radiance=color×intensity | range
    expect([...floats.slice(4, 8)]).toEqual([4, Math.fround(3.6), Math.fround(3.2), 10]);
    // [2] 方向(点光 +Z 占位)| ies 0=无
    expect([...floats.slice(8, 12)]).toEqual([0, 0, 1, 0]);
    // [3] point params = (decay−2,0,0,0)
    expect([...floats.slice(12, 16)]).toEqual([0, 0, 0, 0]);
    // spot 基址 16:方向归一 [0,-1,0],ies 行号 3+1
    expect([...floats.slice(16 + 8, 16 + 12)]).toEqual([0, -1, 0, 4]);
    // spot params = (innerCos, outerCos, coneScale=1/(0.9-0.7), decay−2)
    expect([...floats.slice(16 + 12, 16 + 16)]).toEqual([Math.fround(0.9), Math.fround(0.7), 5, 0]);
    // area 基址 32:法线归一 + twoSided 位
    expect([...floats.slice(32, 36)]).toEqual([0, 3, -2, MEGA_LIGHT_KIND_AREA_RECT]);
    expect([...floats.slice(32 + 8, 32 + 12)]).toEqual([0, 0, -1, 0]);
    expect([...floats.slice(32 + 12, 32 + 16)]).toEqual([0.5, 0.25, 1, 0]);
  });

  it("keeps unused tail slots zeroed (kind=point zero record contributes nothing)", () => {
    // 空池 = 最小占位(1 灯槽,kind=point 全零 → 衰减/贡献恒零);多灯池尾部同纪律。
    const empty = packMegaLights([]);
    expect(empty.count).toBe(0);
    expect([...empty.data]).toEqual(new Array(MEGA_LIGHT_STRIDE_VEC4 * 4).fill(0));
    const two = packMegaLights([point(), point()]);
    expect(two.data.slice(2 * MEGA_LIGHT_WORDS).every(value => value === 0)).toBe(true);
  });

  it("validates every field fail-closed", () => {
    validateMegaLight(point(), "megas[0]");
    expect(() => validateMegaLight(point({ positionView: [0, Number.NaN, 0] }), "l")).toThrow("positionView");
    expect(() => validateMegaLight(point({ range: -1 }), "l")).toThrow("range");
    expect(() => validateMegaLight(point({ intensity: -1 }), "l")).toThrow("intensity");
    expect(() => validateMegaLight(point({ decay: 5 }), "l")).toThrow("decay");
    expect(() => validateMegaLight({ ...point(), kind: "spot" }, "l")).toThrow("directionView");
    expect(() => validateMegaLight({
      kind: "spot", positionView: [0, 0, 0], range: 1, color: [1, 1, 1], intensity: 1, decay: 2,
      directionView: [0, -1, 0], innerConeCos: 0.5, outerConeCos: 0.8,
    }, "l")).toThrow("cone cosines");
    expect(() => validateMegaLight({ ...point(), kind: "area" }, "l")).toThrow("directionView");
    expect(() => validateMegaLight({ ...point(), kind: "area",
      directionView: [0, 0, -1], upView: [0, 1, 0] }, "l")).toThrow("halfExtent");
    expect(() => validateMegaLight({ ...point(), kind: "cube" as never }, "l")).toThrow("kind");
    expect(() => packMegaLights(Array.from({ length: MAX_MEGA_LIGHTS + 1 }, () => point()))).toThrow("exceeds 65535");
  });

  it("adapts ClusteredLights with spot-order ies index alignment (packIesShading rows)", () => {
    const clustered: ClusteredLights = {
      points: [point() as never],
      spots: [{ ...point(), kind: undefined, directionView: [0, -1, 0], innerConeCos: 0.9, outerConeCos: 0.6,
        ies: { profileId: "p1" } } as never],
      areas: [({ positionView: [0, 0, 0], directionView: [0, 0, -1], upView: [0, 1, 0],
        halfExtent: [1, 1], range: 0, color: [1, 1, 1], intensity: 1 }) as AreaLight],
    };
    const megas = megaLightsFromClustered(clustered);
    expect(megas.length).toBe(3);
    expect(megas[1]).toMatchObject({ kind: "spot", iesSpotIndex: 0 });
    const packed = packMegaLights(megas);
    expect(packed.iesReferenceCount).toBe(1);
    // 行号字 = ies 行 + 1(0 = 无 IES 哨兵),着色端以 deepSpotIesFactor(row-1) 复用 E02 表。
    expect(packed.data[16 + 11]).toBe(1);
  });

  it("computes the area extent factor for the center-point approximation", () => {
    expect(megaAreaLightExtentFactor(megaLightFromArea({
      positionView: [0, 0, 0], directionView: [0, 0, -1], upView: [0, 1, 0],
      halfExtent: [0.5, 0.25], range: 0, color: [1, 1, 1], intensity: 1,
    }))).toBeCloseTo(0.5, 12);
    expect(megaAreaLightExtentFactor(megaLightFromPoint(point()))).toBe(0);
  });

  it("round-trips through the adapter family without drift", () => {
    const area: AreaLight = { positionView: [1, 2, -3], directionView: [0, 0, -2], upView: [0, 1, 0],
      halfExtent: [0.4, 0.2], range: 5, color: [1, 0.5, 0.25], intensity: 2, twoSided: true };
    expect(megaLightFromArea(area)).toMatchObject({ kind: "area", range: 5, twoSided: true });
    expect(megaLightFromPoint(point({ decay: undefined })).decay).toBe(2);
    expect(megaLightFromSpot({ ...point(), directionView: [0, -1, 0], innerConeCos: 1, outerConeCos: -1 } as never,
      2).iesSpotIndex).toBe(2);
  });
});

describe("MegaLights M1 direct lighting path selection", () => {
  it("keeps the cluster fast path inside the 64-light budget", () => {
    expect(resolveDirectLightingPath({ points: 0, spots: 0 })).toEqual({
      path: "cluster-forward-plus", reason: "within-cluster-budget", localLightCount: 0, areaCount: 0 });
    expect(resolveDirectLightingPath({ points: 60, spots: 4, areas: 64 }).path).toBe("cluster-forward-plus");
    expect(resolveDirectLightingPath({ points: 64, spots: 0 }).reason).toBe("within-cluster-budget");
  });

  it("switches to the MegaLights RIS path beyond the budget (cost decoupled from light count)", () => {
    expect(resolveDirectLightingPath({ points: 65, spots: 0 })).toEqual({
      path: "megalights-ris", reason: "light-count-exceeds-cluster-budget", localLightCount: 65, areaCount: 0 });
    expect(resolveDirectLightingPath({ points: 0, spots: 0, forceMegaLights: true }).reason).toBe("megalights-forced");
    expect(resolveDirectLightingPath({ points: 5000, spots: 0 }).path).toBe("megalights-ris");
  });

  it("honors a custom cluster budget and rejects malformed counts", () => {
    expect(resolveDirectLightingPath({ points: 40, spots: 0, clusterBudget: 32 }).reason)
      .toBe("light-count-exceeds-cluster-budget");
    expect(() => resolveDirectLightingPath({ points: -1, spots: 0 })).toThrow("nonnegative light counts");
    expect(() => resolveDirectLightingPath({ points: 1.5, spots: 0 })).toThrow("nonnegative light counts");
    expect(() => resolveDirectLightingPath({ points: 1, spots: 0, areas: -2 })).toThrow("nonnegative integer");
    expect(() => resolveDirectLightingPath({ points: 1, spots: 0, clusterBudget: 0 })).toThrow("cluster budget");
  });
});
