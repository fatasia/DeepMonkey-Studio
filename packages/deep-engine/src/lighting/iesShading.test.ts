import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIesProfile } from "./iesProfile.js";
import { intensityFactor, prepareIesSampling } from "./iesSampling.js";
import { evaluateIesShadingFactor, expandIesProfileTable, IES_EXPANDED_COLUMNS,
  packIesShading } from "./iesShading.js";
import { quantizeIesLightProfile } from "../runtimePackage/lightProfiles.js";
import type { RuntimeLightProfile } from "../runtimePackage/environmentTypes.js";
import type { SpotLight } from "./types.js";

/** 夹具：解析器真实样本（与 iesGolden 同源）量化为运行时表。 */
function quantizedProfile(profileId: string, source: string): RuntimeLightProfile {
  const parsed = parseIesProfile(readFileSync(new URL(`../../fixtures/ies/${source}`, import.meta.url), "utf8"));
  return quantizeIesLightProfile(profileId, parsed);
}

const coneProfile = quantizedProfile("syn.cone-hemisphere", "e02-cone-hemisphere.ies");
const quadProfile = quantizedProfile("syn.quad-0-90", "e02-quad-0-90.ies");

function spot(ies: unknown, overrides: Partial<SpotLight> = {}): SpotLight {
  return {
    positionView: [0, 2, 0], range: 8, color: [1, 1, 1], intensity: 3,
    directionView: [0, -1, 0], innerConeCos: Math.cos(0.2), outerConeCos: Math.cos(0.5),
    ...(ies === undefined ? {} : { ies: ies as SpotLight["ies"] }), ...overrides,
  } as SpotLight;
}

/** 按 iesShading 的基约定（up=(1,0,0)，光轴 (0,-1,0)）构造 θ/φ 精确方向。 */
function directionFor(thetaDeg: number, phiDeg: number): readonly [number, number, number] {
  const theta = thetaDeg * Math.PI / 180, phi = phiDeg * Math.PI / 180;
  const right = [0, 0, -1] as const, pole = [1, 0, 0] as const, axis = [0, -1, 0] as const;
  const horizontal = Math.sin(theta);
  const toSurface = [
    horizontal * (Math.cos(phi) * right[0] + Math.sin(phi) * pole[0]) + Math.cos(theta) * axis[0],
    horizontal * (Math.cos(phi) * right[1] + Math.sin(phi) * pole[1]) + Math.cos(theta) * axis[1],
    horizontal * (Math.cos(phi) * right[2] + Math.sin(phi) * pole[2]) + Math.cos(theta) * axis[2],
  ] as const;
  return [-toSurface[0], -toSurface[1], -toSurface[2]];
}

