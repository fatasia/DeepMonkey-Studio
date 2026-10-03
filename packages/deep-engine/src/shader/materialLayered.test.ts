import { describe, expect, it } from "vitest";
import { evaluateLayeredMaterialDirect } from "./materialLayeredEvaluate.js";
import { DEFAULT_LAYERED_MATERIAL_PARAMETERS, LAYERED_MATERIAL_FLOAT_COUNT,
  MATERIAL_LAYER_FLOAT_COUNT, MATERIAL_LAYER_MAX_COUNT, deserializeLayeredMaterialParameters,
  normalizeLayeredMaterialParameters, packLayeredMaterialFloatArray,
  serializeLayeredMaterialParameters } from "./materialLayeredParameters.js";
import { evaluateExtendedMaterialDirect, type MaterialEvaluationGeometry,
  type MaterialEvaluationResult, type StandardSurfaceInputs, type Vec3 } from "./materialEvaluate.js";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS, type MaterialParameterOverrides } from "./materialParameters.js";

const PI = Math.PI;
const N: Vec3 = [0, 0, 1];
const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const LIGHT = normalize([0.45, 0.3, 0.84]);
const GEOMETRY: MaterialEvaluationGeometry = { normal: N, view: [0, 0, 1], light: LIGHT, tangent: [1, 0, 0] };
const UNIT_RADIANCE: Vec3 = [1, 1, 1];

const SURFACE: StandardSurfaceInputs = { baseColor: [0.8, 0.4, 0.2], metallic: 0.35, roughness: 0.5 };
/** 层参数族:与 base 同一 schema,差异只在扩展段(首刀合同:层求值复用同一 surface)。 */
const DUST_LAYER = { params: { anisotropy: { strength: 0.6, rotation: 0.7 } }, coverage: 0.6, mode: "replace" } as const;
const GLAZE_LAYER = { params: { clearcoat: { factor: 1, roughness: 0.3 } }, coverage: 0.8, mode: "overlay" } as const;

type LayerStack = Parameters<typeof evaluateLayeredMaterialDirect>[1];
type BlendMode = "replace" | "overlay";

/** 白炉:单位 radiance 下 rgb 即 BRDF·cosθL,定向-半球反射率等立体角加权求和。 */
function hemisphereReflectance(
  surface: StandardSurfaceInputs, layered: LayerStack,
  thetaView: number, nTheta = 32, nPhi = 64,
): number {
  const view: Vec3 = [Math.sin(thetaView), 0, Math.cos(thetaView)];
  let sum = 0;
  for (let i = 0; i < nTheta; i++) {
    const theta = (i + 0.5) * (PI / 2) / nTheta;
    const bandWeight = Math.sin(theta) * PI * PI / (nTheta * nPhi);
    for (let j = 0; j < nPhi; j++) {
      const phi = (j + 0.5) * 2 * PI / nPhi;
      const light: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
      const { rgb } = evaluateLayeredMaterialDirect(surface, layered,
        { normal: N, view, light }, UNIT_RADIANCE);
      sum += (rgb[0]! + rgb[1]! + rgb[2]!) / 3 * bandWeight;
    }
  }
  return sum;
}

const shallowEqualBits = (a: Vec3, b: Vec3): boolean =>
  a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

function expectBitsIdentical(left: MaterialEvaluationResult, right: MaterialEvaluationResult): void {
  expect(shallowEqualBits(left.rgb, right.rgb)).toBe(true);
  for (const lobe of ["diffuse", "specular", "clearcoat", "transmission"] as const) {
    expect(shallowEqualBits(left.components[lobe], right.components[lobe])).toBe(true);
  }
}

/** 独立手写的混合闭式(与实现零共享),验证实现逐通道就是合同公式:
 * 权重只由层 rgb 派生(replace=c;overlay=c·clamp01(L_rgb)),同一权重施加于 rgb 与全部 lobe。 */
function inlineBlendWeights(layerRgb: Vec3, coverage: number, mode: BlendMode): Vec3 {
  const coverage32 = Math.fround(coverage);
  if (mode === "replace") return [coverage32, coverage32, coverage32];
  const saturate = (value: number) => Math.min(1, Math.max(0, value));
  return [coverage32 * saturate(layerRgb[0]!), coverage32 * saturate(layerRgb[1]!),
    coverage32 * saturate(layerRgb[2]!)];
}

