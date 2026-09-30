// I 级 C18 体积光 god rays 合同测试(收口 2026-09-30)。覆盖:
// 1) 参数 fail-closed(密度负/步数越界/硬顶全族);2) 光空间基与投影 round-trip;
// 3) 解析遮挡求交(球/盒/边界/退化/非单位方向 fail-closed);4) 参考闭式积分的
// 闭式性质(遮挡全闭 → inscatter 恰 0、透过率与无遮挡逐位一致、密度/反照率单调、
// strength 线性、均匀介质 Beer-Lambert 闭式);5) 与体积雾基线的数值 parity;
// 6) 步数收敛(量化依据,报告曲线的数据源同口径)。
// 阴影图光栅化与 CPU 镜像的测试在 volumetricGodRaysCpu.test.ts,字节门禁在
// volumetricGodRaysWgslChecksum.test.ts。
import { describe, expect, it } from "vitest";
import { defaultTestMedium, rayMarchVolumetricFog } from "../fog/volumetricFog.js";
import { GOD_RAYS_MAX_DISTANCE_CAP, GOD_RAYS_SHADOW_BIAS_MAX, GOD_RAYS_SHADOW_MAP_MAX,
  GOD_RAYS_SHADOW_MAP_MIN, GOD_RAYS_SHADOW_RANGE_CAP, GOD_RAYS_STEPS_MAX, GOD_RAYS_STEPS_MIN,
  GOD_RAYS_STRENGTH_CAP, GOD_RAYS_WORKGROUP_SIZE, analyticGodRaysShadow, buildGodRaysShadowBasis,
  godRaysFogParityProbe, godRaysFrameMarchSamples, godRaysLightSpacePoint,
  intersectGodRaysOccluder, rayMarchVolumetricGodRaysReference,
  validateVolumetricGodRaysOptions, type GodRaysOccluder, type VolumetricGodRaysOptions } from "./volumetricGodRays.js";

const MEDIUM = Object.freeze(defaultTestMedium());
const OBLIQUE_LIGHT = Object.freeze({ direction: [0.3, -0.8, 0.2] as const, radiance: [1, 0.95, 0.9] as const });
const AXIS_LIGHT = Object.freeze({ direction: [0, -1, 0] as const, radiance: [1, 0.95, 0.9] as const });
const OPTIONS = Object.freeze({
  verticalFovRadians: Math.PI / 3, steps: 48, maxDistance: 120,
  medium: MEDIUM, light: OBLIQUE_LIGHT, strength: 1,
  shadowMapSize: 64, shadowRange: 50, shadowBias: 0.05,
} satisfies VolumetricGodRaysOptions);

