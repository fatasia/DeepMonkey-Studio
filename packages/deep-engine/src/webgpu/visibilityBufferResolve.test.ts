import { describe, expect, it } from "vitest";
import { INSTANCE_ROW_FLOATS, packVisibilitySlotRow, visibilitySlotRowFromInstance } from "./visibilityBufferEncoding.js";
import { resolveVisibilityPixelReference, visibilityMaterialSelection, type ResolveReferencePixel,
  type ResolveReferenceUniforms } from "./visibilityBufferResolveReference.js";

const uniforms: ResolveReferenceUniforms = {
  inverseViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  eye: [0, 0, 5], lightDirection: [0, 0, 1], sunColor: [1, 0.9, 0.8, 2], width: 4, height: 4,
};

function pixel(overrides: Partial<ResolveReferencePixel> = {}): ResolveReferencePixel {
  return { slot: 0, packedTriangle: 0, depth: 0.5, forward: [0.1, 0.2, 0.3, 1],
    world: [0, 0, 0], worldNeighborX: [0.01, 0, 0], worldNeighborY: [0, 0.01, 0], ...overrides };
}

describe("visibility resolve CPU reference", () => {
  it("shades covered pixels from the slot table, not the forward color", () => {
    const instanceRow = new Float32Array(INSTANCE_ROW_FLOATS);
    // 正对面片：base=白、metal=0、rough=1、n=l=v → diffuse=1/π、specular≈f·V·D·nl/π。
    instanceRow.set([1, 1, 1, 0], 24); instanceRow.set([1, 0, 0, 0], 28); instanceRow.set([0, 0, 0, 1], 32);
    const row = visibilitySlotRowFromInstance(instanceRow);
    const color = resolveVisibilityPixelReference(pixel(), [row], uniforms);
    expect(color[0]).toBeGreaterThan(0.6); expect(color[1]).toBeGreaterThan(0.54); expect(color[2]).toBeGreaterThan(0.48);
    expect(color[0]).toBeLessThan(0.68); expect(color[3]).toBe(1);
  });

  it("matches the hand-computed GGX energy for a head-on surface", () => {
    const row = { colorMetal: [1, 1, 1, 0] as const, material: [1, 0, 0, 0] as const, emissiveAlpha: [0, 0, 0, 1] as const };
    const color = resolveVisibilityPixelReference(pixel(), [row], uniforms);
    // 手算：nl=1、nh=vh=nv=1、a2=1 → D=1/π、V=0.25、f0=0.04、factor=exp2(-12.53789)。
    // diffuse+specular = 1/π + 0.04004·0.25/π = 0.3215；×sunColor(1,0.9,0.8)×2。
    expect(color[0]).toBeCloseTo(0.643, 3);
    expect(color[1]).toBeCloseTo(0.579, 3);
    expect(color[2]).toBeCloseTo(0.514, 3);
  });

  it("passes sentinel pixels through with the untouched forward color", () => {
    const forward = [0.11, 0.22, 0.33, 0.5] as const;
    const sentinel = pixel({ slot: 0xffffffff, packedTriangle: 0xffffffff, forward });
    expect(resolveVisibilityPixelReference(sentinel, [undefined], uniforms)).toEqual([0.11, 0.22, 0.33, 0.5]);
    expect(visibilityMaterialSelection(sentinel, [undefined])).toBe("forward");
    // 高位脏数据的三角通道同样按 forward 回落，绝不进入 slot 表查找。
    expect(visibilityMaterialSelection(pixel({ packedTriangle: 0x00ff_00ff }), [undefined])).toBe("forward");
  });

  it("falls back to forward when the slot exceeds the provided table", () => {
    const forward = [0.05, 0.05, 0.05, 1] as const;
    const beyond = pixel({ slot: 3, forward });
    expect(resolveVisibilityPixelReference(beyond, [undefined], uniforms)).toEqual([0.05, 0.05, 0.05, 1]);
    expect(visibilityMaterialSelection(beyond, [undefined])).toBe("forward");
  });

  it("selects the same material parameters the forward plain path reads from the instance row", () => {
    // forward plain 着色的 albedo/metal/rough/emissive 全部来自实例行 [24..36]；
    // 可见性 slot 表行必须与其实例行逐字段同源（材质选择一致性合同）。
    const instanceRow = new Float32Array(INSTANCE_ROW_FLOATS);
    instanceRow.set([0.8, 0.6, 0.4, 0.25], 24); instanceRow.set([0.5, 0, 1, 8], 28); instanceRow.set([0.02, 0.04, 0.06, 1], 32);
    const expected = visibilitySlotRowFromInstance(instanceRow);
    const table = packVisibilitySlotRow(expected);
    const selection = visibilityMaterialSelection(pixel({ slot: 0 }), [{ colorMetal: [table[0]!, table[1]!, table[2]!, table[3]!],
      material: [table[4]!, table[5]!, table[6]!, table[7]!], emissiveAlpha: [table[8]!, table[9]!, table[10]!, table[11]!] }]);
    expect(selection).not.toBe("forward");
    if (selection !== "forward") {
      expect([...selection.colorMetal]).toEqual([...expected.colorMetal]);
      expect([...selection.material]).toEqual([...expected.material]);
      expect([...selection.emissiveAlpha]).toEqual([...expected.emissiveAlpha]);
    }
  });

  it("flips depth-derived normals toward the eye and keeps them unit length", () => {
    const row = { colorMetal: [1, 1, 1, 0] as const, material: [1, 0, 0, 0] as const, emissiveAlpha: [0, 0, 0, 1] as const };
    // 与视线相反的叉积方向 → 法线翻转后 dot(n, view) ≥ 0。
    const flipped = pixel({ worldNeighborX: [0, 0.01, 0], worldNeighborY: [0.01, 0, 0] });
    const aligned = pixel();
    const a = resolveVisibilityPixelReference(flipped, [row], uniforms);
    const b = resolveVisibilityPixelReference(aligned, [row], uniforms);
    expect(a[0]).toBeCloseTo(b[0], 4); expect(a[1]).toBeCloseTo(b[1], 4); expect(a[2]).toBeCloseTo(b[2], 4);
  });
});
