import { describe, expect, it } from "vitest";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "./probeClipmapSampling.js";
import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { evaluateProbeRadianceEngineParity, integrateProbeReference } from "./probeReferenceIntegrator.js";
import { buildReferenceRoomScene, referenceSceneDiagonal } from "./probeReferenceScene.js";
import { assembleLeakMatrixRow, buildWallLeakReceivers, facingAwayMaxDelta,
  LEAK_MATRIX_DIRECTION_COUNTS, LEAK_POLLUTION_GATE, LEAK_PREFIX_POLLUTION_FLOOR,
  LEAK_REDUCTION_FACTOR_GATE, meanFacingWallRedError, probeIndexForReceiver,
  referenceLitScaleIR, summarizeLeakMatrix } from "./probeLeakDirectionMatrix.js";

// F5 漏光 × 方向数矩阵（CPU 确定性证据）：把 T02/G3-S1 时代口径分裂的污染测量
// （CPU slab fib8 0.0623 / GPU 存储注入 fib16 0.0582 / GPU 纹理 fib32 0.000214）
// 统一成**同口径**的 8/16/32 对照。两条结论在本文件钉死：
// ① 穿墙亮斑污染源在任一方向档都在场（~31–33% 亮室尺度）——方向数不消除漏光；
// ② validity 拒绝策略在任一方向档都把污染压到 shadowed 真值地板（0.000214）——
//    漏光消除由策略承载、对方向档鲁棒；32 方向改善的是方向采样 RMSE（正交质量轴）。
const scene = buildReferenceRoomScene();
const GRID = [7, 2, 5] as const;
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const linearIndexOf = (position: ProbeVector3): number =>
  ((position[2] - 1) * GRID[1] + (position[1] - 1)) * GRID[0] + (position[0] - 1);
const engine8 = positions.map(position => evaluateProbeRadianceEngineParity(scene, position, 8));
const buried = positions.map((_, index) => index)
  .filter(index => engine8[index]!.missRatio === 0 && engine8[index]!.meanDistance <= 0.2);
const receivers = buildWallLeakReceivers();
const truth = positions.map(position =>
  integrateProbeReference(scene, position, { sampleCount: 2048, seed: 99, shadowed: true }).irradiance);
const truthRed = receivers.map(receiver => truth[probeIndexForReceiver(receiver, positions)]![0]!);
const LEVEL = { level: 0, gridSize: [7, 2, 5], spacing: 1, originCell: [0, 0, 0],
  origin: [1, 1, 1], max: [7, 2, 5], probeCount: 70 } as const;
const litScale = referenceLitScaleIR(positions.map((_, index) => index)
  .filter(index => !buried.includes(index)).map(index => engine8[index]!.irradiance[0]!));

const sampleAll = (records: readonly (IrradianceProbeRecord | undefined)[]): ProbeVector3[] =>
  receivers.map(({ position, normal }) =>
    sampleIrradianceProbeClipmap({ worldPosition: position, worldNormal: normal, levels: [LEVEL], records }).irradiance);

// 反事实：埋入亮源（引擎口径刺穿薄墙的真实辐射）+ validity=1 + 盲距离（无可见性惩罚）。
// 策略现实：生产语义——埋入 RGB 由 producer 清零 + validity=0 + 真实距离统计。
const recordsFor = (count: number, policy: boolean): IrradianceProbeRecord[] => {
  const engine = positions.map(position => evaluateProbeRadianceEngineParity(scene, position, count));
  return engine.map((sample, index) => policy && buried.includes(index)
    ? { irradiance: [0, 0, 0], validity: 0, meanDistance: sample.meanDistance,
      distanceVariance: Math.max(sample.distanceVariance, 1e-4), occlusionFloor: 0 }
    : { irradiance: sample.irradiance, validity: 1,
      meanDistance: policy ? sample.meanDistance : referenceSceneDiagonal(scene),
      distanceVariance: policy ? Math.max(sample.distanceVariance, 1e-4) : 1e-4, occlusionFloor: 0 });
};
const rows = LEAK_MATRIX_DIRECTION_COUNTS.map(count => {
  const preFixSampled = sampleAll(recordsFor(count, false));
  const policySampled = sampleAll(recordsFor(count, true));
  return assembleLeakMatrixRow({ directionCount: count, preFixSampled, policySampled,
    truthRedByReceiver: truthRed, litScale, receivers });
});
const summary = summarizeLeakMatrix(rows);