describe("validateVolumetricGodRaysOptions (fail-closed)", () => {
  it("accepts the reference option set and every cap boundary", () => {
    validateVolumetricGodRaysOptions({ ...OPTIONS });
    validateVolumetricGodRaysOptions({ ...OPTIONS, steps: GOD_RAYS_STEPS_MIN, maxDistance: GOD_RAYS_MAX_DISTANCE_CAP,
      strength: GOD_RAYS_STRENGTH_CAP, shadowMapSize: GOD_RAYS_SHADOW_MAP_MIN, shadowRange: GOD_RAYS_SHADOW_RANGE_CAP,
      shadowBias: GOD_RAYS_SHADOW_BIAS_MAX });
    validateVolumetricGodRaysOptions({ ...OPTIONS, steps: GOD_RAYS_STEPS_MAX, shadowMapSize: GOD_RAYS_SHADOW_MAP_MAX,
      strength: 0, shadowBias: 0 });
  });
  it("rejects steps out of [32, 64] and non-integers (步数越界 fail-closed)", () => {
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, steps: GOD_RAYS_STEPS_MIN - 1 })).toThrow(/steps/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, steps: GOD_RAYS_STEPS_MAX + 1 })).toThrow(/steps/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, steps: 48.5 })).toThrow(/steps/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, steps: Number.NaN })).toThrow(/steps/);
  });
  it("rejects fov / maxDistance / strength / shadow-map shape / range / bias outside their contracts", () => {
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, verticalFovRadians: 0 })).toThrow(/verticalFovRadians/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, verticalFovRadians: Math.PI })).toThrow(/verticalFovRadians/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, verticalFovRadians: Number.NaN })).toThrow(/verticalFovRadians/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, maxDistance: 0 })).toThrow(/maxDistance/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, maxDistance: GOD_RAYS_MAX_DISTANCE_CAP + 1 })).toThrow(/maxDistance/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, strength: -0.1 })).toThrow(/strength/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, strength: GOD_RAYS_STRENGTH_CAP + 0.1 })).toThrow(/strength/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, shadowMapSize: 48 })).toThrow(/shadowMapSize/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, shadowMapSize: 96 })).toThrow(/shadowMapSize/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, shadowRange: 0 })).toThrow(/shadowRange/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, shadowRange: GOD_RAYS_SHADOW_RANGE_CAP + 1 })).toThrow(/shadowRange/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, shadowBias: -0.01 })).toThrow(/shadowBias/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, shadowBias: GOD_RAYS_SHADOW_BIAS_MAX + 0.01 })).toThrow(/shadowBias/);
  });
  it("rejects negative density and other medium/light violations (密度负 fail-closed)", () => {
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, medium: { ...MEDIUM, baseExtinction: -0.01 } })).toThrow(/baseExtinction/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, medium: { ...MEDIUM, baseExtinction: Number.NaN } })).toThrow(/baseExtinction/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, medium: { ...MEDIUM, scaleHeight: 0 } })).toThrow(/scaleHeight/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, medium: { ...MEDIUM, anisotropy: 1 } })).toThrow(/anisotropy/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, medium: { ...MEDIUM, anisotropy: -1 } })).toThrow(/anisotropy/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, medium: { ...MEDIUM, albedo: 1.5 } })).toThrow(/albedo/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, light: { direction: [0, 0, 0], radiance: [1, 1, 1] } })).toThrow(/direction/);
    expect(() => validateVolumetricGodRaysOptions({ ...OPTIONS, light: { direction: [0.3, -0.8, 0.2], radiance: [1, -1, 1] } })).toThrow(/radiance/);
  });
});

describe("godRaysFrameMarchSamples (确定性成本公式)", () => {
  it("counts ceil-half pixels times steps", () => {
    expect(godRaysFrameMarchSamples(1920, 1080, 48)).toBe(960 * 540 * 48);
    expect(godRaysFrameMarchSamples(1, 1, 32)).toBe(32);
    expect(godRaysFrameMarchSamples(63, 63, 32)).toBe(32 * 32 * 32);
  });
  it("rejects non-positive dimensions and non-positive steps", () => {
    expect(() => godRaysFrameMarchSamples(0, 10, 32)).toThrow(/positive safe integers/);
    expect(() => godRaysFrameMarchSamples(10.5, 10, 32)).toThrow(/positive safe integers/);
    expect(() => godRaysFrameMarchSamples(10, 10, 0)).toThrow(/steps/);
  });
});

describe("buildGodRaysShadowBasis / godRaysLightSpacePoint", () => {
  it("constructs an orthonormal right-handed basis with forward = normalized light direction", () => {
    for (const direction of [[0.3, -0.8, 0.2], [1, 0, 0], [0, 0, -1], [0.01, 0.999, 0], [0, 1, 0], [0, -1, 0]]) {
      const basis = buildGodRaysShadowBasis(direction);
      const vectors = [basis.right, basis.up, basis.forward];
      const length = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
      for (const v of vectors) expect(length(v)).toBeCloseTo(1, 12);
      for (const a of vectors) for (const b of vectors) {
        expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeCloseTo(a === b ? 1 : 0, 12);
      }
      const inputLength = Math.hypot(direction[0], direction[1], direction[2]);
      expect(basis.forward[0]).toBeCloseTo(direction[0] / inputLength, 12);
    }
  });
  it("rejects zero and non-finite light directions", () => {
    expect(() => buildGodRaysShadowBasis([0, 0, 0])).toThrow(/nonzero/);
    expect(() => buildGodRaysShadowBasis([Number.NaN, 1, 0])).toThrow(/nonzero/);
  });
  it("projects a point built from the basis back to the same (u, v, w) coordinates", () => {
    const basis = buildGodRaysShadowBasis([0.3, -0.8, 0.2]);
    const [u, v, w] = [3.5, -2.25, 7.125];
    const point = [
      basis.right[0] * u + basis.up[0] * v + basis.forward[0] * w,
      basis.right[1] * u + basis.up[1] * v + basis.forward[1] * w,
      basis.right[2] * u + basis.up[2] * v + basis.forward[2] * w] as const;
    expect(godRaysLightSpacePoint(basis, point)[0]).toBeCloseTo(u, 12);
    expect(godRaysLightSpacePoint(basis, point)[1]).toBeCloseTo(v, 12);
    expect(godRaysLightSpacePoint(basis, point)[2]).toBeCloseTo(w, 12);
  });
});

