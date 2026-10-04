import { describe, expect, it } from "vitest";
import { A2C_ALPHA_THRESHOLDS, aaComboEnergyTable, aaComboReference, aaComboSample,
  MSAA4_SAMPLE_OFFSETS, renderAaComboMsaa4, renderAaComboMsaa4A2c,
  renderAaComboMsaa4Tsr, renderAaComboNoAA, AA_COMBO_SOURCE_CONTRAST } from "./aaComboHarness.js";

describe("AA combo harness (AA-M2 analytic tiers)", () => {
  it("uses a fixed deterministic a2c threshold ladder (same input, same sample mask)", () => {
    // 固定阶梯即确定性:纯查表,无逐像素随机相位。
    expect(A2C_ALPHA_THRESHOLDS).toEqual([0.125, 0.375, 0.625, 0.875]);
    // 阶梯无偏性:覆盖率 = round(alpha·4)/4 —— 阈值均值 0.5,偏差有界 ±0.125。
    const coverageAt = (alpha: number): number =>
      A2C_ALPHA_THRESHOLDS.filter(threshold => alpha > threshold).length / 4;
    expect(coverageAt(0.5)).toBe(0.5);
    expect(coverageAt(0.9)).toBe(1);
    expect(coverageAt(0.1)).toBe(0);
    expect(coverageAt(0.3)).toBe(0.25);
    expect(coverageAt(0.7)).toBe(0.75);
  });

  it("uses the standard rotated-grid 4-sample pattern", () => {
    expect(MSAA4_SAMPLE_OFFSETS).toEqual([[-0.125, -0.375], [0.375, -0.125], [-0.375, 0.125], [0.125, 0.375]]);
  });

  it("gives a2c zero gain on fully opaque geometry and distinct coverage on alpha gradients", () => {
    // 细杆带(alpha=1):solid 判决与 a2c 阈值无关 → 两档像素完全一致。
    const width = 192, height = 128;
    const msaa4 = renderAaComboMsaa4(width, height), a2c = renderAaComboMsaa4A2c(width, height);
    const railPixelsDiffer = (() => {
      for (let y = Math.floor(0.04 * height); y < Math.floor(0.32 * height); y++) {
        for (let x = 0; x < width; x++) {
          const pixel = (y * width + x) * 4;
          if (msaa4[pixel] !== a2c[pixel]) return true;
        }
      }
      return false;
    })();
    expect(railPixelsDiffer).toBe(false);
    // 植被带(alpha 渐变):阶梯量化相对 0.5 硬切改变部分像素的覆盖采样数。
    const foliagePixelsDiffer = (() => {
      for (let y = Math.floor(0.66 * height); y < Math.floor(0.96 * height); y++) {
        for (let x = 0; x < width; x++) {
          const pixel = (y * width + x) * 4;
          if (msaa4[pixel] !== a2c[pixel]) return true;
        }
      }
      return false;
    })();
    expect(foliagePixelsDiffer).toBe(true);
  });

  it("renders every tier over the shared geometry truth with bounded values", () => {
    const width = 96, height = 64, reference = aaComboReference(width, height);
    expect(reference.length).toBe(width * height * 4);
    for (const tier of [renderAaComboNoAA(width, height), renderAaComboMsaa4(width, height),
      renderAaComboMsaa4A2c(width, height), renderAaComboMsaa4Tsr(width, height)]) {
      expect(tier.length).toBe(reference.length);
      for (let index = 0; index < tier.length; index += 4) {
        expect(tier[index]!).toBeGreaterThanOrEqual(0.1 - 1e-9);
        expect(tier[index]!).toBeLessThanOrEqual(0.9 + 1e-9);
        expect(tier[index + 3]).toBe(1);
      }
    }
    // 场景真值采样合同:细杆带命中二值 solid;空带无覆盖。
    expect(aaComboSample({ px: 0.5, py: 0.18 * 128, width: 192, height: 128 }).solid).toBe(true);
    expect(aaComboSample({ px: 96.5, py: 0.02 * 128, width: 192, height: 128 })).toEqual({ solid: false, alpha: 0 });
  });

  it("rejects out-of-range TSR frame counts (fail-closed)", () => {
    expect(() => renderAaComboMsaa4Tsr(16, 16, 0)).toThrow("frame count");
    expect(() => renderAaComboMsaa4Tsr(16, 16, 65)).toThrow("frame count");
  });

  it("expresses the AA-M2 combo gate (≥80% edge-energy reduction) over the analytic tiers", () => {
    const table = aaComboEnergyTable(192, 128);
    console.log("[AA-M2 combo tiers @192x128]", table.rows.map(row =>
      `${row.tier}: edge=${row.energy.edgeEnergy.toFixed(4)} reduction=${(row.reduction * 100).toFixed(1)}%`).join(" | "));
    expect(table.sourceContrast).toBe(AA_COMBO_SOURCE_CONTRAST);
    expect(table.rows.map(row => row.tier)).toEqual(
      ["noAA", "msaa4", "noAA+a2cFallback", "msaa4+a2c", "msaa4+tsr", "msaa4+a2c+tsr"]);
    const [, msaa4, a2cFallback, msaa4A2c, tsr, combo] = table.rows;
    // alphaTest 组:MSAA4 的几何平滑显著降能;TSR 理想化(硬切)至少同量级。
    expect(msaa4!.reduction).toBeGreaterThan(0.3);
    expect(tsr!.reduction).toBeGreaterThan(0.3);
    // a2c 组:无 MSAA 时纯 a2c 材质退化为硬边全画(基线);MSAA4+阶梯覆盖相对它
    // 降幅显著(a2c 的真实贡献)。
    expect(a2cFallback!.reduction).toBe(0);
    expect(msaa4A2c!.reduction).toBeGreaterThan(0.3);
    // AA-M2 组合门:完整组合档(MSAA4+a2c+TSR 理想化)相对 a2c 材质基线 ↓≥80%。
    expect(combo!.reduction).toBeGreaterThanOrEqual(0.8);
    expect(table.comboGatePassed).toBe(true);
  });
});
