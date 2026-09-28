import { describe, expect, it } from "vitest";
import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { evaluateProbeRadianceEngineParity, integrateProbeReference,
  normalizedProbeFieldRmse } from "./probeReferenceIntegrator.js";
import { buildReferenceRoomScene, referenceSceneDiagonal,
  referenceThinWallBoxes } from "./probeReferenceScene.js";

// T02 验收分母：房间+薄墙+门洞+天窗场景的高采样 CPU 参考积分与方向预算收敛数据。
// 探针网格 x∈[1,7]×y∈[1,2]×z∈[1,5]（间距 1，x=4 列穿过薄墙），共 70 探针。
const scene = buildReferenceRoomScene();
const GRID = [7, 2, 5] as const;
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const linearIndexOf = (position: ProbeVector3): number =>
  ((position[2] - 1) * GRID[1] + (position[1] - 1)) * GRID[0] + (position[0] - 1);
const inThinWall = (position: ProbeVector3): boolean =>
  position[0] > 3.95 && position[0] < 4.05 && !(position[2] > 2.5 && position[2] < 3.5);
const buriedIndices = positions.filter(inThinWall).map(linearIndexOf).sort((left, right) => left - right);
const includeStable = (index: number): boolean => !buriedIndices.includes(index);

describe("probe reference scene", () => {
  it("detects wall-interior probes via occlusion statistics (miss=0, tiny mean distance)", () => {
    const tMax = referenceSceneDiagonal(scene);
    const detected: number[] = [];
    positions.forEach((position, index) => {
      const sample = evaluateProbeRadianceEngineParity(scene, position, 8);
      const buried = sample.missRatio === 0 && sample.meanDistance <= 0.2;
      if (buried) detected.push(index);
    });
    expect(detected.sort((left, right) => left - right)).toEqual(buriedIndices);
    expect(buriedIndices).toHaveLength(8);
    // 门洞列 (x=4, z=3) 在开阔门洞里，不属于埋入。
    for (const y of [1, 2]) {
      expect(inThinWall([4, y, 3])).toBe(false);
    }
    expect(referenceThinWallBoxes(scene)).toHaveLength(3);
  });
});

describe("probe reference integrator determinism", () => {
  it("produces bitwise-identical references for a fixed seed and reacts to seed changes", () => {
    const first = integrateProbeReference(scene, [2, 1, 2], { sampleCount: 1024, seed: 5 });
    const second = integrateProbeReference(scene, [2, 1, 2], { sampleCount: 1024, seed: 5 });
    expect(second.irradiance).toEqual(first.irradiance);
    expect(second.meanDistance).toBe(first.meanDistance);
    expect(second.halfSplitZ).toBe(first.halfSplitZ);
    const other = integrateProbeReference(scene, [2, 1, 2], { sampleCount: 1024, seed: 6 });
    expect(other.irradiance).not.toEqual(first.irradiance);
  });
});

describe("stable-region normalized RMSE vs high-sampling reference", () => {
  const references = positions.map(position =>
    integrateProbeReference(scene, position, { sampleCount: 4096, seed: 20260927 }));
  const rmseFor = (directionCount: number): number =>
    normalizedProbeFieldRmse(
      positions.map(position => evaluateProbeRadianceEngineParity(scene, position, directionCount).irradiance),
      references.map(reference => reference.irradiance), includeStable).normalizedRmse;

  it("keeps every non-buried probe statistically stable at 4096 samples", () => {
    const unstable = references.filter(reference => !reference.stable);
    expect(unstable).toHaveLength(0);
  });

  it("documents the engine direction budget: 32 directions reach RMSE<=10%, 8 do not", () => {
    const fib8 = rmseFor(8), fib16 = rmseFor(16), fib32 = rmseFor(32), fib1024 = rmseFor(1024);
    // 数据（seed 20260927）：fib8 22.35%、fib16 11.64%、fib32 8.06%、fib1024 0.67%。
    expect(fib8).toBeGreaterThan(0.10);
    expect(fib16).toBeGreaterThan(0.10); // 现行 producer 上限 16 方向：临界不足（联测确认）。
    expect(fib32).toBeLessThanOrEqual(0.10); // 验收容差档：≥32 方向/探针。
    expect(fib1024).toBeLessThan(0.02); // 参考积分自收敛。
    expect(fib32).toBeLessThan(fib8);
  });
});