describe("intersectGodRaysOccluder (解析求交)", () => {
  it("sphere: exact hit distance, miss, behind-origin, inside-origin clamp, tangent", () => {
    const sphere: GodRaysOccluder = { kind: "sphere", center: [0, 0, -10], radius: 2 };
    expect(intersectGodRaysOccluder(sphere, [0, 0, 0], [0, 0, -1], 0)).toBe(8);
    // tMin 落在球内(t=9 处 z=-9 在球内)→ 钳制命中 tMin(非 null)。
    expect(intersectGodRaysOccluder(sphere, [0, 0, 0], [0, 0, -1], 9)).toBe(9);
    // tMin ≥ 远交点(t=12 恰为远交点,严格比较)→ 整段被遮挡体覆盖之外 → null。
    expect(intersectGodRaysOccluder(sphere, [0, 0, 0], [0, 0, -1], 12)).toBeNull();
    // 视线偏移超过半径 → 无交。
    expect(intersectGodRaysOccluder(sphere, [5, 0, 0], [0, 0, -1], 0)).toBeNull();
    // 遮挡体在射线后方 → null。
    expect(intersectGodRaysOccluder(sphere, [0, 0, 0], [0, 0, 1], 0)).toBeNull();
    // 起点在球内 → 钳制命中 tMin(非 null)。
    expect(intersectGodRaysOccluder(sphere, [0, 0, -10], [0, 0, -1], 0.5)).toBe(0.5);
    // 切线(discriminant = 0)→ 命中切点。
    const tangent: GodRaysOccluder = { kind: "sphere", center: [2, 0, -10], radius: 2 };
    expect(intersectGodRaysOccluder(tangent, [0, 0, 0], [0, 0, -1], 0)).toBeCloseTo(10, 9);
    // 非正半径 fail-closed。
    expect(() => intersectGodRaysOccluder({ kind: "sphere", center: [0, 0, 0], radius: 0 }, [0, 0, 0], [0, 0, -1], 0))
      .toThrow(/radius/);
  });
  it("sphere: non-unit direction is rejected fail-closed (2026-09-30 缺陷修复锁)", () => {
    const sphere: GodRaysOccluder = { kind: "sphere", center: [0, 0, -10], radius: 2 };
    // 修复前:球分支以 a=1 化简,非单位方向静默返回被 |d|² 缩放的错误距离。
    expect(() => intersectGodRaysOccluder(sphere, [0, 0, 0], [0, 0, -2], 0)).toThrow(/unit/);
    expect(() => intersectGodRaysOccluder(sphere, [0, 0, 0], [0, 0, 0], 0)).toThrow(/unit/);
    expect(() => intersectGodRaysOccluder(sphere, [0, 0, 0], [Number.POSITIVE_INFINITY, 0, 0], 0)).toThrow(/unit/);
  });
  it("box: front hit, inside-origin clamp, parallel-outside miss, parallel-inside hit, behind miss", () => {
    const box: GodRaysOccluder = { kind: "box", min: [-1, -1, -5], max: [1, 1, -2] };
    expect(intersectGodRaysOccluder(box, [0, 0, 0], [0, 0, -1], 0)).toBe(2);
    // tMin 落在盒内(t=3 处 z=-3 在盒内)→ 钳制命中 tMin(非 null)。
    expect(intersectGodRaysOccluder(box, [0, 0, 0], [0, 0, -1], 3)).toBe(3);
    // tMin ≥ 远交点(tExit=5,严格比较)→ null。
    expect(intersectGodRaysOccluder(box, [0, 0, 0], [0, 0, -1], 5)).toBeNull();
    const aroundOrigin: GodRaysOccluder = { kind: "box", min: [-1, -1, -5], max: [1, 1, 5] };
    expect(intersectGodRaysOccluder(aroundOrigin, [0, 0, 0], [0, 0, -1], 0.5)).toBe(0.5);
    // 平行于 x 且在板外 → null;板内 → 穿过。
    expect(intersectGodRaysOccluder({ kind: "box", min: [2, -1, -5], max: [3, 1, -2] }, [0, 0, 0], [0, 0, -1], 0)).toBeNull();
    expect(intersectGodRaysOccluder({ kind: "box", min: [-2, -1, -5], max: [3, 1, -2] }, [0, 0, 0], [0, 0, -1], 0)).toBe(2);
    // 遮挡体整体在后方 → null。
    expect(intersectGodRaysOccluder({ kind: "box", min: [-1, -1, -5], max: [1, 1, -2] }, [0, 0, 0], [0, 0, 1], 0)).toBeNull();
    // 非有限 / min >= max 的退化盒 fail-closed。
    expect(() => intersectGodRaysOccluder({ kind: "box", min: [1, -1, -5], max: [1, 1, -2] }, [0, 0, 0], [0, 0, -1], 0))
      .toThrow(/min < max/);
    expect(() => intersectGodRaysOccluder({ kind: "box", min: [-1, Number.NaN, -5], max: [1, 1, -2] }, [0, 0, 0], [0, 0, -1], 0))
      .toThrow(/min < max/);
  });
  it("box: non-unit direction is rejected fail-closed (与球分支同语义)", () => {
    const box: GodRaysOccluder = { kind: "box", min: [-1, -1, -5], max: [1, 1, -2] };
    expect(() => intersectGodRaysOccluder(box, [0, 0, 0], [0, 0, -0.5], 0)).toThrow(/unit/);
  });
  it("sphere: oblique unit-direction hit matches the closed-form quadratic root", () => {
    // 3-4-5 方向精确二进制:[0.6, 0, -0.8];球心在射线上距原点 5,半径 1 → 首交 = 4(精确)。
    const sphere: GodRaysOccluder = { kind: "sphere", center: [3, 0, -4], radius: 1 };
    expect(intersectGodRaysOccluder(sphere, [0, 0, 0], [0.6, 0, -0.8], 0)).toBe(4);
  });
});