function inlineBlendVec3(underlying: Vec3, layer: Vec3, weights: Vec3): Vec3 {
  return [0, 1, 2].map((channel) =>
    (1 - weights[channel]!) * underlying[channel]! + weights[channel]! * layer[channel]!) as Vec3;
}

const LOBES = ["diffuse", "specular", "clearcoat", "transmission"] as const;

describe("C23 layered material degradation identity (bitwise)", () => {
  it("no layers reproduces the single-layer path bitwise across a config matrix", () => {
    const configs: readonly (readonly [string, MaterialParameterOverrides])[] = [
      ["default", {}],
      ["clearcoat-base", { clearcoat: { factor: 0.7, roughness: 0.3 } }],
      ["aniso-transmission-base", { anisotropy: { strength: 0.4, rotation: 0.4 }, transmission: { factor: 0.4 } }],
      ["full-base", { ior: 1.6, clearcoat: { factor: 0.5, roughness: 0.2 }, anisotropy: { strength: 0.6, rotation: -0.3 },
        transmission: { factor: 0.7 } }],
    ];
    for (const [name, base] of configs) {
      const single = evaluateExtendedMaterialDirect(SURFACE, base, GEOMETRY, UNIT_RADIANCE);
      const layered = evaluateLayeredMaterialDirect(SURFACE, { base }, GEOMETRY, UNIT_RADIANCE);
      expectBitsIdentical(layered, single);
      void name;
    }
    // 空栈默认输入同样恒等(含缺省 radiance)。
    expectBitsIdentical(
      evaluateLayeredMaterialDirect(SURFACE, DEFAULT_LAYERED_MATERIAL_PARAMETERS, GEOMETRY),
      evaluateExtendedMaterialDirect(SURFACE, DEFAULT_EXTENDED_MATERIAL_PARAMETERS, GEOMETRY));
  });

  it("prunes zero-coverage layers bitwise for both blend modes, even mid-stack", () => {
    const baseOnly = evaluateLayeredMaterialDirect(SURFACE, {}, GEOMETRY, UNIT_RADIANCE);
    for (const mode of ["replace", "overlay"] as const) {
      expectBitsIdentical(
        evaluateLayeredMaterialDirect(SURFACE,
          { layers: [{ params: GLAZE_LAYER.params, coverage: 0, mode }] }, GEOMETRY, UNIT_RADIANCE),
        baseOnly);
    }
    const withMiddle = evaluateLayeredMaterialDirect(SURFACE,
      { layers: [DUST_LAYER, { params: GLAZE_LAYER.params, coverage: 0, mode: "overlay" }] },
      GEOMETRY, UNIT_RADIANCE);
    const withoutMiddle = evaluateLayeredMaterialDirect(SURFACE,
      { layers: [DUST_LAYER] }, GEOMETRY, UNIT_RADIANCE);
    expectBitsIdentical(withMiddle, withoutMiddle);
  });

  it("replace at coverage 1 is bitwise the pure layer evaluation (full takeover)", () => {
    const pureLayer = evaluateExtendedMaterialDirect(SURFACE, GLAZE_LAYER.params, GEOMETRY, UNIT_RADIANCE);
    const replaced = evaluateLayeredMaterialDirect(SURFACE,
      { layers: [{ params: GLAZE_LAYER.params, coverage: 1, mode: "replace" }] }, GEOMETRY, UNIT_RADIANCE);
    expectBitsIdentical(replaced, pureLayer);
  });

  it("matches an independent closed-form implementation bitwise across a cell matrix", () => {
    const configs: readonly (readonly [LayerStack, BlendMode, number])[] = [
      [{ layers: [{ params: GLAZE_LAYER.params, coverage: 0.8, mode: "overlay" }] }, "overlay", 0.8],
      [{ layers: [{ params: DUST_LAYER.params, coverage: 0.6, mode: "replace" }] }, "replace", 0.6],
      [{ layers: [{ params: DUST_LAYER.params, coverage: 0.25, mode: "replace" }] }, "replace", 0.25],
      [{ layers: [{ params: GLAZE_LAYER.params, coverage: 1, mode: "overlay" }] }, "overlay", 1],
    ];
    for (const [stack, mode, coverage] of configs) {
      const base = evaluateExtendedMaterialDirect(SURFACE, {}, GEOMETRY, UNIT_RADIANCE);
      const layerParams = (stack.layers![0] as { params: MaterialParameterOverrides }).params;
      const layer = evaluateExtendedMaterialDirect(SURFACE, layerParams, GEOMETRY, UNIT_RADIANCE);
      const blended = evaluateLayeredMaterialDirect(SURFACE, stack, GEOMETRY, UNIT_RADIANCE);
      const weights = inlineBlendWeights(layer.rgb, coverage, mode);
      expect(blended.rgb).toEqual(inlineBlendVec3(base.rgb, layer.rgb, weights));
      for (const lobe of LOBES) {
        // 同一权重施加于全部 lobe(分量分解合同的混合侧结构)。
        expect(blended.components[lobe]).toEqual(inlineBlendVec3(base.components[lobe], layer.components[lobe], weights));
      }
    }
  });

  it("overlay converges bitwise to replace wherever the layer response saturates (L_rgb≥1)", () => {
    // 锐利镜向格点:spec 峰值 ≫1 → 全通道权重 = c,与 replace 同式同序 ⇒ 逐位一致。
    const sharp: StandardSurfaceInputs = { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 0.045 };
    const mirror: MaterialEvaluationGeometry = { normal: N, view: N, light: N, tangent: [1, 0, 0] };
    const layerResponse = evaluateExtendedMaterialDirect(sharp, GLAZE_LAYER.params, mirror, UNIT_RADIANCE);
    expect(layerResponse.rgb.every((value) => value > 1)).toBe(true);
    const asOverlay = evaluateLayeredMaterialDirect(sharp,
      { layers: [{ params: GLAZE_LAYER.params, coverage: 0.7, mode: "overlay" }] }, mirror, UNIT_RADIANCE);
    const asReplace = evaluateLayeredMaterialDirect(sharp,
      { layers: [{ params: GLAZE_LAYER.params, coverage: 0.7, mode: "replace" }] }, mirror, UNIT_RADIANCE);
    expectBitsIdentical(asOverlay, asReplace);
  });
});

