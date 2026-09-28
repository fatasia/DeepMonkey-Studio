import { describe, expect, it } from "vitest";
import { defaultTestMedium, henyeyGreensteinPhase, rayMarchVolumetricFog } from "../fog/volumetricFog.js";
import { pbrFogFactor } from "../webgpu/pbrFog.js";
import { equivalentBeerExtinction, exp2FogFactor, heightFogTransmittance, multiScatterInscatter,
  uniformFogTransmittance, uniformInscatter } from "./fogReference.js";

const medium = defaultTestMedium(); // { baseExtinction 0.02, scaleHeight 8, anisotropy 0.3, albedo 0.8 }

describe("heightFogTransmittance (closed form)", () => {
  it("stays in [0,1] across an extreme parameter sweep", () => {
    for (const originY of [-50, 0, 2, 100]) {
      for (const directionY of [-1, -0.3, 0, 0.3, 1]) {
        for (const distance of [0, 0.001, 10, 1000, 1e6]) {
          const transmittance = heightFogTransmittance(originY, directionY, distance,
            { baseExtinction: 100, scaleHeight: 0.1 });
          expect(transmittance).toBeGreaterThanOrEqual(0);
          expect(transmittance).toBeLessThanOrEqual(1);
        }
      }
    }
  });
  it("is monotonically non-increasing in distance and exact at zero", () => {
    let previous = 1;
    for (const distance of [0, 5, 20, 80, 320, 1280]) {
      const transmittance = heightFogTransmittance(2, 0.3, distance, medium);
      expect(transmittance).toBeLessThanOrEqual(previous + 1e-15);
      previous = transmittance;
    }
    expect(heightFogTransmittance(2, 0.3, 0, medium)).toBe(1);
  });
  it("reproduces the horizontal uniform case as exp(−σd)", () => {
    const horizontal = heightFogTransmittance(0, 0, 250, medium);
    expect(horizontal).toBeCloseTo(Math.exp(-medium.baseExtinction * 250), 12);
  });
  it("matches a fine independent numerical integration (Simpson, ground-clamped density)", () => {
    // 独立复算:辛普森积分 σ(y),含 h<0 钳制段,作为闭式解的外部参照。
    const simpson = (originY: number, dy: number, distance: number, segments: number): number => {
      const h = distance / segments / 2;
      let total = 0;
      const density = (y: number): number => medium.baseExtinction * Math.exp(-Math.max(y, 0) / medium.scaleHeight);
      for (let index = 0; index <= segments * 2; index += 1) {
        const weight = index === 0 || index === segments * 2 ? 1 : index % 2 === 1 ? 4 : 2;
        total += weight * density(originY + dy * index * h);
      }
      return Math.exp(-total * h / 3);
    };
    for (const [originY, directionY, distance] of [[2, 0.5, 120], [5, -0.4, 90], [-3, 0.2, 150]] as const) {
      expect(heightFogTransmittance(originY, directionY, distance, medium))
        .toBeCloseTo(simpson(originY, directionY, distance, 4096), 4);
    }
  });
  it("rejects invalid inputs", () => {
    expect(() => heightFogTransmittance(Number.NaN, 0, 1, medium)).toThrow(/finite/);
    expect(() => heightFogTransmittance(0, 0, -1, medium)).toThrow(/nonnegative/);
  });
});

describe("consistency with the marching reference (fog/volumetricFog.ts)", () => {
  const light = { direction: [0.3, 0.8, -0.5] as const, radiance: [1, 1, 1] as const };
  const march = (steps: number): { transmittance: number; inscatter: readonly [number, number, number] } =>
    rayMarchVolumetricFog(medium, light, {
      rayOrigin: [0, 2, 0], rayDirection: [0.2, 0.3, -0.9], near: 0, far: 200, stepCount: steps,
      shadowAttenuation: () => 1,
    });
  it("closed form bounds the march; march error shrinks with step count", () => {
    const exact = heightFogTransmittance(2, 0.3 / Math.hypot(0.2, 0.3, 0.9), 200, medium);
    const coarse = march(32).transmittance;
    const fine = march(64).transmittance;
    const coarseError = Math.abs(coarse - exact);
    const fineError = Math.abs(fine - exact);
    expect(fineError).toBeLessThan(coarseError);
    expect(fineError / exact).toBeLessThan(0.02); // 中点采样 O(h²):64 步相对误差 < 2%
  });
  it("phase-normalized inscatter matches the uniform closed form for flat rays", () => {
    // 水平射线 + 均匀域时 march 的内散射应逼近闭式 Le·albedo·P·(1−T)。
    const flat = rayMarchVolumetricFog(
      { ...medium, anisotropy: 0 }, light,
      { rayOrigin: [0, 0, 0], rayDirection: [0, 0, -1], near: 0, far: 400, stepCount: 64, shadowAttenuation: () => 1 });
    const exactTransmittance = uniformFogTransmittance(medium.baseExtinction, 400);
    const cosTheta = (0 * 0.3 + 0 * 0.8 + (-1) * -0.5) / Math.hypot(0.3, 0.8, 0.5);
    const expected = uniformInscatter(1, medium.albedo, henyeyGreensteinPhase(cosTheta, 0), exactTransmittance);
    expect(flat.inscatter[0]).toBeCloseTo(expected, 2);
    expect(flat.transmittance).toBeCloseTo(exactTransmittance, 2);
  });
});

