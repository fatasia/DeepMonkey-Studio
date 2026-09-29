import { describe, expect, it } from "vitest";
import { virtualTextureFeedbackInfo, VirtualTextureFeedbackReader } from "./virtualTextureFeedback.js";
import { DEFAULT_VIRTUAL_TEXTURE_TILE, createSyntheticRgba8,
  generateVirtualTexturePages } from "./virtualTexturePages.js";

/** F3 采样反馈读取器:覆盖→tile、密度→mip、聚合、fail-closed 计数。 */
describe("virtualTextureFeedback", () => {
  const info = virtualTextureFeedbackInfo("tex", 64, 64, 4, 4, 4);
  const lookup = () => info;
  const draw = (screenPixels: number, uv = { uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1 }) =>
    ({ textureId: "tex", ...uv, screenPixels });

  it("全图 draw 在中等覆盖下请求链内 mip 并按 tile 均分权重", () => {
    const frame = new VirtualTextureFeedbackReader(lookup).observe(0, [draw(1024)]);
    // ρ = 64·64/1024 = 4 → mip = floor(log4 4) = 1;16 个 tile,每 tile 权重 64。
    expect(frame.stats).toMatchObject({ entryCount: 1, footprintCount: 16, droppedInvalid: 0,
      droppedInvisible: 0, droppedUnknownTexture: 0, mergedEntries: 0 });
    expect(frame.footprints.every(f => f.maxMip === 1 && f.weight === 64)).toBe(true);
  });

  it("局部小覆盖请求 mip0,全域高密度请求最细并钳制在链长内", () => {
    const quarter = new VirtualTextureFeedbackReader(lookup).observe(0,
      [draw(256, { uvMinX: 0, uvMinY: 0, uvMaxX: 0.25, uvMaxY: 0.25 })]);
    // ρ = (16·16)/256 = 1 → mip 0,单 tile,权重 = 全部覆盖。
    expect(quarter.footprints).toHaveLength(1);
    expect(quarter.footprints[0]).toMatchObject({ tileX: 0, tileY: 0, maxMip: 0, weight: 256 });
    const zoomed = new VirtualTextureFeedbackReader(lookup).observe(0, [draw(4)]);
    // ρ = 4096/4 = 1024 → log4 = 5 → 钳到 chainMips-1 = 3。
    expect(zoomed.footprints.every(f => f.maxMip === 3)).toBe(true);
  });

  it("同纹理多条目按 tile 聚合:mip 取最细、权重取最大并计数合并", () => {
    const frame = new VirtualTextureFeedbackReader(lookup).observe(3, [
      draw(100, { uvMinX: 0, uvMinY: 0, uvMaxX: 0.5, uvMaxY: 0.5 }),
      draw(400, { uvMinX: 0, uvMinY: 0, uvMaxX: 0.25, uvMaxY: 0.25 }),
    ]);
    expect(frame.stats.mergedEntries).toBe(1);
    expect(frame.footprints).toHaveLength(4);
    // tile (0,0) 同时被两条覆盖:两条都是 mip 0(ρ ≤ 1),权重取最大 400。
    const corner = frame.footprints.find(f => f.tileX === 0 && f.tileY === 0)!;
    expect(corner.maxMip).toBe(0);
    expect(corner.weight).toBe(400);
  });

  it("repeat 寻址按模回绕覆盖 tile 并去重", () => {
    const frame = new VirtualTextureFeedbackReader(lookup).observe(0,
      [draw(64, { uvMinX: -0.25, uvMinY: 0, uvMaxX: 0.25, uvMaxY: 0.5 })]);
    // 列 floor(-0.5)..ceil(0.5)-1 = -1,0 → 回绕 {3,0};行 0,1。
    expect(frame.footprints.map(f => `${f.tileX},${f.tileY}`).sort()).toEqual(
      ["0,0", "0,1", "3,0", "3,1"]);
  });

  it("非法输入逐类显式计数,不产出伪 footprint(fail-closed)", () => {
    const map = new Map([["tex", info]]);
    const frame = new VirtualTextureFeedbackReader(id => map.get(id)).observe(0, [
      { textureId: "bad|id", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 10 },
      { textureId: "tex", uvMinX: 0.5, uvMinY: 0, uvMaxX: 0.5, uvMaxY: 1, screenPixels: 10 },
      { textureId: "tex", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 0 },
      { textureId: "tex", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: Number.NaN },
      { textureId: "unknown", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 10 },
      { textureId: "tex", uvMinX: Number.POSITIVE_INFINITY, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 10 },
    ]);
    expect(frame.stats).toMatchObject({ footprintCount: 0, droppedInvalid: 4, droppedInvisible: 1,
      droppedUnknownTexture: 1 });
  });

  it("footprint 输出确定性排序(textureId → tileY → tileX)", () => {
    const map = new Map([
      ["b", virtualTextureFeedbackInfo("b", 64, 64, 2, 2, 2)],
      ["a", virtualTextureFeedbackInfo("a", 64, 64, 2, 2, 2)],
    ]);
    const reader = new VirtualTextureFeedbackReader(id => map.get(id));
    const frame = reader.observe(0, [
      { textureId: "b", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 16 },
      { textureId: "a", uvMinX: 0, uvMinY: 0, uvMaxX: 1, uvMaxY: 1, screenPixels: 16 },
    ]);
    expect(frame.footprints.map(f => f.textureId)).toEqual(["a", "a", "a", "a", "b", "b", "b", "b"]);
    expect(frame.footprints.filter(f => f.textureId === "a").map(f => `${f.tileX},${f.tileY}`))
      .toEqual(["0,0", "1,0", "0,1", "1,1"]);
  });

  it("与离线页集产物同构:footprint 全部命中真实页 id(寻址一致性)", () => {
    const pages = generateVirtualTexturePages(createSyntheticRgba8("synth", 64, 64, 7),
      DEFAULT_VIRTUAL_TEXTURE_TILE);
    const info = virtualTextureFeedbackInfo("synth", 64, 64, pages.gridX, pages.gridY, pages.chainMips);
    const frame = new VirtualTextureFeedbackReader(() => info).observe(0,
      [{ textureId: "synth", uvMinX: 0.3, uvMinY: 0.6, uvMaxX: 0.8, uvMaxY: 1, screenPixels: 2048 }]);
    expect(frame.footprints.length).toBeGreaterThan(0);
    const pageIds = new Set(pages.pages.map(page => page.id));
    for (const footprint of frame.footprints) {
      expect(pageIds.has(`${footprint.textureId}|${footprint.tileX},${footprint.tileY}|mip0`)).toBe(true);
    }
  });

  it("档案构造拒绝非法输入,读取器拒绝非函数查找", () => {
    expect(() => virtualTextureFeedbackInfo("a|b", 64, 64, 1, 1, 1)).toThrow(TypeError);
    expect(() => virtualTextureFeedbackInfo("a", 0, 64, 1, 1, 1)).toThrow(RangeError);
    expect(virtualTextureFeedbackInfo("a", 64, 64, 1, 1, 1)).toMatchObject({ gridX: 1, chainMips: 1 });
    expect(() => new VirtualTextureFeedbackReader(undefined as unknown as () => undefined)).toThrow(TypeError);
  });
});