describe("C23 layered energy conservation (white furnace ≤1)", () => {
  const FURNACE: readonly (readonly [string, StandardSurfaceInputs, LayerStack])[] = [
    ["replace-dust", SURFACE, { layers: [DUST_LAYER] }],
    ["overlay-glaze", SURFACE, { layers: [GLAZE_LAYER] }],
    ["stack-replace+overlay", SURFACE, { layers: [DUST_LAYER, GLAZE_LAYER] }],
    ["stack-double-overlay", SURFACE, { layers: [
      { params: { clearcoat: { factor: 1, roughness: 0.5 } }, coverage: 0.7, mode: "overlay" },
      { params: { anisotropy: { strength: 0.8, rotation: 0.3 } }, coverage: 0.6, mode: "overlay" }] }],
    ["stack-white-rough", { baseColor: [1, 1, 1], metallic: 0, roughness: 1 }, { layers: [
      { params: { transmission: { factor: 1 } }, coverage: 0.8, mode: "replace" },
      { params: { clearcoat: { factor: 1, roughness: 1 } }, coverage: 0.7, mode: "overlay" }] }],
  ];

  it("keeps hemispherical reflectance ≤1+1e-3 for replace and overlay stacks", () => {
    for (const [name, surface, layered] of FURNACE) {
      let max = 0;
      for (const degrees of [0, 25, 50, 75]) {
        max = Math.max(max, hemisphereReflectance(surface, layered, degrees * PI / 180));
      }
      expect(max).toBeLessThanOrEqual(1 + 1e-3);
      void name;
    }
  }, 60_000);

  it("never amplifies: single-layer cells stay within the two-parent envelope (convex mix)", () => {
    for (const stack of [
      { layers: [DUST_LAYER] }, { layers: [GLAZE_LAYER] },
    ] as const) {
      const base = evaluateExtendedMaterialDirect(SURFACE, {}, GEOMETRY, UNIT_RADIANCE);
      const layer = evaluateExtendedMaterialDirect(SURFACE,
        (stack.layers![0] as { params: MaterialParameterOverrides }).params, GEOMETRY, UNIT_RADIANCE);
      const blended = evaluateLayeredMaterialDirect(SURFACE, stack, GEOMETRY, UNIT_RADIANCE);
      for (let channel = 0; channel < 3; channel++) {
        const ceiling = Math.max(base.rgb[channel]!, layer.rgb[channel]!) + 1e-12;
        expect(blended.rgb[channel]!).toBeLessThanOrEqual(ceiling);
        for (const lobe of LOBES) {
          const lobeCeiling = Math.max(base.components[lobe][channel]!, layer.components[lobe][channel]!) + 1e-12;
          expect(blended.components[lobe][channel]!).toBeLessThanOrEqual(lobeCeiling);
        }
      }
    }
  });
});

