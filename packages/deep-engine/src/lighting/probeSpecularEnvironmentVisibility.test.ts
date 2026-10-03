import { describe, expect, it } from "vitest";
import { sceneShader } from "../webgpu/pbrShader.js";
import { GI_SPECULAR_ENVIRONMENT_VISIBILITY_LUMA_EPSILON,
  probeSpecularEnvironmentVisibility } from "./probeSpecularEnvironmentVisibility.js";

const grey = (value: number): [number, number, number] => [value, value, value];

describe("F5 rejected brightness heuristic: arithmetic is not physical visibility", () => {
  it("retains positive/negative/overshoot arithmetic for reproducible counterexamples", () => {
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(0.5), a: 1 })).toBe(1);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(-0.5), a: 1 })).toBe(0);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(1), a: 1 })).toBe(1);
  });

  it("cannot distinguish an unoccluded dark Lambert surface from an occluded bright surface", () => {
    // Same measured irradiance: albedo 0.1 × visibility 1 versus albedo 1 × visibility 0.1.
    const fullVisibilityDark = { rgb: grey(0.5 * 0.1 * 1), a: 1 };
    const partialVisibilityWhite = { rgb: grey(0.5 * 1 * 0.1), a: 1 };
    expect(fullVisibilityDark).toEqual(partialVisibilityWhite);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), fullVisibilityDark)).toBeCloseTo(0.1, 12);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), partialVisibilityWhite)).toBeCloseTo(0.1, 12);
    // Different physical visibility, identical heuristic output: it cannot gate specular IBL.
  });

  it("has a discontinuity at the near-black threshold and is not exposure-scale invariant", () => {
    const epsilon = GI_SPECULAR_ENVIRONMENT_VISIBILITY_LUMA_EPSILON;
    expect(probeSpecularEnvironmentVisibility(grey(epsilon * 0.5), { rgb: grey(0), a: 1 })).toBe(1);
    expect(probeSpecularEnvironmentVisibility(grey(epsilon * 2), { rgb: grey(0), a: 1 })).toBe(0);
  });

  it("treats fractional cascade validity as fully valid rather than preserving environment fallback", () => {
    // Production deepGiSampleTexture mixes fine/coarse vec4f, so a can be fractional.
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(0), a: 0 })).toBe(1);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(0), a: 0.001 })).toBe(0);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(0), a: 0.5 })).toBe(0);
  });

  it("does not provide finite diagnostic outputs for all non-finite probe inputs", () => {
    expect(Number.isNaN(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(NaN), a: 1 }))).toBe(true);
    expect(probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(Infinity), a: 1 })).toBe(1);
  });

  it("cannot attest local reflection visibility from a diffuse probe measurement", () => {
    const localMirrorRadiance = 2;
    const ratio = probeSpecularEnvironmentVisibility(grey(0.5), { rgb: grey(0), a: 1 });
    expect(localMirrorRadiance * ratio).toBe(0); // Would erase a valid local reflection.
    // 生产面合同（F5 方案 A，2026-10-03 批准）：镜面项乘方向门；本标量算术只允许以
    // 「SH 缺失探针的逐探针 fallback」形式在场（WGSL deepGiSpecularLevelGate 内联），
    // 拒绝的全域乘子与被撤函数不得回归。
    expect(sceneShader).toContain("let radiance = deepPbrReflectionRadiance(world, reflection, rough) * frame.lightDirection.w;");
    expect(sceneShader).toContain(
      "color += radiance * specularDirectionalVisibility * specularFraction * occlusion * frame.eye.w;");
  });

  it("keeps diffuse GI and the split-sum energy allocation; the directional gate is the only specular multiplier", () => {
    expect(sceneShader).toContain("let irradiance = mix(environmentIrradiance, gi.rgb, gi.a);");
    expect(sceneShader).toContain("(1.0 - specularFraction) * (1.0 - metal) * base * irradiance * occlusion");
    expect(sceneShader).toContain("clamp(f0 * dfg.x + dfg.y, vec3f(0.0), vec3f(1.0)) * energyCompensation");
    // 被撤销的全域标量乘子/函数不得回归：
    expect(sceneShader).not.toContain("fn deepGiSpecularEnvironmentVisibility(");
    expect(sceneShader).not.toContain("specularEnvironmentVisibility *");
    // F5 方案 A：方向门单源定义一次、应用一次（fallback 在门函数内，不在 shade()）。
    expect(sceneShader.match(/deepGiSpecularDirectionalVisibility\(world,/g)).toHaveLength(1);
    expect(sceneShader).toContain(
      "let specularDirectionalVisibility = deepGiSpecularDirectionalVisibility(world, n, reflection, environmentIrradiance);");
    expect(sceneShader).toContain("let shMissing = all(shR == vec4f(0.0)) && all(shG == vec4f(0.0)) && all(shB == vec4f(0.0));");
  });
});
