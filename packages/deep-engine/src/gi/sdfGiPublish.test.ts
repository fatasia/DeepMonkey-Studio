import { describe, expect, it } from "vitest";
import { bakeSdfSceneGrid, type SdfSceneBakeInstance } from "./sdfSceneBake.js";
import { deriveSdfGiProbeLattice } from "./sdfGiSceneAdapter.js";
import { probeLatticeBounds, resolveSdfGiBakeCellSize, bakeSdfSceneWithRetries } from "./sdfGiBakePlan.js";
import { flattenWorldTriangles, packBakeParams } from "./sdfSceneBakeGpu.js";
import { sdfGiPublishLevel, packSdfGiPublishParams, halfFloatBits, quantizeHalf,
  expectedSdfGiVolumeTexel, expectedSdfGiMomentLanes } from "./sdfGiPublish.js";
import { packProbeLevels } from "../lighting/probeClipmapResourceData.js";
import { SDF_BAKE_SCENE_GRID_PARAMS_BYTES, SDF_BAKE_SCENE_GRID_TRIANGLE_VEC4S } from "./sdfBakeSceneGridWgsl.js";
import { SDF_GI_PUBLISH_PARAMS_BYTES } from "./sdfGiPublishWgsl.js";

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

describe("Brief-GI M3 GPU 烘焙展平层(CPU 驱动侧)", () => {
  it("展平的格几何与 bakeSdfSceneGrid 同输入逐值一致(bounds/dimensions/exterior)", () => {
    const instances = [box([0, 0, 0], [2, 1, 2], "a"), box([1.5, 0, 0], [3.5, 2, 2], "b")];
    const cellSize = 0.25;
    const cpu = bakeSdfSceneGrid(instances, { cellSize });
    const flat = flattenWorldTriangles(instances, cellSize, "aabb");
    expect(flat).toBeDefined();
    expect([...flat!.bounds.min]).toEqual([...cpu.grid.origin]);
    expect([...flat!.dimensions]).toEqual([...cpu.report.dimensions]);
    expect(flat!.exteriorDistance).toBe(cpu.report.exteriorDistance);
    expect(flat!.cells).toBe(cpu.grid.distances.length);
    // 三角形数 = 全静态实例三角形总和;动态实例排除。
    expect(flat!.triangleCount).toBe(24);
    const withDynamic = flattenWorldTriangles(
      [instances[0]!, box([9, 9, 9], [10, 10, 10], "mover", true)], cellSize, "aabb");
    expect(withDynamic!.triangleCount).toBe(12);
    expect(withDynamic!.excludedDynamicCount).toBe(1);
  });

  it("域编码:aabb 域 = AABB ± cellSize 外推圈(bakeInstanceGrid 同式);scene 域 = 全域", () => {
    const instances = [box([1, 0, 1], [3, 2, 3], "solo")];
    const cellSize = 0.2;
    const flat = flattenWorldTriangles(instances, cellSize, "aabb")!;
    // 每三角形 5 vec4:域行 = vec4[3](origin,dimX) / vec4[4](dimY,dimZ)。
    const words = flat.triangles;
    const originX = words[12]!, originY = words[13]!, originZ = words[14]!, dimX = words[15]!;
    const dimY = words[16]!, dimZ = words[17]!;
    expect([originX, originY, originZ]).toEqual([
      Math.fround(1 - cellSize), Math.fround(0 - cellSize), Math.fround(1 - cellSize)]);
    const scene = flattenWorldTriangles(instances, cellSize, "scene")!;
    const sceneWords = scene.triangles;
    expect([sceneWords[12]!, sceneWords[13]!, sceneWords[14]!]).toEqual([...scene.bounds.min]);
    expect(sceneWords[15]!).toBe(scene.dimensions[0]);
    // 域维度按 bakeInstanceGrid 同式复算(f32 origin 参与运算,不手写数值):
    expect([dimY, dimZ]).toEqual([
      Math.ceil((2 + cellSize - originY) / cellSize) + 1,
      Math.ceil((3 + cellSize - originZ) / cellSize) + 1,
    ]);
  });

  it("BakeParams 打包与 WGSL struct 布局逐字互钉(64B;origin 对齐 16)", () => {
    const flat = flattenWorldTriangles([box([0, 0, 0], [2, 1, 2], "a")], 0.25, "aabb")!;
    const words = new DataView(packBakeParams(flat, 0.25));
    expect(packBakeParams(flat, 0.25).byteLength).toBe(SDF_BAKE_SCENE_GRID_PARAMS_BYTES);
    expect(words.getUint32(0, true)).toBe(flat.dimensions[0]);
    expect(words.getUint32(4, true)).toBe(flat.dimensions[1]);
    expect(words.getUint32(8, true)).toBe(flat.dimensions[2]);
    expect(words.getUint32(12, true)).toBe(flat.triangleCount);
    expect(words.getFloat32(16, true)).toBe(0.25);
    expect(words.getFloat32(32, true)).toBe(flat.bounds.min[0]);
    expect(words.getFloat32(36, true)).toBe(flat.bounds.min[1]);
    expect(words.getFloat32(40, true)).toBe(flat.bounds.min[2]);
    expect(words.getFloat32(44, true)).toBe(flat.exteriorDistance);
    expect(words.getUint32(48, true)).toBe(flat.cells);
    // 三角形行距 = 5 vec4(80B)。
    expect(SDF_BAKE_SCENE_GRID_TRIANGLE_VEC4S).toBe(5);
  });

  it("resolveSdfGiBakeCellSize:场景最长边/64 基准 + [0.05,1] 钳制(确定性)", () => {
    const instances = [box([0, 0, 0], [64, 1, 1], "long")];
    expect(resolveSdfGiBakeCellSize(instances, undefined)).toBe(1);
    expect(resolveSdfGiBakeCellSize([box([0, 0, 0], [0.64, 1, 1], "small")], undefined)).toBeCloseTo(0.05, 6);
    expect(resolveSdfGiBakeCellSize(instances, 0.5)).toBe(0.5);
  });

  it("bakeSdfSceneWithRetries 保持 CPU 增量路径语义(缓存命中逐位复用)", () => {
    const instances = [box([0, 0, 0], [2, 1, 2], "a")];
    const cache = { entries: new Map() };
    const first = bakeSdfSceneWithRetries(instances, { cellSize: 0.25, instanceDomain: "aabb" });
    const cacheFirst = bakeSdfSceneGrid(instances, { cellSize: 0.25, cache });
    const cacheSecond = bakeSdfSceneGrid(instances, { cellSize: 0.25, cache });
    expect(cacheSecond.report.cachedCount).toBe(1);
    expect(cacheSecond.grid.distances).toEqual(cacheFirst.grid.distances);
    expect(first.bake.grid.distances.length).toBe(cacheFirst.grid.distances.length);
  });
});

