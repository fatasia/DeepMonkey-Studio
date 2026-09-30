import { describe, expect, it } from "vitest";
import { createSdfCollisionProfile, deriveSdfProfileDistanceBound,
  validateSdfProfileAgainstRapierHull,
  type SdfProfileBudget, type SdfProfileTruthRow } from "./sdfCollisionProfile.js";
import { GRID_CELL_SIZE, lcgTruthRows, loadFixtureGrid } from "./sdfCollisionTruthFixture.js";

/** 实测钉定:近表面带内最小法线对齐。4096 LCG 点实测 min = 0.19876(下限由共享棱
 * 附近的行决定:凸包最近面单选一面,场梯度指向最近面,棱处固有分歧),钉 0.15 留 25% 余量。 */
const MEASURED_MIN_NORMAL_ALIGNMENT = 0.15;

const budget = (grid: ReturnType<typeof loadFixtureGrid>): SdfProfileBudget => ({
  maxOutsideDistanceError: deriveSdfProfileDistanceBound(grid),
  minNormalAlignment: MEASURED_MIN_NORMAL_ALIGNMENT,
  nearSurfaceBand: 2 * GRID_CELL_SIZE,
  maxGhostThickness: Math.SQRT2 + deriveSdfProfileDistanceBound(grid),
});

describe("A2 SDF 碰撞 profile × Rapier 凸包真值(逐字段 fail-closed 对照)", () => {
  it("凸包真值对照全绿:outside-agreement 距离误差 ≤ 采样上界(4096 LCG 点实测表)", () => {
    const grid = loadFixtureGrid();
    const profile = createSdfCollisionProfile({ enabled: true, grid });
    const { rows: table, violations } = validateSdfProfileAgainstRapierHull(profile, lcgTruthRows(grid, 4096), budget(grid));
    expect(violations).toHaveLength(0);
    const agreement = table.filter(row => row.region === "outside-agreement");
    expect(agreement.length).toBeGreaterThan(400);
    const worstError = Math.max(...agreement.map(row => row.outsideDistanceError ?? 0));
    expect(worstError).toBeLessThanOrEqual(budget(grid).maxOutsideDistanceError);
  });

  it("近表面法线对齐 ≥ 钉定预算(实测最小值 + 余量,带内行全覆盖)", () => {
    const grid = loadFixtureGrid();
    const profile = createSdfCollisionProfile({ enabled: true, grid });
    const { rows: table } = validateSdfProfileAgainstRapierHull(profile, lcgTruthRows(grid, 4096), budget(grid));
    const band = table.filter(row => row.region === "outside-agreement"
      && row.normalAlignment !== null && Math.abs(row.sdfDistance) <= 2 * GRID_CELL_SIZE);
    expect(band.length).toBeGreaterThan(100);
    const worst = Math.min(...band.map(row => row.normalAlignment!));
    expect(worst).toBeGreaterThanOrEqual(MEASURED_MIN_NORMAL_ALIGNMENT);
  });

  it("幽灵区:厚度为正且 ≤ √2 + 采样上界,分类 free(SDF 对凹域的价值)", () => {
    const grid = loadFixtureGrid();
    const profile = createSdfCollisionProfile({ enabled: true, grid });
    const { rows: table } = validateSdfProfileAgainstRapierHull(profile, lcgTruthRows(grid, 4096), budget(grid));
    const ghost = table.filter(row => row.region === "ghost");
    expect(ghost.length).toBeGreaterThan(50);
    const maxThickness = Math.max(...ghost.map(row => row.ghostThickness ?? 0));
    expect(maxThickness).toBeGreaterThan(0);
    expect(maxThickness).toBeLessThanOrEqual(Math.SQRT2 + deriveSdfProfileDistanceBound(grid));
    expect(ghost.every(row => !row.penetrating)).toBe(true);
  });

  it("leak fail-closed:构造 sdf<hull 行 → validate 抛错并指认字段", () => {
    const profile = createSdfCollisionProfile({ enabled: true, grid: loadFixtureGrid() });
    const rows: SdfProfileTruthRow[] = [{
      point: [0.5, 0.5, 0.5], hullDistance: 1, hullNormal: [0, 0, 1], hullFeatureIsGhostFace: false,
    }];
    expect(() => validateSdfProfileAgainstRapierHull(profile, rows, {
      maxOutsideDistanceError: 0.3, minNormalAlignment: 0, nearSurfaceBand: 1, maxGhostThickness: 2,
    })).toThrow(/leak/);
  });

  it("域外真值行 fail-closed:collect 记 domain 违规,validate 抛错", () => {
    const profile = createSdfCollisionProfile({ enabled: true, grid: loadFixtureGrid() });
    const rows: SdfProfileTruthRow[] = [{
      point: [99, 99, 99], hullDistance: 1, hullNormal: [0, 0, 1], hullFeatureIsGhostFace: false,
    }];
    expect(() => validateSdfProfileAgainstRapierHull(profile, rows, {
      maxOutsideDistanceError: 0.3, minNormalAlignment: 0, nearSurfaceBand: 1, maxGhostThickness: 2,
    })).toThrow(/fail-closed/);
  });

  it("[测量证据] 4096 点对照表:区域分布 / 最差误差 / 最差法线 / 幽灵厚度上限", () => {
    const grid = loadFixtureGrid();
    const profile = createSdfCollisionProfile({ enabled: true, grid });
    const { rows: table, violations } = validateSdfProfileAgainstRapierHull(profile, lcgTruthRows(grid, 4096), budget(grid));
    expect(violations).toHaveLength(0);
    const regions = new Map<string, number>();
    table.forEach(row => regions.set(row.region, (regions.get(row.region) ?? 0) + 1));
    const agreement = table.filter(row => row.region === "outside-agreement");
    const ghost = table.filter(row => row.region === "ghost");
    const band = agreement.filter(row => row.normalAlignment !== null && Math.abs(row.sdfDistance) <= 2 * GRID_CELL_SIZE);
    // 双端(native rapier3d 真值)同表逐项一致,数字变更必须两侧同步复核:
    expect(regions.get("outside-agreement")).toBe(1356);
    expect(regions.get("outside-ghost-adjacent")).toBe(1578);
    expect(regions.get("ghost")).toBe(371);
    expect(regions.get("inside-agreement")).toBe(791);
    expect(Math.max(...agreement.map(row => row.outsideDistanceError ?? 0))).toBeCloseTo(0.09929742092390575, 12);
    expect(Math.min(...band.map(row => row.normalAlignment!))).toBeCloseTo(0.19875684271938046, 12);
    expect(Math.max(...ghost.map(row => row.ghostThickness ?? 0))).toBeCloseTo(1.1167188882827759, 12);
  });
});
