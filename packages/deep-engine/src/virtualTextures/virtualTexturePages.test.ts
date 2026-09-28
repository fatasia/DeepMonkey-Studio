import { describe, expect, it } from "vitest";
import { boxDownsampleRgba8, createSyntheticRgba8, DEFAULT_VIRTUAL_TEXTURE_TILE,
  generateVirtualTexturePages, virtualTexturePageCostBytes, virtualTexturePageId } from "./virtualTexturePages.js";

const TILE = Object.freeze({ tileEdgeTexels: 4, bytesPerTexel: 4 });

function texel(level: { data: Uint8Array; width: number }, x: number, y: number): readonly [number, number, number, number] {
  const offset = (y * level.width + x) * 4;
  return [level.data[offset]!, level.data[offset + 1]!, level.data[offset + 2]!, level.data[offset + 3]!];
}

describe("offline virtual texture page generation", () => {
  it("creates deterministic synthetic textures from the same seed and size", () => {
    const first = createSyntheticRgba8("t", 32, 16, 7);
    const second = createSyntheticRgba8("t", 32, 16, 7);
    expect([...second.data]).toEqual([...first.data]);
    expect(createSyntheticRgba8("t", 32, 16, 8).data.some((value, index) => value !== first.data[index])).toBe(true);
    expect(first.data[3]).toBe(255);
  });

  it("box-downsamples with half-weight tails and reaches 1x1", () => {
    const level = { width: 3, height: 3, data: new Uint8Array([0, 0, 0, 255, 40, 40, 40, 255, 80, 80, 80, 255,
      120, 120, 120, 255, 160, 160, 160, 255, 200, 200, 200, 255, 240, 240, 240, 255, 10, 10, 10, 255, 30, 30, 30, 255]) };
    const down = boxDownsampleRgba8(level);
    expect([down.width, down.height]).toEqual([1, 1]);
    const average = (0 + 40 + 120 + 160) / 4;
    expect(texel(down, 0, 0)).toEqual([average, average, average, 255]);
    const wide = boxDownsampleRgba8({ width: 3, height: 1, data: new Uint8Array(12).fill(200) });
    expect([wide.width, wide.height]).toEqual([1, 1]);
    expect(texel(wide, 0, 0)[0]).toBe(200);
  });

  it("cuts every mip-0 tile into a region-constant mip chain of shrinking pages", () => {
    const source = createSyntheticRgba8("tex", 18, 10, 3);
    const table = generateVirtualTexturePages(source, TILE);
    expect([table.gridX, table.gridY, table.chainMips]).toEqual([5, 3, 3]);
    expect(table.pages.length).toBe(15 * 3);
    expect([virtualTexturePageCostBytes(TILE, 0), virtualTexturePageCostBytes(TILE, 1),
      virtualTexturePageCostBytes(TILE, 2)]).toEqual([64, 16, 4]);
    for (const page of table.pages) expect(page.data.byteLength).toBe(page.costBytes);
    // Ragged corner tile: valid 2x2 at mip 0, zero-padded to the full 4x4 page.
    // Page rows are pitched to the full tile edge, not the valid width.
    const corner = table.pageByTile.get(virtualTexturePageId("tex", 4, 2, 0))!;
    const pageTexel = (page: typeof corner, x: number, y: number): readonly number[] =>
      [...page.data.subarray((y * TILE.tileEdgeTexels + x) * 4, (y * TILE.tileEdgeTexels + x) * 4 + 4)];
    expect([corner.width, corner.height]).toEqual([2, 2]);
    expect(pageTexel(corner, 0, 0)).toEqual([...texel(source, 16, 8)]);
    expect(pageTexel(corner, 1, 1)).toEqual([...texel(source, 17, 9)]);
    for (const [x, y] of [[2, 0], [0, 2], [3, 3]] as const) {
      expect(corner.data[(y * TILE.tileEdgeTexels + x) * 4 + 3]).toBe(0);
    }
    // The same region at mip 2 collapses below one texel: a zero-valid padded page.
    const subTexel = table.pageByTile.get(virtualTexturePageId("tex", 4, 2, 2))!;
    expect([subTexel.width, subTexel.height, subTexel.costBytes]).toEqual([0, 0, 4]);
    expect(subTexel.data.every(value => value === 0)).toBe(true);
    expect(table.totalBytes).toBe(table.pages.reduce((sum, page) => sum + page.costBytes, 0));
  });

  it("coarser mips box-average the same region (per-tile chain, not a shared coarse grid)", () => {
    const source = createSyntheticRgba8("avg", 8, 8, 11);
    const table = generateVirtualTexturePages(source, TILE);
    const mip0 = table.pageByTile.get(virtualTexturePageId("avg", 0, 0, 0))!;
    const mip1 = table.pageByTile.get(virtualTexturePageId("avg", 0, 0, 1))!;
    const mip2 = table.pageByTile.get(virtualTexturePageId("avg", 1, 1, 2))!;
    const level1 = boxDownsampleRgba8(source);
    const level2 = boxDownsampleRgba8(level1);
    expect(mip1.data[0]).toBe(level1.data[0]);
    expect(mip0.data[0]).toBe(source.data[0]);
    // Page (1,1) at mip 2 extracts level-2 texel (1,1): the 4x4-region average.
    expect(mip2.data[0]).toBe(level2.data[(1 * 2 + 1) * 4]);
    const region = (x: number, y: number) => source.data[((y + 4) * 8 + x + 4) * 4]!;
    expect(mip2.data[0]).toBe(Math.floor((region(0, 0) + region(1, 0) + region(0, 1) + region(1, 1)
      + region(2, 0) + region(3, 0) + region(2, 1) + region(3, 1)
      + region(0, 2) + region(1, 2) + region(0, 3) + region(1, 3)
      + region(2, 2) + region(3, 2) + region(2, 3) + region(3, 3)) / 16));
  });

  it("rejects incomplete mip chains and invalid specs, and is byte-deterministic", () => {
    const source = createSyntheticRgba8("det", 8, 8, 5);
    expect(() => generateVirtualTexturePages({ ...source, mipmaps: [] }, TILE)).toThrow(/mip chain must be complete/);
    expect(() => generateVirtualTexturePages(source, { tileEdgeTexels: 3, bytesPerTexel: 4 })).toThrow(/power-of-two/);
    expect(() => generateVirtualTexturePages(source, { tileEdgeTexels: 4, bytesPerTexel: 0 })).toThrow(/bytesPerTexel/);
    expect(() => generateVirtualTexturePages({ ...source, id: "" }, TILE)).toThrow();
    const first = generateVirtualTexturePages(source, TILE);
    const second = generateVirtualTexturePages(source, TILE);
    expect(second.pages.length).toBe(first.pages.length);
    for (let index = 0; index < first.pages.length; index++) {
      expect([...second.pages[index]!.data]).toEqual([...first.pages[index]!.data]);
      expect(second.pages[index]!.id).toBe(first.pages[index]!.id);
    }
    expect(DEFAULT_VIRTUAL_TEXTURE_TILE.tileEdgeTexels).toBe(128);
  });
});
