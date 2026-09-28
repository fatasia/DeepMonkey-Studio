import { describe, expect, it } from "vitest";
import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "./probeClipmapSampling.js";
import { computeProbeRelocation } from "./probeRelocation.js";
import { evaluateProbeRadianceEngineParity, integrateProbeReference } from "./probeReferenceIntegrator.js";
import { buildReferenceRoomScene, referenceSceneDiagonal,
  referenceThinWallBoxes } from "./probeReferenceScene.js";

// T02 墙内探针验证：埋入判定（relocation 语义）+ 穿墙亮斑的 CPU 级证明——
// 引擎口径（无阴影射线）下墙内探针的射线刺穿 0.1 薄墙取到亮面 → 亮斑伪源；
// 「埋入 → validity 0 拒绝贡献」策略把朝墙接收点的污染从 0.0625 降到 0（vs shadowed 真值）。
const scene = buildReferenceRoomScene();
const GRID = [7, 2, 5] as const;
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const linearIndexOf = (position: ProbeVector3): number =>
  ((position[2] - 1) * GRID[1] + (position[1] - 1)) * GRID[0] + (position[0] - 1);
const engine = positions.map(position => evaluateProbeRadianceEngineParity(scene, position, 8));
const buried = positions.map((_, index) => index)
  .filter(index => engine[index]!.missRatio === 0 && engine[index]!.meanDistance <= 0.2);
const thinWalls = referenceThinWallBoxes(scene);
const LEVEL = { level: 0, gridSize: [7, 2, 5], spacing: 1, originCell: [0, 0, 0],
  origin: [1, 1, 1], max: [7, 2, 5], probeCount: 70 } as const;

const recordsFor = (rejectBuried: boolean, blind: boolean): (IrradianceProbeRecord | undefined)[] =>
  engine.map((sample, index) => {
    const isBuried = buried.includes(index);
    return { irradiance: sample.irradiance, validity: isBuried && rejectBuried ? 0 : 1,
      meanDistance: blind ? referenceSceneDiagonal(scene) : sample.meanDistance,
      distanceVariance: blind ? 1e-4 : Math.max(sample.distanceVariance, 1e-4), occlusionFloor: 0 };
  });
const sampleAt = (position: ProbeVector3, normal: ProbeVector3,
  records: (IrradianceProbeRecord | undefined)[]): ProbeVector3 =>
  sampleIrradianceProbeClipmap({ worldPosition: position, worldNormal: normal,
    levels: [LEVEL], records }).irradiance;

describe("buried probe detection (relocation semantics)", () => {
  it("flags exactly the thin-wall probes, not the doorway column", () => {
    expect(buried).toHaveLength(8);
    for (const index of buried) {
      expect(positions[index]![0]).toBe(4);
      expect(positions[index]![2]).not.toBe(3); // 门洞列不埋入
    }
    for (const y of [1, 2]) {
      const doorway = linearIndexOf([4, y, 3]);
      expect(buried).not.toContain(doorway);
    }
  });

  it("escapes buried probes along the thin axis and is idempotent for safe probes", () => {
    for (const index of buried) {
      const offset = computeProbeRelocation({ cellPosition: positions[index]!, spacing: 1,
        obstacles: thinWalls, maxOffset: 0.5, margin: 0.2 });
      expect(offset[0]).toBeCloseTo(0.25, 6); // 沿最薄轴 +x 逸出（0.05 厚 + 0.2 margin）
      expect(offset[1]).toBe(0);
      expect(offset[2]).toBe(0);
      const escaped = computeProbeRelocation({
        cellPosition: [positions[index]![0] + offset[0]!, positions[index]![1] + offset[1]!,
          positions[index]![2] + offset[2]!] as ProbeVector3,
        spacing: 1, obstacles: thinWalls, maxOffset: 0.5, margin: 0.2 });
      expect(escaped).toEqual([0, 0, 0]);
    }
    const safe = computeProbeRelocation({ cellPosition: [2, 1, 3], spacing: 1,
      obstacles: thinWalls, maxOffset: 0.5, margin: 0.2 });
    expect(safe).toEqual([0, 0, 0]);
  });
});

describe("through-wall bright-spot rejection (CPU proof)", () => {
  // shadowed 真值口径：墙区应为暗；引擎口径的埋入探针因刺穿薄墙而偏亮 = 亮斑伪源。
  const truth = positions.map(position =>
    integrateProbeReference(scene, position, { sampleCount: 2048, seed: 99, shadowed: true }).irradiance);
  // 朝墙接收点：x∈{4.4,4.8}（三线性模板含埋入列）、法线 -x，z 取薄墙各列。
  const receivers: { position: ProbeVector3; normal: ProbeVector3 }[] = [];
  for (const x of [4.4, 4.8]) for (const z of [1.5, 2, 4, 4.5]) {
    receivers.push({ position: [x, 1, z], normal: [-1, 0, 0] });
  }
  const errors = (rejectBuried: boolean, blind: boolean): number[] =>
    receivers.map(({ position, normal }) => {
      const sampled = sampleAt(position, normal, recordsFor(rejectBuried, blind));
      const truthAt = truth[linearIndexOf([Math.round(position[0]), position[1], Math.round(position[2])])];
      return Math.abs(sampled[0]! - truthAt![0]!);
    });

  it("carries bright through-wall contamination from wall-interior probes when admitted", () => {
    const base = errors(false, true);
    const meanBase = base.reduce((sum, value) => sum + value, 0) / base.length;
    expect(meanBase).toBeGreaterThan(0.03); // 实测 0.0623：明显亮斑污染（真值 ≈ 0）。
  });

  it("drops the contamination to reference level once wall-interior probes are rejected", () => {
    const base = errors(false, true), policy = errors(true, false);
    const meanBase = base.reduce((sum, value) => sum + value, 0) / base.length;
    const meanPolicy = policy.reduce((sum, value) => sum + value, 0) / policy.length;
    expect(meanPolicy).toBeLessThan(0.005); // 实测 0.0002。
    expect(meanPolicy).toBeLessThan(meanBase / 10); // 消除 ≥ 一个数量级。
    for (let index = 0; index < base.length; index++) {
      expect(policy[index]!).toBeLessThan(base[index]! + 1e-9);
    }
  });

  it("leaves facing-away receivers untouched: normal weights already reject buried probes", () => {
    for (const z of [1.5, 2, 4, 4.5]) {
      const position: ProbeVector3 = [4.4, 1, z];
      const base = sampleAt(position, [1, 0, 0], recordsFor(false, true));
      const policy = sampleAt(position, [1, 0, 0], recordsFor(true, false));
      expect(policy).toEqual(base); // 背墙时法线权重已把埋入探针清零，策略不改变结果。
    }
  });

  it("keeps the shadowed truth dark at the wall region (contrast sanity)", () => {
    for (const index of buried) {
      expect(truth[index]![0]).toBeLessThan(0.02); // 墙内真值近零（实测 < 0.02）。
    }
  });
});