describe("C23 blend order determinism", () => {
  it("swapping the layer order changes the result; reruns are bitwise stable", () => {
    const first = evaluateLayeredMaterialDirect(SURFACE, { layers: [DUST_LAYER, GLAZE_LAYER] }, GEOMETRY, UNIT_RADIANCE);
    const second = evaluateLayeredMaterialDirect(SURFACE, { layers: [GLAZE_LAYER, DUST_LAYER] }, GEOMETRY, UNIT_RADIANCE);
    const rerun = evaluateLayeredMaterialDirect(SURFACE, { layers: [DUST_LAYER, GLAZE_LAYER] }, GEOMETRY, UNIT_RADIANCE);
    expectBitsIdentical(first, rerun);
    const identical = shallowEqualBits(first.rgb, second.rgb)
      && LOBES.every((lobe) => shallowEqualBits(first.components[lobe], second.components[lobe]));
    expect(identical).toBe(false);
  });

  it("keeps component decomposition exact after blending: four lobes sum to rgb", () => {
    const { rgb, components } = evaluateLayeredMaterialDirect(SURFACE,
      { layers: [DUST_LAYER, GLAZE_LAYER] }, GEOMETRY, UNIT_RADIANCE);
    for (const channel of [0, 1, 2]) {
      const sum = components.diffuse[channel]! + components.specular[channel]!
        + components.clearcoat[channel]! + components.transmission[channel]!;
      expect(Math.abs(sum - rgb[channel]!)).toBeLessThan(1e-12);
    }
  });

  it("coverage is monotonic: raising it moves the response toward the layer", () => {
    const layer = evaluateExtendedMaterialDirect(SURFACE, GLAZE_LAYER.params, GEOMETRY, UNIT_RADIANCE);
    let previous = evaluateLayeredMaterialDirect(SURFACE, {}, GEOMETRY, UNIT_RADIANCE).rgb;
    for (const coverage of [0.2, 0.4, 0.6, 0.8]) {
      const current = evaluateLayeredMaterialDirect(SURFACE,
        { layers: [{ params: GLAZE_LAYER.params, coverage, mode: "replace" }] }, GEOMETRY, UNIT_RADIANCE).rgb;
      const distanceCurrent = current.reduce((acc, value, index) => acc + Math.abs(value - layer.rgb[index]!), 0);
      const distancePrevious = previous.reduce((acc, value, index) => acc + Math.abs(value - layer.rgb[index]!), 0);
      expect(distanceCurrent).toBeLessThan(distancePrevious);
      previous = current;
    }
  });

  it("overlay never overshoots replace toward the layer (effective weight ≤ coverage)", () => {
    // overlay 的有效权重 = c·clamp01(L_rgb) ≤ c = replace 权重 ⇒ 每格都至少与 replace
    // 一样靠近底材(|out_overlay − U| ≤ |out_replace − U|)。
    const roughLayer = { params: { anisotropy: { strength: 0.5, rotation: 0 } }, coverage: 0.75, mode: "replace" } as const;
    const base = evaluateLayeredMaterialDirect(SURFACE, {}, GEOMETRY, UNIT_RADIANCE).rgb;
    const asReplace = evaluateLayeredMaterialDirect(SURFACE, { layers: [roughLayer] }, GEOMETRY, UNIT_RADIANCE).rgb;
    const asOverlay = evaluateLayeredMaterialDirect(SURFACE,
      { layers: [{ ...roughLayer, mode: "overlay" }] }, GEOMETRY, UNIT_RADIANCE).rgb;
    for (let channel = 0; channel < 3; channel++) {
      const replaceStep = Math.abs(asReplace[channel]! - base[channel]!);
      const overlayStep = Math.abs(asOverlay[channel]! - base[channel]!);
      expect(overlayStep).toBeLessThanOrEqual(replaceStep + 1e-15);
    }
  });
});

