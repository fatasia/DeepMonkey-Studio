import { describe, expect, it } from "vitest";
import { sceneShader } from "./pbrShader.js";
import { PBR_DIRECT_DISPLAY_WGSL } from "./pbrDirectDisplayWgsl.js";
import { pbrFogFactor } from "./pbrFog.js";
import { encodePbrDisplayColor } from "./pbrDisplayColor.js";
import { compositeAmbientOcclusionCpu } from "../postprocess/ambientOcclusionCompositeCpu.js";

describe("PBR renderer unlit surface branch", () => {
  it("selects unlit color at the shared fog exit without nonuniform early returns before derivatives", () => {
    expect(sceneShader).not.toContain("if (flag(materialFlags, 64u))");
    expect(sceneShader).toContain("deepApplySceneFog(select(color, baseInput, flag(materialFlags, 64u)), world, materialFlags)");
    expect(sceneShader).toContain("SurfaceSample(v.colorMetal.rgb * baseSample.rgb");
    expect(sceneShader).toContain("v.emissiveAlpha.w * baseSample.a");
    expect(sceneShader).toContain("vec4f(viewNormal * 0.5 + 0.5, clamp(roughness, 0.0, 1.0))");
  });

  it("keeps all no-effects direct variants unlit and sends alpha through normal coverage", () => {
    expect(PBR_DIRECT_DISPLAY_WGSL).not.toContain("if (flag(flags, 64u))");
    expect(PBR_DIRECT_DISPLAY_WGSL).not.toContain("if (flag(v.material.w, 64u))");
    expect(PBR_DIRECT_DISPLAY_WGSL).toContain("baseInput, flag(flags, 64u)");
    expect(PBR_DIRECT_DISPLAY_WGSL).toContain("colorMetal.rgb, flag(flags, 64u)");
    expect(PBR_DIRECT_DISPLAY_WGSL).toContain("deepDisplayColor(select(color, v.colorMetal.rgb, flag(v.material.w, 64u)), frame.output)");
  });

  it("retains linear base texture products and opacity through AO then common display encoding", () => {
    // Texture decoding produces linear samples before this stage, just like textureSample(srgb).
    const factor = [0.5, 2, 0.25], sample = [0.25, 0.5, 1];
    const linear = factor.map((value, index) => value * sample[index]!) as [number, number, number];
    const alpha = 0.8 * 0.5;
    const output = compositeAmbientOcclusionCpu({ width: 1, height: 1, color: [...linear, alpha],
      depth: [5], unlitMask: [1], ambientOcclusionWidth: 1, ambientOcclusionHeight: 1, ambientOcclusion: [0] },
    { depthSigma: 0.1, strength: 1 });
    expect([...output.slice(0, 3)]).toEqual([0.125, 1, 0.25]);
    expect(output[3]).toBeCloseTo(0.4, 7);
    const fog = { kind: "linear" as const, color: [1, 0, 0] as const, near: 0, far: 10 };
    const amount = pbrFogFactor(fog, 5);
    const fogged = linear.map((value, index) => value * (1 - amount) + fog.color[index]! * amount) as [number, number, number];
    expect(fogged).toEqual([0.5625, 0.5, 0.125]);
    const settings = { exposure: 1, toneMapping: "three-aces-r185" as const };
    expect(encodePbrDisplayColor(fogged, settings)).not.toEqual(encodePbrDisplayColor(linear, settings));
    expect(encodePbrDisplayColor(linear, settings).every(value => value >= 0 && value <= 1)).toBe(true);
  });
});
