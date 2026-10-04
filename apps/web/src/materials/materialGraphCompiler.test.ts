import { describe, expect, it } from "vitest";
import type { MaterialGraphDefinition, MaterialGraphLayer } from "./materialGraphModel";
import { createLayer, createMaterialGraph } from "./materialGraphModel";
import {
  compileGraphGrids,
  graphBaseMetalByte,
  graphBaseRgb,
  graphBaseRoughByte,
  graphMaterialPatch,
  heightToNormalRgba,
} from "./materialGraphCompiler";

/** 确定性核心:同图同网格逐字节相等;通道开关只接管启用的槽。 */
describe("materialGraphCompiler", () => {
  const size = 64;

  function graphWithLayer(patch: Partial<MaterialGraphLayer>, maskPatch: Partial<MaterialGraphLayer["mask"]> = {}): MaterialGraphDefinition {
    const layer = { ...createLayer("wear", "磨损层"), ...patch } as MaterialGraphLayer;
    layer.mask = { ...layer.mask, ...maskPatch };
    return { ...createMaterialGraph("测试", { color: "#406080", roughness: 0.4, metalness: 0.2 }), layers: [layer] };
  }

  it("同一定义两次编译:RGBA/粗糙度/金属度/高度网格逐字节相等(确定性硬约束)", () => {
    const graph = graphWithLayer({ useColor: true, useRoughness: true, useMetalness: true, bump: 0.5 });
    const a = compileGraphGrids(graph, size);
    const b = compileGraphGrids(graph, size);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    expect(Buffer.from(a.rough).equals(Buffer.from(b.rough))).toBe(true);
    expect(Buffer.from(a.metal).equals(Buffer.from(b.metal))).toBe(true);
    expect(Buffer.from(a.height.buffer)).toEqual(Buffer.from(b.height.buffer));
  });

  it("空图:无通道接管(used 全 false),网格=底材质常量场", () => {
    const graph = createMaterialGraph("空", { color: "#406080", roughness: 0.4, metalness: 0.2 });
    const grids = compileGraphGrids(graph, 8);
    expect(grids.used).toEqual({ color: false, roughness: false, metalness: false, bump: false });
    const [r] = graphBaseRgb(graph);
    expect(grids.rgba[0]).toBe(r);
    expect(grids.rgba[3]).toBe(255);
    expect(grids.rough.every(byte => byte === graphBaseRoughByte(graph))).toBe(true);
    expect(grids.metal.every(byte => byte === graphBaseMetalByte(graph))).toBe(true);
  });

  it("颜色层 mix:遮罩=1 区域输出层色,遮罩=0 区域输出底色", () => {
    const layer = Object.assign(createLayer("stripes", "标带"), { color: "#ff8000", useColor: true, opacity: 1 });
    layer.mask = { ...layer.mask, kind: "stripes", seed: 1, scale: 1, coverage: 0.5, softness: 0, angle: 0 };
    const graph = { ...createMaterialGraph("色", { color: "#000000", roughness: 0.5, metalness: 0 }), layers: [layer] };
    const grids = compileGraphGrids(graph, 32);
    expect(grids.used.color).toBe(true);
    // 条纹硬边:0.5 duty 下必有纯层色与纯底色像素
    const hits = { layer: 0, base: 0 };
    for (let i = 0; i < 32 * 32; i += 1) {
      const o = i * 4;
      if (grids.rgba[o] === 255 && grids.rgba[o + 1] === 128) hits.layer += 1;
      if (grids.rgba[o] === 0 && grids.rgba[o + 1] === 0) hits.base += 1;
    }
    expect(hits.layer).toBeGreaterThan(0);
    expect(hits.base).toBeGreaterThan(0);
  });

  it("停用层与无通道层不接管:used 反映启用通道集合", () => {
    const colorOnly = graphWithLayer({ useColor: true, useRoughness: false, useMetalness: false, bump: 0, enabled: true });
    expect(compileGraphGrids(colorOnly, 8).used).toEqual({ color: true, roughness: false, metalness: false, bump: false });
    const disabled = graphWithLayer({ useColor: true, enabled: false });
    expect(compileGraphGrids(disabled, 8).used.color).toBe(false);
  });

  it("粗糙度混合:遮罩中部值介于底与层之间;mask=0 处等于底", () => {
    const layer = Object.assign(createLayer("dust", "灰尘"), { useRoughness: true, roughness: 0.9, opacity: 1 });
    layer.mask = { ...layer.mask, kind: "dust", seed: 5, scale: 2, coverage: 0.6, softness: 0.2 };
    const graph = { ...createMaterialGraph("粗", { color: "#808080", roughness: 0.1, metalness: 0 }), layers: [layer] };
    const grids = compileGraphGrids(graph, 32);
    expect(grids.used.roughness).toBe(true);
    let sawLayerValue = false;
    for (const byte of grids.rough) {
      expect(byte).toBeGreaterThanOrEqual(graphBaseRoughByte(graph));
      expect(byte).toBeLessThanOrEqual(Math.round(0.9 * 255));
      if (byte === Math.round(0.9 * 255)) sawLayerValue = true;
    }
    expect(sawLayerValue).toBe(true);
    expect(grids.metal.every(byte => byte === graphBaseMetalByte(graph))).toBe(true);
  });

  it("高度→法线:平台区域输出中性法线 (128,128,255);输出域合法", () => {
    const height = new Float32Array(16 * 16);
    height.fill(0.5);
    const flat = heightToNormalRgba(height, 16);
    for (let i = 0; i < 16 * 16; i += 1) {
      const o = i * 4;
      expect(flat[o]).toBe(128);
      expect(flat[o + 1]).toBe(128);
      expect(flat[o + 2]).toBe(255);
      expect(flat[o + 3]).toBe(255);
    }
    const varied = heightToNormalRgba(new Float32Array(16 * 16).map((_, i) => (i % 5) / 5), 16);
    for (let o = 0; o < varied.length; o += 4) {
      expect(varied[o]).toBeGreaterThanOrEqual(0);
      expect(varied[o + 2]).toBeGreaterThanOrEqual(128);
    }
  });

  it("patch 生成:只含接管槽;ORM 图同 URL 双槽且标量置 1(three 贴图×标量语义)", () => {
    const empty = graphMaterialPatch({});
    expect(empty).toEqual({});
    const full = graphMaterialPatch({ colorUrl: "data:image/png;base64,C", ormUrl: "data:image/png;base64,O", normalUrl: "data:image/png;base64,N" });
    expect(full.baseColorMapUrl).toBe("data:image/png;base64,C");
    expect(full.roughnessMapUrl).toBe(full.metalnessMapUrl);
    expect(full.roughness).toBe(1);
    expect(full.metalness).toBe(1);
    expect(full.normalMapUrl).toBe("data:image/png;base64,N");
    expect(full.normalScale).toBe(1);
  });

  it("纹理遮罩注入采样:上传图亮度直接进入遮罩(灰阶映射)", () => {
    const layer = Object.assign(createLayer("texture", "贴图遮罩"), { useColor: true, color: "#ffffff", opacity: 1 });
    layer.mask = { ...layer.mask, kind: "texture", seed: 1, textureUrl: "data:image/png;base64,X", textureName: "m.png" };
    const graph = { ...createMaterialGraph("纹", { color: "#000000", roughness: 0.5, metalness: 0 }), layers: [layer] };
    const grids = compileGraphGrids(graph, 8, (target, u, v) => (u < 0.5 && v < 0.5 ? 0.5 : 0));
    // 左上象限 alpha=0.5 → 灰度 128;右下=底色 0
    expect(grids.rgba[0]).toBe(128);
    const last = (8 * 8 - 1) * 4;
    expect(grids.rgba[last]).toBe(0);
    void graph;
  });
});
