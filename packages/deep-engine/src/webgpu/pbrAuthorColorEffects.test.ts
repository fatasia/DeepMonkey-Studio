import { describe, expect, it } from "vitest";
import { applyPbrAuthorColorEffects as apply, packPbrAuthorColorEffects as pack } from "./pbrAuthorColorEffects.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { outputShader } from "./pbrOutputShader.js";

const neutral = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };
const source = [0.1, 0.4, 2] as const;
const view = { eye: [0, 0, 3], target: [0, 0, 0], background: [0.1, 0.2, 0.3], floor: [0, 0, 0],
  width: 100, height: 100, pixelRatio: 1, extent: 1, exposure: 1, roughness: 0.5 } as const;

describe("Three-compatible author output color effects", () => {
  it("applies author effects once before display conversion, keeping legacy grading separate", () => {
    expect(outputShader).toContain("@group(1) @binding(0) var<uniform> authorEffects");
    expect(outputShader).toContain("deepDisplayColor(deepAuthorColor(color, v.uv), authorSettings)");
    expect(outputShader).toContain("DeepOutputSettings(settings.exposure, 0.0, 0.0, settings.toneMapping, 0.0, 0.0, 1.0, 1.0)");
    expect(outputShader.indexOf("return vec4f(deepDisplayColor(deepAuthorColor")).toBeLessThan(outputShader.indexOf("color *= 1.0 - settings.vignette"));
  });
  it("keeps undefined legacy distinct from explicitly disabled author effects", () => {
    expect(Array.from(pack(undefined))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(pack({}))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(apply(source, [0, 0], {})).toEqual(source);
    expect(apply(source, [0, 0], { colorGrading: neutral })).toEqual(source);
  });
  it.each([[[], [0, 0]], [[1, 2], [0, 0]], [[1, 2, 3, 4], [0, 0]], [[1, 2, 3], []],
    [[1, 2, 3], [0, 0, 0]], [[Infinity, 2, 3], [0, 0]], [[1, 2, 3], [NaN, 0]]])
  ("rejects malformed CPU color/UV tuples", (color, uv) => {
    expect(() => apply(color as never, uv as never, {})).toThrow();
  });
  it("uses Three mix toward 1-darkness, not multiplicative legacy vignette", () => {
    expect(apply(source, [0.5, 0.5], { vignette: { darkness: 1.2 } })).toEqual(source);
    const corner = apply(source, [0, 0], { vignette: { darkness: 1.2 } });
    corner.forEach((value, index) => expect(value).toBeCloseTo(source[index]! * 0.5 - 0.1));
  });
  it("rotates hue in degrees with Three channel weights", () => {
    const color = apply([1, 0, 0], [0.5, 0.5], { colorGrading: { ...neutral, hue: 120 } });
    expect(color[0]).toBeCloseTo(0); expect(color[1]).toBeCloseTo(1); expect(color[2]).toBeCloseTo(0);
  });
  it("uses average saturation and stays finite at maximum positive saturation", () => {
    expect(apply([0.3, 0.6, 0.9], [0, 0], { colorGrading: { ...neutral, saturation: -1 } }))
      .toEqual([0.6, 0.6, 0.6]);
    const result = apply(source, [0, 0], { colorGrading: { ...neutral, saturation: 1 } });
    expect(result.every(Number.isFinite)).toBe(true);
    const avg = (source[0] + source[1] + source[2]) / 3;
    result.forEach((value, index) => expect(value).toBeCloseTo(source[index]! + (avg - source[index]!) * (1 - 1 / 0.001), 5));
  });
  it("applies brightness before Studio linear contrast, after vignette", () => {
    const result = apply([0.4, 0.4, 0.4], [0, 0], { vignette: { darkness: 1 },
      colorGrading: { ...neutral, brightness: 0.2, contrast: 0.5 } });
    result.forEach(value => expect(value).toBeCloseTo((0.2 + 0.2 - 0.5) * 1.5 + 0.5));
    expect(apply(source, [0, 0], { colorGrading: { ...neutral, contrast: -1 } })).toEqual([0.5, 0.5, 0.5]);
  });
  it.each([null, [], { unknown: 1 }, { vignette: null }, { vignette: {} }, { vignette: { darkness: 4 } },
    { vignette: { darkness: NaN } }, { colorGrading: {} }, { colorGrading: { ...neutral, hue: 181 } },
    { colorGrading: { ...neutral, saturation: 1.001 } }, { colorGrading: { ...neutral, brightness: Infinity } },
    { colorGrading: { ...neutral, contrast: "0" } }])("rejects invalid author state %j", effects => {
    expect(() => pack(effects as never)).toThrow();
  });
  it("validates view effects and forbids mixing the two grading models", () => {
    expect(() => validatePbrRenderView({ ...view, authorColorEffects: { colorGrading: neutral } })).not.toThrow();
    expect(() => validatePbrRenderView({ ...view, authorColorEffects: {}, colorGrading: {} })).toThrow("cannot be combined");
  });
  it("only admits disabled author effects into direct display and suppresses legacy vignette", () => {
    const features = resolvePbrRendererFeatures({ environment: false, ambientOcclusion: false, temporalAa: false, spatialAa: false,
      occlusionCulling: false, bloom: false, vignette: true });
    expect(pbrDirectDisplayClear(view, features, false)).toBeUndefined();
    expect(pbrDirectDisplayClear({ ...view, authorColorEffects: {} }, features, false)).toBeDefined();
    expect(pbrDirectDisplayClear({ ...view, authorColorEffects: { colorGrading: neutral } }, features, false)).toBeUndefined();
  });
});