describe("analyticGodRaysShadow (参考闭式遮挡判定)", () => {
  // light = [0,-1,0](光自上而下):forward = [0,-1,0],basisW = -y,向光回投 = +Y。
  const basis = buildGodRaysShadowBasis([0, -1, 0]);
  // 遮挡板 y ∈ [1, 2] → 光空间 w ∈ [-2, -1];朝光面(最近光侧)为 y=2 → w_f = -2。
  const slab: GodRaysOccluder = { kind: "box", min: [-100, 1, -100], max: [100, 2, 100] };

  it("no occluder → 1; any blocking occluder → 0 (遮挡全闭 → 0)", () => {
    expect(analyticGodRaysShadow(basis, [], [0, 0, 0], 0.25)).toBe(1);
    expect(analyticGodRaysShadow(basis, [slab], [0, 0, 0], 0.25)).toBe(0);
    // 多遮挡体:任一遮挡即 0。
    const farSphere: GodRaysOccluder = { kind: "sphere", center: [0, 50, 0], radius: 2 };
    expect(analyticGodRaysShadow(basis, [farSphere], [0, 0, 0], 0.25)).toBe(0);
    expect(analyticGodRaysShadow(basis, [farSphere, slab], [0, 0, 0], 0.25)).toBe(0);
  });
  it("bias boundary is strict: a surface exactly shadowBias away along toward-light stays lit", () => {
    // 采样点在板内、距朝光面(y=2, w_f=-2)恰好 bias:w - w_f = 0.25(二进制精确)→ lit。
    expect(analyticGodRaysShadow(basis, [slab], [0, 1.75, 0], 0.25)).toBe(1);
    // 再深入 0.05(w - w_f = 0.3 > bias)→ occluded。
    expect(analyticGodRaysShadow(basis, [slab], [0, 1.7, 0], 0.25)).toBe(0);
    // 朝光面之外(w < w_f,靠光一侧)恒 lit(fail-open 语义)。
    expect(analyticGodRaysShadow(basis, [slab], [0, 2.25, 0], 0.25)).toBe(1);
  });
});