describe("E02 IES shading packing (WebGPU binding 12)", () => {
  it("expands profiles so the packed table equals intensityFactor on every 0.5° grid point", () => {
    for (const profile of [coneProfile, quadProfile]) {
      const sampling = prepareIesSampling(profile);
      const expanded = expandIesProfileTable(profile);
      expect(expanded.length).toBe(sampling.candela.length * IES_EXPANDED_COLUMNS);
      for (let row = 0; row < sampling.candela.length; row += 1) {
        const rowCenter = sampling.rowHalfStep === 0 ? 0 : row * sampling.rowHalfStep / 2;
        for (let column = 0; column < IES_EXPANDED_COLUMNS; column += 1) {
          const expected = intensityFactor(sampling, column * 0.5, rowCenter, 0, 1);
          expect(expanded[row * IES_EXPANDED_COLUMNS + column]).toBe(expected === 0 ? 0 : Math.fround(expected));
        }
      }
    }
  });

  it("packs a determinate buffer: params, meta and normalized table sections", () => {
    const lights = [spot({ profileId: "syn.cone-hemisphere" }), spot(undefined), spot({ profileId: "syn.quad-0-90", rotationDeg: 45, scaleFactor: 0.5 })];
    const packing = packIesShading(lights, [coneProfile, quadProfile]);
    expect(packing.spotCount).toBe(3);
    expect(packing.profileCount).toBe(2);
    expect(packing.vec4Count).toBe(3 + 2 + (coneProfile.candela.length + quadProfile.candela.length) * 91);
    // 参数节：无 ies 的灯占位 -1；有 ies 的灯写 profileIndex/半度旋转/缩放/meta 基址。
    expect([...packing.data.slice(0, 4)]).toEqual([0, 0, 1, 3]);
    expect([...packing.data.slice(4, 8)]).toEqual([-1, 0, 0, 0]);
    expect([...packing.data.slice(8, 12)]).toEqual([1, 90, 0.5, 3 + 1]);
    // 元数据节：tableBase/rows/rowHalfStep/symmetry。
    const metaBase = 3;
    expect([...packing.data.slice(metaBase * 4, metaBase * 4 + 4)])
      .toEqual([5, coneProfile.candela.length, 0, 1]);
    const quadRows = quadProfile.candela.length;
    expect([...packing.data.slice((metaBase + 1) * 4, (metaBase + 1) * 4 + 4)])
      .toEqual([5 + coneProfile.candela.length * 91, quadRows, 180 / (quadRows - 1), 4]);
    // 展开值与权威函数逐位相等（f32 归一化）。
    const expanded = expandIesProfileTable(coneProfile);
    expect([...packing.data.slice((metaBase + 2) * 4, (metaBase + 2) * 4 + 8)]).toEqual([...expanded.slice(0, 8)]);
    const repacked = packIesShading(lights, [coneProfile, quadProfile]);
    expect(repacked.data.every((value, index) => value === packing.data[index])).toBe(true);
  });

  it("emits the identity placeholder buffer when no light carries ies", () => {
    const packing = packIesShading([spot(undefined), spot(undefined)], []);
    expect(packing.vec4Count).toBe(2);
    expect([...packing.data]).toEqual([-1, 0, 0, 0, -1, 0, 0, 0]);
    expect(evaluateIesShadingFactor(packing, 0, [0, -1, 0], [0, -1, 1])).toBe(1);
    expect(evaluateIesShadingFactor(packing, 1, [0, -1, 0], [0, -1, 1])).toBe(1);
  });

  it("rejects dangling profile references and off-contract parameters by column name", () => {
    expect(() => packIesShading([spot({ profileId: "missing" })], [coneProfile]))
      .toThrow("spots[0].ies.profileId missing 未在 lightProfiles 中声明");
    expect(() => packIesShading([spot({ profileId: "syn.cone-hemisphere" })], undefined))
      .toThrow("未携带 lightProfiles 载荷");
    expect(() => packIesShading([spot({ profileId: "syn.cone-hemisphere", rotationDeg: 45.25 })], [coneProfile]))
      .toThrow("rotationDeg");
    expect(() => packIesShading([spot({ profileId: "syn.cone-hemisphere", scaleFactor: 10.5 })], [coneProfile]))
      .toThrow("scaleFactor");
  });

  it("evaluates the CPU reference bit-equal to the authority on the packed table", () => {
    const lights = [spot({ profileId: "syn.cone-hemisphere" }), spot({ profileId: "syn.quad-0-90", rotationDeg: 90, scaleFactor: 0.5 })];
    const packing = packIesShading(lights, [coneProfile, quadProfile]);
    const coneSampling = prepareIesSampling(coneProfile), quadSampling = prepareIesSampling(quadProfile);
    const lightDirection = [0, -1, 0] as const;
    for (const theta of [0, 0.5, 3.5, 21, 45, 60, 90]) {
      for (const phi of [0, 45, 90, 135, 180, 225, 270, 315]) {
        // θ=0 的方向与 φ 无关（轴上无方位语义），只保留 φ=0 的对照。
        if (theta === 0 && phi !== 0) continue;
        const surfaceToLight = directionFor(theta, phi);
        const factor = evaluateIesShadingFactor(packing, 0, lightDirection, surfaceToLight);
        const authority = intensityFactor(coneSampling, theta, phi, 0, 1);
        expect(factor).toBeCloseTo(authority, 6);
        // 旋转 90° 后 φ 平移：evaluate(φ) 应等于权威 (θ, φ, rotation=90)。
        const rotated = evaluateIesShadingFactor(packing, 1, lightDirection, directionFor(theta, phi));
        const rotatedAuthority = intensityFactor(quadSampling, theta, phi, 90, 0.5);
        expect(rotated).toBeCloseTo(rotatedAuthority, 6);
      }
    }
    // θ 超出角域（锥形 profile 实测 0–90）→ 合同性无光，不外推。
    expect(evaluateIesShadingFactor(packing, 0, lightDirection, directionFor(120, 0))).toBe(0);
  });
});
