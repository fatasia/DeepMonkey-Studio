import { describe, expect, it } from "vitest";
import { bakeSdfSceneGrid, createSdfSceneBakeCache, MAX_SDF_SCENE_BAKE_AXIS,
  MAX_SDF_SCENE_BAKE_TRIANGLES, type SdfSceneBakeInstance } from "./sdfSceneBake.js";
import { sampleSdfGrid } from "../physics/sdfGrid.js";
import { MAX_SDF_PROFILE_GRID_CELLS } from "../physics/sdfCollisionProfile.js";

function boxMesh(min: readonly number[], max: readonly number[]): SdfSceneBakeInstance["mesh"] {
  return {
    positions: Float32Array.from([
      min[0], min[1], min[2], max[0], min[1], min[2], max[0], max[1], min[2], min[0], max[1], min[2],
      min[0], min[1], max[2], max[0], min[1], max[2], max[0], max[1], max[2], min[0], max[1], max[2],
    ]),
    indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]),
  };
}

const box = (min: readonly number[], max: readonly number[], id: string,
  dynamic = false): SdfSceneBakeInstance => ({ id, dynamic, mesh: boxMesh(min, max) });

describe("Brief-GI M1 场景级 SDF 烘焙", () => {
  it("单盒烘焙:SDF 符号与距离正确(trilinear 采样 vs 解析盒距离,scene 域全覆盖)", () => {
    const { grid, report } = bakeSdfSceneGrid([box([1, 0, 1], [3, 2, 3], "solo")], {
      cellSize: 0.2,
      bounds: { min: [0.4, -0.4, 0.4], max: [3.6, 3, 3.4] },
      instanceDomain: "scene",
    });
    expect(report.bakedCount).toBe(1);
    expect(report.excludedDynamicCount).toBe(0);
    expect(report.instances.every(instance => instance.status === "baked")).toBe(true);
    const tolerance = grid.maxSamplingError + 1e-4;
    const probes: [readonly [number, number, number], number][] = [
      [[2, 1, 2], -1],           // 盒心:内部为负
      [[1.5, 1, 2], -0.5],
      [[3.6, 1, 2], 0.6],        // 外部为正(域边界圈)
      [[2, 2.8, 2], 0.8],
    ];
    for (const [point, expected] of probes) {
      const sampled = sampleSdfGrid(grid, point);
      expect(Math.abs(sampled - expected)).toBeLessThanOrEqual(tolerance);
    }
    // 场永不含非有限值:
    expect(grid.distances.every(Number.isFinite)).toBe(true);
  });

  it("aabb 域:几何邻域精确,多资产未覆盖空域保持 exterior(有界近似,如实)", () => {
    const { grid } = bakeSdfSceneGrid([box([1, 0, 1], [3, 2, 3], "solo")], {
      cellSize: 0.2, bounds: { min: [0.4, -0.4, 0.4], max: [3.6, 3, 3.4] } });
    const tolerance = grid.maxSamplingError + 1e-4;
    expect(Math.abs(sampleSdfGrid(grid, [2, 1, 2]) + 1)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(sampleSdfGrid(grid, [3.2, 1, 2]) - 0.2)).toBeLessThanOrEqual(tolerance);
    // AABB ±1 cell 之外的空域:exterior 有界值(非度量距离,近似语义):
    expect(sampleSdfGrid(grid, [3.6, 1, 2])).toBeCloseTo(5.549774646759033, 3);
  });

  it("min 合成 = 闭体并集:两盒之间与内部均为负,域外为正", () => {
    const { grid } = bakeSdfSceneGrid(
      [box([0, 0, 0], [2, 1, 2], "a"), box([1.5, 0, 0], [3.5, 2, 2], "b")],
      { cellSize: 0.2, bounds: { min: [-0.4, -0.4, -0.4], max: [4.4, 2.4, 2.4] } });
    expect(sampleSdfGrid(grid, [1, 0.5, 1])).toBeLessThan(0);
    expect(sampleSdfGrid(grid, [1.7, 0.5, 1])).toBeLessThan(0);   // 重叠区
    expect(sampleSdfGrid(grid, [3, 1, 1])).toBeLessThan(0);      // 第二盒内
    expect(sampleSdfGrid(grid, [4.2, 1, 1])).toBeGreaterThan(0); // 域外未覆盖
  });

  it("动态资产排除:不入场且逐条报告;静态场不受其几何影响", () => {
    const without = bakeSdfSceneGrid([box([0, 0, 0], [2, 1, 2], "static")], { cellSize: 0.25 });
    const withDynamic = bakeSdfSceneGrid(
      [box([0, 0, 0], [2, 1, 2], "static"), box([2.5, 0, 0], [4, 1, 2], "mover", true)],
      { cellSize: 0.25 });
    expect(withDynamic.report.excludedDynamicCount).toBe(1);
    expect(withDynamic.report.instances.find(entry => entry.id === "mover")
      ?.status).toBe("dynamic-excluded");
    expect([...withDynamic.grid.distances]).toEqual([...without.grid.distances]);
  });

  it("静态资产哈希缓存:命中不重烘;几何或变换变化即 miss;同缓存逐位同输出", () => {
    const cache = createSdfSceneBakeCache();
    const instances = [box([0, 0, 0], [2, 1, 2], "a"), box([3, 0, 0], [5, 2, 2], "b")];
    const first = bakeSdfSceneGrid(instances, { cellSize: 0.25, cache });
    expect([first.report.bakedCount, first.report.cachedCount]).toEqual([2, 0]);
    const second = bakeSdfSceneGrid(instances, { cellSize: 0.25, cache });
    expect([second.report.bakedCount, second.report.cachedCount]).toEqual([0, 2]);
    expect([...second.grid.distances]).toEqual([...first.grid.distances]);
    const changed = [instances[0]!, box([3, 0, 0], [5, 3, 2], "b")];
    const third = bakeSdfSceneGrid(changed, { cellSize: 0.25, cache });
    expect([third.report.bakedCount, third.report.cachedCount]).toEqual([1, 1]);
    const moved = [{ ...instances[0]!, transform: { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const,
      translation: [0.5, 0, 0] as const } }, instances[1]!];
    const fourth = bakeSdfSceneGrid(moved, { cellSize: 0.25, cache });
    expect(fourth.report.bakedCount).toBe(1);
    expect(fourth.report.cachedCount).toBe(1);
  });

  it("规模墙 fail-visible:超三角形预算资产跳过并带原因,其余照常烘焙", () => {
    const triangles = MAX_SDF_SCENE_BAKE_TRIANGLES + 1;
    const oversized: SdfSceneBakeInstance = { id: "huge", mesh: {
      positions: Float32Array.from({ length: triangles * 9 }, (_, index) => (index % 7) * 0.01),
      indices: Uint32Array.from({ length: triangles * 3 }, (_, index) => index % 64),
    } };
    const { report } = bakeSdfSceneGrid([oversized, box([0, 0, 0], [1, 1, 1], "small")],
      { cellSize: 0.25 });
    const huge = report.instances.find(entry => entry.id === "huge");
    expect(huge?.status).toBe("skipped");
    expect(huge?.reason).toBe(`triangle-budget:${MAX_SDF_SCENE_BAKE_TRIANGLES}`);
    expect(report.instances.find(entry => entry.id === "small")?.status).toBe("baked");
    expect(report.skippedCount).toBe(1);
  });

  it("内存档复用 sdfCollisionProfile:cells 上限与字节账同源;超上限 fail-closed", () => {
    const { memory, report } = bakeSdfSceneGrid([box([0, 0, 0], [2, 1, 2], "a")], { cellSize: 0.25 });
    expect(memory.cells).toBe(report.dimensions[0] * report.dimensions[1] * report.dimensions[2]);
    expect(memory.fieldBytes).toBe(memory.cells * 4);
    expect(memory.uploadBytes).toBe(memory.fieldBytes + memory.queryBufferBytes + memory.paramsBytes);
    expect(memory.cells).toBeLessThanOrEqual(MAX_SDF_PROFILE_GRID_CELLS);
    expect(() => bakeSdfSceneGrid([box([0, 0, 0], [2, 1, 2], "a")], { cellSize: 0.001 }))
      .toThrow(/cells 超预算/);
    expect(MAX_SDF_SCENE_BAKE_AXIS).toBe(128);
  });

  it("确定性:同输入逐位同输出(两次烘焙字节一致)", () => {
    const instances = [box([0, 0, 0], [2, 1, 2], "a"), box([2.6, 0, 0], [4, 1.5, 2], "b")];
    const first = bakeSdfSceneGrid(instances, { cellSize: 0.2 });
    const second = bakeSdfSceneGrid(instances, { cellSize: 0.2 });
    expect([...first.grid.distances]).toEqual([...second.grid.distances]);
    expect(first.report.instances.map(entry => entry.status))
      .toEqual(second.report.instances.map(entry => entry.status));
  });
});
