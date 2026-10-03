import { describe, expect, it } from "vitest";
import { pageOf, pageViewProjection, planVirtualShadowClipmap, projectToRing,
  VIRTUAL_SHADOW_MIP_COUNT, VIRTUAL_SHADOW_PAGE_GRID, VIRTUAL_SHADOW_PAGE_EDGE,
  VIRTUAL_SHADOW_TOP_MIP, VIRTUAL_SHADOW_VIRTUAL_EDGE } from "./virtualShadowClipmap.js";

const camera = Object.freeze({ eye: [0, 4, 12] as const, target: [0, 0, 0] as const,
  verticalFovRadians: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 1_000, extent: 10 });
const light = Object.freeze([-0.4, -0.8, -0.3] as const);

describe("virtual shadow clipmap planner", () => {
  it("plans three rings with 2x extents and texel densities in 16384/page 128 terms", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    expect(plan.rings).toHaveLength(3);
    expect(plan.rings[1]!.halfExtent).toBeCloseTo(plan.rings[0]!.halfExtent * 2, 6);
    expect(plan.rings[2]!.halfExtent).toBeCloseTo(plan.rings[1]!.halfExtent * 2, 6);
    for (const ring of plan.rings) {
      expect(ring.texelWorldSize).toBeCloseTo(2 * ring.halfExtent / VIRTUAL_SHADOW_VIRTUAL_EDGE, 9);
      expect(ring.depthSpan).toBeGreaterThan(2 * ring.halfExtent);
      expect(ring.viewProjection).toHaveLength(16);
    }
    expect(VIRTUAL_SHADOW_PAGE_GRID).toBe(VIRTUAL_SHADOW_VIRTUAL_EDGE / VIRTUAL_SHADOW_PAGE_EDGE);
    expect(VIRTUAL_SHADOW_TOP_MIP).toBe(VIRTUAL_SHADOW_MIP_COUNT - 1);
  });

  it("keeps page boundaries world-stable across anchor movement (clipmap cache contract)", () => {
    const staticPlan = planVirtualShadowClipmap(camera, light);
    const moved = planVirtualShadowClipmap({ ...camera, eye: [0.37, 4.1, 12.9] as const,
      target: [0.21, 0.05, -0.4] as const }, light);
    // 光基向(与规划器同构):吸附只作用于平面内两轴,backdrop 轴随目标连续移动。
    const length = Math.hypot(...light);
    const backward = light.map(value => -value / length) as [number, number, number];
    const up0: [number, number, number] = Math.abs(backward[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    const rightLength = Math.hypot(up0[1] * backward[2] - up0[2] * backward[1],
      up0[2] * backward[0] - up0[0] * backward[2], up0[0] * backward[1] - up0[1] * backward[0]);
    const right = [(up0[1] * backward[2] - up0[2] * backward[1]) / rightLength,
      (up0[2] * backward[0] - up0[0] * backward[2]) / rightLength,
      (up0[0] * backward[1] - up0[1] * backward[0]) / rightLength] as [number, number, number];
    const correctedUp = [backward[1] * right[2] - backward[2] * right[1],
      backward[2] * right[0] - backward[0] * right[2],
      backward[0] * right[1] - backward[1] * right[0]] as [number, number, number];
    const dot3 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let ring = 0; ring < 3; ring++) {
      const center = staticPlan.rings[ring]!.center, movedCenter = moved.rings[ring]!.center;
      const tile = staticPlan.rings[ring]!.texelWorldSize * VIRTUAL_SHADOW_PAGE_GRID;
      // 合同:两次中心都吸附在同一世界页格点上(平面内坐标 / tile ≈ 整数),
      // 页边界跨锚点移动保持世界固定 —— 已物化页内容无需迁移。
      for (const basis of [right, correctedUp]) {
        const coordinate = dot3(center, basis), movedCoordinate = dot3(movedCenter, basis);
        expect(coordinate / tile).toBeCloseTo(Math.round(coordinate / tile), 6);
        expect(movedCoordinate / tile).toBeCloseTo(Math.round(movedCoordinate / tile), 6);
      }
    }
  });

  it("maps world points to pages and page view projections back to the same page uv", () => {
    const plan = planVirtualShadowClipmap(camera, light);
    const ring = plan.rings[0]!;
    const world = [1.5, 2, -3] as const;
    const projected = projectToRing(ring, world as unknown as number[]);
    expect(projected.u).toBeGreaterThan(0); expect(projected.u).toBeLessThan(1);
    expect(projected.depth).toBeGreaterThan(0); expect(projected.depth).toBeLessThan(1);
    const tile = pageOf(ring, 0, projected.u, projected.v);
    expect(tile).toBeDefined();
    // 页 VP 与环 VP 的 uv 一致性:同一世界点经页 VP 投影落在页局部 uv 的对应 texel。
    // 列主序 contract:clip 分量 = m[0*4+r]x+m[1*4+r]y+m[2*4+r]z+m[3*4+r]。
    const pageVp = pageViewProjection(ring, 0, tile!.tileX, tile!.tileY, plan.lightDirection);
    const m = pageVp;
    const clipX = m[0]! * world[0] + m[4]! * world[1] + m[8]! * world[2] + m[12]!;
    const clipY = m[1]! * world[0] + m[5]! * world[1] + m[9]! * world[2] + m[13]!;
    const clipZ = m[2]! * world[0] + m[6]! * world[1] + m[10]! * world[2] + m[14]!;
    const clipW = m[3]! * world[0] + m[7]! * world[1] + m[11]! * world[2] + m[15]!;
    const pageU = clipX / clipW * 0.5 + 0.5, pageV = clipY / clipW * -0.5 + 0.5;
    const pageDepth = clipZ / clipW;
    const expectedU = (projected.u * VIRTUAL_SHADOW_PAGE_GRID - tile!.tileX) / 1;
    expect(pageU).toBeCloseTo(expectedU, 5);
    expect(pageV).toBeCloseTo(projected.v * VIRTUAL_SHADOW_PAGE_GRID - tile!.tileY, 5);
    expect(pageDepth).toBeCloseTo(projected.depth, 5);
  });

  it("returns undefined pages outside the ring footprint and clamps requested mips", () => {
    const plan = planVirtualShadowClipmap(camera, light, { maxShadowDistance: 100 });
    const ring = plan.rings[0]!;
    const far = projectToRing(ring, [5_000, 0, 0] as unknown as number[]);
    expect(far.u > 1 || far.u < 0 || far.v > 1 || far.v < 0).toBe(true);
    expect(pageOf(ring, 0, 1.2, 0.5)).toBeUndefined();
    const topTile = pageOf(ring, VIRTUAL_SHADOW_TOP_MIP, 0.99, 0.99);
    expect(topTile).toEqual({ tileX: 0, tileY: 0 });
  });

  it("rejects invalid cameras, extents and light directions", () => {
    expect(() => planVirtualShadowClipmap({ ...camera, extent: -1 }, light)).toThrow("extent");
    expect(() => planVirtualShadowClipmap(camera, [0, 0, 0] as const)).toThrow("degenerate");
    expect(() => planVirtualShadowClipmap({ ...camera, near: 5, far: 1 }, light)).toThrow("far");
    expect(() => planVirtualShadowClipmap(camera, light, { ringCount: 0 })).toThrow("ring count");
  });
});
