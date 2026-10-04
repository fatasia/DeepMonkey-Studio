import { describe, expect, it } from "vitest";
import { aliasingReduction, measureAliasingEnergy, resolvableStaircaseCase, syntheticStaircaseCase } from "./aliasingEnergy.js";

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

describe("resolvable staircase case (AA-M2 gate-① resolvable-caliber scene)", () => {
  const width = 96, height = 64;
  const scene = resolvableStaircaseCase(width, height);

  it("keeps the same four self-consistency semantics as the legacy scene (shared ruler)", () => {
    // 同尺四条:fail-closed / 零残差与反相上界 / 边缘集中 / ≥80% 门语义。
    expect(() => measureAliasingEnergy({ output: scene.noAA, reference: scene.reference, width, height,
      sourceContrast: -1 })).toThrow("contrast");
    const identical = measureAliasingEnergy({ output: scene.reference, reference: scene.reference, width, height,
      sourceContrast: 0.8 });
    expect(identical.edgeEnergy).toBe(0);
    const inverted = new Float32Array(width * height * 4);
    for (let offset = 0; offset < inverted.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        inverted[offset + channel] = 1 - scene.reference[offset + channel]!;
      }
      inverted[offset + 3] = 1;
    }
    const flipped = measureAliasingEnergy({ output: inverted, reference: scene.reference, width, height, sourceContrast: 0.8 });
    expect(flipped.totalEnergy).toBeGreaterThan(0.5);
    expect(flipped.totalEnergy).toBeLessThanOrEqual(1);
    const baseline = measureAliasingEnergy({ output: scene.noAA, reference: scene.reference, width, height,
      sourceContrast: scene.sourceContrast });
    expect(baseline.edgePixels).toBeGreaterThan(0);
    expect(baseline.edgePixels).toBeLessThan(width * height * 0.65);
    expect(baseline.edgeEnergy).toBeGreaterThan(0.01);
    expect(baseline.edgeEnergy).toBeGreaterThan(baseline.totalEnergy * 2);
  });

  it("derives noAA and the 4×SSAA reference from the single geometry truth (coverAt)", () => {
    // 几何真值单一来源:no-AA 像素 == coverAt 历史口径中心判决 (x+0.375,y+0.375);
    // 参考 == 16 子采样覆盖率。
    const bright = 0.9, dark = 0.1;
    let checked = 0;
    for (let y = 0; y < height; y += 7) for (let x = 0; x < width; x += 5) {
      const pixel = (y * width + x) * 4;
      const center = scene.coverAt(x + 0.375, y + 0.375) ? bright : dark;
      expect(scene.noAA[pixel]).toBeCloseTo(center, 5);
      let sum = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        sum += scene.coverAt(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) ? 1 : 0;
      }
      expect(scene.reference[pixel]).toBeCloseTo(dark + (bright - dark) * (sum / 16), 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    // 覆盖判定器对两场景分别可调用(欠采样场景同接口)。
    expect(typeof syntheticStaircaseCase(32, 32).coverAt).toBe("function");
  });

  it("contains only resolvable features (no ≤2px periods, wide rails, thick arcs)", () => {
    // 可采样性结构哨兵:栅栏杆宽 3px(连续覆盖扫描中每根杆至少命中 2 个整数像素中心),
    // 且底部带内存在杆与空隙(周期 8px 结构真实存在)。
    let railHits = 0, gapHits = 0;
    for (let x = 0; x < width; x++) {
      const py = 0.85 * height;
      if (scene.coverAt(x + 0.5, py)) railHits++; else gapHits++;
    }
    expect(railHits).toBeGreaterThan(0);
    expect(gapHits).toBeGreaterThan(0);
    // 杆宽:连续采样相位扫描(取右部 x∈[64,96],斜边在 x≥56 后已离开底部带),
    // 单周期 8px 内覆盖行程应为 3px(±0.05 采样粒度)。
    const widths: number[] = [];
    let run = 0;
    for (let step = 1280; step <= 1920; step++) {
      const px = step * 0.05;
      const inside = scene.coverAt(px, 0.85 * height);
      if (inside) run++;
      else if (run > 0) { widths.push(run * 0.05); run = 0; }
    }
    // 栅栏杆投影宽度 ∈ (2, 4)px(标称 3px,扫描粒度 0.05px)。
    for (const measured of widths) expect(measured).toBeGreaterThan(2);
    expect(widths.some(measured => measured < 4)).toBe(true);
    // 圆弧最小半径 ≥12px ≥4px:圆心附近(半径<12)无圆弧覆盖(除非被斜边命中)。
    const cx = width * 0.7, cy = height * 0.35;
    let arcNearCenter = 0;
    for (let angle = 0; angle < 64; angle++) {
      const px = cx + Math.cos(angle / 64 * 2 * Math.PI) * 6;
      const py = cy + Math.sin(angle / 64 * 2 * Math.PI) * 6;
      // 只统计圆弧贡献:斜边在该区域的覆盖单独扣除。
      if (scene.coverAt(px, py) && !(py > 0.42 * height + px - 0.3 * width)) arcNearCenter++;
    }
    expect(arcNearCenter).toBe(0);
  });

  it("carries positive no-AA energy the AA tiers can actually remove (gate-① has headroom)", () => {
    const baseline = measureAliasingEnergy({ output: scene.noAA, reference: scene.reference, width, height,
      sourceContrast: scene.sourceContrast });
    // 可恢复走样:no-AA 基线能量为正且与旧口径同量级(场景仍有足够边缘密度),
    // 门①(↓≥80%)在此基线上有可判定的下降空间。
    expect(baseline.edgeEnergy).toBeGreaterThan(0.05);
    expect(baseline.edgePixels).toBeGreaterThan(width * height * 0.02);
  });
});
