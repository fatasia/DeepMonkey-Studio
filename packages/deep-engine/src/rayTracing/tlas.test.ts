import { describe, expect, it } from "vitest";
import { buildTlas, invertAffine3x4, traceTlasClosest } from "./tlas.js";
import { buildTracedScene, traceClosest, type TraceQuery } from "./rayTrace.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

function unitBlas(id: string, offsetX = 0, offsetY = 0): RayBlasDescriptor {
  const vertices = new Float32Array([
    -1 + offsetX, -1 + offsetY, 0, 1 + offsetX, -1 + offsetY, 0,
    1 + offsetX, 1 + offsetY, 0, -1 + offsetX, 1 + offsetY, 0,
  ]);
  return { id, vertices, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

describe("tlas instance layer", () => {
  it("hits the nearest instance across two translated quads", () => {
    const tlas = buildTlas([
      { id: "near", blas: unitBlas("near"), worldToLocal: IDENTITY, mask: 1 },
      { id: "far", blas: unitBlas("far", 0, 0), worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5], mask: 1 },
    ]);
    const hit = traceTlasClosest(tlas, { ox: 0, oy: 0, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 64 });
    expect(hit).toBeDefined();
    expect(hit!.instanceId).toBe("near");
    expect(hit!.t).toBeCloseTo(5, 5);
  });

  it("honours instance translation and mask filtering", () => {
    const tlas = buildTlas([
      { id: "masked-away", blas: unitBlas("a"), worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -5], mask: 0b10 },
      { id: "visible", blas: unitBlas("b"), worldToLocal: IDENTITY, mask: 0b01 },
    ]);
    const hit = traceTlasClosest(tlas, { ox: 0, oy: 0, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 64 }, 0b01);
    expect(hit!.instanceId).toBe("visible");
  });

  it("scales t back to world units under non-uniform transform", () => {
    // local z 缩放 2：世界 oz=10、局部 oz=5（|worldDir|=|localDir|=1）→ 世界 t 与局部 t 相同。
    const scaled = buildTlas([
      { id: "scaled", blas: unitBlas("s"), worldToLocal: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0], mask: 1 },
    ]);
    const hit = traceTlasClosest(scaled, { ox: 0, oy: 0, oz: 10, dx: 0, dy: 0, dz: -1, tMax: 64 });
    expect(hit).toBeDefined();
    expect(hit!.t).toBeCloseTo(10, 5);
  });

  it("returns undefined when nothing is hit", () => {
    const tlas = buildTlas([{ id: "quad", blas: unitBlas("q"), worldToLocal: IDENTITY, mask: 1 }]);
    expect(traceTlasClosest(tlas, { ox: 0, oy: 0, oz: 5, dx: 0, dy: 0, dz: 1, tMax: 64 })).toBeUndefined();
  });

  // —— TLAS WGSL 扩展（实例层布局/盒剪枝）锚定的 CPU 侧合同 ——
  it("inverts the world-to-local affine exactly", () => {
    const worldToLocal = [0.5, 0, 0, 3, 0, 2, 0, -4, 1, 1, 1, 5];
    const localToWorld = invertAffine3x4(worldToLocal);
    for (const point of [[1, 2, 3], [-7, 0.5, 11], [0, 0, 0]]) {
      const local = applyMatrix(worldToLocal, point);
      const world = applyMatrix(localToWorld, local);
      expect(world[0]).toBeCloseTo(point[0]!, 9);
      expect(world[1]).toBeCloseTo(point[1]!, 9);
      expect(world[2]).toBeCloseTo(point[2]!, 9);
    }
    expect(() => invertAffine3x4([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0])).toThrow("singular");
  });

  it("reports true world-space instance bounds (localToWorld direction)", () => {
    // worldToLocal z+5 ⇒ 实例世界位置 z=-5（世界 = 局部 - 5），非 worldToLocal 直施的 +5。
    const tlas = buildTlas([
      { id: "near", blas: unitBlas("near"), worldToLocal: IDENTITY, mask: 1 },
      { id: "far", blas: unitBlas("far"), worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5], mask: 1 },
      { id: "empty", blas: { id: "empty", vertices: new Float32Array(0), indices: new Uint32Array(0) },
        worldToLocal: IDENTITY, mask: 1 },
    ]);
    expect(tlas.instanceBounds[0]).toEqual({ minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 0 });
    expect(tlas.instanceBounds[1]).toEqual({ minX: -1, minY: -1, minZ: -5, maxX: 1, maxY: 1, maxZ: -5 });
    expect(tlas.instanceBounds[2]).toBeUndefined();
  });

  it("world bounds survive a non-uniform scale in world terms", () => {
    // worldToLocal = 0.5×（即世界 = 2×局部）：局部 [-1,1] 实际世界盒为 [-2,2]。
    const tlas = buildTlas([{ id: "scaled", blas: unitBlas("s"), worldToLocal: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0], mask: 1 }]);
    expect(tlas.instanceBounds[0]).toEqual({ minX: -2, minY: -2, minZ: 0, maxX: 2, maxY: 2, maxZ: 0 });
  });

  it("identity transform: two-level CPU trace equals the single-BLAS reference ray for ray", () => {
    const grid: RayBlasDescriptor = {
      id: "identity-grid",
      vertices: new Float32Array(Array.from({ length: 75 }, (_, i) => ((i * 37) % 11) - 5)),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]),
    };
    const scene = buildTracedScene(grid);
    const tlas = buildTlas([{ id: "solo", blas: grid, worldToLocal: IDENTITY, mask: 1 }]);
    const queries: TraceQuery[] = [];
    for (let step = 0; step < 32; step++) {
      const angle = step / 32 * Math.PI * 2;
      queries.push({ ox: 0, oy: 0, oz: 6, dx: Math.cos(angle), dy: Math.sin(angle), dz: -1, tMax: 64 });
    }
    queries.forEach((query, index) => {
      const single = traceClosest(scene, query);
      const twoLevel = traceTlasClosest(tlas, query);
      expect((single === undefined) !== (twoLevel === undefined), `ray ${index} hit agreement`).toBe(false);
      if (single !== undefined && twoLevel !== undefined) {
        expect(twoLevel.primitiveIndex).toBe(single.primitiveIndex);
        expect(twoLevel.t).toBeCloseTo(single.t, 9);
        expect(twoLevel.instanceId).toBe("solo");
      }
    });
  });
});

function applyMatrix(m: readonly number[], point: readonly number[]): [number, number, number] {
  return [m[0]! * point[0]! + m[1]! * point[1]! + m[2]! * point[2]! + m[3]!,
    m[4]! * point[0]! + m[5]! * point[1]! + m[6]! * point[2]! + m[7]!,
    m[8]! * point[0]! + m[9]! * point[1]! + m[10]! * point[2]! + m[11]!];
}
