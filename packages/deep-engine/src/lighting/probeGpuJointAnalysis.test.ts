import { describe, expect, it } from "vitest";
import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { packProbeRadianceUniform } from "../rayTracing/probeRadianceKernel.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import { analyzeProbeFieldDeviation, budgetRecoverySchedule,
  packProbeRadianceUniformWithCapacity, PRODUCER_SHADING_PI_SCALE } from "./probeGpuJointAnalysis.js";

const baseInput = (directionCount: number) => ({
  updateCount: 70, directionCount, rayMask: 1, tMax: 11.09,
  surfaceToLight: [0.2, 0.9798, 0.1] as const,
  lightColor: [1, 1, 1] as const,
  lightIntensity: PRODUCER_SHADING_PI_SCALE,
  ambient: [0.0628, 0.0628, 0.0785] as const,
  directions: Array.from({ length: directionCount }, (_, ordinal) =>
    probeOcclusionDirection(ordinal, directionCount) as [number, number, number]),
});

describe("packProbeRadianceUniformWithCapacity", () => {
  it("preserves the first 16 production lanes at legacy capacity 16", () => {
    const production = new Uint8Array(packProbeRadianceUniform(baseInput(16)));
    const variant = new Uint8Array(packProbeRadianceUniformWithCapacity(baseInput(16), 16));
    expect(variant.byteLength).toBe(320);
    expect(variant).toEqual(production.slice(0, variant.byteLength));
  });

  it("is byte-identical to the production packer at capacity 32", () => {
    const production = new Uint8Array(packProbeRadianceUniform(baseInput(32)));
    const variant = new Uint8Array(packProbeRadianceUniformWithCapacity(baseInput(32), 32));
    expect(variant).toEqual(production);
  });

  it("mirrors the production layout fields for a 32-direction table (576B)", () => {
    const data = new Float32Array(packProbeRadianceUniformWithCapacity(baseInput(32), 32));
    const words = new Uint32Array(data.buffer);
    expect(words[0]).toBe(70);
    expect(words[1]).toBe(32);
    expect(words[2]).toBe(1);
    expect(data.buffer.byteLength).toBe(4 * 4 + 4 * 4 * 3 + 32 * 4 * 4);
    expect(data[3]).toBeCloseTo(11.09, 6);
    expect(data[7]).toBeCloseTo(PRODUCER_SHADING_PI_SCALE, 6);
    for (let ordinal = 0; ordinal < 32; ordinal++) {
      const direction = probeOcclusionDirection(ordinal, 32);
      const base = 16 + ordinal * 4;
      // uniform 是 f32 表（f64 方向量化到 f32，~7 位有效数字）。
      expect(data[base]).toBeCloseTo(direction[0], 6);
      expect(data[base + 1]).toBeCloseTo(direction[1], 6);
      expect(data[base + 2]).toBeCloseTo(direction[2], 6);
      expect(data[base + 3]).toBe(0);
    }
  });

  it("rejects direction counts beyond capacity", () => {
    expect(() => packProbeRadianceUniformWithCapacity(baseInput(16), 8)).toThrow(RangeError);
    expect(() => packProbeRadianceUniformWithCapacity(baseInput(16), 0)).toThrow(RangeError);
  });
});

describe("analyzeProbeFieldDeviation", () => {
  const references: ProbeVector3[] = [[0.2, 0, 0], [0.2, 0, 0], [0.4, 0, 0], [0.1, 0, 0]];
  const estimates: ProbeVector3[] = [[0.1, 0, 0], [0.3, 0, 0], [0.5, 0, 0], [9, 9, 9]];
  const include = (index: number): boolean => index !== 3;

  it("computes signed bias, relative distribution, and worst offenders on the include set", () => {
    const stats = analyzeProbeFieldDeviation(estimates, references, include);
    expect(stats.probeCount).toBe(3);
    // 只对参与统计的 3 个探针平均：(-0.1 + 0.1 + 0.1) / 3。
    expect(stats.meanSignedDelta[0]).toBeCloseTo(0.1 / 3, 12);
    expect(stats.meanAbsDelta).toBeCloseTo(0.1, 12);
    expect(stats.meanSignedDelta[1]).toBe(0);
    // 相对误差：0.1/0.2=0.5, 0.1/0.2=0.5, 0.1/0.4=0.25 → 中位 0.5, 最大 0.5。
    expect(stats.medianRelative).toBeCloseTo(0.5, 12);
    expect(stats.maxRelative).toBeCloseTo(0.5, 12);
    expect(stats.worst[0]!.relative).toBeCloseTo(0.5, 12);
    expect(stats.worst.every(entry => entry.index !== 3)).toBe(true);
    // normalizedRmse 只取 include 集（复用 computeNormalizedFieldRmse 语义）。
    const squareMean = (0.1 ** 2 + 0.1 ** 2 + 0.1 ** 2) / 3;
    const referenceMean = (0.2 + 0.2 + 0.4) / 3;
    expect(stats.normalizedRmse).toBeCloseTo(Math.sqrt(squareMean) / referenceMean, 12);
  });

  it("rejects mismatched or invalid vectors", () => {
    expect(() => analyzeProbeFieldDeviation(estimates.slice(1), references, include)).toThrow(RangeError);
    expect(() => analyzeProbeFieldDeviation([[Number.NaN, 0, 0]] as ProbeVector3[],
      [[0.1, 0, 0]], () => true)).toThrow(RangeError);
  });
});

describe("budgetRecoverySchedule", () => {
  const positions: ProbeVector3[] = [
    [0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0], [3, 0, 0], [1, 1, 0]];
  const camera: ProbeVector3 = [2, 0, 0];

  it("orders dirty probes by distance to the camera and chunks by budget", () => {
    const schedule = budgetRecoverySchedule(positions, [0, 1, 2, 3, 4, 5], camera, 2);
    expect(schedule[0]).toEqual([2, 1]);
    expect(schedule.flat()).toHaveLength(6);
    expect(new Set(schedule.flat()).size).toBe(6);
    // 手工核对排序：距离 [2]=0、[1]=[4]=1（下标序）、[5]=2、[0]=4、[3]=5。
    expect(schedule.flat()).toEqual([2, 1, 4, 5, 0, 3]);
  });

  it("keeps the scheduler tie-break: equal distance resolves by ascending index", () => {
    const flat = budgetRecoverySchedule(positions, [0, 1, 4], camera, 3).flat();
    expect(flat).toEqual([1, 4, 0]); // [1] 与 [4] 同距 1 → 下标序；[0] 距 4 最后。
  });

  it("rejects invalid budgets and out-of-range dirty indices", () => {
    expect(() => budgetRecoverySchedule(positions, [0], camera, 0)).toThrow(RangeError);
    expect(() => budgetRecoverySchedule(positions, [positions.length], camera, 2)).toThrow(RangeError);
    expect(() => budgetRecoverySchedule(positions, [-1], camera, 2)).toThrow(RangeError);
  });
});
