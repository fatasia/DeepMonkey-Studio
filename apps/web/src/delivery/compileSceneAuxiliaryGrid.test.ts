import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "@bim-studio/deep-engine";
import { compileSceneAuxiliaryGrid } from "./compileSceneAuxiliaryGrid";

describe("published scene auxiliary grid", () => {
  it("is zero-cost while hidden and uses bounded mip-filtered coverage while visible", () => {
    expect(compileSceneAuxiliaryGrid(false)).toEqual({ geometries: [], materials: [], instances: [] });
    const grid = compileSceneAuxiliaryGrid(true, { x: -1000, y: 0, z: 2000 });
    expect(grid.geometries).toHaveLength(4);
    expect(grid.materials).toHaveLength(4);
    expect(grid.instances).toHaveLength(4);
    expect(grid.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0)).toBe(8);
    expect(grid.textures).toHaveLength(4);
    expect(grid.textures!.reduce((sum, texture) => sum + texture.data.byteLength
      + texture.mipmaps!.reduce((bytes, mip) => bytes + mip.data.byteLength, 0), 0)).toBeLessThan(1024 * 1024);
    for (const texture of grid.textures!) {
      expect(texture.mipmaps!.at(-1)).toMatchObject({ width: 1, height: 1 });
      expect(texture.sampler).toMatchObject({ mipmapFilter: "linear", maxAnisotropy: 8 });
      expect(texture.mipmaps!.at(-1)!.data[3]).toBeGreaterThan(0);
    }
    expect(grid.geometries.reduce((sum, geometry) => sum + geometry.vertices.byteLength + geometry.indices.byteLength, 0))
      .toBeLessThan(64 * 1024);
    expect(Array.from(grid.instances[0]!.transform).slice(12, 15)).toEqual([-1000, 0, 2000]);
    const redAxis = grid.geometries.find(geometry => geometry.id.endsWith("axis-x"))!;
    expect(redAxis.vertices[0]).toBe(-1);
    expect(redAxis.vertices[2]).toBe(-100);
    expect(Array.from(redAxis.uv0!)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
    expect(() => prepareRenderPacket(grid)).not.toThrow();
  });
});