describe("consistency with the HDR composite contract (webgpu/pbrFog.ts)", () => {
  it("volumetric kind is the exact complement of uniform transmittance", () => {
    for (const [extinction, depth] of [[0.02, 100], [0.5, 7], [1e-6, 3e5]] as const) {
      const factor = pbrFogFactor({ kind: "volumetric", color: [1, 1, 1], density: extinction }, depth);
      expect(factor).toBeCloseTo(1 - uniformFogTransmittance(extinction, depth), 12);
    }
  });
  it("exp2 kind is density-squared (Three r185 semantics) and matches exp2FogFactor exactly", () => {
    for (const [density, depth] of [[0.018, 100], [0.0018, 555.5], [0.012, 10]] as const) {
      expect(exp2FogFactor(density, depth)).toBe(pbrFogFactor({ kind: "exp2", color: [1, 1, 1], density }, depth));
    }
    // 两种口径的差异实证:同 depth 下 exp2(density²) 消光更陡。
    expect(exp2FogFactor(0.018, 100)).toBeGreaterThan(1 - uniformFogTransmittance(0.018, 100));
  });
  it("contract exp2 density converts to an equivalent Beer extinction at a reference depth", () => {
    const equivalent = equivalentBeerExtinction(0.018, 100); // σ = ρ²·x₀ = 0.0324 /m
    expect(equivalent).toBeCloseTo(0.0324, 12);
    // 等透射性:参考深度处两种口径的透射率相等。
    expect(uniformFogTransmittance(equivalent, 100)).toBeCloseTo(1 - exp2FogFactor(0.018, 100), 12);
  });
});

describe("energy conservation", () => {
  const phase = henyeyGreensteinPhase(0.6, 0.3);
  it("transmittance never exceeds 1 and inscatter is zero when there is no fog", () => {
    expect(uniformFogTransmittance(0, 1e9)).toBe(1);
    expect(uniformInscatter(1, 0.9, phase, 1)).toBe(0);
  });
  it("multi-scatter octaves never exceed the single-scatter energy budget P·albedo", () => {
    for (const contribution of [0.3, 0.5, 0.7, 0.9]) {
      for (const octaves of [1, 2, 4, 8]) {
        for (const transmittance of [0, 0.01, 0.2, 0.5, 0.9, 0.999]) {
          const multi = multiScatterInscatter(1, 1, phase, transmittance, octaves, contribution);
          expect(multi).toBeLessThanOrEqual(phase * 1 + 1e-12);
        }
      }
    }
  });
  it("normalized allocation is necessary: the naive a^i sum can exceed the budget", () => {
    // 误实现:直接叠加 aⁱ·(1−T^{2i+1})(不乘 (1−a))。a=0.9、T→0(浓雾)时
    // Σaⁱ = 1/(1−a) = 10 ≫ 1,直接突破 P·albedo 预算;归一化版恒 ≤ 1。
    const naive = Array.from({ length: 8 }, (_, octave) => octave)
      .reduce((sum, octave) => sum + 0.9 ** octave * (1 - 0.05 ** (2 * octave + 1)), 0);
    const normalized = multiScatterInscatter(1, 1, phase, 0.05, 8, 0.9) / phase;
    expect(naive).toBeGreaterThan(1); // 反例成立:未归一化确实增亮
    expect(normalized).toBeLessThanOrEqual(1 + 1e-12);
  });
  it("one octave carries the (1−a) share; more octaves approach the budget from below", () => {
    const single = uniformInscatter(1, 0.9, phase, 0.5);
    expect(multiScatterInscatter(1, 0.9, phase, 0.5, 1, 0.5)).toBeCloseTo(0.5 * single, 12);
    const many = multiScatterInscatter(1, 0.9, phase, 0.5, 8, 0.5) / phase;
    expect(many).toBeGreaterThan(0); // 多八度单调增能(仍在预算内)
    expect(many).toBeLessThanOrEqual(1 + 1e-12);
  });
});
