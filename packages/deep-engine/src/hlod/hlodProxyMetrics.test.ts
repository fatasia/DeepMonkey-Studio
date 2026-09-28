import { describe, expect, it } from "vitest";
import { generateClusterProxyGeometry, resolveHlodProxyOptions } from "./hlodProxyGeometry.js";
import { boxesFromProxyMesh, distancePointToBox, measureHlodProxyError } from "./hlodProxyMetrics.js";
import type { HlodInstanceShape } from "./hlodProxyTypes.js";

const shape = (id: string, cx: number, cy: number, cz: number, hx = 0.5, hy = 0.5, hz = 0.5): HlodInstanceShape =>
  ({ instanceId: id, min: [cx - hx, cy - hy, cz - hz], max: [cx + hx, cy + hy, cz + hz] });

describe("distancePointToBox", () => {
  it("matches closed-form expectations for inside, face, edge and corner regions", () => {
    const min = [0, 0, 0] as const, max = [2, 2, 2] as const;
    expect(distancePointToBox([1, 1, 1], min, max)).toBe(0);
    expect(distancePointToBox([3, 1, 1], min, max)).toBe(1); // 面外
    expect(distancePointToBox([3, 3, 1], min, max)).toBeCloseTo(Math.SQRT2, 12); // 棱外
    expect(distancePointToBox([3, 3, 3], min, max)).toBeCloseTo(Math.sqrt(3), 12); // 角外
    expect(distancePointToBox([-1, 0.5, 2.5], min, max)).toBeCloseTo(Math.sqrt(1 + 0.25), 12);
  });
});

describe("boxesFromProxyMesh", () => {
  it("recovers per-box bounds from the emitted Float32 geometry", () => {
    const proxy = generateClusterProxyGeometry([shape("a", 10, 0, 0, 1, 2, 3)]);
    const boxes = boxesFromProxyMesh(proxy.mesh);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.min[0]).toBeCloseTo(9, 5);
    expect(boxes[0]!.max[0]).toBeCloseTo(11, 5);
    expect(boxes[0]!.max[1]).toBeCloseTo(2, 5);
    expect(boxes[0]!.max[2]).toBeCloseTo(3, 5);
  });
});

describe("measureHlodProxyError", () => {
  it("reports zero deviation both ways when the proxy is the exact per-instance boxes", () => {
    const shapes = [shape("a", 0, 0, 0), shape("b", 4, 0, 0), shape("c", 8, 0, 0)];
    const proxy = generateClusterProxyGeometry(shapes);
    const metrics = measureHlodProxyError(shapes, proxy.mesh, resolveHlodProxyOptions());
    expect(metrics.instanceToProxyMax).toBe(0);
    expect(metrics.proxyToInstanceMax).toBe(0); // 代理采样点全部落在实例盒表面。
    expect(metrics.proxySampleCount).toBe(3 * 9);
  });

  it("hand-checks proxyToInstanceMax for a merged proxy of two unit cubes", () => {
    // 两个单位立方体 [0,1]³ 与 [2,3]³ 合并为 [0,3]×[0,1]×[0,1](预算 1 盒)。
    const shapes = [shape("a", 0.5, 0.5, 0.5, 0.5, 0.5, 0.5), shape("b", 2.5, 0.5, 0.5, 0.5, 0.5, 0.5)];
    const proxy = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 12 });
    expect(proxy.mesh.boxCount).toBe(1);
    const metrics = measureHlodProxyError(shapes, proxy.mesh, resolveHlodProxyOptions());
    // 实例→代理:实例盒表面全部在并盒内 → 0。
    expect(metrics.instanceToProxyMax).toBe(0);
    // 代理→实例:并盒 = [0,3]×[0,1]×[0,1];8 个角全是实例 a/b 的角(距离 0),
    // 最远采样点是质心 (1.5,0.5,0.5) → 距两实例盒各 0.5。
    expect(metrics.proxyToInstanceMax).toBeCloseTo(0.5, 9);
  });

  it("reports volume sums and the upper-bound ratio for identical box sets", () => {
    const shapes = [shape("a", 0, 0, 0, 1, 1, 1)];
    const proxy = generateClusterProxyGeometry(shapes);
    const metrics = measureHlodProxyError(shapes, proxy.mesh, resolveHlodProxyOptions());
    expect(metrics.proxyBoxVolume).toBeCloseTo(8, 9);
    expect(metrics.instanceBoxVolume).toBeCloseTo(8, 9);
    expect(metrics.volumeRatioUpperBound).toBeCloseTo(1, 9);
  });

  it("shrinks sampling deterministically under a tight evaluation budget", () => {
    const shapes: HlodInstanceShape[] = [];
    for (let index = 0; index < 64; index++) shapes.push(shape(`s${index}`, index * 2, 0, 0));
    const proxy = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 24 });
    const generous = measureHlodProxyError(shapes, proxy.mesh, resolveHlodProxyOptions({ metricEvalBudget: 2_000_000 }));
    const tight = measureHlodProxyError(shapes, proxy.mesh,
      resolveHlodProxyOptions({ metricEvalBudget: 300 })); // 预算恰容 10 实例 × 14 方向 × 2 盒
    expect(tight.instanceSampleCount).toBe(10);
    expect(tight.instanceSampleCount).toBeLessThan(generous.instanceSampleCount);
    expect(Number.isFinite(tight.instanceToProxyMax)).toBe(true);
    expect(Number.isFinite(tight.proxyToInstanceMax)).toBe(true);
    const again = measureHlodProxyError(shapes, proxy.mesh,
      resolveHlodProxyOptions({ metricEvalBudget: 300 }));
    expect(again.instanceToProxyMax).toBe(tight.instanceToProxyMax);
    expect(again.proxyToInstanceMax).toBe(tight.proxyToInstanceMax);
  });

  it("is independent of shape input order (bit-identical metrics)", () => {
    const shapes = [shape("a", 0, 0, 0), shape("b", 4, 1, 0), shape("c", 8, 0, 2), shape("d", 2, 3, 1)];
    const proxy = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 24 });
    const forward = measureHlodProxyError(shapes, proxy.mesh, resolveHlodProxyOptions());
    const backward = measureHlodProxyError([...shapes].reverse(), proxy.mesh, resolveHlodProxyOptions());
    expect(backward.instanceToProxyMax).toBe(forward.instanceToProxyMax);
    expect(backward.proxyToInstanceMax).toBe(forward.proxyToInstanceMax);
    expect(backward.proxyBoxVolume).toBe(forward.proxyBoxVolume);
  });

  it("marks a degenerate all-zero-volume cluster honestly (ratio 0 when both volumes are 0)", () => {
    const shapes = [shape("p", 0, 0, 0, 0, 0, 0)];
    const proxy = generateClusterProxyGeometry(shapes);
    const metrics = measureHlodProxyError(shapes, proxy.mesh, resolveHlodProxyOptions());
    expect(metrics.instanceBoxVolume).toBe(0);
    expect(metrics.volumeRatioUpperBound).toBe(0);
  });
});
