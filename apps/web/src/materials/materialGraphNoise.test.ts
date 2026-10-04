import { describe, expect, it } from "vitest";
import type { MaterialGraphMask } from "./materialGraphModel";
import { defaultMask } from "./materialGraphModel";
import { angleSteps, hashLattice, maskGrid, sampleMaskAlpha, valueNoise2 } from "./materialGraphNoise";

const SIZE = 64;

function proceduralMask(kind: Exclude<MaterialGraphMask["kind"], "texture">, patch: Partial<MaterialGraphMask> = {}): MaterialGraphMask {
  return { ...defaultMask(kind), ...patch } as MaterialGraphMask;
}

/** 确定性硬约束:同参数网格逐字节相等;不同种子不同字节。 */
describe("materialGraphNoise", () => {
  it("hashLattice 同入参恒同出参,输出在 [0,1)", () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      for (let ix = -3; ix <= 3; ix += 1) {
        const a = hashLattice(ix, seed * 7, seed);
        const b = hashLattice(ix, seed * 7, seed);
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }
    }
  });

  it("valueNoise2 周期无缝:u=0 与 u=1-ε 一致(整周期回绕)", () => {
    for (const periodU of [1, 3, 6] as const) {
      const left = valueNoise2(0, 0.37, periodU, 4, 42);
      const right = valueNoise2(1 - 1e-6, 0.37, periodU, 4, 42);
      expect(Math.abs(left - right)).toBeLessThan(0.02);
      const bottom = valueNoise2(0.73, 0, 4, periodU, 42);
      const top = valueNoise2(0.73, 1 - 1e-6, 4, periodU, 42);
      expect(Math.abs(bottom - top)).toBeLessThan(0.02);
    }
  });

  it.each(["wear", "dust", "stripes"] as const)("同定义两次采样逐字节相等(%s)", (kind) => {
    const mask = proceduralMask(kind, { seed: 77, scale: 3, coverage: 0.45, softness: 0.3, angle: 30 });
    const a = maskGrid(mask, SIZE);
    const b = maskGrid(mask, SIZE);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("不同种子产生不同字节(遮罩可变体,不退化为常量)", () => {
    const a = maskGrid(proceduralMask("dust", { seed: 7 }), SIZE);
    const b = maskGrid(proceduralMask("dust", { seed: 8 }), SIZE);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("输出域 [0,255] 且非全 0/全 255(有图案)", () => {
    const grid = maskGrid(proceduralMask("wear", { seed: 12, coverage: 0.5 }), SIZE);
    let min = 255;
    let max = 0;
    for (const byte of grid) { min = Math.min(min, byte); max = Math.max(max, byte); }
    expect(min).toBe(0);
    expect(max).toBeGreaterThanOrEqual(128);
  });

  it("覆盖率单调:coverage 越大,遮罩面积不减小", () => {
    const area = (coverage: number) => {
      const grid = maskGrid(proceduralMask("dust", { seed: 5, coverage, softness: 0.05 }), SIZE);
      let sum = 0;
      for (const byte of grid) sum += byte;
      return sum;
    };
    expect(area(0.3)).toBeLessThan(area(0.5));
    expect(area(0.5)).toBeLessThan(area(0.8));
  });

  it("stripes:0° 水平周期带(coverage=占空比);90° 转垂直", () => {
    const horizontal = maskGrid(proceduralMask("stripes", { seed: 1, scale: 1, coverage: 0.5, softness: 0, angle: 0 }), 32);
    // angle 0 → 沿 V 的 1 条带:v<0.5 全亮、v≥0.5 全暗;行内恒定
    const row = (y: number) => Array.from(horizontal.slice(y * 32, y * 32 + 32));
    expect(JSON.stringify(row(3))).toBe(JSON.stringify(row(4)));
    expect(row(8).every(byte => byte === 255)).toBe(true);
    expect(row(24).every(byte => byte === 0)).toBe(true);
    const vertical = maskGrid(proceduralMask("stripes", { seed: 1, scale: 1, coverage: 0.5, softness: 0, angle: 90 }), 32);
    const col = (x: number) => Array.from({ length: 32 }, (_, y) => vertical[y * 32 + x]);
    expect(JSON.stringify(col(5))).toBe(JSON.stringify(col(6)));
    expect(col(8).every(byte => byte === 255)).toBe(true);
    expect(col(24).every(byte => byte === 0)).toBe(true);
  });

  it("angleSteps:0°→计数在 V,90°→计数在 U,永不全零(无缝前提)", () => {
    expect(angleSteps(0, 4)).toEqual({ nU: 0, nV: 4 });
    expect(angleSteps(90, 4)).toEqual({ nU: 4, nV: 0 });
    for (let angle = 0; angle <= 90; angle += 15) {
      const { nU, nV } = angleSteps(angle, 4);
      expect(nU + nV).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(nU)).toBe(true);
      expect(Number.isInteger(nV)).toBe(true);
    }
  });

  it("texture 类型无采样回调时网格全 0(编译器注入上传图采样)", () => {
    const grid = maskGrid({ ...defaultMask("texture"), kind: "texture", seed: 1 }, 8);
    expect(grid.every(byte => byte === 0)).toBe(true);
    const injected = maskGrid({ ...defaultMask("texture"), kind: "texture", seed: 1 }, 4, (u, v) => (u < 0.5 && v < 0.5 ? 1 : 0));
    expect(injected[0]).toBe(255);
    expect(injected[4 * 4 - 1]).toBe(0);
  });

  it("sampleMaskAlpha 对程序化类型返回 [0,1];texture 返回 -1 哨兵", () => {
    expect(sampleMaskAlpha(proceduralMask("dust"), 0.3, 0.6)).toBeGreaterThanOrEqual(0);
    expect(sampleMaskAlpha(proceduralMask("dust"), 0.3, 0.6)).toBeLessThanOrEqual(1);
    expect(sampleMaskAlpha({ ...defaultMask("texture"), kind: "texture", seed: 1 }, 0.3, 0.6)).toBe(-1);
  });
});
