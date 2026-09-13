import { describe, expect, it } from "vitest";
import { planCascadedShadows } from "./cascadedShadowPlanner.js";

const camera = { eye: [0, 2, 8] as const, target: [0, 1, 0] as const, verticalFovRadians: Math.PI / 3,
  aspect: 16 / 9, near: 0.5, far: 200 };

function project(matrix: Float32Array, point: readonly [number, number, number]): readonly [number, number, number] {
  const x = point[0], y = point[1], z = point[2];
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  return [(matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w,
    (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w,
    (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) / w];
}

function fittedNearDepth(index: number, plan: ReturnType<typeof planCascadedShadows>): number {
  const corners = plan.cascades[index]!.corners.slice(0, 4);
  const center = corners.reduce((sum, corner) => [sum[0] + corner[0], sum[1] + corner[1], sum[2] + corner[2]], [0, 0, 0]);
  const direction = camera.target.map((value, axis) => value - camera.eye[axis]!) as [number, number, number];
  const length = Math.hypot(...direction);
  return center.reduce((depth, value, axis) => depth + (value / corners.length - camera.eye[axis]!) * direction[axis]! / length, 0);
}

describe("planCascadedShadows", () => {
  it("uses practical monotonic splits and honors the maximum shadow distance", () => {
    const plan = planCascadedShadows(camera, [1, -2, 1], { cascadeCount: 4, splitLambda: 0.7, maxShadowDistance: 100 });
    expect(plan.cascades).toHaveLength(4); expect(plan.splitDepths[3]).toBe(100);
    expect([...plan.splitDepths]).toEqual([...plan.splitDepths].sort((a, b) => a - b));
    plan.cascades.forEach((cascade, index) => expect(cascade.near)
      .toBeCloseTo(index === 0 ? camera.near : plan.splitDepths[index - 1]!, 5));
    expect(plan.cascades.every((cascade) => cascade.blendStart >= cascade.near && cascade.blendStart <= cascade.far)).toBe(true);
  });

  it("contains all slice corners in each cascade's WebGPU clip volume", () => {
    const plan = planCascadedShadows(camera, [0.4, -1, 0.2], { cascadeCount: 3, depthPadding: 20 });
    for (const cascade of plan.cascades) for (const corner of cascade.corners) {
      const [x, y, z] = project(cascade.viewProjection, corner);
      expect(Math.abs(x)).toBeLessThanOrEqual(1.00001); expect(Math.abs(y)).toBeLessThanOrEqual(1.00001);
      expect(z).toBeGreaterThanOrEqual(-0.00001); expect(z).toBeLessThanOrEqual(1.00001);
    }
  });

  it("fits adjacent cascades over the complete blend interval", () => {
    const plan = planCascadedShadows(camera, [0.4, -1, 0.2], { cascadeCount: 4, blendRatio: 0.15 });
    expect(fittedNearDepth(0, plan)).toBeCloseTo(camera.near, 5);
    for (let index = 1; index < plan.cascades.length; index++) {
      expect(fittedNearDepth(index, plan)).toBeCloseTo(plan.cascades[index - 1]!.blendStart, 5);
      expect(plan.cascades[index]!.near).toBeGreaterThan(plan.cascades[index - 1]!.blendStart);
    }
  });

  it("snaps light-space centers to shadow texels and remains stable under a sub-texel lateral camera move", () => {
    const first = planCascadedShadows(camera, [0, -1, -1], { cascadeCount: 1, shadowMapSize: 1024 });
    const texel = first.cascades[0]!.texelWorldSize;
    const moved = { ...camera, eye: [texel * 0.2, 2, 8] as const, target: [texel * 0.2, 1, 0] as const };
    const second = planCascadedShadows(moved, [0, -1, -1], { cascadeCount: 1, shadowMapSize: 1024 });
    expect([...second.cascades[0]!.viewProjection]).toEqual([...first.cascades[0]!.viewProjection]);
  });

  it("supports one through eight cascades and fails closed on invalid camera or options", () => {
    expect(planCascadedShadows(camera, [1, -1, 0], { cascadeCount: 1 }).cascades).toHaveLength(1);
    expect(planCascadedShadows(camera, [1, -1, 0], { cascadeCount: 8 }).cascades).toHaveLength(8);
    expect(() => planCascadedShadows({ ...camera, far: 0.1 }, [1, -1, 0])).toThrow("camera far");
    expect(() => planCascadedShadows(camera, [0, 0, 0])).toThrow("degenerate");
    expect(() => planCascadedShadows(camera, [1, -1, 0], { shadowMapSize: 32 })).toThrow("shadow map size");
  });
});