describe("rayMarchVolumetricGodRaysReference (CPU f64 参考闭式积分)", () => {
  const basis = buildGodRaysShadowBasis([0, -1, 0]);

  it("fully blocked line of sight yields exactly zero inscatter and bit-identical transmittance", () => {
    // 下降射线(dirY<0)采样 y ∈ (-12, 0);遮挡板 y ∈ [1, 2] 在每一步采样点与光源
    // 之间 → 全遮挡:每步 shadow = 0 → 每项恰为 0(f64 精确),透过率序列不受影响。
    const blocker: GodRaysOccluder = { kind: "box", min: [-1000, 1, -1000], max: [1000, 2, 1000] };
    const input = { rayDirection: [0.15, -0.9, -0.2] as const, marchDistance: 12, stepCount: 32 };
    const blocked = rayMarchVolumetricGodRaysReference(MEDIUM, AXIS_LIGHT, 1, basis, [blocker], 0.25, input);
    const open = rayMarchVolumetricGodRaysReference(MEDIUM, AXIS_LIGHT, 1, basis, [], 0.25, input);
    expect(blocked.inscatter[0]).toBe(0);
    expect(blocked.inscatter[1]).toBe(0);
    expect(blocked.inscatter[2]).toBe(0);
    expect(blocked.transmittance).toBe(open.transmittance);
  });
  it("transmittance decreases strictly with baseExtinction; inscatter grows strictly with albedo (密度单调)", () => {
    const input = { rayDirection: [0.1, 0.6, -0.2] as const, marchDistance: 80, stepCount: 48 };
    const obliqueBasis = buildGodRaysShadowBasis(OBLIQUE_LIGHT.direction);
    let previousT = Number.POSITIVE_INFINITY;
    for (const sigma of [0.005, 0.02, 0.05, 0.1]) {
      const result = rayMarchVolumetricGodRaysReference({ ...MEDIUM, baseExtinction: sigma },
        OBLIQUE_LIGHT, 1, obliqueBasis, [], 0, input);
      expect(result.transmittance).toBeLessThan(previousT);
      expect(result.transmittance).toBeGreaterThan(0);
      previousT = result.transmittance;
    }
    let previousScatter = -1;
    for (const albedo of [0.1, 0.3, 0.6, 0.9]) {
      const result = rayMarchVolumetricGodRaysReference({ ...MEDIUM, albedo }, OBLIQUE_LIGHT, 1, obliqueBasis, [], 0, input);
      expect(result.inscatter[0]).toBeGreaterThan(previousScatter);
      previousScatter = result.inscatter[0];
    }
  });
  it("strength scales inscatter linearly, zeroes it at 0, and leaves transmittance untouched", () => {
    const input = { rayDirection: [0.1, 0.6, -0.2] as const, marchDistance: 60, stepCount: 48 };
    const obliqueBasis = buildGodRaysShadowBasis(OBLIQUE_LIGHT.direction);
    const one = rayMarchVolumetricGodRaysReference(MEDIUM, OBLIQUE_LIGHT, 1, obliqueBasis, [], 0, input);
    const two = rayMarchVolumetricGodRaysReference(MEDIUM, OBLIQUE_LIGHT, 2, obliqueBasis, [], 0, input);
    const zero = rayMarchVolumetricGodRaysReference(MEDIUM, OBLIQUE_LIGHT, 0, obliqueBasis, [], 0, input);
    expect(zero.inscatter[0]).toBe(0);
    expect(two.inscatter[0]).toBeCloseTo(one.inscatter[0] * 2, 12);
    expect(two.inscatter[1]).toBeCloseTo(one.inscatter[1] * 2, 12);
    expect(two.transmittance).toBe(one.transmittance);
  });
  it("uniform medium (descending ray) matches the closed-form Beer-Lambert transmittance", () => {
    // 下降射线 height < 0 被 max(h,0) 钳 → 均匀密度 σ₀:离散 T = Π exp(-σ₀·Δs) ≈ exp(-σ₀·L)。
    const input = { rayDirection: [0.1, -0.7, -0.2] as const, marchDistance: 40, stepCount: 48 };
    const result = rayMarchVolumetricGodRaysReference(MEDIUM, AXIS_LIGHT, 1, basis, [], 0, input);
    expect(result.transmittance).toBeCloseTo(Math.exp(-MEDIUM.baseExtinction * 40), 9);
    // 无遮挡、无吸收差异时散射总量满足辐射守恒近似:inscatter ≤ radiance·albedo·phase·(1 - T) 量级。
    expect(result.inscatter[0]).toBeGreaterThan(0);
    expect(result.inscatter[0]).toBeLessThan(2);
  });
  it("converges with step count: error(64) well below error(32) and within a tight bound (量化依据)", () => {
    const input = { rayDirection: [0.1, 0.6, -0.2] as const, marchDistance: 120, stepCount: 4096 };
    const obliqueBasis = buildGodRaysShadowBasis(OBLIQUE_LIGHT.direction);
    const truth = rayMarchVolumetricGodRaysReference(MEDIUM, OBLIQUE_LIGHT, 1, obliqueBasis, [], 0, input);
    const relativeError = (steps: number): number => {
      const coarse = rayMarchVolumetricGodRaysReference(MEDIUM, OBLIQUE_LIGHT, 1, obliqueBasis, [], 0,
        { ...input, stepCount: steps });
      return Math.abs(coarse.inscatter[0] - truth.inscatter[0]) / Math.abs(truth.inscatter[0]);
    };
    const error32 = relativeError(32);
    const error64 = relativeError(64);
    expect(error64).toBeLessThan(error32);
    expect(error64).toBeLessThan(0.01);
    const tError64 = Math.abs(rayMarchVolumetricGodRaysReference(MEDIUM, OBLIQUE_LIGHT, 1, obliqueBasis, [], 0,
      { ...input, stepCount: 64 }).transmittance - truth.transmittance);
    // 有原则的界:T≈0.5 处 rgba16float 的 ulp = 2^-11 ≈ 4.9e-4;N=64 的闭式误差
    // 必须低于一个 f16 存储量化步长(否则 GPU 目标格式会吞掉并放大该误差)。
    expect(tError64).toBeLessThan(1 / 2048);
  });
});

