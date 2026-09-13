import { describe, expect, it } from "vitest";
import { resolveShaderPackagePipeline } from "@bim-studio/deep-engine/shader-package";
import { adaptPbrTextureSlotsProbe } from "./deepSlPbrTextureSlotsProbe.js";
import {
  DEEP_SL_PBR_TEXTURE_SLOTS_SOURCE, evaluatePbrTextureSlotsProbe,
  pbrTextureSlotGeometry, pbrTextureSlotTangents, rgba8,
} from "./deepSlPbrTextureSlotsProbeFixture.js";
import { TEST_CAPABILITIES } from "./testShaderCapabilities.js";


describe("DeepSL five-slot PBR texture GPU probe", () => {
  it("selects the bounded tangent pipeline with one fixed material layout", () => {
    const adapted = adaptPbrTextureSlotsProbe(TEST_CAPABILITIES);
    expect(adapted.success).toBe(true);
    if (!adapted.success) return;
    expect(adapted.report).toMatchObject({
      adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-textures.v2",
      vertexStreams: ["geometry", "instance", "tangent"],
      materialTextureDefaults: {
        enabledSlots: ["baseColor", "metallicRoughness", "occlusion", "normal", "emissive"],
      },
    });
    expect(adapted.package.passes.filter((pass) => pass.kind === "forward").every((pass) =>
      resolveShaderPackagePipeline(adapted.package.shaderAbi.contract, pass.pipeline)?.vertexStreams
        .map((stream) => stream.id).join("|") === "geometry|instance|tangent")).toBe(true);
    expect(adapted.package.passes.filter((pass) => pass.kind === "forward").every((pass) =>
      resolveShaderPackagePipeline(adapted.package.shaderAbi.contract, pass.pipeline)?.bindGroupLayouts
        .map((layout) => layout.id).join("|") === "forward-frame|material")).toBe(true);
  });

  it("keeps fixtures bounded and encodes UV1 and tangent handedness explicitly", () => {
    expect(DEEP_SL_PBR_TEXTURE_SLOTS_SOURCE.match(/Texture on/gu)).toHaveLength(5);
    const geometry = pbrTextureSlotGeometry();
    expect([geometry[6], geometry[8], geometry[16], geometry[18]]).toEqual([0.25, 0.75, 0.25, 0.75]);
    expect([...pbrTextureSlotTangents(-1)]).toEqual([
      1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1,
    ]);
    expect([...rgba8(1, 2, 3, 4, 5, 6, 7, 8)]).toHaveLength(8);
    expect(() => rgba8(256, 0, 0, 0)).toThrow(/bytes/u);
  });

  it("requires every directional readback and shared pipeline identity", () => {
    const samples = [
      { id: "neutral" as const, pixel: [0.5, 0.5, 0.5, 1] },
      { id: "metallic-roughness" as const, pixel: [0.3, 0.3, 0.3, 1] },
      { id: "normal-scale" as const, pixel: [0.1, 0.1, 0.1, 1] },
      { id: "occlusion-uv1" as const, pixel: [0.48, 0.48, 0.48, 1] },
      { id: "emissive-srgb" as const, pixel: [1.5, 0.5, 0.5, 1] },
      { id: "emissive-strength-hdr" as const, pixel: [4.5, 0.5, 0.5, 1] },
    ];
    expect(evaluatePbrTextureSlotsProbe(samples, true)).toMatchObject({
      finite: true, metallicRoughnessBgDirectional: true, normalScaleDirectional: true,
      occlusionUv1Directional: true, emissiveSrgbDirectional: true,
      emissiveStrengthDirectional: true, sharedPipeline: true, verified: true,
    });
    expect(evaluatePbrTextureSlotsProbe(samples, false).verified).toBe(false);
    expect(evaluatePbrTextureSlotsProbe(samples.slice(1), true).verified).toBe(false);
  });
});
