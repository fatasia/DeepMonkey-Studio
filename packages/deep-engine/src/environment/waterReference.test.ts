import { describe, expect, it } from "vitest";
import { compileGerstnerWaves, gerstnerSample, planarReflectionMatrix, schlickFresnel,
  transformByMatrix, waterFresnelZero } from "./waterReference.js";
import type { GerstnerWave } from "./waterReference.js";

describe("planarReflectionMatrix", () => {
  it("mirrors a point across the y=0 plane", () => {
    const matrix = planarReflectionMatrix([0, 1, 0], [0, 0, 0]);
    expect(transformByMatrix(matrix, [1, 2, 3], true)).toEqual([1, -2, 3]);
    expect(transformByMatrix(matrix, [5, -7, 0], true)).toEqual([5, 7, 0]);
  });
  it("mirrors across an offset plane (y = 2) keeping the plane fixed", () => {
    const matrix = planarReflectionMatrix([0, 1, 0], [10, 2, -3]);
    expect(transformByMatrix(matrix, [4, 5, 6], true)).toEqual([4, -1, 6]);
    // 平面上的点不动。
    expect(transformByMatrix(matrix, [-8, 2, 42], true)).toEqual([-8, 2, 42]);
  });
  it("double reflection is the identity and the linear part is orthogonal with determinant −1", () => {
    const normal = [1, 2, 3].map(value => value / Math.hypot(1, 2, 3)) as [number, number, number];
    const matrix = planarReflectionMatrix(normal, [1, -2, 0.5]);
    const twice = new Float64Array(16);
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        let sum = 0;
        for (let inner = 0; inner < 4; inner += 1) sum += matrix[inner * 4 + row] * matrix[column * 4 + inner];
        twice[column * 4 + row] = sum;
      }
    }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let index = 0; index < 16; index += 1) expect(twice[index]).toBeCloseTo(identity[index], 9);
    // 3×3 行列式(-1)与正交性。
    const [a, b, c, d, e, f, g, h, i] = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5],
      matrix[6], matrix[8], matrix[9], matrix[10]];
    const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    expect(determinant).toBeCloseTo(-1, 9);
    for (const column of [0, 1, 2]) {
      const norm = Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]);
      expect(norm).toBeCloseTo(1, 9);
    }
  });
  it("reflected view direction matches the analytic ray formula", () => {
    const matrix = planarReflectionMatrix([0, 1, 0], [0, 0, 0]);
    const view = [0.3, -0.4, -0.5].map(v => v / Math.hypot(0.3, 0.4, 0.5)) as [number, number, number];
    const viaMatrix = transformByMatrix(matrix, view, false);
    const dot = view[0] * 0 + view[1] * 1 + view[2] * 0;
    const analytic = [view[0], view[1] - 2 * dot, view[2]] as const;
    expect(viaMatrix[0]).toBeCloseTo(analytic[0], 15);
    expect(viaMatrix[1]).toBeCloseTo(analytic[1], 15);
    expect(viaMatrix[2]).toBeCloseTo(analytic[2], 15);
  });
  it("is an isometry for arbitrary points and rejects non-unit normals", () => {
    const normal = [0.5, 0.5, 0.7071067811865476].map(v => v / Math.hypot(0.5, 0.5, 0.7071067811865476)) as [number, number, number];
    const matrix = planarReflectionMatrix(normal, [2, -1, 3]);
    const point = [-4.2, 7.5, 1.1] as const;
    const mirrored = transformByMatrix(matrix, point, true);
    const roundTrip = transformByMatrix(matrix, mirrored, true);
    for (let axis = 0; axis < 3; axis += 1) expect(roundTrip[axis]).toBeCloseTo(point[axis], 9);
    expect(() => planarReflectionMatrix([0, 2, 0], [0, 0, 0])).toThrow(/unit/);
    expect(() => planarReflectionMatrix([0, Number.NaN, 0], [0, 0, 0])).toThrow(/unit/);
  });
});

const WAVES: readonly GerstnerWave[] = [
  { directionXZ: [1, 0.3], amplitude: 0.12, wavelength: 6, steepness: 0.35 },
  { directionXZ: [-0.4, 1], amplitude: 0.07, wavelength: 3.1, steepness: 0.25 },
  { directionXZ: [0.8, -0.6], amplitude: 0.04, wavelength: 1.7, steepness: 0.15 },
];

