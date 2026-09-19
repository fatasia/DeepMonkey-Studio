import { describe, expect, it } from "vitest";
import { intensityFactor, iesMaxCandela, prepareIesSampling, type IesSamplingTable } from "./iesSampling";
import type { RuntimeLightProfile } from "../runtimePackage/environmentTypes.js";

/** 表直构助手：candela[行][列]，verticalAngles 升序 0.5° 网格。 */
function profile(overrides: Partial<RuntimeLightProfile> & { candela: readonly (readonly number[])[]; verticalAngles: readonly number[] }): RuntimeLightProfile {
  return {
    profileId: "test.profile", format: "LM-63-2002", horizontalSymmetry: 1, totalLumens: 0, ...overrides,
  };
}

describe("IES intensityFactor sampling contract", () => {
  it("integrates a uniform 1000cd hemisphere cone to the analytic flux within 1%", () => {
    // 解析解 Φ = I·2π·(1−cos90°) = 6283.185 lm；最近邻采样对常量分布是精确的。
    const angles = Array.from({ length: 37 }, (_, i) => i * 2.5);
    const table = prepareIesSampling(profile({ verticalAngles: angles, candela: [angles.map(() => 1000)] }));
    const steps = 720;
    let flux = 0;
    for (let i = 0; i < steps; i += 1) {
      const theta = ((i + 0.5) * 90) / steps;
      const factor = intensityFactor(table, theta, 0);
      flux += factor * table.maxCandela * Math.sin((theta * Math.PI) / 180) * ((90 / steps) * Math.PI) / 180 * 2 * Math.PI;
    }
    expect(flux / 6283.185307179587).toBeGreaterThan(0.99);
    expect(flux / 6283.185307179587).toBeLessThan(1.01);
  });

  it("integrates a cosine distribution within 1% of π·I and matches the zone-rule lumens", () => {
    // I(θ)=1000·cosθ（[0,90]）：Φ = π·1000 = 3141.59 lm。
    const angles = Array.from({ length: 37 }, (_, i) => i * 2.5);
    const candela = angles.map((angle) => Math.round(1000 * Math.cos((angle * Math.PI) / 180) * 1000) / 1000);
    const table = prepareIesSampling(profile({ verticalAngles: angles, candela: [candela] }));
    const steps = 1440;
    let flux = 0;
    for (let i = 0; i < steps; i += 1) {
      const theta = ((i + 0.5) * 90) / steps;
      const factor = intensityFactor(table, theta, 0);
      flux += factor * table.maxCandela * Math.sin((theta * Math.PI) / 180) * ((90 / steps) * Math.PI) / 180 * 2 * Math.PI;
    }
    const ratio = flux / (Math.PI * 1000);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });

  it("rotates the phi response by rotationDeg and keeps rotational symmetry unaffected", () => {
    // 对称 2，行角 0/90/180：旋转 45° 后 φ=45° 处读到原 90° 行的值（镜像语义 I(φ)=I(360−φ)）。
    const table = prepareIesSampling(profile({
      verticalAngles: [0, 45, 90], horizontalSymmetry: 2,
      candela: [[1000, 1000, 1000], [100, 100, 100], [25, 25, 25]],
    }));
    const at = (phi: number, rotation = 0): number => intensityFactor(table, 45, phi, rotation);
    expect(at(0)).toBe(1);
    expect(at(90)).toBe(0.1);
    expect(at(180)).toBe(0.025); // φ=180 必须保持末行，不得折回第 0 行。
    expect(at(270)).toBe(0.1); // 360−270=90 镜像。
    expect(at(45, 45)).toBe(1); // 45−45=0 → 第 0 行。
    expect(at(90, 45)).toBe(at(45)); // 旋转后读到旋转前的同一 g。
    expect(at(135, 45)).toBe(0.1); // 135−45=90 → 第 1 行。
    expect(at(0)).not.toBe(at(0, 45)); // 旋转确实改变了采样。
    // 旋转对称表对 rotationDeg 不敏感。
    const spin = prepareIesSampling(profile({ verticalAngles: [0, 90, 180], candela: [[1000, 500, 0]] }));
    expect(intensityFactor(spin, 90, 0)).toBe(intensityFactor(spin, 90, 123.5, 217));
  });

  it("scales intensity by scaleFactor within [0,10] and fails safe on non-finite input", () => {
    const table = prepareIesSampling(profile({ verticalAngles: [0, 180], candela: [[1000, 100]] }));
    expect(intensityFactor(table, 0, 0, 0, 0.5)).toBe(0.5);
    expect(intensityFactor(table, 0, 0, 0, 10)).toBe(10);
    expect(intensityFactor(table, 0, 0, 0, 0)).toBe(0);
    expect(intensityFactor(table, NaN, 0)).toBe(0);
    expect(intensityFactor(table, 0, Infinity)).toBe(0);
    expect(intensityFactor(table, 0, 0, NaN)).toBe(0);
  });

  it("treats asymmetric vertical profiles faithfully without mirroring", () => {
    // 对称 1：θ 剖面非对称（30° 亮、150° 暗）必须如实采样，不做任何 θ 镜像。
    const table = prepareIesSampling(profile({ verticalAngles: [0, 30, 60, 90, 120, 150, 180], candela: [[1000, 800, 600, 400, 200, 50, 0]] }));
    expect(intensityFactor(table, 30, 0)).toBe(0.8);
    expect(intensityFactor(table, 150, 0)).toBe(0.05);
    expect(intensityFactor(table, 30, 217)).toBe(0.8); // φ 任意，行恒 0。
    expect(intensityFactor(table, 31, 0)).toBe(0.8); // 0.5° 网格量化后 31.0 → 最近邻 30。
    expect(intensityFactor(table, 47, 0)).toBe(0.6); // 47 距 60 更近。
  });

  it("quantizes query angles onto the 0.5 degree grid and resolves ties to the lower index", () => {
    const table = prepareIesSampling(profile({ verticalAngles: [0, 10, 20], candela: [[1000, 400, 100]] }));
    expect(intensityFactor(table, 10.24, 0)).toBe(intensityFactor(table, 10, 0));
    expect(intensityFactor(table, 10.3, 0)).toBe(0.4); // 10.3 → 10.5 → 最近邻 10。
    expect(intensityFactor(table, 15, 0)).toBe(0.4); // 距 10/20 并列 → 取低索引 10。
    expect(intensityFactor(table, 20.75, 0)).toBe(0); // → 21.0 → 超出末角 20：不外推。
    expect(intensityFactor(table, 20.24, 0)).toBe(0.1); // → 20.0 → 末角列。
  });

  it("rejects out-of-domain theta honestly and handles dark single-cell tables", () => {
    // 半光度表只测到 90°：θ>90 合同性无光，不把 nadir 强度外推到天顶。
    const half = prepareIesSampling(profile({ verticalAngles: [0, 45, 90], candela: [[1000, 500, 100]] }));
    expect(intensityFactor(half, 90, 0)).toBe(0.1);
    expect(intensityFactor(half, 90.5, 0)).toBe(0);
    expect(intensityFactor(half, 120, 0)).toBe(0);
    expect(intensityFactor(half, -0.4, 0)).toBe(1); // clamp 到 0 → 第 0 列。
    const dark = prepareIesSampling(profile({ verticalAngles: [0], candela: [[0]] }));
    expect(dark.maxCandela).toBe(0);
    expect(intensityFactor(dark, 0, 0)).toBe(0);
    expect(intensityFactor(prepareIesSampling(profile({ verticalAngles: [10], candela: [[1000]] })), 0, 0)).toBe(0);
  });
});
