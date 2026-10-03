import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEEP_GI_TEXTURE_BINDING, DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES, DEEP_GI_TEXTURE_LEVELS_BINDING,
  DEEP_GI_TEXTURE_SAMPLER_BINDING, PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL } from "./probeClipmapTextureSamplingWgsl.js";
import { PROBE_RADIANCE_MOMENT_LANES } from "../rayTracing/probeRadianceKernel.js";

describe("texture-backed GI clipmap sampling", () => {
  it("uses the free Forward+ bindings and 8 per-probe taps with the DDGI normal weight", () => {
    expect([DEEP_GI_TEXTURE_BINDING, DEEP_GI_TEXTURE_SAMPLER_BINDING,
      DEEP_GI_TEXTURE_LEVELS_BINDING]).toEqual([9, 10, 11]);
    // Leak suppression needs per-probe weighting, which hardware bilinear cannot express:
    // the level sampler must load each cube corner explicitly (8 taps) and apply the
    // cosine^bias normal weight. Hardware-filtered fetches must be gone from this path.
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).not.toContain("textureSampleLevel(");
    // textureLoad 分解：漫射路径（体积 1 + moments lane0 包装 1）+ F5 方向门
    // （体积 1 + lane0/1/2/3 共 4）= 7。
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL.match(/textureLoad\(/g)).toHaveLength(7);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("@group(3) @binding(16) var deepGiMoments");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("moment.w == 0.0");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("distance <= meanDistance && enclosed");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("deepGiTextureNormalWeight");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("corner < 8u");
    expect(DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES).toBe(256);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("levels: array<DeepGiTextureLevel, 4>");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("let levelCount = 4u");
  });

  it("F5 方案 A：moments lane 布局与镜面方向门（域外/近黑恒 1，SH 缺失走标量 fallback）", () => {
    // lane 常量单源：消费侧从捕获核常量导入，禁双源。
    expect(PROBE_RADIANCE_MOMENT_LANES).toBe(4);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain(`logicalLayer * ${PROBE_RADIANCE_MOMENT_LANES}u + 0u`);
    // realMoments 判据按 lane 扩容后的层容量核对（旧 1-lane 体积 → false → 旧行为降级）。
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain(
      `(level.level + 1u) * level.gridSize.z * ${PROBE_RADIANCE_MOMENT_LANES}u`);
    // 方向门单源定义一次；重建核 (1, y, z, x) 与 CPU probeDirectionalVisibilitySh 同族；
    // SH 缺失（三通道全零）→ 标量 fallback；保守分支与权重归一在案。
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL.match(/fn deepGiSpecularLevelGate\(/g)).toHaveLength(1);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL.match(/fn deepGiSpecularDirectionalVisibility\(/g)).toHaveLength(1);
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("let axis = vec4f(1.0, direction.y, direction.z, direction.x);");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain(
      "let shMissing = all(shR == vec4f(0.0)) && all(shG == vec4f(0.0)) && all(shB == vec4f(0.0));");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("if (!(envLuma > 0.0001)) { return 1.0; }");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("if (!(totalWeight >= 0.001)) { return 1.0; }");
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain("if (!realMoments) { return 1.0; }");
    // 门权重与漫射采样同款（trilinear × validity × normal × chebyshev）。
    expect(PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL).toContain(
      "* deepGiTextureVisibilityFrom(moment, receiver, probePosition, level.originSpacing.w);");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga semantic validation", () => {
    const code = `${PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL}
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  let gate = deepGiSpecularDirectionalVisibility(vec3f(0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0), vec3f(1.0));
  return deepGiSampleTexture(vec3f(0.0), vec3f(0.0, 1.0, 0.0)) * gate;
}`;
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-gi-texture-sampling.wgsl", "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
