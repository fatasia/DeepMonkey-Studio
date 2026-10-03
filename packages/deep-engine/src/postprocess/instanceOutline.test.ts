import { describe, expect, it } from "vitest";
import { INSTANCE_OUTLINE_WGSL } from "./instanceOutlineWgsl.js";
import { DEFAULT_PBR_RENDERER_FEATURES } from "../webgpu/pbrRendererFeatures.js";
import { resolvePbrPostProcessOverrides, validatePbrPostProcessOverrides } from "../webgpu/pbrPostProcessOverrides.js";
import { DEFAULT_INSTANCE_OUTLINE, instanceOutlineCompose, instanceOutlineEdge, packInstanceOutlineParams,
  resolveInstanceOutlineOptions, srgbToLinear, validateInstanceOutlineOptions } from "./instanceOutlineCpu.js";

describe("instance outline options", () => {
  it("defaults to the author OutlinePass look (linear #4d9fff / #234a71, strength 2.5, no glow)", () => {
    expect(DEFAULT_INSTANCE_OUTLINE.strength).toBe(2.5);
    expect(DEFAULT_INSTANCE_OUTLINE.thickness).toBe(1);
    expect(DEFAULT_INSTANCE_OUTLINE.glow).toBe(0);
    expect(DEFAULT_INSTANCE_OUTLINE.visibleColor[0]).toBeCloseTo(srgbToLinear(0x4d / 255), 6);
    expect(DEFAULT_INSTANCE_OUTLINE.visibleColor[2]).toBeCloseTo(1, 6);
    expect(DEFAULT_INSTANCE_OUTLINE.hiddenColor[1]).toBeCloseTo(srgbToLinear(0x4a / 255), 6);
    expect(resolveInstanceOutlineOptions()).toBe(DEFAULT_INSTANCE_OUTLINE);
  });

  it("fails closed on unknown keys, non-finite values and out-of-range channels", () => {
    expect(() => validateInstanceOutlineOptions({ strength: Number.NaN })).toThrow(RangeError);
    expect(() => validateInstanceOutlineOptions({ strength: 17 })).toThrow(RangeError);
    expect(() => validateInstanceOutlineOptions({ thickness: 0.1 })).toThrow(RangeError);
    expect(() => validateInstanceOutlineOptions({ visibleColor: [0, 1] as never })).toThrow(RangeError);
    expect(() => validateInstanceOutlineOptions({ bogus: 1 } as never)).toThrow(/Unknown/);
    expect(() => validateInstanceOutlineOptions("x" as never)).toThrow(TypeError);
    expect(() => validateInstanceOutlineOptions(undefined)).not.toThrow();
  });

  it("packs a 48-byte uniform whose layout matches the WGSL Params struct", () => {
    const packed = packInstanceOutlineParams(resolveInstanceOutlineOptions({ strength: 4, thickness: 2, glow: 0.5,
      visibleColor: [1, 0.5, 0.25], hiddenColor: [0.1, 0.2, 0.3] }));
    expect(Array.from(packed)).toEqual([4, 2, 0.5, 0, 1, 0.5, 0.25, 0, expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3), 0]);
    expect(packed.byteLength).toBe(48);
    expect(INSTANCE_OUTLINE_WGSL).toContain("struct Params { shape: vec4f, visible: vec4f, hidden: vec4f };");
  });
});

describe("instance outline CPU reference", () => {
  const outside: [number, number] = [1, 1], insideVisible: [number, number] = [0, 1], insideHidden: [number, number] = [0, 0];
  it("detects the silhouette boundary and classifies visible vs occluded edges", () => {
    expect(instanceOutlineEdge([outside, outside, outside, outside])).toEqual([0, 0]);
    expect(instanceOutlineEdge([insideVisible, insideVisible, insideVisible, insideVisible])).toEqual([0, 0]);
    const [visible, hidden] = instanceOutlineEdge([outside, insideVisible, outside, outside]);
    expect(visible).toBeCloseTo(0.5, 6); expect(hidden).toBe(0);
    const [v2, h2] = instanceOutlineEdge([outside, insideHidden, outside, outside]);
    expect(v2).toBe(0); expect(h2).toBeCloseTo(0.5, 6);
  });

  it("adds the edge additively only outside the silhouette and scales with strength", () => {
    const base: [number, number, number] = [0.2, 0.2, 0.2], options = resolveInstanceOutlineOptions({ strength: 2 });
    const lit = instanceOutlineCompose(base, 1, [0.5, 0], [0, 0], options);
    expect(lit[2]).toBeCloseTo(0.2 + 2 * 0.5 * options.visibleColor[2], 6);
    expect(lit[0]).toBeGreaterThan(0.2);
    expect(instanceOutlineCompose(base, 0, [0.5, 0], [0, 0], options)).toEqual(base);
    expect(instanceOutlineCompose(base, 1, [0, 0], [0, 0], options)).toEqual(base);
    const glow = instanceOutlineCompose(base, 1, [0, 0], [0.4, 0], resolveInstanceOutlineOptions({ strength: 2, glow: 0.5 }));
    expect(glow[2]).toBeCloseTo(0.2 + 2 * 0.4 * 0.5 * options.visibleColor[2], 6);
  });
});

describe("instance outline WGSL", () => {
  it("is a compact, self-contained module with the entry points the pass binds", () => {
    for (const entry of ["maskVertex", "silhouetteFragment", "visibleFragment", "edgeMain", "composeMain"]) {
      expect(INSTANCE_OUTLINE_WGSL).toContain(`fn ${entry}(`);
    }
    // 单一 shader 模块;体积预算:不得因后续扩写悄悄膨胀(当前约 3.5 KB)。
    expect(INSTANCE_OUTLINE_WGSL.length).toBeLessThan(5_000);
    // 与 renderPacketBatches 的实例 flag 位约定一致:256 = 对象级 outline。
    expect(INSTANCE_OUTLINE_WGSL).toContain("& 256u");
  });
});

describe("instance outline per-frame override", () => {
  it("is carried through the resolved overrides and validated fail-closed", () => {
    const resolved = resolvePbrPostProcessOverrides({ instanceOutline: { strength: 4 } }, DEFAULT_PBR_RENDERER_FEATURES);
    expect(resolved.instanceOutline).toEqual({ strength: 4 });
    expect(resolvePbrPostProcessOverrides({}, DEFAULT_PBR_RENDERER_FEATURES).instanceOutline).toBeUndefined();
    expect(() => validatePbrPostProcessOverrides({ instanceOutline: { strength: -1 } })).toThrow(RangeError);
    expect(() => validatePbrPostProcessOverrides({ instanceOutline: { nope: 1 } as never })).toThrow(/Unknown instance outline/);
  });
});
