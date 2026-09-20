import { describe, expect, it } from "vitest";
import { createSoftRasterTarget, rasterizeTriangle,
  VISIBILITY_CLEAR_SLOT } from "./softRasterizeReference.js";
import { unpackVisibilityTriangle } from "./visibilityBufferEncoding.js";

interface Tri { ax: number; ay: number; az: number; bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number; slot: number; triangleLocalIndex: number }

/** 独立重心坐标参考（与 scanline 实现不同算法，交叉验证覆盖与深度）。 */
function bruteRaster(target: ReturnType<typeof createSoftRasterTarget>, tri: Tri): void {
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      const px = x + 0.5, py = y + 0.5;
      const denom = (tri.by - tri.cy) * (tri.ax - tri.cx) + (tri.cx - tri.bx) * (tri.ay - tri.cy);
      if (denom === 0) continue;
      const w0 = ((tri.by - tri.cy) * (px - tri.cx) + (tri.cx - tri.bx) * (py - tri.cy)) / denom;
      const w1 = ((tri.cy - tri.ay) * (px - tri.cx) + (tri.ax - tri.cx) * (py - tri.cy)) / denom;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const depth = w0 * tri.az + w1 * tri.bz + w2 * tri.cz;
      const pixel = y * target.width + x;
      if (depth >= target.depth[pixel]!) continue;
      target.depth[pixel] = depth;
      target.slot[pixel] = tri.slot;
      target.packedTriangle[pixel] = (tri.triangleLocalIndex & 0xff) >>> 0;
    }
  }
}

describe("soft rasterize reference", () => {
  const FULL: Tri = { ax: -1, ay: -1, az: 0.5, bx: 2, by: 6, bz: 0.5, cx: 5, cy: -1, cz: 0.5,
    slot: 7, triangleLocalIndex: 3 };

  it("matches the independent barycentric reference across z-fighting scenarios", () => {
    const scenarios: Tri[][] = [
      [FULL],
      [{ ...FULL, az: 0.8, bz: 0.8, cz: 0.8, slot: 1, triangleLocalIndex: 0 }],
      [{ ...FULL, az: 0.8, bz: 0.8, cz: 0.8, slot: 1 },
       { ...FULL, az: 0.2, bz: 0.2, cz: 0.2, slot: 2, triangleLocalIndex: 1 },
       { ...FULL, az: 0.9, bz: 0.9, cz: 0.9, slot: 3, triangleLocalIndex: 2 }],
    ];
    for (const scenario of scenarios) {
      const scanline = createSoftRasterTarget(5, 4);
      const brute = createSoftRasterTarget(5, 4);
      for (const tri of scenario) {
        rasterizeTriangle(scanline, tri);
        bruteRaster(brute, tri);
      }
      for (let pixel = 0; pixel < 20; pixel++) {
        expect(scanline.slot[pixel]).toBe(brute.slot[pixel]);
        expect(scanline.packedTriangle[pixel]).toBe(brute.packedTriangle[pixel]);
        expect(scanline.depth[pixel]).toBeCloseTo(brute.depth[pixel], 5);
      }
    }
  });

  it("covers a known non-empty region and never mutates outside coverage", () => {
    const target = createSoftRasterTarget(5, 4);
    const written = rasterizeTriangle(target, FULL);
    const covered = Array.from(target.slot).filter(slot => slot !== VISIBILITY_CLEAR_SLOT).length;
    expect(covered).toBe(written);
    expect(written).toBeGreaterThan(4);
    expect(written).toBeLessThanOrEqual(20);
    expect(unpackVisibilityTriangle(target.packedTriangle[0] ?? 0xff)).toBe(3);
  });

  it("z-tests with less semantics: closer triangle wins, farther loses", () => {
    const target = createSoftRasterTarget(5, 4);
    rasterizeTriangle(target, { ...FULL, az: 0.8, bz: 0.8, cz: 0.8, slot: 1, triangleLocalIndex: 0 });
    rasterizeTriangle(target, { ...FULL, az: 0.2, bz: 0.2, cz: 0.2, slot: 2, triangleLocalIndex: 1 });
    for (let pixel = 0; pixel < 20; pixel++) {
      if (target.slot[pixel] !== VISIBILITY_CLEAR_SLOT) expect(target.slot[pixel]).toBe(2);
    }
    rasterizeTriangle(target, { ...FULL, az: 0.9, bz: 0.9, cz: 0.9, slot: 3, triangleLocalIndex: 2 });
    for (let pixel = 0; pixel < 20; pixel++) {
      if (target.slot[pixel] !== VISIBILITY_CLEAR_SLOT) expect(target.slot[pixel]).toBe(2);
    }
  });

  it("rejects backface, degenerate triangles, and invalid slots fail-closed", () => {
    const target = createSoftRasterTarget(4, 4);
    expect(rasterizeTriangle(target, { ax: 5, ay: -1, az: 0.5, bx: 2, by: 6, az: 0.5,
      cx: -1, cy: -1, cz: 0.5, slot: 1, triangleLocalIndex: 0 })).toBe(0);
    expect(rasterizeTriangle(target, { ax: 1, ay: 1, az: 0.5, bx: 2, by: 2, az: 0.5,
      cx: 3, cy: 3, cz: 0.5, slot: 1, triangleLocalIndex: 0 })).toBe(0);
    expect(() => rasterizeTriangle(target, { ax: -1, ay: -1, az: 0.5, bx: 2, by: 6, az: 0.5,
      cx: 5, cy: -1, cz: 0.5, slot: VISIBILITY_CLEAR_SLOT, triangleLocalIndex: 0 })).toThrow(RangeError);
  });

  it("rejects invalid dimensions fail-closed", () => {
    expect(() => createSoftRasterTarget(0, 4)).toThrow(RangeError);
  });
});
