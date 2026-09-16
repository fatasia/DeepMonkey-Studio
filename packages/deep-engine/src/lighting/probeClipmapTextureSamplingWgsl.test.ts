import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEEP_GI_TEXTURE_BINDING, DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES, DEEP_GI_TEXTURE_LEVELS_BINDING,
  DEEP_GI_TEXTURE_SAMPLER_BINDING, PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL } from "./probeClipmapTextureSamplingWgsl.js";

describe("texture-backed GI clipmap sampling", () => {
  it("uses the free Forward+ bindings and two filtered fetches per level", () => {
    expect([DEEP_GI_TEXTURE_BINDING, DEEP_GI_TEXTURE_SAMPLER_BINDING,
      DEEP_GI_TEXTURE_LEVELS_BINDING]).toEqual([9, 10, 11]);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL.match(/textureSampleLevel\(/g)).toHaveLength(2);
    expect(DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES).toBe(256);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("levels: array<DeepGiTextureLevel, 4>");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("let levelCount = 4u");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga semantic validation", () => {
    const code = `${PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL}
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return deepGiSampleTexture(vec3f(0.0), vec3f(0.0, 1.0, 0.0));
}`;
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-gi-texture-sampling.wgsl", "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
