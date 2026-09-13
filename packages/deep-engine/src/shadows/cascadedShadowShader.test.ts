import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { planCascadedShadows } from "./cascadedShadowPlanner.js";
import { CASCADED_SHADOW_UNIFORM_BYTES, CASCADED_SHADOW_WGSL, packCascadedShadowUniform } from "./cascadedShadowShader.js";

describe("cascaded shadow shader ABI", () => {
  it("packs fixed eight-cascade matrix and scalar slots", () => {
    const plan = planCascadedShadows({ eye: [0, 2, 8], target: [0, 0, 0], verticalFovRadians: 1,
      aspect: 1.5, near: 0.1, far: 100 }, [1, -2, 1], { cascadeCount: 4, shadowMapSize: 2048 });
    const packed = packCascadedShadowUniform(plan, 0.002, true);
    expect(packed.byteLength).toBe(CASCADED_SHADOW_UNIFORM_BYTES);
    expect([...packed.slice(128, 132)]).toEqual([...plan.splitDepths]);
    expect(packed[152]).toBe(4); expect(packed[153]).toBeCloseTo(0.002);
    expect(packed[154]).toBeCloseTo(1 / 2048); expect(packed[155]).toBe(1);
    expect([...packed.slice(64, 80)]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("contains bounded cascade selection, clip rejection, PCF and blend operations", () => {
    expect(CASCADED_SHADOW_WGSL).toMatch(/texture_depth_2d_array/);
    expect(CASCADED_SHADOW_WGSL).toMatch(/textureSampleCompare/);
    expect(CASCADED_SHADOW_WGSL).toContain("select(slopeBias, 1.0, deepCascade.params.w > 0.5)");
    expect(CASCADED_SHADOW_WGSL).toMatch(/index \+ 1u >= count/);
    expect(CASCADED_SHADOW_WGSL).toMatch(/blendStart >= split/);
    expect(CASCADED_SHADOW_WGSL).toMatch(/smoothstep\(blendStart, split, viewDepth\)/);
    expect(CASCADED_SHADOW_WGSL).toMatch(/ndc\.z < 0\.0 \|\| ndc\.z > 1\.0/);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-cascaded-shadow.wgsl", "--input-kind", "wgsl"],
      { input: CASCADED_SHADOW_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr || validation.stdout).toBe(0);
  });
});
