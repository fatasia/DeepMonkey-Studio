import { describe, expect, it } from "vitest";
import { TerrainField } from "./terrainField.js";
import {
  TERRAIN_ALGORITHM_VERSION,
  buildTerrainChunkGeometry,
  createTerrainHeightSampler,
  type TerrainFieldParameters,
  type TerrainFlattenRegion,
} from "./terrainHeightfield.js";

const baseParameters: TerrainFieldParameters = {
  seed: 20260927,
  chunkSize: 16,
  cellSize: 1,
  amplitude: 12,
  frequency: 0.02,
  octaves: 4,
  algorithmVersion: TERRAIN_ALGORITHM_VERSION,
};

/** 空参数浮点数组逐位比较。 */
function expectBuffersEqual(a: Float32Array, b: Float32Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) expect(a[i]).toBe(b[i]);
}

function expectUintBuffersEqual(a: Uint32Array, b: Uint32Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) expect(a[i]).toBe(b[i]);
}

describe("T13 高度场采样器", () => {
  it("同参数两次构建块几何逐位一致(确定性合同)", () => {
    const a = createTerrainHeightSampler(baseParameters, []);
    const b = createTerrainHeightSampler(baseParameters, []);
    const chunkA = buildTerrainChunkGeometry(baseParameters, a, -1, 2);
    const chunkB = buildTerrainChunkGeometry(baseParameters, b, -1, 2);
    expectBuffersEqual(chunkA.positions, chunkB.positions);
    expectBuffersEqual(chunkA.normals, chunkB.normals);
    expectUintBuffersEqual(chunkA.indices, chunkB.indices);
    expect(chunkA.vertexCount).toBe(17 * 17);
    expect(chunkA.indexCount).toBe(16 * 16 * 6);
  });

  it("不同 seed 生成不同地形", () => {
    const a = createTerrainHeightSampler(baseParameters, []);
    const b = createTerrainHeightSampler({ ...baseParameters, seed: baseParameters.seed + 1 }, []);
    let differing = 0;
    for (let i = 1; i <= 256; i += 1) {
      if (a(i * 0.61, i * -0.23) !== b(i * 0.61, i * -0.23)) differing += 1;
    }
    expect(differing).toBeGreaterThan(240);
  });

  it("输出高度受振幅约束,平整区圆心精确等于目标高度", () => {
    const region: TerrainFlattenRegion = { centerX: 10, centerZ: -4, radiusM: 6, heightM: 3.5, transitionM: 2 };
    const sampler = createTerrainHeightSampler(baseParameters, [region]);
    for (let i = 0; i < 512; i += 1) {
      const h = sampler(i * 1.7 - 400, i * -1.3 + 300);
      expect(h).toBeGreaterThanOrEqual(-baseParameters.amplitude - 1e-9);
      expect(h).toBeLessThanOrEqual(baseParameters.amplitude + 1e-9);
    }
    // 圆盘内圈(dist <= radius - transition)完全平整。
    expect(sampler(10, -4)).toBe(3.5);
    expect(sampler(10 + 3.5, -4)).toBe(3.5);
    expect(sampler(10, -4 - 3.9)).toBe(3.5);
  });

  it("非法参数被拒绝", () => {
    expect(() => createTerrainHeightSampler({ ...baseParameters, chunkSize: 0 }, [])).toThrow();
    expect(() => createTerrainHeightSampler({ ...baseParameters, cellSize: -1 }, [])).toThrow();
    expect(() =>
      createTerrainHeightSampler(baseParameters, [{ centerX: 0, centerZ: 0, radiusM: 0, heightM: 0, transitionM: 0 }]),
    ).toThrow();
  });
});

