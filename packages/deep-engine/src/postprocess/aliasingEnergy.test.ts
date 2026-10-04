import { describe, expect, it } from "vitest";
import { aliasingReduction, measureAliasingEnergy, syntheticStaircaseCase } from "./aliasingEnergy.js";

describe("staircase aliasing energy measurement (AA-M2 gate ruler)", () => {
  const { noAA, reference, sourceContrast } = syntheticStaircaseCase(96, 64);

  it("rejects invalid contrast and mismatched buffers (fail-closed)", () => {
    expect(() => measureAliasingEnergy({ output: noAA, reference, width: 96, height: 64, sourceContrast: 0 })).toThrow("contrast");
    expect(() => measureAliasingEnergy({ output: noAA, reference: new Float32Array(4), width: 96, height: 64,
      sourceContrast: 0.8 })).toThrow("differ in size");
  });

  it("reports zero energy for the exact reference and full energy for inverted input", () => {
    const identical = measureAliasingEnergy({ output: reference, reference, width: 96, height: 64, sourceContrast: 0.8 });
    expect(identical.edgeEnergy).toBe(0);
    expect(identical.totalEnergy).toBe(0);
    const inverted = new Float32Array(96 * 64 * 4);
    for (let offset = 0; offset < inverted.length; offset += 4) {
      inverted[offset] = 1 - reference[offset]!; inverted[offset + 1] = 1 - reference[offset + 1]!;
      inverted[offset + 2] = 1 - reference[offset + 2]!; inverted[offset + 3] = 1;
    }
    const flipped = measureAliasingEnergy({ output: inverted, reference, width: 96, height: 64, sourceContrast: 0.8 });
    // 全图反相:平坦区每像素 |ΔLuma|=contrast(归一化=1),coverage 过渡像素 |Δ|<1,
    // 高频图案下过渡占比可观 ⇒ 全图均值落在 (0.5,1) 区间(上界语义+过渡衰减可见)。
    expect(flipped.totalEnergy).toBeGreaterThan(0.5);
    expect(flipped.totalEnergy).toBeLessThanOrEqual(1);
    expect(flipped.edgeEnergy).toBeGreaterThan(0.4);
  });

  it("places the staircase energy in edge regions only (flat areas carry none)", () => {
    const baseline = measureAliasingEnergy({ output: noAA, reference, width: 96, height: 64, sourceContrast: sourceContrast });
    // no-AA 阶梯图案:边缘区必须检出能量;高频测试图(细栅栏+密集圆弧)的 Sobel
    // 边缘带本就偏宽,掩码有效性由下一条「边缘能量>2×全图均值」承载,不靠像素占比。
    expect(baseline.edgePixels).toBeGreaterThan(0);
    expect(baseline.edgePixels).toBeLessThan(96 * 64 * 0.65);
    expect(baseline.edgeEnergy).toBeGreaterThan(0.01);
    // 边缘区能量显著高于全图平均(能量集中在轮廓,不是噪声)。
    expect(baseline.edgeEnergy).toBeGreaterThan(baseline.totalEnergy * 2);
  });

  it("expresses the AA-M2 ≥80% reduction gate over the shared ruler", () => {
    const before = measureAliasingEnergy({ output: noAA, reference, width: 96, height: 64, sourceContrast });
    // 模拟一个"降噪 85% 的 AA 输出":残差按 0.15 缩放。
    const reduced = new Float32Array(96 * 64 * 4);
    for (let offset = 0; offset < reduced.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        reduced[offset + channel] = reference[offset + channel]! +
          (noAA[offset + channel]! - reference[offset + channel]!) * 0.15;
      }
      reduced[offset + 3] = 1;
    }
    const after = measureAliasingEnergy({ output: reduced, reference, width: 96, height: 64, sourceContrast });
    expect(aliasingReduction(before.edgeEnergy, after.edgeEnergy)).toBeGreaterThan(0.8);
    // 反向哨兵:无改善(残差放大)时降幅钳为 0,不产生负值误导。
    expect(aliasingReduction(before.edgeEnergy, before.edgeEnergy * 2)).toBe(0);
  });
});
