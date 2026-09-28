import { describe, expect, it } from "vitest";
import {
  recomputeVertexNormals,
  type NormalRecomputeInput,
} from "./meshNormalRecompute.js";

/** 单位立方体六面,每面独立顶点与外法线(硬边参照)。 */
function boxWithFaceNormals(): NormalRecomputeInput {
  const face = (
    origin: [number, number, number],
    u: [number, number, number],
    v: [number, number, number],
    normal: [number, number, number],
  ): { positions: number[]; indices: number[]; normals: number[] } => {
    const base = faceVertexCursor;
    const corner = (du: number, dv: number): number[] => [
      origin[0] + u[0] * du + v[0] * dv,
      origin[1] + u[1] * du + v[1] * dv,
      origin[2] + u[2] * du + v[2] * dv,
    ];
    positions.push(...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 1));
    for (let offset = 0; offset < 4; offset += 1) normals.push(...normal);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faceVertexCursor += 4;
    return { positions, indices, normals };
  };
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  let faceVertexCursor = 0;
  face([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]);
  face([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
  face([0, 0, 0], [0, 0, 1], [0, 1, 0], [-1, 0, 0]);
  face([1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  face([0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, -1]);
  face([0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  return { primitiveId: "box", positions, indices, normals };
}

/** 单位球经纬网格(共享顶点,平滑参照),顶点位置即源法线。 */
function uvSphere(segments = 32, rings = 16): NormalRecomputeInput {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * stride + segment;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (ring !== 0) indices.push(a, b, c);
      if (ring !== rings - 1) indices.push(b, d, c);
    }
  }
  return { primitiveId: "sphere", positions, indices };
}

describe("T12 法线重算", () => {
  it("立方体硬边保持:重算法线与源法线零偏差,六个面各自法线独立", async () => {
    const box = boxWithFaceNormals();
    for (const weighting of ["area", "angle"] as const) {
      const result = await recomputeVertexNormals(box, { weighting });
      // 簇 = (位置, 源法线) 组:每面四角位置不同 → 24 簇;但法线只有 6 个方向。
      expect(result.smoothClusters).toBe(24);
      expect(result.maxDeviationDegrees).toBeLessThan(1e-4);
      expect(result.meanDeviationDegrees).toBeLessThan(1e-4);
      expect(result.vertexCount).toBe(24);
      const distinctNormals = new Set<string>();
      for (let vertex = 0; vertex < 24; vertex += 1) {
        const offset = vertex * 3;
        const length = Math.hypot(
          result.normals[offset]!, result.normals[offset + 1]!, result.normals[offset + 2]!);
        expect(length).toBeCloseTo(1, 6);
        distinctNormals.add([0, 1, 2].map((axis) => result.normals[offset + axis]!.toFixed(5)).join(","));
      }
      expect(distinctNormals.size).toBe(6);
      expect(result.normals.slice(0, 3)).toEqual(Float32Array.from([0, -1, 0]));
    }
  });

  it("球体共享顶点:极点同簇法线一致,重算法线近似径向源法线", async () => {
    const sphere = uvSphere();
    const result = await recomputeVertexNormals(sphere, { weighting: "area" });
    expect(result.smoothClusters).toBeGreaterThan(60);
    expect(result.hadSourceNormals).toBe(false);
    expect(result.maxDeviationDegrees).toBeNull();
    expect(result.validTriangleCount).toBe(result.triangleCount);
    // 极点(ring 0,sin(0)=0 精确)13 个重复顶点同位置同簇 → 重算法线完全一致。
    const stride = 13;
    for (let segment = 1; segment < stride; segment += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(result.normals[segment * 3 + axis]!).toBe(result.normals[axis]!);
      }
    }
    // 球面重算法线与径向方向的夹角有界:32×16 经纬球实测 ~5.9°(极圈三角收拢导致 O(h) 收敛,
    // 面积/角加权实测接近,见 T12 几何报告);跳过零长法线(浮点极点收拢顶点,如实为零向量)。
    let maxRadialDeviation = 0;
    for (let vertex = 0; vertex < result.vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const normalLength = Math.hypot(result.normals[offset]!, result.normals[offset + 1]!, result.normals[offset + 2]!);
      if (normalLength === 0) continue;
      const positionLength = Math.hypot(
        sphere.positions[offset]!, sphere.positions[offset + 1]!, sphere.positions[offset + 2]!);
      if (positionLength === 0) continue;
      const dot = result.normals[offset]! * sphere.positions[offset]! / positionLength
        + result.normals[offset + 1]! * sphere.positions[offset + 1]! / positionLength
        + result.normals[offset + 2]! * sphere.positions[offset + 2]! / positionLength;
      maxRadialDeviation = Math.max(maxRadialDeviation, Math.acos(Math.min(1, dot)) * (180 / Math.PI));
    }
    expect(maxRadialDeviation).toBeLessThan(8);
  });

  it("同位置不同源法线保持硬边:两片对折面不互相渗透", async () => {
    // 两个三角形共享折线 (0,1),四个顶点、四个法线(上片朝上、下片朝下)。
    const input: NormalRecomputeInput = {
      primitiveId: "fold",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 3]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1]),
    };
    const result = await recomputeVertexNormals(input, { weighting: "area" });
    // 簇 = (位置, 源法线) 组:4 个不同位置 → 4 簇;折点两侧靠源法线区分,不合并。
    expect(result.smoothClusters).toBe(4);
    expect(result.maxDeviationDegrees).toBeLessThan(1e-4);
    // 共享折线两侧:上片法线保持 (0,0,1),未被下片 (-1) 稀释。
    expect(result.normals.slice(0, 3)).toEqual(Float32Array.from([0, 0, 1]));
    expect(result.normals.slice(3, 6)).toEqual(Float32Array.from([0, 0, 1]));
    expect(result.normals.slice(9, 12)).toEqual(Float32Array.from([0, 0, -1]));
  });

  it("面积加权与角加权在非均匀网格上产生可测差异且均为单位向量", async () => {
    // 拉长三角形 + 小三角形共享扇心,位置连续、无源法线(按位置聚簇)。
    const input: NormalRecomputeInput = {
      primitiveId: "nonuniform",
      positions: Float32Array.from([0, 0, 0, 10, 0, 0, 5, 0.1, 0, 5, 0, 1, 4, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 3, 2, 0, 4, 3]),
    };
    const area = await recomputeVertexNormals(input, { weighting: "area" });
    const angle = await recomputeVertexNormals(input, { weighting: "angle" });
    expect(area.smoothClusters).toBe(5);
    expect(angle.smoothClusters).toBe(5);
    expect(Array.from(area.normals)).not.toEqual(Array.from(angle.normals));
    for (const result of [area, angle]) {
      for (let offset = 0; offset < result.normals.length; offset += 3) {
        const length = Math.hypot(
          result.normals[offset]!, result.normals[offset + 1]!, result.normals[offset + 2]!);
        expect(length).toBeCloseTo(1, 6);
      }
    }
  });

  it("退化三角形不参与,孤立顶点回落为源法线并计数", async () => {
    const input: NormalRecomputeInput = {
      primitiveId: "degenerate",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 3, 1]),
      normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    };
    const result = await recomputeVertexNormals(input, { weighting: "area" });
    expect(result.validTriangleCount).toBe(1);
    expect(result.triangleCount).toBe(2);
    // 顶点 2 只邻接退化三角形,累加为零,回落到源法线。
    expect(result.normals.slice(6, 9)).toEqual(Float32Array.from([0, 1, 0]));
    expect(result.maxDeviationDegrees).toBeLessThan(1e-4);
  });

  it("畸形输入显式抛错而非产出脏法线", async () => {
    await expect(recomputeVertexNormals({
      primitiveId: "bad", positions: Float32Array.from([0, 0, 0, 1]), indices: Uint32Array.from([0, 0, 0]),
    })).rejects.toThrow("POSITION 长度不是 3 的倍数");
    await expect(recomputeVertexNormals({
      primitiveId: "bad-index", positions: Float32Array.from([0, 0, 0, 1, 0, 0]), indices: Uint32Array.from([0, 1, 0, 1]),
    })).rejects.toThrow("索引长度不是 3 的倍数");
  });

  it("同输入两次重算逐字节一致(确定性)", async () => {
    const sphere = uvSphere(16, 8);
    const first = await recomputeVertexNormals(sphere, { weighting: "angle" });
    const second = await recomputeVertexNormals(sphere, { weighting: "angle" });
    expect(Buffer.from(second.normals.buffer).equals(Buffer.from(first.normals.buffer))).toBe(true);
    expect(second.maxDeviationDegrees).toBe(first.maxDeviationDegrees);
    expect(second.smoothClusters).toBe(first.smoothClusters);
  });
});
