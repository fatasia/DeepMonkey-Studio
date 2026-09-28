import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSdfCollisionMesh, MAX_SDF_COLLISION_TRIANGLES, sdfColliderPayloadToGrid } from "./sdfCollisionBridge.js";
import { buildSdfGrid, sampleSdfGrid, type SdfMesh } from "./sdfGrid.js";

/** 与 sdfGrid.test.ts 同源凹 L 棱柱(perimeter 在 XY,z 向拉伸 0..1)。 */
function concavePrism(): SdfMesh {
  const perimeter = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  const positions = new Float32Array(perimeter.flatMap(([x, y]) => [x, y, 0, x, y, 1]));
  const indices: number[] = [];
  for (let i = 0; i < perimeter.length; i++) {
    const next = (i + 1) % perimeter.length;
    indices.push(i * 2, next * 2, i * 2 + 1, next * 2, next * 2 + 1, i * 2 + 1);
  }
  for (const [a, b, c, d] of [[0, 3, 4, 5], [0, 1, 2, 3]]) {
    indices.push(a * 2, b * 2, c * 2, a * 2, c * 2, d * 2);
    indices.push(c * 2 + 1, b * 2 + 1, a * 2 + 1, d * 2 + 1, c * 2 + 1, a * 2 + 1);
  }
  return { positions, indices: Uint32Array.from(indices) };
}

const L_GRID = {
  origin: [-0.125, -0.125, -0.125] as const,
  dimensions: [16, 16, 8] as const,
  cellSize: 0.25,
};

function lGrid() {
  return buildSdfGrid(concavePrism(), L_GRID.origin, L_GRID.dimensions, L_GRID.cellSize);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 跨端逐位配对 fixture(native include_str! 同文件对拍);F6_UPDATE_SDF_FIXTURE=1 再生。 */
const FIXTURE_PATH = resolve(__dirname, "../../../deep-engine-native/src/physics_sdf_l_fixture.json");

interface FixtureShape {
  meta: { grid: { origin: number[]; cellSize: number; dimensions: number[] } };
  distances: number[];
  expect: { triangleCount: number; vertexCount: number; positionsSha256: string; indicesSha256: string };
}

function computeExtraction() {
  const grid = lGrid();
  const mesh = extractSdfCollisionMesh(grid);
  return { grid, mesh };
}

describe("SDF → 碰撞网格桥(F6 凹体 Rapier 桥的确定性核)", () => {
  it("凹 L 等值面输出闭合流形:每条棱恰被两个三角形共享", () => {
    const { mesh } = computeExtraction();
    expect(mesh.triangleCount).toBeGreaterThan(100);
    const edgeUse = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const corners = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = corners[e]!, b = corners[(e + 1) % 3]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
    }
    for (const [edge, count] of edgeUse) {
      expect(count, `edge ${edge}`).toBe(2);
    }
  });

  it("等值面顶点落在源 SDF 零面容差内,凹槽内壁顶点真实存在(凸包不具备)", () => {
    const { grid, mesh } = computeExtraction();
    const tolerance = grid.maxSamplingError;
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const distance = sampleSdfGrid(grid, [mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!]);
      expect(Math.abs(distance), `vertex ${v / 3}`).toBeLessThanOrEqual(tolerance);
    }
    // 凹槽内壁:x=1(y∈1..3)与 y=1(x∈1..3)平面必须有顶点,否则球无处可触。
    const onPlane = (axis: number, plane: number) => {
      let count = 0;
      for (let v = axis; v < mesh.positions.length; v += 3) {
        if (Math.abs(mesh.positions[v]! - plane) <= tolerance) count++;
      }
      return count;
    };
    expect(onPlane(0, 1)).toBeGreaterThan(0);
    expect(onPlane(1, 1)).toBeGreaterThan(0);
  });

  it("同输入双跑逐位一致(f32 合同)", () => {
    const first = extractSdfCollisionMesh(lGrid());
    const second = extractSdfCollisionMesh(lGrid());
    expect(second.positions).toEqual(first.positions);
    expect(second.indices).toEqual(first.indices);
  });

  it("预算 fail-closed 与非法输入拒绝", () => {
    expect(() => extractSdfCollisionMesh(lGrid(), { maxTriangles: 10 })).toThrow(/预算/);
    expect(() => extractSdfCollisionMesh(lGrid(), { maxTriangles: 0 })).toThrow(/正整数/);
    const grid = lGrid();
    expect(() => extractSdfCollisionMesh({
      ...grid, dimensions: [1, 4, 4] as unknown as readonly [number, number, number],
    })).toThrow(/有界网格/);
    expect(() => extractSdfCollisionMesh({
      origin: grid.origin, cellSize: grid.cellSize, dimensions: grid.dimensions,
      distances: new Float32Array(grid.distances.length).fill(1),
    })).toThrow(/全场同号/);
    expect(MAX_SDF_COLLISION_TRIANGLES).toBe(65_536);
  });

  it("运行包载荷转 Grid 与跨端 fixture 逐位对拍(native include_str! 同源)", () => {
    const { grid, mesh } = computeExtraction();
    const distances = Array.from(grid.distances);
    // JSON 往返:f32 → number → JSON → parse → f32 必须逐位还原(桥载荷传输前提)。
    const roundTrip = sdfColliderPayloadToGrid({
      origin: grid.origin, cellSize: grid.cellSize, dimensions: grid.dimensions, distances,
    });
    expect(roundTrip.distances).toEqual(grid.distances);

    const extraction = {
      triangleCount: mesh.triangleCount, vertexCount: mesh.vertexCount,
      positionsSha256: sha256(new Uint8Array(mesh.positions.buffer)),
      indicesSha256: sha256(new Uint8Array(mesh.indices.buffer)),
    };
    if (process.env.F6_UPDATE_SDF_FIXTURE) {
      mkdirSync(resolve(FIXTURE_PATH, ".."), { recursive: true });
      writeFileSync(FIXTURE_PATH, JSON.stringify({
        meta: { grid: { origin: grid.origin, cellSize: grid.cellSize, dimensions: grid.dimensions } },
        distances, expect: extraction,
      }, null, 1));
      return;
    }
    expect(existsSync(FIXTURE_PATH), "跨端 fixture 缺失;以 F6_UPDATE_SDF_FIXTURE=1 再生").toBe(true);
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureShape;
    expect(fixture.distances.length).toBe(grid.distances.length);
    expect(Float32Array.from(fixture.distances)).toEqual(grid.distances);
    expect(fixture.expect.triangleCount).toBe(extraction.triangleCount);
    expect(fixture.expect.vertexCount).toBe(extraction.vertexCount);
    expect(fixture.expect.positionsSha256).toBe(extraction.positionsSha256);
    expect(fixture.expect.indicesSha256).toBe(extraction.indicesSha256);
  });
});
