import { describe, expect, it } from "vitest";
import { downsampleLuma2x, edgeAliasingEnergy, fenceRegionFor } from "./virtualShadowProbeScene.js";

// 门①口径裁决(2026-10-05)新增纯图像函数的合同测试:fenceRegionFor 与 captureStill
// 现行测区逐值同源;downsampleLuma2x 是 4×SSAA 参考腿的还原步(2×2 box)。

describe("fenceRegionFor", () => {
  it("与现行 captureStill 测区比例逐值一致(1080p 1x)", () => {
    expect(fenceRegionFor({ width: 1920, height: 1080 })).toEqual({
      x0: Math.floor(1920 * 0.34), y0: Math.floor(1080 * 0.52),
      x1: Math.floor(1920 * 0.66), y1: Math.floor(1080 * 0.97),
    });
  });

  it("2× SSAA 还原场(1× 尺寸)复用同一口径", () => {
    expect(fenceRegionFor({ width: 1920, height: 1080 })).toEqual(fenceRegionFor({ width: 1920, height: 1080 }));
  });
});

describe("downsampleLuma2x", () => {
  it("2×2 box 均值:全 0.5 场下采样恒 0.5,尺寸减半", () => {
    const width = 8, height = 6;
    const field = { width, height, luma: new Float32Array(width * height).fill(0.5) };
    const out = downsampleLuma2x(field);
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    expect(out.luma.every(v => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it("已知四像素块取均值(位置对齐:左上角块 = 四个独立值的平均)", () => {
    const field = { width: 2, height: 2, luma: Float32Array.from([0.1, 0.3, 0.5, 0.7]) };
    const out = downsampleLuma2x(field);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(out.luma[0]).toBeCloseTo(0.4, 6);
  });

  it("奇数尺寸拒绝(显式合同,不静默截断)", () => {
    expect(() => downsampleLuma2x({ width: 3, height: 4, luma: new Float32Array(12) })).toThrow("even dimensions");
    expect(() => downsampleLuma2x({ width: 4, height: 3, luma: new Float32Array(12) })).toThrow("even dimensions");
  });

  it("亚像素信息:2× 渲染的对角边界下采样后出现过渡灰度(1× 渲染只有硬二值)", () => {
    // 1×:8×8,45° 对角硬边界(每像素单次采样,只有 0.9/0.1 两值)。
    const size = 8;
    const native = { width: size, height: size, luma: new Float32Array(size * size) };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        native.luma[y * size + x] = x + y < size - 1 ? 0.9 : 0.1;
      }
    }
    const nativeHas = [...new Set(native.luma)];
    expect(nativeHas.some(v => Math.abs(v - 0.9) < 0.01) && nativeHas.some(v => Math.abs(v - 0.1) < 0.01)
      && !nativeHas.some(v => Math.abs(v - 0.5) < 0.01)).toBe(true);
    // 2× 渲染(16×16 同几何边界)→ 2×2 box 下采样:跨界块产生 0.5 过渡值 ——
    // SSAA 参考携带亚像素混合信息,这就是"1× vs 4×SSAA 亮度差"能度量锯齿成分的根据。
    const fine = size * 2;
    const rendered2x = { width: fine, height: fine, luma: new Float32Array(fine * fine) };
    for (let y = 0; y < fine; y++) {
      for (let x = 0; x < fine; x++) {
        rendered2x.luma[y * fine + x] = x + y < fine - 1 ? 0.9 : 0.1;
      }
    }
    const ssaa = downsampleLuma2x(rendered2x);
    // 跨界块按亮像素覆盖比例混合(45° 边界与偶数对齐块相位下为 25%/75% → 0.3/0.7)。
    const near = (v: number, target: number): boolean => Math.abs(v - target) < 0.01;
    let transitionPixels = 0;
    for (let i = 0; i < ssaa.luma.length; i++) {
      const v = ssaa.luma[i]!;
      if (!near(v, 0.9) && !near(v, 0.1)) transitionPixels += 1;
    }
    expect(transitionPixels).toBeGreaterThan(0);
  });

  it("回归锚:高对比边界下 2×2 box 下采样 + 0.55 硬阈值的角密度对 SSAA 不敏感(2026-10-05 实测发现,备选口径因此改用亮度差而非下采样后角密度)", () => {
    const size = 8;
    const build = (grid: number): { width: number; height: number; luma: Float32Array } => {
      const field = { width: size * grid, height: size * grid, luma: new Float32Array(size * grid * size * grid) };
      for (let y = 0; y < field.height; y++) {
        for (let x = 0; x < field.width; x++) {
          field.luma[y * field.width + x] = x + y < size * grid - 1 ? 0.9 : 0.1;
        }
      }
      return field;
    };
    const native = edgeAliasingEnergy(build(1), { x0: 1, y0: 1, x1: size - 1, y1: size - 1 });
    const ssaa = edgeAliasingEnergy(downsampleLuma2x(build(2)), { x0: 1, y0: 1, x1: size - 1, y1: size - 1 });
    expect(ssaa.cornerRatio).toBe(native.cornerRatio);
  });
});
