import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LOCAL_SPOT_SHADOW_WGSL } from "./localSpotShadowShader.js";
import { LOCAL_SHADOW_PCSS_MAX_RADIUS_TEXELS, LOCAL_SHADOW_PCSS_TAPS,
  localShadowPcssDepthBias, localShadowPcssRadius, localShadowPcssRotation,
  resolveLocalShadowSoftness } from "./localShadowSoftness.js";

describe("local spot soft-shadow contract", () => {
  it("keeps the legacy four-tap branch for omitted softness and bounds PCSS cost", () => {
    expect(resolveLocalShadowSoftness(undefined)).toBe(0);
    expect(resolveLocalShadowSoftness(0)).toBe(0);
    expect(localShadowPcssRadius(0.7, 0.5, 0)).toBe(1);
    expect(localShadowPcssRadius(0.7, 0.5, 0.5)).toBeGreaterThan(1);
    expect(localShadowPcssRadius(0.9, 0.01, 1)).toBe(LOCAL_SHADOW_PCSS_MAX_RADIUS_TEXELS);
    expect(LOCAL_SHADOW_PCSS_TAPS).toBe(12);
    expect(() => resolveLocalShadowSoftness(-0.1)).toThrow(/\[0, 1\]/);
    expect(() => resolveLocalShadowSoftness(Number.NaN)).toThrow(/\[0, 1\]/);
  });

  it("uses slope-aware bias and a deterministic per-tile sampling rotation", () => {
    expect(localShadowPcssDepthBias(0.001, 1)).toBeCloseTo(0.001);
    expect(localShadowPcssDepthBias(0.001, 0)).toBeCloseTo(0.003);
    const tile = localShadowPcssRotation(2 / 1024, 2 / 1024);
    expect(localShadowPcssRotation(2 / 1024, 2 / 1024)).toBe(tile);
    expect(localShadowPcssRotation(514 / 1024, 2 / 1024)).not.toBe(tile);
    expect(() => localShadowPcssDepthBias(-1, 0)).toThrow(/bias/);
    expect(() => localShadowPcssRotation(2, 0)).toThrow(/tile offset/);
  });

  it("performs blocker search and guarded PCSS sampling only after the compatibility branch", () => {
    const legacy = LOCAL_SPOT_SHADOW_WGSL.indexOf("if (softness <= 0.0) { return legacyVisibility; }");
    const blocker = LOCAL_SPOT_SHADOW_WGSL.indexOf("textureLoad(deepLocalShadowAtlas");
    expect(legacy).toBeGreaterThan(0); expect(blocker).toBeGreaterThan(legacy);
    expect(LOCAL_SPOT_SHADOW_WGSL).toContain("pcssIndex < 12u");
    expect(LOCAL_SPOT_SHADOW_WGSL).toContain("fn deepLocalShadowRotate");
    expect(LOCAL_SPOT_SHADOW_WGSL).toContain("clamp(atlasUv + stableOffset");
    expect(LOCAL_SPOT_SHADOW_WGSL).toContain("entry.params.y * (1.0 + 2.0");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("is Naga-valid", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-local-spot-shadow.wgsl", "--input-kind", "wgsl"],
      { input: LOCAL_SPOT_SHADOW_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
