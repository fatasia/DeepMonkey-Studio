import { describe, expect, it } from "vitest";
import { denoiseTexture, dilateTexture } from "./lightmapTexture";

describe("lightmap texture post-processing", () => {
  it("expands a covered texel to its four direct neighbours", () => {
    const resolution = 5;
    const pixels = new Uint8ClampedArray(resolution * resolution * 4);
    const covered = new Uint8Array(resolution * resolution);
    const center = 2 * resolution + 2;
    pixels.set([12, 34, 56, 255], center * 4);
    covered[center] = 1;

    dilateTexture(pixels, covered, resolution, 1);

    for (const index of [center - 1, center + 1, center - resolution, center + resolution]) {
      expect(Array.from(pixels.subarray(index * 4, index * 4 + 4))).toEqual([12, 34, 56, 255]);
      expect(covered[index]).toBe(1);
    }
    expect(covered[0]).toBe(0);
  });

  it("smooths covered outliers without changing uncovered texels", () => {
    const resolution = 5;
    const pixels = new Uint8ClampedArray(resolution * resolution * 4);
    const covered = new Uint8Array(resolution * resolution);
    for (let y = 1; y <= 3; y += 1) for (let x = 1; x <= 3; x += 1) {
      const index = y * resolution + x;
      pixels.set([40, 40, 40, 255], index * 4);
      covered[index] = 1;
    }
    const center = 2 * resolution + 2;
    pixels.set([255, 255, 255, 255], center * 4);
    const uncovered = 2 * resolution + 3;
    pixels.set([73, 74, 75, 255], uncovered * 4);
    covered[uncovered] = 0;

    denoiseTexture(pixels, covered, resolution, 1);

    expect(pixels[center * 4]).toBeLessThan(255);
    expect(pixels[center * 4]).toBeGreaterThan(40);
    expect(Array.from(pixels.subarray(uncovered * 4, uncovered * 4 + 4))).toEqual([73, 74, 75, 255]);
  });
});
