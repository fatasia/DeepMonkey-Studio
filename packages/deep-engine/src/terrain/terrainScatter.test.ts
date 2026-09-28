import { describe, expect, it } from "vitest";
import { TerrainField } from "./terrainField.js";
import { SCATTER_TRANSFORM_STRIDE, scatterInstancesOnField, type ScatterOptions } from "./terrainScatter.js";
import { TERRAIN_ALGORITHM_VERSION, type TerrainFieldParameters } from "./terrainHeightfield.js";

const baseParameters: TerrainFieldParameters = {
  seed: 777,
  chunkSize: 16,
  cellSize: 1,
  amplitude: 10,
  frequency: 0.02,
  octaves: 4,
  algorithmVersion: TERRAIN_ALGORITHM_VERSION,
};

const baseOptions: ScatterOptions = {
  seed: 4242,
  densityPerSqm: 0.25,
  maxSlopeDegrees: 55,
  slopeProbeM: 1,
  obstacleClearanceM: 1.5,
  scaleMin: 0.8,
  scaleMax: 1.4,
  yOffsetM: 0,
};

const range = { minChunkX: 0, minChunkZ: 0, maxChunkX: 3, maxChunkZ: 3 };

describe("T13 散布确定性", () => {
  it("同 seed 两次散布 transforms 逐位一致", () => {
    const field = new TerrainField(baseParameters, [{ centerX: 30, centerZ: 40, radiusM: 8, heightM: 2, transitionM: 3 }]);
    const a = scatterInstancesOnField(field, baseOptions, [], range);
    const b = scatterInstancesOnField(field, baseOptions, [], range);
    expect(a.instanceCount).toBe(b.instanceCount);
    expect(a.instanceCount).toBeGreaterThan(0);
    expect(a.transforms.length).toBe(b.transforms.length);
    for (let i = 0; i < a.transforms.length; i += 1) expect(a.transforms[i]).toBe(b.transforms[i]);
    expect(a.chunkSummaries).toEqual(b.chunkSummaries);
  });

  it("不同 seed 散布结果不同", () => {
    const field = new TerrainField(baseParameters, []);
    const a = scatterInstancesOnField(field, baseOptions, [], range);
    const b = scatterInstancesOnField(field, { ...baseOptions, seed: baseOptions.seed + 1 }, [], range);
    // 布局含恒零位,元素级对齐无意义;按实例比较平移位(tx)判别。
    const shared = Math.min(a.instanceCount, b.instanceCount);
    let differing = 0;
    for (let i = 0; i < shared; i += 1) {
      if (a.transforms[i * SCATTER_TRANSFORM_STRIDE + 3] !== b.transforms[i * SCATTER_TRANSFORM_STRIDE + 3]) {
        differing += 1;
      }
    }
    expect(differing).toBeGreaterThan(shared * 0.9);
  });
});

describe("T13 避让与贴地", () => {
  it("障碍净距内零实例,拒绝计数入账", () => {
    const field = new TerrainField(baseParameters, []);
    // 障碍圆心放在块(1,1)中心(世界 24,24),半径 5 + 净距 1.5 = 6.5m 禁区。
    const obstacles = [{ centerX: 24, centerZ: 24, radiusM: 5 }];
    const result = scatterInstancesOnField(field, baseOptions, obstacles, { minChunkX: 1, minChunkZ: 1, maxChunkX: 1, maxChunkZ: 1 });
    expect(result.instanceCount).toBeGreaterThan(0);
    expect(result.chunkSummaries[0].rejectedByObstacle).toBeGreaterThan(0);
    for (let i = 0; i < result.instanceCount; i += 1) {
      const tx = result.transforms[i * SCATTER_TRANSFORM_STRIDE + 3];
      const tz = result.transforms[i * SCATTER_TRANSFORM_STRIDE + 11];
      const dx = tx - 24;
      const dz = tz - 24;
      // float32 打包引入半 ULP 误差,净距比较放宽到 1e-3 米。
      expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThanOrEqual(5 + 1.5 - 1e-3);
    }
  });

  it("实例位置与地形采样一致(几何与碰撞位置一致的基础)", () => {
    const field = new TerrainField(baseParameters, [{ centerX: 20, centerZ: 30, radiusM: 6, heightM: 4, transitionM: 2 }]);
    const yOffset = 0.35;
    const result = scatterInstancesOnField(field, { ...baseOptions, yOffsetM: yOffset }, [], range);
    expect(result.instanceCount).toBeGreaterThan(100);
    // 逐实例断言:平移列 (m[3], m[7], m[11]) 的 y 等于采样高度 + 抬升。
    // packTransform 输出为 float32(fround),与 float64 采样链相比容差 1e-3 米。
    for (let i = 0; i < result.instanceCount; i += 1) {
      const base = i * SCATTER_TRANSFORM_STRIDE;
      const tx = result.transforms[base + 3];
      const ty = result.transforms[base + 7];
      const tz = result.transforms[base + 11];
      expect(Math.abs(ty - (field.sampleHeight(tx, tz) + yOffset))).toBeLessThan(1e-3);
    }
  });

  it("packTransform 布局:平移列、法线列与 padding 位抽查", () => {
    const field = new TerrainField(baseParameters, []);
    const result = scatterInstancesOnField(field, baseOptions, [], { minChunkX: 0, minChunkZ: 0, maxChunkX: 0, maxChunkZ: 0 });
    expect(result.transforms.length).toBe(result.instanceCount * SCATTER_TRANSFORM_STRIDE);
    for (let i = 0; i < result.instanceCount; i += 1) {
      const base = i * SCATTER_TRANSFORM_STRIDE;
      // packTransform 布局:[0..2]=列0, [3]=tx, [4..6]=列1, [7]=ty, [8..10]=列2, [11]=tz,
      // [12..14]=法线x列, [15]=0, [16..18]=法线y列, [19]=0, [20..22]=法线z列, [23]=0。
      expect(result.transforms[base + 15]).toBe(0);
      expect(result.transforms[base + 19]).toBe(0);
      expect(result.transforms[base + 23]).toBe(0);
      const normalLength = Math.sqrt(
        result.transforms[base + 12] ** 2 + result.transforms[base + 13] ** 2 + result.transforms[base + 14] ** 2,
      );
      // 逆转置法线:均匀缩放下列长 = 1/scale,与第一列(旋转×scale)长度相乘为 1。
      const columnLength = Math.sqrt(
        result.transforms[base] ** 2 + result.transforms[base + 1] ** 2 + result.transforms[base + 2] ** 2,
      );
      expect(normalLength * columnLength).toBeCloseTo(1, 4);
      // 旋转 + 均匀缩放保持第一列长度等于缩放值(0.8..1.4)。
      expect(columnLength).toBeGreaterThanOrEqual(baseOptions.scaleMin - 1e-6);
      expect(columnLength).toBeLessThanOrEqual(baseOptions.scaleMax + 1e-6);
    }
  });
});

