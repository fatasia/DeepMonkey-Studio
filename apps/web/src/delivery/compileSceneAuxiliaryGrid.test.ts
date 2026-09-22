import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "@bim-studio/deep-engine";
import { compileSceneAuxiliaryGrid } from "./compileSceneAuxiliaryGrid";

describe("published scene auxiliary grid", () => {
  it("is zero-cost while hidden and emits bounded, sharp Native geometry while visible", () => {
    expect(compileSceneAuxiliaryGrid(false)).toEqual({ geometries: [], materials: [], instances: [] });
    const grid = compileSceneAuxiliaryGrid(true, { x: -1000, y: 0, z: 2000 });
    expect(grid.geometries).toHaveLength(4);
    expect(grid.materials).toHaveLength(4);
    expect(grid.instances).toHaveLength(4);
    expect(grid.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0)).toBe(804);
    expect(grid.geometries.reduce((sum, geometry) => sum + geometry.vertices.byteLength + geometry.indices.byteLength, 0))
      .toBeLessThan(64 * 1024);
    expect(Array.from(grid.instances[0]!.transform).slice(12, 15)).toEqual([-1000, 0, 2000]);
    expect(() => prepareRenderPacket(grid)).not.toThrow();
  });
});