describe("Brief-GI M3 探针消费发布(CPU 镜像/打包面)", () => {
  it("sdfGiPublishLevel 构造与探针格内缩半格合同一致(采样域 = lattice 边界)", () => {
    const instances = [box([0, 0, 0], [6, 2, 4], "room")];
    const bake = bakeSdfSceneGrid(instances, { cellSize: 0.25 });
    const bounds = probeLatticeBounds(bake.grid);
    const lattice = deriveSdfGiProbeLattice(bounds, 1, 4096);
    const level = sdfGiPublishLevel(lattice.positions[0]!, lattice.spacing, lattice.dimensions);
    expect(level.level).toBe(0);
    expect(level.probeCount).toBe(lattice.dimensions[0]! * lattice.dimensions[1]! * lattice.dimensions[2]!);
    expect(level.probeCount).toBe(lattice.positions.length);
    // max = origin + (dims−1)×spacing:deriveSdfGiProbeLattice 的最后位置恒达此界。
    for (let axis = 0; axis < 3; axis++) {
      expect(level.max[axis]).toBeCloseTo(
        bounds.min[axis]! + (lattice.dimensions[axis]! - 1) * lattice.spacing, 5);
    }
    // metadata 单层打包与 F5 packProbeLevels 同源(单层 64B;发布 buffer 仍分配 256B
    // 的 DeepGiTextureLevelBlock,层 1..3 全零 = originSpacing.w=0 → 采样端不可用)。
    expect(packProbeLevels([level]).byteLength).toBe(64);
  });

  it("PublishParams 打包与 WGSL struct 布局互钉(32B,u32 位型;probeCount 落 @12)", () => {
    const words = packSdfGiPublishParams([9, 4, 7], 252);
    expect(words.byteLength).toBe(SDF_GI_PUBLISH_PARAMS_BYTES);
    expect(words).toEqual(new Uint32Array([9, 4, 7, 252, 6, 4, 0, 0]));
  });

  it("f16 量化参考:round-to-nearest-even 与已知位型逐值一致", () => {
    expect(halfFloatBits(1)).toBe(0x3c00);
    expect(halfFloatBits(0.5)).toBe(0x3800);
    expect(halfFloatBits(2)).toBe(0x4000);
    expect(halfFloatBits(65504)).toBe(0x7bff);
    expect(halfFloatBits(-1)).toBe(0xbc00);
    // 中点舍入到偶数:
    expect(halfFloatBits(1 + 2 ** -12)).toBe(0x3c00);      // 1 + 0.5ulp → 偶数尾
    expect(halfFloatBits(1 + 3 * 2 ** -12)).toBe(0x3c01);  // 上中点进位
    expect(quantizeHalf(1)).toBe(1);
    expect(quantizeHalf(0.1)).toBe(0.0999755859375); // f16 0x2E66(RNE 最近值)
    // 表示边界:65520 恰在 65504/65536 中点,RNE 向偶数尾 → inf;65512 → 65504。
    expect(quantizeHalf(65512)).toBe(65504);
    expect(quantizeHalf(65520)).toBe(Infinity);
  });

  it("期望 texel:volume = record vec4[0] 经 f16 量化;moments lane0 = vec4[1].xyz + 1", () => {
    const record = { irradiance: [0.25, 1.5, 3] as const, validity: 1,
      meanDistance: 2.5, distanceVariance: 0.75, occlusionFloor: 0.5 };
    const volume = expectedSdfGiVolumeTexel(record);
    expect(volume[0]).toBe(quantizeHalf(0.25));
    expect(volume[3]).toBe(1);
    const moments = expectedSdfGiMomentLanes(record);
    expect(moments).toEqual([2.5, 0.75, 0.5, 1]);
  });
});