describe("T13 块接缝连续性(CPU 几何级证明)", () => {
  const field = new TerrainField(baseParameters, [
    { centerX: 14, centerZ: 30, radiusM: 9, heightM: 2, transitionM: 4 },
  ]);
  // 2x2 块:共享一条内部十字边界与一个角点;平整区骑跨边界,防止"纯噪声碰巧连续"。
  const chunks = [
    field.getChunk(0, 0), field.getChunk(1, 0),
    field.getChunk(0, 1), field.getChunk(1, 1),
  ];
  const size = baseParameters.chunkSize;
  const stride = size + 1;

  /** 断言两块共享边界上全部 size+1 个顶点的位置与法线逐位相等。 */
  function expectSharedEdgeEqual(
    a: ReturnType<TerrainField["getChunk"]>, aIndex: (j: number) => number,
    b: ReturnType<TerrainField["getChunk"]>, bIndex: (j: number) => number,
  ): void {
    for (let j = 0; j <= size; j += 1) {
      const ia = aIndex(j);
      const ib = bIndex(j);
      const pa = ia * 3;
      const pb = ib * 3;
      expect(a.positions[pa]).toBe(b.positions[pb]);
      expect(a.positions[pa + 1]).toBe(b.positions[pb + 1]);
      expect(a.positions[pa + 2]).toBe(b.positions[pb + 2]);
      expect(a.normals[pa]).toBe(b.normals[pb]);
      expect(a.normals[pa + 1]).toBe(b.normals[pb + 1]);
      expect(a.normals[pa + 2]).toBe(b.normals[pb + 2]);
    }
  }

  it("水平缝:块(0,z)右边界与块(1,z)左边界逐位一致", () => {
    expectSharedEdgeEqual(chunks[0], (j) => j * stride + size, chunks[1], (j) => j * stride + 0);
    expectSharedEdgeEqual(chunks[2], (j) => j * stride + size, chunks[3], (j) => j * stride + 0);
  });

  it("垂直缝:块(x,0)上边界与块(x,1)下边界逐位一致", () => {
    expectSharedEdgeEqual(
      chunks[0], (i) => size * stride + i,
      chunks[2], (i) => 0 * stride + i,
    );
    expectSharedEdgeEqual(
      chunks[1], (i) => size * stride + i,
      chunks[3], (i) => 0 * stride + i,
    );
  });

  it("四块共享角点位置与法线逐位一致", () => {
    const corners = [
      chunks[0].normals.slice((size * stride + size) * 3, (size * stride + size) * 3 + 3),
      chunks[1].normals.slice((size * stride + 0) * 3, (size * stride + 0) * 3 + 3),
      chunks[2].normals.slice((0 * stride + size) * 3, (0 * stride + size) * 3 + 3),
      chunks[3].normals.slice(0, 3),
    ];
    const positions = [
      chunks[0].positions.slice((size * stride + size) * 3, (size * stride + size) * 3 + 3),
      chunks[1].positions.slice((size * stride + 0) * 3, (size * stride + 0) * 3 + 3),
      chunks[2].positions.slice((0 * stride + size) * 3, (0 * stride + size) * 3 + 3),
      chunks[3].positions.slice(0, 3),
    ];
    for (let k = 1; k < 4; k += 1) {
      expectBuffersEqual(corners[0], corners[k]);
      expectBuffersEqual(positions[0], positions[k]);
    }
  });

  it("法线为单位向量且朝上(绕序与差分正确性抽查)", () => {
    const chunk = chunks[0];
    for (let v = 0; v < chunk.vertexCount; v += 1) {
      const nx = chunk.normals[v * 3];
      const ny = chunk.normals[v * 3 + 1];
      const nz = chunk.normals[v * 3 + 2];
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      expect(Math.abs(length - 1)).toBeLessThan(1e-6);
      expect(ny).toBeGreaterThan(0);
    }
  });
});

