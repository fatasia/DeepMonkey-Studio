import { afterEach, describe, expect, it } from "vitest";
import { clearThumbnailCaches, createThumbnailCache, inspectThumbnailCaches, thumbnailCacheGeneration } from "./thumbnailCache";

afterEach(() => clearThumbnailCaches());

describe("thumbnail cache management", () => {
  it("counts only registered rebuildable thumbnail strings", () => {
    const a = createThumbnailCache("test-a");
    const b = createThumbnailCache("test-b");
    a.set("a", "123"); b.set("b", "45");
    expect(inspectThumbnailCaches()).toEqual({ entries: 2, estimatedBytes: 14 });
    expect(clearThumbnailCaches()).toEqual({ entries: 2, estimatedBytes: 14 });
    expect(inspectThumbnailCaches()).toEqual({ entries: 0, estimatedBytes: 0 });
  });

  it("invalidates queued writes even when the cache was already empty", () => {
    const before = thumbnailCacheGeneration();
    clearThumbnailCaches();
    expect(thumbnailCacheGeneration()).not.toBe(before);
    expect(clearThumbnailCaches()).toEqual({ entries: 0, estimatedBytes: 0 });
  });
});