describe("gerstner waves", () => {
  it("compiles with cached scalars and rejects self-intersecting stacks", () => {
    const evaluation = compileGerstnerWaves(WAVES);
    expect(evaluation.waveNumbers[0]).toBeCloseTo(2 * Math.PI / 6, 12);
    expect(evaluation.angularFrequencies[0]).toBeCloseTo(Math.sqrt(9.81 * evaluation.waveNumbers[0]), 12);
    const looping: GerstnerWave[] = [{ directionXZ: [1, 0], amplitude: 4, wavelength: 1, steepness: 1 }];
    expect(() => compileGerstnerWaves(looping)).toThrow(/self-intersect/);
    expect(() => compileGerstnerWaves([{ ...WAVES[0], steepness: 1.5 }])).toThrow(/steepness/);
    expect(() => compileGerstnerWaves([{ ...WAVES[0], amplitude: 0 }])).toThrow(/amplitude/);
    expect(() => compileGerstnerWaves([{ ...WAVES[0], wavelength: 0 }])).toThrow(/wavelength/);
    expect(() => compileGerstnerWaves([{ ...WAVES[0], directionXZ: [0, 0] }])).toThrow(/direction/);
  });
  it("is bitwise deterministic for identical inputs and seeds", () => {
    const evaluation = compileGerstnerWaves(WAVES, 1234);
    const first = gerstnerSample(evaluation, WAVES, 3.3, -2.2, 1.5, 1234);
    const second = gerstnerSample(evaluation, WAVES, 3.3, -2.2, 1.5, 1234);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // 异 seed 相位偏移不同 → 位移不同。
    const other = gerstnerSample(compileGerstnerWaves(WAVES, 5678), WAVES, 3.3, -2.2, 1.5, 5678);
    expect(other.position[1]).not.toBe(first.position[1]);
  });
  it("is time-periodic through the wave period and bounded by the amplitude sum", () => {
    // 单波验证周期性(多波叠加仅在共同周期整体周期);显式 phaseOffset 消除 seed 相位。
    const single: GerstnerWave[] = [{ directionXZ: [1, 0], amplitude: 0.3, wavelength: 6, steepness: 0.2, phaseOffset: 0 }];
    const singleEvaluation = compileGerstnerWaves(single);
    const period = 2 * Math.PI / singleEvaluation.angularFrequencies[0];
    expect(gerstnerSample(singleEvaluation, single, 0.7, 1.9, period).position[1])
      .toBeCloseTo(gerstnerSample(singleEvaluation, single, 0.7, 1.9, 0).position[1], 9);
    const evaluation = compileGerstnerWaves(WAVES, 99);
    const amplitudeSum = WAVES.reduce((sum, wave) => sum + wave.amplitude, 0);
    for (let step = 0; step <= 40; step += 1) {
      const sample = gerstnerSample(evaluation, WAVES, 0.7, 1.9, step * 0.25);
      expect(Math.abs(sample.position[1])).toBeLessThanOrEqual(amplitudeSum + 1e-12);
      const normalLength = Math.hypot(...sample.normal);
      expect(normalLength).toBeCloseTo(1, 12);
    }
  });
  it("puts crests at quarter-wavelength phase with an explicit zero phase offset", () => {
    // λ=100 → k=2π/100;x=25 处 φ=k·x=π/2 → 波峰 +A;x=75 处 3π/2 → 波谷 −A。
    const single: GerstnerWave[] = [{ directionXZ: [1, 0], amplitude: 0.5, wavelength: 100, steepness: 0.01, phaseOffset: 0 }];
    const evaluation = compileGerstnerWaves(single);
    const crest = gerstnerSample(evaluation, single, 25, 0, 0);
    expect(crest.position[1]).toBeCloseTo(0.5, 9);
    expect(Math.abs(crest.normal[0])).toBeLessThan(0.02);
    const trough = gerstnerSample(evaluation, single, 75, 0, 0);
    expect(trough.position[1]).toBeCloseTo(-0.5, 9);
  });
});

describe("fresnel (Schlick, water F0)", () => {
  it("equals f0 at normal incidence and rises monotonically to 1 at grazing", () => {
    const f0 = waterFresnelZero();
    expect(f0).toBeCloseTo(0.0203732, 6); // ((1.333−1)/(1.333+1))² 精确值
    let previous = -1;
    for (const cos of [1, 0.9, 0.7, 0.5, 0.3, 0.1, 0.01, 0]) {
      const value = schlickFresnel(cos, f0);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
    expect(schlickFresnel(1, f0)).toBeCloseTo(f0, 12);
    expect(schlickFresnel(0, f0)).toBeCloseTo(1, 12);
  });
  it("rejects out-of-range inputs", () => {
    expect(() => schlickFresnel(1.5, 0.02)).toThrow(/cos/);
    expect(() => schlickFresnel(0.5, 1)).toThrow(/f0/);
    expect(() => waterFresnelZero(0.9)).toThrow(/refractive/);
  });
});
