import { describe, expect, it } from "vitest";
import { resolveShaderPackagePipeline } from "@bim-studio/deep-engine/shader-package";
import { adaptBaseColorTextureProbe } from "./deepSlBaseColorTextureProbe.js";
import {
  baseColorProbeTexture, baseColorTextureSource, constantUv0ProbeGeometry,
  evaluateBaseColorTextureProbe, translatedBaseColorParameters,
} from "./deepSlBaseColorTextureProbeFixture.js";
import { PBR_PROBE_CLEAR } from "./deepSlPbrProbeFixture.js";
import { TEST_CAPABILITIES } from "./testShaderCapabilities.js";

describe("DeepSL base-color texture WebGPU probe", () => {
  it("builds OPAQUE and MASK packages on the fixed group 1 ABI", () => {
    for (const alpha of ["opaque", "mask"] as const) {
      const adapted = adaptBaseColorTextureProbe(alpha, TEST_CAPABILITIES);
      expect(adapted.success).toBe(true);
      if (!adapted.success) continue;
      expect(adapted.report).toMatchObject({
        adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-textures.v2",
        materialSource: "instance-and-material-bind-group",
        materialTextureDefaults: { byteSize: 160, enabledSlots: ["baseColor"] },
      });
      const layouts = adapted.package.passes.map((pass) => ({
        kind: pass.kind,
        layouts: resolveShaderPackagePipeline(adapted.package.shaderAbi.contract, pass.pipeline)
          ?.bindGroupLayouts.map((layout) => layout.id),
      }));
      expect(layouts.filter((entry) => entry.kind === "forward").every((entry) =>
        entry.layouts?.join("|") === "forward-frame|material")).toBe(true);
      expect(layouts.filter((entry) => entry.kind === "shadow").every((entry) =>
        entry.layouts?.join("|") === (alpha === "mask" ? "shadow-frame|material" : "shadow-frame")))
        .toBe(true);
    }
  });

  it("keeps texture pixels and UV transforms in runtime material data", () => {
    expect(baseColorTextureSource("mask")).toContain("baseColorTexture on");
    expect([...baseColorProbeTexture()]).toEqual([230, 26, 18, 64, 20, 220, 30, 192]);
    const geometry = constantUv0ProbeGeometry();
    expect([geometry[6], geometry[16], geometry[26]]).toEqual([0.25, 0.25, 0.25]);
    const parameters = Array.from({ length: 40 }, (_, index) => index);
    const translated = translatedBaseColorParameters(parameters, 0.5);
    expect(translated[2]).toBe(0.5);
    expect(parameters[2]).toBe(2);
    expect(() => translatedBaseColorParameters([1], 0)).toThrow(/40-f32/u);
  });

  it("fails closed unless all color, transform, MASK and cache invariants pass", () => {
    const visibleRed = [0.5, 0.02, 0.01, 1];
    const visibleGreen = [0.02, 0.5, 0.01, 1];
    const samples = [
      { id: "opaque-uv0-left" as const, pixel: visibleRed, shadowDepth: 0.5 },
      { id: "opaque-runtime-transform" as const, pixel: visibleGreen, shadowDepth: 0.5 },
      { id: "mask-alpha-below" as const, pixel: PBR_PROBE_CLEAR, shadowDepth: 1 },
      { id: "mask-alpha-above" as const, pixel: visibleGreen, shadowDepth: 0.5 },
    ];
    expect(evaluateBaseColorTextureProbe(samples, true)).toMatchObject({
      finite: true, opaqueUv0Red: true, runtimeTransformGreen: true,
      maskBelowClear: true, maskAboveVisible: true,
      runtimeVariantsSharePreparedPass: true, verified: true,
    });
    expect(evaluateBaseColorTextureProbe(samples, false).verified).toBe(false);
    expect(evaluateBaseColorTextureProbe(samples.slice(1), true).verified).toBe(false);
  });
});
