import { describe, expect, it } from "vitest";
import { initialThumbnailCrop, thumbnailSourceRect } from "./thumbnailCrop";

describe("thumbnail crop geometry", () => {
  it("fits portrait and landscape images to a centered 4:3 crop", () => {
    expect(thumbnailSourceRect(1600, 900, initialThumbnailCrop)).toEqual({ x: 200, y: 0, width: 1200, height: 900 });
    expect(thumbnailSourceRect(600, 1200, initialThumbnailCrop)).toEqual({ x: 0, y: 375, width: 600, height: 450 });
  });
  it("keeps zoomed and panned crops inside the source, including extreme inputs", () => {
    for (const crop of [{ zoom: 4, x: 1, y: 0 }, { zoom: -1, x: -5, y: 9 }, { zoom: NaN, x: NaN, y: Infinity }]) {
      const rect = thumbnailSourceRect(600, 1200, crop);
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(600); expect(rect.y + rect.height).toBeLessThanOrEqual(1200);
      expect(rect.width / rect.height).toBeCloseTo(4 / 3);
    }
  });
  it("rejects unusable image dimensions", () => {
    expect(() => thumbnailSourceRect(0, 2, initialThumbnailCrop)).toThrow();
    expect(() => thumbnailSourceRect(Infinity, 2, initialThumbnailCrop)).toThrow();
  });
});