describe("T13 散布局部失效", () => {
  it("新增仅覆盖单块的障碍:其他块实例段逐位不变", () => {
    const field = new TerrainField(baseParameters, []);
    const before = scatterInstancesOnField(field, baseOptions, [], range);
    // 障碍完全位于块(2,1)(世界 [32,48)×[16,32))内。
    const after = scatterInstancesOnField(field, baseOptions, [{ centerX: 40, centerZ: 24, radiusM: 4 }], range);
    // 块顺序:行主序 (minZ..maxZ) × (minX..maxX);块(2,1) 为第 1*4+2 = 6 块。
    const affectedIndex = 1 * 4 + 2;
    expect(after.chunkSummaries[affectedIndex].rejectedByObstacle).toBeGreaterThan(0);
    expect(before.chunkSummaries[affectedIndex].rejectedByObstacle).toBe(0);
    let offsetBefore = 0;
    let offsetAfter = 0;
    for (let s = 0; s < before.chunkSummaries.length; s += 1) {
      const countBefore = before.chunkSummaries[s].instanceCount;
      const countAfter = after.chunkSummaries[s].instanceCount;
      if (s !== affectedIndex) {
        expect(countAfter).toBe(countBefore);
        for (let f = 0; f < countBefore * SCATTER_TRANSFORM_STRIDE; f += 1) {
          expect(after.transforms[offsetAfter + f]).toBe(before.transforms[offsetBefore + f]);
        }
      }
      offsetBefore += countBefore * SCATTER_TRANSFORM_STRIDE;
      offsetAfter += countAfter * SCATTER_TRANSFORM_STRIDE;
    }
  });
});

describe("T13 十万实例 CPU 生成阶梯(GPU 阶梯另行联测)", () => {
  it("生成 ≥100,000 实例并记录耗时/字节数/单实例成本", { timeout: 60_000 }, () => {
    const field = new TerrainField(baseParameters, [
      { centerX: 300, centerZ: 300, radiusM: 20, heightM: 0, transitionM: 8 },
    ]);
    // 45x45 块 × 每块 81 候选 = 164,025 候选,过滤后应仍 ≥100k。
    const bigRange = { minChunkX: 0, minChunkZ: 0, maxChunkX: 44, maxChunkZ: 44 };
    const result = scatterInstancesOnField(field, baseOptions, [
      { centerX: 240, centerZ: 240, radiusM: 12 },
      { centerX: 400, centerZ: 520, radiusM: 10 },
    ], bigRange);
    // 报告引用的统计一行。
    const perInstanceUs = (result.generationMs * 1000) / result.instanceCount;
    const candidates = (bigRange.maxChunkX + 1) * (bigRange.maxChunkZ + 1) * 81;
    console.info(
      `[T13 scatter ladder] instances=${result.instanceCount} candidates=${candidates}` +
      ` generationMs=${result.generationMs.toFixed(1)} bytes=${result.transformsByteLength}` +
      ` perInstanceUs=${perInstanceUs.toFixed(2)}`,
    );
    expect(result.instanceCount).toBeGreaterThanOrEqual(100_000);
    expect(result.generationMs).toBeLessThan(30_000);
    expect(result.transformsByteLength).toBe(result.instanceCount * SCATTER_TRANSFORM_STRIDE * 4);
    // 十万级也应保持确定性(抽样逐位复核)。
    const replay = scatterInstancesOnField(field, baseOptions, [
      { centerX: 240, centerZ: 240, radiusM: 12 },
      { centerX: 400, centerZ: 520, radiusM: 10 },
    ], bigRange);
    expect(replay.instanceCount).toBe(result.instanceCount);
    for (let i = 0; i < 4096; i += 1) {
      const index = (i * 7919) % result.transforms.length;
      expect(replay.transforms[index]).toBe(result.transforms[index]);
    }
  });
});