describe("C23 fail-closed contract", () => {
  it("rejects over-deep stacks, invalid coverage, unknown modes and invalid params", () => {
    const threeLayers = Array.from({ length: MATERIAL_LAYER_MAX_COUNT + 1 },
      () => ({ params: {}, coverage: 0.5, mode: "replace" as const }));
    expect(() => normalizeLayeredMaterialParameters({ layers: threeLayers })).toThrow(RangeError);
    expect(() => normalizeLayeredMaterialParameters(
      { layers: [{ params: {}, coverage: -0.1, mode: "replace" }] })).toThrow(/coverage/u);
    expect(() => normalizeLayeredMaterialParameters(
      { layers: [{ params: {}, coverage: Number.NaN, mode: "replace" }] })).toThrow(/coverage/u);
    expect(() => normalizeLayeredMaterialParameters(
      { layers: [{ params: {}, coverage: 1.0001, mode: "replace" }] })).toThrow(/coverage/u);
    expect(() => normalizeLayeredMaterialParameters(
      { layers: [{ params: {}, coverage: 0.5, mode: "add" as never }] })).toThrow(/blend mode/u);
    expect(() => normalizeLayeredMaterialParameters(
      { layers: [{ params: { ior: 0.9 }, coverage: 0.5, mode: "replace" }] })).toThrow(/IOR/u);
    expect(() => normalizeLayeredMaterialParameters({ base: { ior: -1 } })).toThrow(/IOR/u);
  });

  it("round-trips serialization bitwise and prunes zero-coverage layers", () => {
    const layered = { base: { ior: 1.6, clearcoat: { factor: 0.5, roughness: 0.25 } },
      layers: [DUST_LAYER, GLAZE_LAYER] } as LayerStack;
    const serialized = serializeLayeredMaterialParameters(layered);
    const restored = deserializeLayeredMaterialParameters(serialized);
    const reserialized = serializeLayeredMaterialParameters(restored);
    expect(JSON.stringify(reserialized)).toBe(JSON.stringify(serialized));
    expectBitsIdentical(
      evaluateLayeredMaterialDirect(SURFACE, restored, GEOMETRY, UNIT_RADIANCE),
      evaluateLayeredMaterialDirect(SURFACE, layered, GEOMETRY, UNIT_RADIANCE));
    expect(serialized.layers).toHaveLength(2);
    // 零覆盖层在序列化侧剪除(剪枝合同:零覆盖层不产生求值扰动)。
    const withZeroLayer = serializeLayeredMaterialParameters(
      { layers: [{ params: GLAZE_LAYER.params, coverage: 0, mode: "overlay" }] });
    expect(withZeroLayer.layers).toHaveLength(0);
    // 未知键 fail-closed。
    expect(() => deserializeLayeredMaterialParameters(
      { layers: [{ ...serialized.layers[0]!, unknownKey: 1 }] })).toThrow(/Unknown serialized material layer key/u);
  });

  it("packs the fixed 22-float block in canonical order with layer slots", () => {
    expect(LAYERED_MATERIAL_FLOAT_COUNT).toBe(22);
    expect(MATERIAL_LAYER_FLOAT_COUNT).toBe(8);
    expect(MATERIAL_LAYER_MAX_COUNT).toBe(2);
    const packed = packLayeredMaterialFloatArray(
      { layers: [{ params: GLAZE_LAYER.params, coverage: 0.8, mode: "overlay" }] });
    expect(packed).toHaveLength(22);
    // base 槽(默认)在 0..5;层 0 槽 6..13,coverage 落槽 12、modeCode 落槽 13;空层槽 14..21 全零。
    expect(packed.slice(0, 6)).toEqual([1.5, 0, 0, 0, 0, 0]);
    expect(packed[12]).toBe(Math.fround(0.8)); // f32 语义:coverage 经 fround,不等于 f64 字面量。
    expect(packed[13]).toBe(1);
    expect(packed.slice(14, 22)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // 两层栈:层 1 的 modeCode 落在槽 21;replace 层的 modeCode 为 0。
    const twoLayers = packLayeredMaterialFloatArray({ layers: [DUST_LAYER, GLAZE_LAYER] });
    expect(twoLayers[13]).toBe(0);
    expect(twoLayers[21]).toBe(1);
  });
});
