import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLegacyModel } from "./legacyModelLoader";

afterEach(() => vi.unstubAllGlobals());

describe("legacy model loader", () => {
  it("parses OBJ geometry through the shared asset boundary", async () => {
    stubAsset("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");

    const result = await loadLegacyModel("obj", "/assets/triangle.obj");

    expect(result.object.children).toHaveLength(1);
    expect(result.animations).toEqual([]);
  });

  it("parses ASCII STL and creates a visible physical material", async () => {
    stubAsset("solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t");

    const result = await loadLegacyModel("stl", "/assets/triangle.stl");
    const mesh = result.object;

    expect(mesh.name).toBe("STL 模型");
    expect("geometry" in mesh).toBe(true);
  });
});

function stubAsset(source: string): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { status: 200 })));
}