describe("godRaysFogParityProbe (参数空间兼容性锚点)", () => {
  it("no-occluder reference is bit-identical to the fog baseline for representative rays", () => {
    for (const rayDirection of [[0, 1, 0], [0.3, -0.8, 0.2], [0.5, 0.2, -1], [-0.2, -0.4, 0.9]]) {
      const probe = godRaysFogParityProbe(MEDIUM, OBLIQUE_LIGHT, 120, 48, rayDirection as [number, number, number]);
      // 同一 f64 求值序(0 + x === x、r·1 === r 均精确)→ 逐位一致,非容差对拍。
      expect(probe.godRays.inscatter).toEqual(probe.fog.inscatter);
      expect(probe.godRays.transmittance).toBe(probe.fog.transmittance);
      expect(probe.fog.transmittance).toBeGreaterThan(0);
      expect(probe.fog.inscatter[0]).toBeGreaterThan(0);
    }
  });
  it("matches an independent fog call with the identical input shape", () => {
    const rayDirection: [number, number, number] = [0.4, 0.3, -0.8];
    const probe = godRaysFogParityProbe(MEDIUM, OBLIQUE_LIGHT, 90, 64, rayDirection);
    const direct = rayMarchVolumetricFog(MEDIUM, OBLIQUE_LIGHT, {
      rayOrigin: [0, 0, 0], rayDirection, near: 0, far: 90, stepCount: 64, shadowAttenuation: () => 1 });
    expect(probe.fog.inscatter).toEqual(direct.inscatter);
    expect(probe.fog.transmittance).toBe(direct.transmittance);
  });
});

describe("workgroup contract re-export", () => {
  it("re-exports the generated mirror workgroup size without hardcoding", () => {
    expect(GOD_RAYS_WORKGROUP_SIZE).toBe(8);
  });
});
