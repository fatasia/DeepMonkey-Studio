import { describe, expect, it } from "vitest";
import type { ShaderCompileCapabilities } from "@bim-studio/deep-engine/shader";
import { adaptUnlitProbeSource, evaluateUnlitProbe } from "./deepSlUnlitProbe.js";

const CAPABILITIES: ShaderCompileCapabilities = Object.freeze({
  features: Object.freeze([]), limits: Object.freeze({
    maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16,
  }),
});

describe("DeepSL Unlit real-GPU probe contract", () => {
  it("builds the exact executable probe package", () => {
    const result = adaptUnlitProbeSource(`shader deep.unlit-test {
  surface unlit;
  alpha mask;
  baseColorTexture on;
  baseColorTextureTransform texCoord 1 offset [0.5, 0] scale [1, 1] rotation 0;
}`, CAPABILITIES);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.package.passes.map((pass) => pass.id)).toEqual([
      "webgpu/forwardCcw", "webgpu/forwardCw", "webgpu/shadowCcw", "webgpu/shadowCw",
    ]);
    expect(result.report.materialTextureDefaults?.baseColor)
      .toMatchObject({ enabled: true, texCoord: 1, offset: [0.5, 0] });
  });

  it("requires direct HDR color, UV1 texture visibility, and both shadows", () => {
    expect(evaluateUnlitProbe([
      { id: "plain", pixel: [0.45, 0.9, 1.35, 1], shadowDepth: 0.5 },
      { id: "textured-mask", pixel: [0.1, 0.6, 0.2, 1], shadowDepth: 0.5 },
    ])).toMatchObject({ verified: true, plainUnlit: true, uv1MaskVisible: true, shadowsVisible: true });
    expect(evaluateUnlitProbe([
      { id: "plain", pixel: [0.1, 0.1, 0.1, 1], shadowDepth: 1 },
      { id: "textured-mask", pixel: [0.1, 0.6, 0.2, 1], shadowDepth: 1 },
    ])).toMatchObject({ verified: false, plainUnlit: false, shadowsVisible: false });
  });
});
