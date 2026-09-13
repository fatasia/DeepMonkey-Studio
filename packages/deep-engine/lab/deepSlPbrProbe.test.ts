import { describe, expect, it } from "vitest";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { adaptDeepSlPbrProbeCase } from "./deepSlPbrProbe.js";
import {
  DEEP_SL_PBR_PROBE_SOURCES,
  evaluatePbrProbe,
  pbrProbeFrame,
  pbrProbeGeometry,
  pbrProbeInstance,
  type DeepSlPbrProbeCaseId,
} from "./deepSlPbrProbeFixture.js";

const capabilities: ShaderCompileCapabilities = Object.freeze({
  features: Object.freeze([]),
  limits: Object.freeze({
    maxBindGroups: 4,
    maxBindingsPerBindGroup: 16,
    maxInterStageShaderVariables: 16,
  }),
});

describe("DeepSL PBR package GPU probe fixture", () => {
  it("adapts three material-only sources to one real PBR package identity", () => {
    const ids = Object.keys(DEEP_SL_PBR_PROBE_SOURCES) as DeepSlPbrProbeCaseId[];
    const adapted = ids.map((id) => adaptDeepSlPbrProbeCase(id, capabilities));
    expect(adapted.every((result) => result.success)).toBe(true);
    const packages = adapted.flatMap((result) => result.success ? [result.package] : []);
    expect(new Set(packages.map((value) => value.packageCacheKey))).toHaveLength(1);
    expect(packages[0]?.modules[0]?.source).toContain("fn deepLowerStandardPbr(");
    expect(packages[0]?.passes.map((pass) => pass.id)).toEqual([
      "webgpu/forwardCcw", "webgpu/forwardCw", "webgpu/shadowCcw", "webgpu/shadowCw",
    ]);
    expect(adapted.map((result) => result.report.materialDefaults)).toEqual([
      {
        baseColorMetallic: [0.75, 0.08, 0.06, 0],
        roughnessAlphaCutoffHandednessFlags: [0.8, 0.5, 1, 0],
        emissiveAlpha: [0, 0, 0, 1],
      },
      {
        baseColorMetallic: [0.08, 0.65, 0.06, 0],
        roughnessAlphaCutoffHandednessFlags: [0.8, 0.5, 1, 0],
        emissiveAlpha: [0, 0, 0, 1],
      },
      {
        baseColorMetallic: [0.75, 0.08, 0.06, 0],
        roughnessAlphaCutoffHandednessFlags: [0.25, 0.5, 1, 0],
        emissiveAlpha: [0, 0, 0, 1],
      },
    ]);
  });

  it("packs the frozen Frame208, geometry40, and instance144 ABI", () => {
    const adapted = adaptDeepSlPbrProbeCase("rough-red", capabilities);
    expect(adapted.success).toBe(true);
    if (!adapted.success || !adapted.report.materialDefaults) return;
    const frame = pbrProbeFrame();
    const geometry = pbrProbeGeometry();
    const instance = pbrProbeInstance(adapted.report.materialDefaults);
    expect(frame.byteLength).toBe(208);
    expect(geometry.byteLength / 3).toBe(40);
    expect(instance.byteLength).toBe(144);
    expect(Array.from(instance.slice(24, 36))).toEqual(Array.from(new Float32Array([
      ...adapted.report.materialDefaults.baseColorMetallic,
      ...adapted.report.materialDefaults.roughnessAlphaCutoffHandednessFlags,
      ...adapted.report.materialDefaults.emissiveAlpha,
    ])));
  });

  it("requires finite, non-clear output and directional material deltas", () => {
    const passing = evaluatePbrProbe([
      { id: "rough-red", pixel: [0.8, 0.1, 0.1, 1] },
      { id: "rough-green", pixel: [0.1, 0.8, 0.1, 1] },
      { id: "glossy-red", pixel: [2, 0.3, 0.3, 1] },
    ]);
    expect(passing).toMatchObject({
      verified: true,
      finite: true,
      nonClear: true,
      baseColorDirection: true,
      roughnessDirection: true,
    });
    expect(evaluatePbrProbe([
      { id: "rough-red", pixel: [0.003, 0.007, 0.011, 1] },
      { id: "rough-green", pixel: [0.003, 0.007, 0.011, 1] },
      { id: "glossy-red", pixel: [Number.NaN, 0, 0, 1] },
    ])).toMatchObject({ verified: false, finite: false, nonClear: false });
  });
});
