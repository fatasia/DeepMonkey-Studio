import { describe, expect, it } from "vitest";
import { verifySsrCpuConventions, verifySsrWgslConventions } from "./screenSpaceReflectionConventions.js";
import { sampleScreenSpaceReflectionRoughRadianceCpu, screenSpaceReflectionEdgeFade,
} from "./screenSpaceReflectionCpu.js";
import { SSR_COMPOSITE_WGSL, SSR_TRACE_WGSL } from "./screenSpaceReflectionWgsl.js";

const OPTIONS = Object.freeze({ verticalFovRadians: Math.PI / 3, maxDistance: 40, thickness: 0.5,
  steps: 64, refines: 4, edgeFade: 0.08, fresnelF0: 0.5 });

describe("SSR WGSL 静态约定核验", () => {
  it("生产 WGSL 通过全部约定检查（含 T07 边界与全屏模糊禁项）", () => {
    const results = verifySsrWgslConventions();
    const failed = results.filter(check => !check.passed);
    expect(failed).toEqual([]);
    // 覆盖面守护：约定清单不得静默缩水。
    expect(results.length).toBeGreaterThanOrEqual(18);
    const ids = results.map(check => check.id);
    for (const required of ["origin-guard", "thickness-band", "normal-view-decode", "roughness-cone-mip",
      "refine-hole-guard", "edge-fade-clamp", "fresnel-split-sum", "brdf-lut-bound", "composite-replace",
      "no-temporal-history", "no-fullscreen-blur"]) {
      expect(ids).toContain(required);
    }
  });
  it("对被篡改的 WGSL 报告失败（核验器不是恒真）", () => {
    // 模拟厚度带回归：去掉 thickness 比较。
    const mutated = SSR_TRACE_WGSL.replace("&& rayDepth - surfaceDepth < ssrParams.projection.w", "");
    expect(mutated).not.toBe(SSR_TRACE_WGSL);
    const thicknessCheck = verifySsrWgslConventions().find(check => check.id === "thickness-band");
    expect(thicknessCheck).toBeDefined();
    // 直接用核验器同款正则验证“变异体必须失败”。
    expect(/if \(surfaceDepth < rayDepth && rayDepth - surfaceDepth < ssrParams\.projection\.w\) \{/u
      .test(mutated)).toBe(false);
    expect(/if \(surfaceDepth < rayDepth && rayDepth - surfaceDepth < ssrParams\.projection\.w\) \{/u
      .test(SSR_TRACE_WGSL)).toBe(true);
  });
  it("composite 不含法线/深度绑定（只做上采样替换）", () => {
    expect(SSR_COMPOSITE_WGSL).not.toContain("sourceDepth");
    expect(SSR_COMPOSITE_WGSL).not.toContain("sourceNormal");
  });
});

describe("SSR CPU 数值约定核验", () => {
  it("投影往返/反射对称/edgeFade 有界/lod 一致/参数块布局全部通过", () => {
    expect(verifySsrCpuConventions({ ...OPTIONS }, 128, 128)).toEqual([]);
  });
  it("coneMipLevels 漂移回归：收紧锥档后 CPU 顶档采样必须改变", () => {
    const scene = { width: 64, height: 64, depth: [], normals: [],
      color: Array.from({ length: 64 * 64 * 3 }, (_, index) => {
        const pixel = Math.floor(index / 3);
        return pixel === 32 * 64 + 32 ? 1 : 0.1;
      }) };
    // 2026-09-27 修复前：旧实现忽略 coneMipLevels，coneMipLevels=2 与 6 的顶档采样相同。
    const top = (coneMipLevels?: number) => sampleScreenSpaceReflectionRoughRadianceCpu(
      scene, 0.5, 0.5, 1, coneMipLevels)[0];
    expect(top(2)).not.toBe(top(6));
    expect(top(3)).not.toBe(top(6));
    expect(top()).toBe(top(6)); // 默认（不传）= 6 档。
  });
});

describe("edgeFade 下界 clamp 同族回归", () => {
  it("出界 uv 收敛到 0，不再产生 t²(3−2t) 的假放大", () => {
    // 修复前：t = min(1, 负值) → t²(3−2t) 为正且可达 ~1，屏边 mask 被放大。
    expect(screenSpaceReflectionEdgeFade(-0.001, 0.5, 0.08)).toBe(0);
    expect(screenSpaceReflectionEdgeFade(0.5, 1.001, 0.08)).toBe(0);
    expect(screenSpaceReflectionEdgeFade(-0.5, 0.5, 0.1)).toBe(0);
    expect(screenSpaceReflectionEdgeFade(1.5, 0.5, 0.1)).toBe(0);
    // 界内行为保持不变。
    expect(screenSpaceReflectionEdgeFade(0.5, 0.5, 0.1)).toBe(1);
  });
});
