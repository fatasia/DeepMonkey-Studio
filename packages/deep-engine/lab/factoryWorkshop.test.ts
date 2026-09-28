import { describe, expect, it } from "vitest";
import { BAY_PLACEMENTS, WORKSHOP_ASSETS, WORKSHOP_COUNTS, buildWorkshopLayout,
  multiplyTransform, placementTransform, type WorkshopInstanceCount } from "./factoryWorkshop.js";

const SHA256 = /^[a-f0-9]{64}$/;

describe("T00 multi-asset workshop layout", () => {
  it("freezes at least five distinct kit roles with verifiable derivative identities", () => {
    expect(WORKSHOP_ASSETS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(WORKSHOP_ASSETS.map(asset => asset.id)).size).toBe(WORKSHOP_ASSETS.length);
    for (const asset of WORKSHOP_ASSETS) {
      expect(asset.file).toMatch(/\.glb$/);
      expect(asset.sha256, asset.file).toMatch(SHA256);
      expect(asset.role.trim().length).toBeGreaterThan(0);
    }
  });

  it("produces exactly the frozen tier totals from deterministic bay tiling plus machine fill", () => {
    for (const count of WORKSHOP_COUNTS) {
      const layout = buildWorkshopLayout(count as WorkshopInstanceCount);
      expect(layout.totalInstances).toBe(count);
      const instances = layout.groups.reduce((sum, group) => sum + group.instances, 0);
      expect(instances).toBe(count);
      // 每 bay 16 放置位 24 实例:15 单实例资产 + 1 台 9 mesh 节点机械臂。
      const bayPlacements = BAY_PLACEMENTS.length;
      expect(bayPlacements).toBe(16);
      expect(layout.placements.length).toBe(layout.bays * bayPlacements + layout.fillMachines);
      const robotArm = layout.groups.find(group => group.asset === "robotArm")!;
      expect(robotArm.instances).toBe(layout.bays * 9);
      expect(robotArm.placements).toBe(layout.bays);
      const machine = layout.groups.find(group => group.asset === "machine")!;
      expect(machine.instances).toBe(layout.bays * 2 + layout.fillMachines);
    }
    const tier = buildWorkshopLayout(1_000);
    expect(tier.bays).toBe(41); expect(tier.fillMachines).toBe(16);
    expect(buildWorkshopLayout(5_000).bays).toBe(208);
    expect(buildWorkshopLayout(5_000).fillMachines).toBe(8);
    expect(buildWorkshopLayout(10_000).bays).toBe(416);
  });

  it("is byte-stable across repeated builds (no clock, no randomness)", () => {
    const first = JSON.stringify(buildWorkshopLayout(5_000));
    const second = JSON.stringify(buildWorkshopLayout(5_000));
    expect(second).toBe(first);
  });

  it("keeps every transform finite with orthonormal rotation columns and in-bounds coordinates", () => {
    for (const count of WORKSHOP_COUNTS) {
      const layout = buildWorkshopLayout(count as WorkshopInstanceCount);
      const maxX = layout.bayColumns * 6, maxZ = layout.bayRows * 6 + 1.5;
      for (const placement of layout.placements) {
        expect(placement.x).toBeGreaterThanOrEqual(0);
        expect(placement.z).toBeGreaterThanOrEqual(0);
        expect(placement.x).toBeLessThan(maxX + 0.75);
        expect(placement.z).toBeLessThan(maxZ + 0.75);
        const matrix = placementTransform(placement);
        expect(matrix).toHaveLength(16);
        for (const value of matrix) expect(Number.isFinite(value)).toBe(true);
        for (const column of [0, 2] as const) {
          const length = Math.hypot(matrix[column * 4]!, matrix[column * 4 + 1]!, matrix[column * 4 + 2]!);
          expect(length).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it("composes placement and instance transforms like a column-major world matrix", () => {
    const world = placementTransform({ asset: "machine", x: 10, y: 2, z: 4, rotY: Math.PI / 2 });
    const local = placementTransform({ asset: "machine", x: 1, y: 0, z: 0, rotY: 0 });
    const composed = multiplyTransform(world, local);
    // 本约定 col0=(cosθ,0,-sinθ):局部 (1,0,0) 绕 Y 转 +90° 后落在世界 (10, 2, 4-1)。
    expect(composed[12]).toBeCloseTo(10, 12);
    expect(composed[13]).toBeCloseTo(2, 12);
    expect(composed[14]).toBeCloseTo(3, 12);
    const identity = multiplyTransform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], local);
    identity.forEach((value, index) => expect(value).toBeCloseTo(local[index]!, 12));
  });

  it("rejects unfrozen tiers instead of silently scaling", () => {
    expect(() => buildWorkshopLayout(2_000 as WorkshopInstanceCount)).toThrow(RangeError);
  });
});
