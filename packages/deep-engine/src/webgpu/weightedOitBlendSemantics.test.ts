import { describe, expect, it } from "vitest";
import { prepareInstanceUpdate } from "../renderPacket.js";
import type { PbrMaterial, RenderInstance } from "../renderPacket.js";
import { transparencySupportMatrix } from "./pipelines.js";
import { WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOitWgsl.js";

// 与 weightedOitWgsl.ts 逐公式对应的 TS 参考实现:f64 语义镜像,用于冻结 OIT 的次序无关声明。
const weight = (alpha: number, normalizedLinearDepth: number): number =>
  Math.min(Math.max(alpha * 8 + 0.01, 0.01), 8) * Math.max(1 - Math.min(Math.max(normalizedLinearDepth, 0), 1) * 0.95, 0.05);

function accumulate(accumulation: [number, number, number, number], revealage: number,
  color: readonly number[], alpha: number, depth: number, premultiplied = false): number {
  const a = Math.min(Math.max(alpha, 0), 1), w = weight(a, depth);
  const rgb = premultiplied ? color : color.map(channel => channel * a);
  accumulation[0] += Math.max(rgb[0]!, 0) * w; accumulation[1] += Math.max(rgb[1]!, 0) * w;
  accumulation[2] += Math.max(rgb[2]!, 0) * w; accumulation[3] += a * w;
  return revealage * (1 - a);
}
/** 与 WEIGHTED_OIT_COMPOSITE_WGSL 的 compositeFragment 逐项对应。 */
function composite(opaque: readonly number[], accumulation: readonly number[], revealage: number): number[] {
  const denominator = Math.max(accumulation[3], 0.00001);
  const coverage = 1 - Math.min(Math.max(revealage, 0), 1);
  return [
    ...accumulation.slice(0, 3).map((channel, index) => channel / denominator * coverage + opaque[index]! * revealage),
    coverage + opaque[3]! * revealage,
  ];
}

describe("weighted OIT blend semantics (DE26/C03 frozen declarations)", () => {
  it("composites transparent panes order-independently: same frame, either draw order agrees to rounding", () => {
    const panes = [{ color: [0.8, 0.2, 0.1], alpha: 0.4, depth: 0.2 }, { color: [0.1, 0.6, 0.9], alpha: 0.65, depth: 0.7 }];
    const compositeFor = (order: number[]): number[] => {
      const accumulation: [number, number, number, number] = [0, 0, 0, 0]; let revealage = 1;
      for (const index of order) {
        const pane = panes[index]!;
        revealage = accumulate(accumulation, revealage, pane.color, pane.alpha, pane.depth);
      }
      return composite([0.1, 0.1, 0.1, 1], accumulation, revealage);
    };
    const forward = compositeFor([0, 1]), backward = compositeFor([1, 0]);
    // 排序跳变边界:weighted OIT 无次序依赖,同一帧交换绘制顺序只允许浮点舍入级差异。
    backward.forEach((channel, index) => expect(channel).toBeCloseTo(forward[index]!, 12));
  });

  it("gives zero alpha fully-invisible semantics without rejecting the draw", () => {
    for (const premultiplied of [false, true]) {
      const accumulation: [number, number, number, number] = [0, 0, 0, 0]; let revealage = 1;
      // premultiplied 输入遵守预乘不变式 C' = C·a:零 alpha 的规范编码 RGB 必为 0。
      const color = premultiplied ? [0, 0, 0] : [0.7, 0.5, 0.3];
      revealage = accumulate(accumulation, revealage, color, 0, 0.5, premultiplied);
      const output = composite([0.25, 0.25, 0.25, 1], accumulation, revealage);
      expect(accumulation).toEqual([0, 0, 0, 0]);
      expect(output).toEqual([0.25, 0.25, 0.25, 1]); // 仅剩 opaque 背景
    }
  });

  it("matches the premultiplied accumulation against straight input so the shader branch is a no-op refactor", () => {
    const straight = [0, 0, 0, 0], premultiplied = [0, 0, 0, 0];
    let straightRevealage = 1, premultipliedRevealage = 1;
    const color = 0.6, alpha = 0.35, depth = 0.42;
    straightRevealage = accumulate(straight, straightRevealage, [color, color, color], alpha, depth, false);
    premultipliedRevealage = accumulate(premultiplied, premultipliedRevealage,
      [color * alpha, color * alpha, color * alpha], alpha, depth, true);
    expect(premultiplied).toEqual(straight);
    expect(premultipliedRevealage).toBe(straightRevealage);
  });

  it("keeps the WGSL premultiplied entry point wired to the same bit the packet encoder sets", () => {
    expect(WEIGHTED_OIT_FRAGMENT_WGSL).toContain("deepWeightedOitPremultiplied");
    // 材质 flags bit128 是 TS packMaterialRecord 与 Native surface_flags 的共享合同位。
    expect(transparencySupportMatrix.premultiplied.color).toEqual(["one", "one-minus-src-alpha"]);
    expect(transparencySupportMatrix.straight.color).toEqual(["src-alpha", "one-minus-src-alpha"]);
    expect(transparencySupportMatrix.depthWriteEnabled).toBe(false);
    expect(transparencySupportMatrix.shadow).toBe("none");
    expect(transparencySupportMatrix.supportedSides).toEqual(["front", "double"]);
  });

  it("splits straight and premultiplied glass into separate batches even when everything else matches", () => {
    const base = { baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 };
    const materials: PbrMaterial[] = [
      { id: "straight", ...base, alphaMode: "BLEND", baseColorAlpha: 0.5 },
      { id: "premultiplied", ...base, alphaMode: "BLEND", baseColorAlpha: 0.5, premultipliedAlpha: true },
    ];
    const instance = (id: string, material: string): RenderInstance =>
      ({ id, geometry: "g", material, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
    const batches = prepareInstanceUpdate(new Map([["g", { uv0: false, uv1: false, tangents: false, colors: false }]]),
      { materials, instances: [instance("a", "straight"), instance("b", "straight"), instance("c", "premultiplied")] });
    expect(batches).toHaveLength(2);
    expect(batches[0]!.premultipliedAlpha).toBeUndefined();
    expect(batches[0]).toMatchObject({ key: expect.stringContaining("BLEND"), count: 2 });
    expect(batches[1]).toMatchObject({ premultipliedAlpha: true, count: 1 });
    expect(batches[1]!.key.endsWith("/premultiplied")).toBe(true);
  });

  it("fails closed when the packet declares premultipliedAlpha outside BLEND, including explicit false", () => {
    const base = { id: "material", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 };
    for (const alphaMode of ["OPAQUE", "MASK"] as const) {
      for (const premultipliedAlpha of [false, true]) {
        expect(() => prepareInstanceUpdate(new Map(), {
          materials: [{ ...base, alphaMode, premultipliedAlpha }], instances: [],
        })).toThrow("premultipliedAlpha is only valid with alphaMode BLEND");
      }
    }
    expect(() => prepareInstanceUpdate(new Map(), {
      materials: [{ ...base, alphaMode: "BLEND", premultipliedAlpha: false }], instances: [],
    })).not.toThrow();
  });
});