describe("T13 增量失效", () => {
  it("修改单个平整区只重建影响盒内块,外块引用与几何逐位不变", () => {
    const field = new TerrainField(baseParameters, [
      { centerX: 24, centerZ: 24, radiusM: 4, heightM: 5, transitionM: 2 },
    ]);
    // 缓存 3x3 块;平整区影响盒 reach = 4+2+1(cellSize) = 7,完全落在块(1,1)内。
    const before = [
      field.getChunk(0, 0), field.getChunk(1, 0), field.getChunk(2, 0),
      field.getChunk(0, 1), field.getChunk(1, 1), field.getChunk(2, 1),
      field.getChunk(0, 2), field.getChunk(1, 2), field.getChunk(2, 2),
    ];
    const beforeData = before.map((chunk) => chunk.positions.slice());
    const rebuilt = field.updateRegions([
      { centerX: 24, centerZ: 24, radiusM: 4, heightM: 1, transitionM: 2 },
    ]);
    expect(rebuilt).toEqual(["1,1"]);
    expect(field.stats.rebuildCount).toBe(1);
    // 未受影响块:同一对象引用 + 几何逐位不变。
    for (let i = 0; i < before.length; i += 1) {
      if (i === 4) continue;
      expect(field.getChunk(before[i].chunkX, before[i].chunkZ)).toBe(before[i]);
      expectBuffersEqual(before[i].positions, beforeData[i]);
    }
    // 受影响块:新对象引用,且圆心高度变为新目标值。
    const updated = field.getChunk(1, 1);
    expect(updated).not.toBe(before[4]);
    expect(updated.positions[(8 * 17 + 8) * 3 + 1]).toBe(1);
  });

  it("平整区骑跨块边界时重建集合覆盖两侧块", () => {
    const field = new TerrainField(baseParameters, [
      // center x=16 恰在块(0,*)与块(1,*)边界上;reach = 3+2+1 = 6 → 覆盖 (0,1) 与 (1,1)。
      { centerX: 16, centerZ: 24, radiusM: 3, heightM: 0, transitionM: 2 },
    ]);
    field.ensureChunkRange(0, 0, 2, 2);
    const rebuilt = field.updateRegions([
      { centerX: 16, centerZ: 24, radiusM: 3, heightM: 2, transitionM: 2 },
    ]);
    expect(rebuilt).toContain("0,1");
    expect(rebuilt).toContain("1,1");
    expect(rebuilt).not.toContain("2,2");
  });

  it("全局参数(seed)变化使已缓存块全部重建,未变化调用零重建", () => {
    const field = new TerrainField(baseParameters, []);
    field.ensureChunkRange(0, 0, 1, 1);
    const rebuilt = field.updateParameters({ seed: baseParameters.seed + 7 });
    expect(rebuilt.sort()).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    expect(field.updateParameters({ seed: baseParameters.seed + 7 })).toEqual([]);
    expect(field.updateParameters({})).toEqual([]);
    expect(field.stats.rebuildCount).toBe(4);
  });

  it("algorithmVersion 禁止原地热改,generationVersion 随输入敏感变化", () => {
    const field = new TerrainField(baseParameters, [{ centerX: 0, centerZ: 0, radiusM: 5, heightM: 1, transitionM: 1 }]);
    const version = field.generationVersion;
    expect(() => field.updateParameters({ algorithmVersion: "rogue" })).toThrow();
    expect(field.generationVersion).toBe(version);
    const sameParams = new TerrainField(baseParameters, [{ centerX: 0, centerZ: 0, radiusM: 5, heightM: 1, transitionM: 1 }]);
    expect(sameParams.generationVersion).toBe(version);
    const shifted = new TerrainField(baseParameters, [{ centerX: 0, centerZ: 1, radiusM: 5, heightM: 1, transitionM: 1 }]);
    expect(shifted.generationVersion).not.toBe(version);
    const seeded = new TerrainField({ ...baseParameters, seed: 1 }, []);
    expect(seeded.generationVersion).not.toBe(new TerrainField(baseParameters, []).generationVersion);
  });

  it("块缓存惰性构建:未请求的块不产生构建成本", () => {
    const field = new TerrainField(baseParameters, []);
    field.getChunk(3, -2);
    expect(field.stats.cachedChunkCount).toBe(1);
    expect(field.getChunk(3, -2)).toBe(field.getChunk(3, -2));
    expect(field.stats.cachedChunkCount).toBe(1);
  });
});
