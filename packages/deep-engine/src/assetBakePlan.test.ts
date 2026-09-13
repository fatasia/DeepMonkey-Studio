import { describe, expect, it } from "vitest";
import { bakeRenderPacket } from "./assetBakePlan.js";

const packet = () => ({ geometries: [{ id: "box", revision: 1,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) }], materials: [{ id: "mat", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 0.5 }], textures: [] });

describe("Deep asset bake artifact", () => {
  it("builds deterministic meshlet and indirect-index artifacts", () => {
    const first = bakeRenderPacket(packet()), second = bakeRenderPacket(packet());
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.geometries[0]).toMatchObject({ id: "box", revision: 1, meshletHash: expect.any(String) });
    expect(first.geometryPlans[0]).toMatchObject({ triangleCount: 1, meshletCount: 1, expandedIndexCount: 3 });
    expect(first.staticLighting).toBe("probe-hybrid");
  });

  it("changes cache identity when geometry content or recipe changes", () => {
    const base = bakeRenderPacket(packet()), changed = packet(); changed.geometries[0]!.vertices[0] = 0.25;
    expect(bakeRenderPacket(changed).cacheKey).not.toBe(base.cacheKey);
    expect(bakeRenderPacket(packet(), { recipeVersion: "next" }).cacheKey).not.toBe(base.cacheKey);
    expect(bakeRenderPacket(packet(), { quality: "performance" }).geometries[0]!.meshlets.maxTriangles).toBe(64);
  });

  it("rejects malformed geometry stride and quality", () => {
    expect(() => bakeRenderPacket({ ...packet(), geometries: [{ ...packet().geometries[0]!, vertices: new Float32Array(3) }] })).toThrow("stride");
    expect(() => bakeRenderPacket(packet(), { quality: "ultra" as never })).toThrow("quality");
  });
});
