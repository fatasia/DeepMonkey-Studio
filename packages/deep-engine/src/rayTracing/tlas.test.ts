import { describe, expect, it } from "vitest";
import { buildTlas, traceTlasClosest } from "./tlas.js";
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
});
