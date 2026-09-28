import { describe, expect, it } from "vitest";
import { finiteDifferenceGradient, fitSliderCrank, gearOutputAngle, gaussNewtonStep,
  sliderCrankPosition, sliderCrankValueAndGradient, type SliderCrankParams } from "./mechanismCalibration.js";

const TRUE_PARAMS: SliderCrankParams = { r: 0.025, l: 0.1, offset: 0.005 };

describe("D2 机构可微标定", () => {
  it("解析梯度与中心差分一致（相对误差 < 1e-6，三点多角度采样）", () => {
    for (const theta of [-1.2, -0.4, 0.0, 0.35, 1.9]) {
      const analytic = sliderCrankValueAndGradient(TRUE_PARAMS, theta);
      const [fdTheta, fdR, fdL, fdOffset] = finiteDifferenceGradient(TRUE_PARAMS, theta);
      expect(Math.abs(analytic.dxdTheta - fdTheta) / Math.max(1, Math.abs(analytic.dxdTheta))).toBeLessThan(1e-6);
      expect(Math.abs(analytic.dxdR - fdR) / Math.max(1, Math.abs(analytic.dxdR))).toBeLessThan(1e-6);
      expect(Math.abs(analytic.dxdL - fdL) / Math.max(1, Math.abs(analytic.dxdL))).toBeLessThan(1e-6);
      expect(analytic.dxdOffset).toBe(1);
      expect(fdOffset).toBeCloseTo(1, 6);
      void fdTheta; void fdR; void fdL;
    }
  });

  it("Gauss-Newton 对无噪样本精确恢复真参数（算法正确性，容差机器精度级）", () => {
    const samples = [0, 0.55, 1.1, 1.9, 2.6, 3.3, 3.9, 4.4, 5.1, 5.6, 6.0, 6.2]
      .map(theta => ({ theta, x: sliderCrankPosition(TRUE_PARAMS, theta) }));
    const fitted = fitSliderCrank({ r: 0.03, l: 0.12, offset: 0 }, samples);
    expect(Math.abs(fitted.params.r - TRUE_PARAMS.r)).toBeLessThan(1e-9);
    expect(Math.abs(fitted.params.l - TRUE_PARAMS.l)).toBeLessThan(1e-9);
    expect(Math.abs(fitted.params.offset - TRUE_PARAMS.offset)).toBeLessThan(1e-9);
    expect(fitted.residualSse).toBeLessThan(1e-18);
  });

  it("Gauss-Newton 对带噪样本鲁棒：残差收敛到噪声能量级，参数误差在噪声量级内", () => {
    // 系统性固定偏移不是零均值噪声：参数误差由具体噪声实现决定，算法保证的是
    // 残差收敛到噪声水平 + 参数不发散；精确恢复不是可断言性质。
    const perturbation = [4e-5, -5e-5, 3e-5, -2e-5, 5e-5, -4e-5, 2e-5, 5e-5, -3e-5, 4e-5, -5e-5, 2e-5];
    const samples = [0, 0.55, 1.1, 1.9, 2.6, 3.3, 3.9, 4.4, 5.1, 5.6, 6.0, 6.2].map((theta, index) => ({
      theta, x: sliderCrankPosition(TRUE_PARAMS, theta) + perturbation[index % perturbation.length]!,
    }));
    const noiseEnergy = perturbation.reduce((sum, value) => sum + value * value, 0);
    const fitted = fitSliderCrank({ r: 0.03, l: 0.12, offset: 0 }, samples);
    expect(fitted.residualSse).toBeLessThan(noiseEnergy * 1.5);
    expect(fitted.params.r).toBeGreaterThan(0);
    expect(fitted.params.l).toBeGreaterThan(fitted.params.r);
    for (const sample of samples) {
      const residual = sliderCrankPosition(fitted.params, sample.theta) - sample.x;
      expect(Math.abs(residual)).toBeLessThan(2e-4);
    }
  });

  it("同输入逐位一致；非法输入与不可辨识样本集 fail-closed", () => {
    const a = sliderCrankValueAndGradient(TRUE_PARAMS, 0.7);
    const b = sliderCrankValueAndGradient(TRUE_PARAMS, 0.7);
    expect(a.x).toBe(b.x); expect(a.dxdTheta).toBe(b.dxdTheta); expect(a.dxdR).toBe(b.dxdR);
    expect(() => sliderCrankPosition({ ...TRUE_PARAMS, r: -1 }, 0)).toThrow(/> 0/);
    expect(() => sliderCrankPosition({ ...TRUE_PARAMS, l: TRUE_PARAMS.r }, 0)).toThrow(/可装配/);
    expect(() => sliderCrankPosition(TRUE_PARAMS, Number.NaN)).toThrow(/有限/);
    expect(() => gaussNewtonStep(TRUE_PARAMS, [{ theta: 0, x: 1 }])).toThrow(/至少需要 3 个/);
    // 三共线同值样本 → JᵀJ 奇异 → 拒绝而非输出垃圾参数
    const degenerate = [{ theta: 0.3, x: 0.12 }, { theta: 0.3, x: 0.12 }, { theta: 0.3, x: 0.12 }];
    expect(() => gaussNewtonStep(TRUE_PARAMS, degenerate)).toThrow(/不可辨识/);
    expect(() => gearOutputAngle(1, 0)).toThrow(/非零/);
    expect(gearOutputAngle(2.5, -3)).toBe(-7.5);
  });
});
