import { describe, expect, it } from "vitest";
import { SPLAT_RECORD_FLOAT_STRIDE } from "./splatFormatContract.js";
import { computeSplatViewDepths, sortSplatIndicesByDepth } from "./sortSplatsByDepth.js";
import type { SplatCloud } from "./decodeSplatPly.js";

/**
 * 列主序 view 矩阵:相机在 (0,0,5) 朝 -z 看。
 * viewZ = z-5,depth = -viewZ = 5-z:z 越小越远(z=1 距相机 4,z=3 距相机 2);
 * z>5(相机身后)depth 为负,落最深桶最先绘制。
 */
const CAMERA_AT_Z5_LOOKING_NEGZ = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, -5, 1,
] as const;

function cloudWithPositions(points: ReadonlyArray<readonly [number, number, number]>): SplatCloud {
  const records = new Float32Array(points.length * SPLAT_RECORD_FLOAT_STRIDE);
  points.forEach((point, index) => {
    records.set(point, index * SPLAT_RECORD_FLOAT_STRIDE);
  });
  return { format: "test", splatCount: points.length, records, shDegree: 0, shRest: null, shRestCount: 0 };
}

describe("sortSplatsByDepth (CPU counting sort, far-to-near)", () => {
  it("orders splats far to near under a known camera and stays stable for equal depths", () => {
    const cloud = cloudWithPositions([
      [0, 0, 1], // 最远(z=1,depth 4)
      [0, 0, 3], // 最近(depth 2)
      [0, 0, 2], // 中(depth 3)
      [9, 9, 2], // 与中同深 → 稳定保持原始序
      [0, 0, 3], // 与最近同深 → 稳定保持原始序
    ]);
    const order = sortSplatIndicesByDepth(cloud.records, cloud.splatCount, CAMERA_AT_Z5_LOOKING_NEGZ);
    expect(Array.from(order)).toEqual([0, 2, 3, 1, 4]);

    const depths = computeSplatViewDepths(cloud.records, cloud.splatCount, CAMERA_AT_Z5_LOOKING_NEGZ);
    expect(depths[0]).toBeCloseTo(4, 12);
    expect(depths[1]).toBeCloseTo(2, 12);
    expect(depths[3]).toBeCloseTo(3, 12);
  });

  it("handles empty clouds, single splats and behind-camera negatives without NaN", () => {
    expect(sortSplatIndicesByDepth(new Float32Array(0), 0, CAMERA_AT_Z5_LOOKING_NEGZ))
      .toEqual(new Uint32Array(0));
    const single = cloudWithPositions([[1, 2, 3]]);
    expect(Array.from(sortSplatIndicesByDepth(single.records, 1, CAMERA_AT_Z5_LOOKING_NEGZ))).toEqual([0]);

    const behind = cloudWithPositions([[0, 0, 15]]); // 相机身后(z>5) → depth = 5-15 = -10
    const order = sortSplatIndicesByDepth(behind.records, 1, CAMERA_AT_Z5_LOOKING_NEGZ);
    expect(Array.from(order)).toEqual([0]);
    const depths = computeSplatViewDepths(behind.records, 1, CAMERA_AT_Z5_LOOKING_NEGZ);
    expect(depths[0]).toBeCloseTo(-10, 12);
  });

  it("fails closed on a non-finite depth caused by a bad view matrix", () => {
    const cloud = cloudWithPositions([[0, 0, 1]]);
    // NaN 必须落在 z 行(列主序下标 2/6/10/14 之一)才会进入深度表达式。
    const brokenView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, Number.NaN, 0, 0, 0, -5, 1] as const;
    expect(() => computeSplatViewDepths(cloud.records, cloud.splatCount, brokenView))
      .toThrow(/non-finite view depth/u);
  });

  it("keeps bucket distribution monotonic on a wide depth span (no order corruption)", () => {
    const positions = Array.from({ length: 512 }, (_, index) =>
      [0, 0, index % 2 === 0 ? index : 10_000 - index] as const);
    const cloud = cloudWithPositions(positions);
    const order = sortSplatIndicesByDepth(cloud.records, cloud.splatCount, CAMERA_AT_Z5_LOOKING_NEGZ);
    const depths = computeSplatViewDepths(cloud.records, cloud.splatCount, CAMERA_AT_Z5_LOOKING_NEGZ);
    for (let slot = 1; slot < order.length; slot++) {
      expect(depths[order[slot - 1]!]!).toBeGreaterThanOrEqual(depths[order[slot]!]!);
    }
  });
});
