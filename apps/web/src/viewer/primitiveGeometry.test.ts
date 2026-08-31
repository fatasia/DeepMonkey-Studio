import { describe, expect, it, vi } from "vitest";
import { isSharedPrimitiveGeometry, PrimitiveGeometryCache, primitiveGeometry, primitiveGroundOffset, primitiveKindName } from "./primitiveGeometry";

describe("primitive geometry", () => {
  it("keeps authored primitive names and ground offsets stable", () => {
    expect(primitiveKindName("capsule")).toBe("胶囊体");
    expect(primitiveGroundOffset("plane")).toBe(0.01);
    const geometry = primitiveGeometry("box");
    const position = geometry.getAttribute("position");
    expect(position).toBeDefined();
    expect(position!.count).toBeGreaterThan(0);
    geometry.dispose();
  });

  it("reuses geometry within one viewer and releases it only with the cache", () => {
    const cache = new PrimitiveGeometryCache();
    const first = cache.get("box");
    const dispose = vi.spyOn(first, "dispose");
    expect(cache.get("box")).toBe(first);
    expect(cache.get("sphere")).not.toBe(first);
    expect(cache.size()).toBe(2);
    expect(isSharedPrimitiveGeometry(first)).toBe(true);

    cache.dispose();
    expect(cache.size()).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(isSharedPrimitiveGeometry(first)).toBe(false);
  });
});
