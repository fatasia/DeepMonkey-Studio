import { describe, expect, it } from "vitest";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { adaptMaterialModeProbeCase } from "./deepSlMaterialModesProbe.js";
import {
  evaluateMaterialModesProbe,
  materialModeSource,
  reversedPbrProbeGeometry,
} from "./deepSlMaterialModesProbeFixture.js";

const capabilities: ShaderCompileCapabilities = Object.freeze({
  features: Object.freeze([]),
  limits: Object.freeze({
    maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16,
  }),
});

describe("DeepSL material-mode GPU probe fixture", () => {
  it("builds MASK and double-sided packages with executable pass selections", () => {
    const masked = adaptMaterialModeProbeCase({
      id: "mask-below-cutoff", alpha: 0.25, alphaMode: "mask", doubleSided: false, reverseWinding: false,
    }, capabilities);
    expect(masked.success).toBe(true);
    if (!masked.success) return;
    expect(masked.package.passes.map((pass) => pass.id)).toEqual([
      "webgpu/forwardCcw", "webgpu/forwardCw", "webgpu/shadowCcw", "webgpu/shadowCw",
    ]);
    expect(masked.report.materialDefaults?.roughnessAlphaCutoffHandednessFlags).toEqual([0.8, 0.5, 1, 2]);

    const double = adaptMaterialModeProbeCase({
      id: "backface-double-sided", alpha: 1, alphaMode: "opaque", doubleSided: true, reverseWinding: true,
    }, capabilities);
    expect(double.success).toBe(true);
    if (!double.success) return;
    expect(double.package.passes.map((pass) => [pass.id, pass.pipeline.rasterMode])).toEqual([
      ["webgpu/forwardDouble", "double"], ["webgpu/shadowDouble", "double"],
    ]);
    expect(double.report.materialDefaults?.roughnessAlphaCutoffHandednessFlags[3]).toBe(1);
  });

  it("reverses complete geometry40 vertices without changing their values", () => {
    const reversed = reversedPbrProbeGeometry();
    expect(reversed).toHaveLength(30);
    expect(Array.from(reversed.slice(0, 10))).toEqual([-1, -1, 0.5, 0, 0, 1, 0, 0, 0, 0]);
    expect(Array.from(reversed.slice(10, 20))).toEqual([-1, 3, 0.5, 0, 0, 1, 0, 1, 0, 1]);
    expect(Array.from(reversed.slice(20, 30))).toEqual([3, -1, 0.5, 0, 0, 1, 1, 0, 1, 0]);
  });

  it("requires independent color, shadow cutoff, culling, and double-sided readback evidence", () => {
    const passing = evaluateMaterialModesProbe([
      { id: "mask-below-cutoff", pixel: [0.003, 0.007, 0.011, 1], shadowDepth: 1 },
      { id: "mask-above-cutoff", pixel: [0.8, 0.1, 0.1, 1], shadowDepth: 0.5 },
      { id: "backface-single-sided", pixel: [0.003, 0.007, 0.011, 1], shadowDepth: 1 },
      { id: "backface-double-sided", pixel: [0.4, 0.1, 0.1, 1], shadowDepth: 0.5 },
    ]);
    expect(passing).toMatchObject({
      verified: true, finite: true, maskColorCutoff: true, maskShadowCutoff: true,
      singleSidedCulled: true, doubleSidedVisible: true,
    });
    expect(evaluateMaterialModesProbe([
      { id: "mask-below-cutoff", pixel: [0.8, 0.1, 0.1, 1], shadowDepth: 0.5 },
      { id: "mask-above-cutoff", pixel: [0.8, 0.1, 0.1, 1], shadowDepth: 0.5 },
      { id: "backface-single-sided", pixel: [0.4, 0.1, 0.1, 1], shadowDepth: 0.5 },
      { id: "backface-double-sided", pixel: [0.4, 0.1, 0.1, 1], shadowDepth: Number.NaN },
    ])).toMatchObject({ verified: false, finite: false });
    expect(evaluateMaterialModesProbe([
      { id: "mask-below-cutoff", pixel: [0.003, 0.007, 0.011, 1], shadowDepth: 1 },
      { id: "mask-below-cutoff", pixel: [0.003, 0.007, 0.011, 1], shadowDepth: 1 },
      { id: "backface-single-sided", pixel: [0.003, 0.007, 0.011, 1], shadowDepth: 1 },
      { id: "backface-double-sided", pixel: [0.4, 0.1, 0.1, 1], shadowDepth: 0.5 },
    ])).toMatchObject({ verified: false, finite: false });
  });

  it("keeps material-only mask alpha outside the executable package identity", () => {
    const below = adaptMaterialModeProbeCase({
      id: "mask-below-cutoff", alpha: 0.25, alphaMode: "mask", doubleSided: false, reverseWinding: false,
    }, capabilities);
    const above = adaptMaterialModeProbeCase({
      id: "mask-above-cutoff", alpha: 0.75, alphaMode: "mask", doubleSided: false, reverseWinding: false,
    }, capabilities);
    expect(below.success && above.success && below.package.packageCacheKey === above.package.packageCacheKey).toBe(true);
    expect(materialModeSource(0.25, "mask", false)).toContain("baseColor [0.75, 0.08, 0.06, 0.25]");
  });
});
