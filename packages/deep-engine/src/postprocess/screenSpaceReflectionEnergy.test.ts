import { describe, expect, it } from "vitest";
import { ssrBrdfSpecularFractionCpu } from "./screenSpaceReflectionCpu.js";
import { environmentShader } from "../webgpu/environmentShader.js";
import { ggxVisibilityLibrary } from "../shader/ggxVisibilityGlsl.js";

/**
 * C11 物理化能量量化:旧 mask(镜面 Schlick)与新 mask(split-sum 高光分数,CPU DFG 复刻)
 * 在 (nv, rough) 全域的 RMSE/极值表——即本次物理化从粗糙面 SSR 替换权重中移除的能量错配。
 * 白炉守恒(SSR 开/关净零)由真机 whiteFurnaceGpuTest 门禁回归,此处是公式级量化。
 */

const FRESNEL_F0 = 0.05;

function legacyMirrorSchlick(cosTheta: number, roughness: number, fresnelF0: number): number {
  void roughness; // 旧 mask 与粗糙度无关——这正是缺陷的一部分。
  return fresnelF0 + (1 - fresnelF0) * Math.pow(1 - cosTheta, 5);
}

function gridSample(count: number): readonly { readonly nv: number; readonly rough: number }[] {
  const samples: { nv: number; rough: number }[] = [];
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    samples.push({ nv: (x + 0.5) / count, rough: (y + 0.5) / count });
  }
  return samples;
}

describe("C11 SSR mask 物理化能量量化", () => {
  it("keeps the CPU DFG weight near the independent r185 LUT at rough direct-light limits", () => {
    // Bilinear values from Three r185 DFGLUTData (16², 4096-sample RG16F), NV=.8.
    // This fixture rejects the former separable Schlick integrator, independently of our CPU integration.
    for (const [rough, a, b] of [[.55, .85171875, .0015791559], [.9, .45383789, .000646636]]) {
      const expected = (FRESNEL_F0 * a! + b!) * (1 + FRESNEL_F0 * (1 / (a! + b!) - 1));
      expect(Math.abs(ssrBrdfSpecularFractionCpu(.8, rough!, FRESNEL_F0) - expected)).toBeLessThan(.00025);
    }
    expect(environmentShader).toContain(ggxVisibilityLibrary().wgsl);
    expect(environmentShader).toContain("deepSharedGgxVisibility(alpha * alpha, nv, nl)");
    expect(environmentShader).toContain("for (var i = 0u; i < 256u; i++)");
  });
  it("量化旧镜面 Schlick 在粗糙域的能量错配(RMSE 与极值表进报告)", () => {
    const grid = gridSample(16);
    let squaredSum = 0, maxAbs = 0, maxAt = { nv: 0, rough: 0 };
    for (const { nv, rough } of grid) {
      const legacy = legacyMirrorSchlick(nv, rough, FRESNEL_F0);
      const physical = ssrBrdfSpecularFractionCpu(nv, rough, FRESNEL_F0);
      const delta = physical - legacy;
      squaredSum += delta * delta;
      if (Math.abs(delta) > maxAbs) { maxAbs = Math.abs(delta); maxAt = { nv, rough }; }
    }
    const rmse = Math.sqrt(squaredSum / grid.length);
    // 量化锚点:错配必须在量级上显著(粗糙掠射处旧 mask 高估一个数量级),
    // 否则本次物理化没有可测量的能量收益,门禁应失败提醒复核。
    expect(rmse).toBeGreaterThan(0.1);
    expect(maxAbs).toBeGreaterThan(0.4);
    expect(maxAt.rough).toBeGreaterThan(0.75);
    expect(maxAt.nv).toBeLessThan(0.25);
  });

  it("镜面极限(rough→0)新分数与 Schlick 一致(与主着色器同权,不改变光滑外观)", () => {
    for (const nv of [0.05, 0.2, 0.5, 0.8, 1]) {
      const schlick = legacyMirrorSchlick(nv, 0, FRESNEL_F0);
      const physical = ssrBrdfSpecularFractionCpu(nv, 0.001, FRESNEL_F0);
      expect(Math.abs(physical - schlick)).toBeLessThan(0.02);
    }
  });

  it("全金属极限(F0=1)经 MS 补偿收敛到全反射(与主着色器金属路径一致)", () => {
    for (const rough of [0.001, 0.25, 0.5, 0.75, 1]) {
      const fraction = ssrBrdfSpecularFractionCpu(1, rough, 1);
      expect(fraction).toBeGreaterThan(0.95);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it("分数有界 [0,1] 且输入校验拒绝非有限值", () => {
    for (const { nv, rough } of gridSample(8)) {
      const fraction = ssrBrdfSpecularFractionCpu(nv, rough, FRESNEL_F0);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect(() => ssrBrdfSpecularFractionCpu(Number.NaN, 0.5, FRESNEL_F0)).toThrow(RangeError);
  });

  it("memo 量化下结果确定(同输入同输出)", () => {
    const a = ssrBrdfSpecularFractionCpu(0.37, 0.62, FRESNEL_F0);
    const b = ssrBrdfSpecularFractionCpu(0.37, 0.62, FRESNEL_F0);
    expect(a).toBe(b);
  });
});
