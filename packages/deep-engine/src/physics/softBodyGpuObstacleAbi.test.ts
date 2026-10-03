// F6/T18 软体并行核障碍刀:pack 层 ABI 逐槽单测锁(布料教训先行版)。
// C8 定位批(softbody-divergence-20261002)回归根因:pack 槽位与 WGSL struct 逐槽
// 错位(halfExtents 写槽 13..15、判别式恒 0)→ sphere 被当退化 cuboid →
// projectObstacles 静默无效应,全部既有门禁全绿。本锁在 pack 层逐槽钉死,并在
// 跨核层与布料 packClothGpuObstacles(真机全绿先例)做字节逐位恒等——同输入
// 两核字节不同 = 槽位漂移,CI 即死,不进真机。
import { describe, expect, it } from "vitest";
import {
  SOFT_BODY_GPU_MAX_OBSTACLES, SOFT_BODY_GPU_OBSTACLE_STRIDE_BYTES,
  packSoftBodyGpuObstacles, type SoftBodyGpuObstacle,
} from "./softBodyGpuWgsl.js";
import { CLOTH_GPU_MAX_OBSTACLES, packClothGpuObstacles } from "./softBodyGpuDispatch.clothParallel.js";

// 与布料逐槽锁测试同源的两组标定样本(sphere identity + 旋转 cuboid)。
const sphere: SoftBodyGpuObstacle = {
  center: [0.55, 0.5, 0.05], radius: 0.45,
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], halfExtents: [0, 0, 0],
};
const cuboid: SoftBodyGpuObstacle = {
  center: [1, 2, 3], radius: 0,
  rotation: [0, 1, 0, 0, 0, 1, 1, 0, 0], halfExtents: [0.2, 0.3, 0.4],
};

describe("软体 GPU 障碍 ABI:逐槽锁(布料教训先行)", () => {
  it("预算常量与布料核同值(64×80B),空预算输出全长零填充缓冲", () => {
    expect([SOFT_BODY_GPU_MAX_OBSTACLES, CLOTH_GPU_MAX_OBSTACLES]).toEqual([64, 64]);
    expect(SOFT_BODY_GPU_OBSTACLE_STRIDE_BYTES).toBe(80);
    const empty = packSoftBodyGpuObstacles([]);
    expect(empty.byteLength).toBe(64 * 80);
    expect(new Float32Array(empty).every(value => value === 0)).toBe(true);
  });

  it("sphere 逐槽:槽0..3=center+radius、槽4..12=rotation 行主序、槽16..18=halfExtents、槽19=判别式(radius)", () => {
    const packed = new Float32Array(packSoftBodyGpuObstacles([sphere]));
    const expectRow = (row: number[]) =>
      expect(Array.from(packed.subarray(0, 20))).toEqual(row.map(Math.fround));
    expectRow([0.55, 0.5, 0.05, 0.45, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.45]);
    // 判别式恒式:sphere 槽 19 与 center.w(槽 3)同值(都是 radius)。
    expect(packed[19]).toBe(packed[3]);
  });

  it("cuboid 逐槽:radius=0 → 判别式槽 19=0(WGSL else 分支),halfExtents.xyz 在槽 16..18,槽13..15=padding 零", () => {
    const packed = new Float32Array(packSoftBodyGpuObstacles([cuboid]));
    expect(Array.from(packed.subarray(0, 20)))
      .toEqual([1, 2, 3, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0.2, 0.3, 0.4, 0].map(Math.fround));
    expect([packed[13], packed[14], packed[15]]).toEqual([0, 0, 0]);
    expect(packed[39]).toBe(0);
  });

  it("跨核字节恒等:同输入与布料 packClothGpuObstacles 逐位一致(sphere/旋转 cuboid/多障碍混排)", () => {
    const rotated: SoftBodyGpuObstacle = {
      center: [0.25, -0.5, 0.125], radius: 0,
      // 非对称旋转矩阵(非正交也无妨,pack 只搬运):逐槽锁不依赖正交性。
      rotation: [0.8, -0.6, 0, 0.6, 0.8, 0, 0, 0, 1],
      halfExtents: [0.5, 0.25, 0.125],
    };
    for (const sample of [[sphere], [cuboid], [sphere, cuboid, rotated]] as const) {
      const soft = new Uint8Array(packSoftBodyGpuObstacles(sample));
      const cloth = new Uint8Array(packClothGpuObstacles(sample));
      expect(Array.from(soft)).toEqual(Array.from(cloth));
    }
  });

  it("超预算与非法参数硬拦:>64 抛错;非有限 center/radius/rotation/halfExtents 抛错", () => {
    const budget = Array.from({ length: SOFT_BODY_GPU_MAX_OBSTACLES + 1 },
      () => ({ ...sphere }));
    expect(() => packSoftBodyGpuObstacles(budget)).toThrow(/budget 64/);
    expect(() => packSoftBodyGpuObstacles([{ ...sphere, center: [Number.NaN, 0, 0] }])).toThrow(/center/);
    expect(() => packSoftBodyGpuObstacles([{ ...sphere, radius: -1 }])).toThrow(/radius/);
    expect(() => packSoftBodyGpuObstacles([{ ...sphere, rotation: [1, 0, 0] }])).toThrow(/rotation/);
    expect(() => packSoftBodyGpuObstacles([{ ...sphere, halfExtents: [0, 0, -0.1] }])).toThrow(/halfExtents/);
    // 恰在预算内不抛(边界)。
    expect(packSoftBodyGpuObstacles(Array.from({ length: SOFT_BODY_GPU_MAX_OBSTACLES }, () => ({ ...sphere }))).byteLength)
      .toBe(64 * 80);
  });
});
