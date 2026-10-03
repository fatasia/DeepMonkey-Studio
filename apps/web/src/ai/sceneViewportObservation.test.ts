import { describe, expect, it } from "vitest";
import { analyzePixels } from "./sceneViewportObservation";

const solid = (width: number, height: number, rgb: [number, number, number]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...rgb, 255], i * 4);
  return data;
};

describe("viewport pixel metrics", () => {
  it("an empty background has zero content and uniform luma", () => {
    const metrics = analyzePixels(solid(9, 9, [10, 20, 30]), 9, 9);
    expect(metrics.contentRatio).toBe(0);
    expect(new Set(metrics.grid).size).toBe(1);
    expect(metrics.meanLuma).toBeGreaterThan(5);
    expect(metrics.meanLuma).toBeLessThan(10);
  });

  it("a bright block on dark background is counted as content in the right grid cell", () => {
    const w = 9, h = 9, data = solid(w, h, [0, 0, 0]);
    for (let y = 3; y < 6; y += 1) for (let x = 3; x < 6; x += 1) data.set([255, 255, 255, 255], (y * w + x) * 4);
    const metrics = analyzePixels(data, w, h);
    expect(metrics.contentRatio).toBeCloseTo(9 / 81, 3);
    expect(metrics.grid[4]).toBe(100);
    expect(metrics.grid[0]).toBe(0);
  });
});