describe("receiver & metric contracts (shared with the real-machine matrix script)", () => {
  it("builds the 16-point wall receiver set with t02 parity: even index faces the wall", () => {
    expect(receivers).toHaveLength(16);
    receivers.forEach((receiver, index) => {
      expect(receiver.facesWall).toBe(index % 2 === 0);
      expect(receiver.normal[0]).toBe(receiver.facesWall ? -1 : 1);
    });
    expect(receivers.filter(receiver => receiver.facesWall)).toHaveLength(8);
  });

  it("maps each receiver to its grid probe and rejects unmatched receivers", () => {
    expect(probeIndexForReceiver(receivers[0]!, positions)).toBe(linearIndexOf([4, 1, 2]));
    const stray: typeof receivers[number] = { position: [99, 1, 1], normal: [-1, 0, 0], facesWall: true };
    expect(() => probeIndexForReceiver(stray, positions)).toThrow(/no matching grid probe/);
  });

  it("keeps gate constants tied to the T02 evidence semantics", () => {
    expect([...LEAK_MATRIX_DIRECTION_COUNTS]).toEqual([8, 16, 32]);
    expect(LEAK_POLLUTION_GATE).toBe(0.005);
    expect(LEAK_REDUCTION_FACTOR_GATE).toBe(10);
    expect(LEAK_PREFIX_POLLUTION_FLOOR).toBe(0.03);
  });

  it("computes the pollution metric over facing-wall receivers only and enforces alignment", () => {
    const sampled: ProbeVector3[] = receivers.map((_, index) => [index, 0, 0]);
    const truthOnes = receivers.map(() => 0);
    // 朝墙 8 点（偶数下标 0..14）误差 = index，均值 = (0+2+…+14)/8 = 7；背墙点不计入。
    expect(meanFacingWallRedError(sampled, truthOnes, receivers)).toBeCloseTo(7, 6);
    expect(() => meanFacingWallRedError(sampled.slice(1), truthOnes, receivers)).toThrow(/index-aligned/);
    expect(() => facingAwayMaxDelta(sampled, sampled, receivers.slice(1))).toThrow(/aligned/);
  });

  it("normalizes leak rates against a positive lit scale and rejects degenerate scales", () => {
    expect(referenceLitScaleIR([0.1903])).toBeCloseTo(0.1903, 9);
    expect(() => referenceLitScaleIR([])).toThrow(/at least one stable probe/);
    expect(() => referenceLitScaleIR([0, -1])).toThrow(/positive and finite/);
  });
});

describe("wall leak × direction matrix (CPU, fib8/16/32 same-semantics comparison)", () => {
  it("produces one aligned row per direction count with finite metrics", () => {
    expect(rows.map(row => row.directionCount)).toEqual([8, 16, 32]);
    for (const row of rows) {
      for (const value of [row.preFixMeanError, row.policyMeanError, row.preFixLeakRate,
        row.policyLeakRate, row.reductionFactor, row.facingAwayMaxDelta]) {
        expect(Number.isFinite(value) || value === Number.POSITIVE_INFINITY).toBe(true);
      }
    }
  });

  it("keeps the through-wall bright source present at every direction count", () => {
    // 实测 0.05822 / 0.06229 / 0.06270：方向密度不消除、也不显著减轻刺穿薄墙的亮斑伪源。
    for (const row of rows) {
      expect(row.preFixMeanError).toBeGreaterThan(LEAK_PREFIX_POLLUTION_FLOOR);
      expect(row.preFixLeakRate).toBeGreaterThan(0.25);
      expect(row.preFixLeakRate).toBeLessThan(0.40);
    }
  });

  it("pins the buried-source brightness into a count-robust band (motivates the policy)", () => {
    const brightness = LEAK_MATRIX_DIRECTION_COUNTS.map(count => {
      const engine = positions.map(position => evaluateProbeRadianceEngineParity(scene, position, count));
      const values = buried.map(index => engine[index]!.irradiance[0]!);
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    });
    for (const value of brightness) {
      expect(value).toBeGreaterThan(0.05);
      expect(value).toBeLessThan(0.08);
    }
  });

  it("drops pollution to the shadowed-truth floor under the validity policy at every count", () => {
    // 实测三档同为 0.00021362（= 墙区 shadowed 真值本身：采样≈0，误差即真值地板）。
    for (const row of rows) {
      expect(row.policyMeanError).toBeLessThanOrEqual(LEAK_POLLUTION_GATE);
      expect(row.policyMeanError).toBeLessThan(0.001);
      expect(row.policyLeakRate).toBeLessThan(0.002);
    }
  });

  it("compresses pollution by more than an order of magnitude at every count", () => {
    // 实测 291.6× / 272.6× / 293.5×。
    for (const row of rows) {
      expect(row.reductionFactor).toBeGreaterThanOrEqual(LEAK_REDUCTION_FACTOR_GATE);
      expect(row.reductionFactor).toBeGreaterThan(100);
    }
  });

  it("leaves facing-away receivers bit-identical between the two policies", () => {
    for (const row of rows) {
      expect(row.facingAwayMaxDelta).toBeLessThanOrEqual(1e-9);
    }
  });

  it("keeps policy metrics count-invariant: the floor is the truth, not the direction set", () => {
    const policyErrors = rows.map(row => row.policyMeanError);
    expect(Math.max(...policyErrors) - Math.min(...policyErrors)).toBeLessThan(1e-12);
    // 地板 = 8 个朝墙接收点 shadowed 真值的均值（采样≈0 时误差即真值本身）。
    const meanWallTruth = truthRed.reduce((sum, value, index) =>
      receivers[index]!.facesWall ? sum + value : sum, 0)
      / receivers.filter(receiver => receiver.facesWall).length;
    expect(policyErrors[0]!).toBeCloseTo(meanWallTruth, 9);
  });

  it("summarizes the matrix as direction-gate robust on all four judgements", () => {
    expect(summary.preFixPollutionAtAllCounts).toBe(true);
    expect(summary.policyWithinGateAtAllCounts).toBe(true);
    expect(summary.reductionAtEveryCount).toBe(true);
    expect(summary.facingAwayUntouched).toBe(true);
    expect(summary.maxPolicyMeanError).toBeCloseTo(0.000213623046875, 12);
    expect(summary.maxPolicyLeakRate).toBeLessThan(0.002);
  });
});
