import { describe, expect, it } from "vitest";
import { createFbm2D, createMulberry32, createValueNoise2D, hashGrid2D, smoothstep01 } from "./terrainRandom.js";

describe("T13 确定性伪随机与噪声", () => {
  it("mulberry32 同 seed 两次实例序列逐位一致", () => {
    const a = createMulberry32(20260927);
    const b = createMulberry32(20260927);
    for (let i = 0; i < 4096; i += 1) {
      expect(a()).toBe(b());
    }
  });

  it("mulberry32 不同 seed 序列不同且输出落在 [0,1)", () => {
    const a = createMulberry32(1);
    const b = createMulberry32(2);
    const sampleA: number[] = [];
    for (let i = 0; i < 256; i += 1) {
      const value = a();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(value).not.toBe(b());
      sampleA.push(value);
    }
    // 漂移检查:序列前段不应与后段完全重合(排除退化为常数的实现)。
    expect(sampleA.slice(0, 8)).not.toEqual(sampleA.slice(8, 16));
  });

  it("hashGrid2D 对同输入逐位一致、不同输入散开", () => {
    expect(hashGrid2D(12, -7, 42)).toBe(hashGrid2D(12, -7, 42));
    const seen = new Set<number>();
    for (let x = 0; x < 64; x += 1) {
      seen.add(hashGrid2D(x, x * 3, 7));
    }
    // 64 个输入至少 60 个不同哈希,证明没有塌缩到少数桶。
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });

  it("值噪声为纯函数:同点两次采样一致,格点两侧极限一致", () => {
    const noise = createValueNoise2D(99);
    expect(noise(3.25, -1.5)).toBe(noise(3.25, -1.5));
    // 整数格点值恰为该格点哈希映射,从两侧趋近应逐位落在同一格点值上。
    const atGrid = createValueNoise2D(5);
    const left = atGrid(4 - 1e-9, 6);
    const right = atGrid(4 + 1e-9, 6);
    // C2 插值在格点连续:两侧值与格点值之差在 float64 舍入内为 0。
    const grid = atGrid(4, 6);
    expect(Math.abs(left - grid)).toBeLessThan(1e-8);
    expect(Math.abs(right - grid)).toBeLessThan(1e-8);
  });

  it("fBm 同参数逐位一致且输出在 [0,1]", () => {
    const a = createFbm2D(1234, 4);
    const b = createFbm2D(1234, 4);
    for (let i = 0; i < 512; i += 1) {
      const x = i * 0.37 - 80;
      const z = i * -0.11 + 42;
      const va = a(x, z);
      expect(va).toBe(b(x, z));
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThanOrEqual(1);
    }
  });

  it("fBm 不同 seed 输出不同,层数参数受校验", () => {
    const a = createFbm2D(1, 4);
    const b = createFbm2D(2, 4);
    let differing = 0;
    for (let i = 1; i <= 64; i += 1) {
      if (a(i * 0.7, i * 0.3) !== b(i * 0.7, i * 0.3)) differing += 1;
    }
    expect(differing).toBeGreaterThan(60);
    expect(() => createFbm2D(1, 0)).toThrow();
    expect(() => createFbm2D(1, 1.5)).toThrow();
  });

  it("smoothstep01 端点与单调性", () => {
    expect(smoothstep01(0, 1, -1)).toBe(0);
    expect(smoothstep01(0, 1, 0)).toBe(0);
    expect(smoothstep01(0, 1, 1)).toBe(1);
    expect(smoothstep01(0, 1, 2)).toBe(1);
    expect(smoothstep01(2, 3, 2.5)).toBeGreaterThan(0.4);
    expect(smoothstep01(2, 3, 2.5)).toBeLessThan(0.6);
  });
});
