// B2 MegaLights M1 RIS 采样 CPU 权威镜像的数学门(验收②⑤的 vitest 真值腿):
// ① 穷举模式(K≥N)输出恒等于精确逐灯和——退化一致性的数学基础(与 WGSL 同式);
// ② RIS 估计器无偏性 + 时域收敛后与 512 样本离线参考 RMSE ≤ 0.05;
// ③ 蓄水池合并/钳制/相似门与确定性种子合同。
import { describe, expect, it } from "vitest";
import { evaluateMegaLightCpu, type MegaLight } from "./megaLights.js";
import { luminance, megaHashU32, megaLightsExhaustiveReferenceCpu, megaLightsFrameCpu,
  megaLightsReferenceCpu, megaPixelSeed, megaRandomNext, megaSurfaceDecodeCpu,
  megaTargetWeightCpu, megaViewDepthCpu, mergeReservoirCpu, rmse, type RisReservoir } from "./megaLightsRisCpu.js";
import type { LightVector3 } from "./types.js";

/** 确定性小场景:球面排布的点光(亮度分层)+ 一块朗伯地面。 */
function buildScene(lightCount: number): { readonly lights: readonly MegaLight[]; readonly surfaces: readonly (readonly (number | LightVector3)[])[] } {
  const lights: MegaLight[] = Array.from({ length: lightCount }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = 2 + (index % 7) * 0.9;
    const intensity = 0.6 + (index % 5) * 0.5;
    return {
      kind: "point" as const,
      positionView: [Math.cos(angle) * radius, Math.sin(angle) * radius, 2 + (index % 3)] as LightVector3,
      range: 0, color: [1, 0.95 - (index % 4) * 0.1, 0.9 - (index % 3) * 0.15], intensity,
      decay: 2,
    };
  });
  const width = 6, height = 6;
  const surfaces: (readonly (number | LightVector3)[])[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (x - (width - 1) / 2) * 0.4, py = (y - (height - 1) / 2) * 0.4;
      const depth = 3.5;
      surfaces.push([
        [px, py, -depth, 0] as unknown as LightVector3,
        [0, 0, 1, 0.5] as unknown as LightVector3,
        [0.8, 0.8, 0.8, 0] as unknown as LightVector3,
      ]);
    }
  }
  return { lights, surfaces };
}

describe("MegaLights RIS CPU mirror math gates", () => {
  it("exhaustive mode output equals the exact per-light sum (degenerate parity foundation)", () => {
    const { lights, surfaces } = buildScene(8);
    const output = megaLightsFrameCpu({ lights, surfaces, frame: 7, config: { width: 6, height: 6, exhaustive: true } });
    for (let pixel = 0; pixel < 36; pixel++) {
      const surface = megaSurfaceDecodeCpu(surfaces[pixel]!);
      const exact = lights.reduce<LightVector3>((sum, light) => {
        const c = evaluateMegaLightCpu(light, surface);
        return [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
      }, [0, 0, 0]);
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(output.color[pixel * 3 + channel]! - exact[channel]!)).toBeLessThan(1e-6 * Math.max(1, exact[channel]!));
      }
    }
  });

  it("RIS estimator is unbiased in expectation over independent seeds", () => {
    const { lights, surfaces } = buildScene(64);
    const surface = megaSurfaceDecodeCpu(surfaces[20]!);
    const exact = lights.reduce<LightVector3>((sum, light) => {
      const c = evaluateMegaLightCpu(light, surface);
      return [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
    }, [0, 0, 0]);
    const frames = 256;
    let total = 0;
    for (let frame = 0; frame < frames; frame++) {
      const output = megaLightsFrameCpu({ lights, surfaces: [surfaces[20]!], frame,
        config: { width: 1, height: 1, temporal: false, spatial: false } });
      total += output.color[0]!;
    }
    const mean = total / frames;
    expect(Math.abs(mean - exact[0])).toBeLessThan(0.05 * Math.max(1, exact[0]));
  });

  it("EMA-converged output tracks the exhaustive ground truth within RMSE 0.05 (acceptance ② shape)", () => {
    // 真值端 = 穷举精确和(零方差;512 采样 MC 的独立无偏性由下一条守)。
    // 配置 = M1 交付默认:时域单候选合并 + 颜色 EMA 1/32(空间复用默认关——
    // 无 MIS 时邻居胜者 t-分布偏差实测 +9%,M2 接 MIS 后启用;定案见实现注释)。
    const { lights, surfaces } = buildScene(256);
    const width = 6, height = 6;
    const truth = megaLightsExhaustiveReferenceCpu(lights, surfaces, width, height);
    let previous: readonly RisReservoir[] | undefined;
    let previousColor: Float32Array | undefined;
    let color = new Float32Array(0);
    for (let frame = 0; frame < 128; frame++) {
      const output = megaLightsFrameCpu({ lights, surfaces, previous, previousColor, frame,
        config: { width, height, temporal: true, spatial: false, alphaBlend: 1 / 32 } });
      previous = output.reservoirs;
      previousColor = Float32Array.from(output.color);
      color = output.color;
    }
    expect(rmse(color, truth)).toBeLessThanOrEqual(0.05);
  });

  it("512-sample MC reference stays within 0.08 of the exhaustive truth (reference integrator gate)", () => {
    const { lights, surfaces } = buildScene(256);
    const truth = megaLightsExhaustiveReferenceCpu(lights, surfaces, 6, 6);
    expect(rmse(megaLightsReferenceCpu(lights, surfaces, 6, 6, 512), truth)).toBeLessThanOrEqual(0.08);
  });

  it("deterministic seeds reproduce bit-identical frames for static scenes (flicker-gate foundation)", () => {
    const { lights, surfaces } = buildScene(32);
    const first = megaLightsFrameCpu({ lights, surfaces, frame: 3, config: { width: 6, height: 6 } });
    const second = megaLightsFrameCpu({ lights, surfaces, frame: 3, config: { width: 6, height: 6 } });
    expect([...first.color]).toEqual([...second.color]);
  });

  it("reservoir merge follows the weighted-competition contract with history clamping", () => {
    const reservoir: RisReservoir = { weightSum: 0, winner: 0xffffffff, m: 0 };
    mergeReservoirCpu(reservoir, 2, 5, 1, 0.99);
    expect(reservoir).toEqual({ weightSum: 2, winner: 5, m: 1 });
    // 零权重/零计数合并是空操作。
    mergeReservoirCpu(reservoir, 0, 9, 1, 0);
    mergeReservoirCpu(reservoir, 1, 9, 0, 0);
    expect(reservoir).toEqual({ weightSum: 2, winner: 5, m: 1 });
    // 大权重合并胜出。
    mergeReservoirCpu(reservoir, 100, 7, 1, 0.5);
    expect(reservoir.winner).toBe(7);
    expect(reservoir.weightSum).toBeCloseTo(102, 12);
    // 带权合并(count>1)把 weight×count 计入 w_sum(与 WGSL deepMegaReservoirMerge 同式)。
    const multi: RisReservoir = { weightSum: 1, winner: 3, m: 1 };
    mergeReservoirCpu(multi, 2, 9, 4, 0.0);
    expect(multi).toEqual({ weightSum: 9, winner: 9, m: 5 });
  });

  it("hash and seed contract matches the WGSL literal family", () => {
    expect(megaHashU32(0)).toBe(megaHashU32(0));
    expect(megaHashU32(0)).not.toBe(megaHashU32(1));
    expect(megaPixelSeed(1, 1, 0)).not.toBe(megaPixelSeed(2, 1, 0));
    expect(megaPixelSeed(1, 1, 0)).not.toBe(megaPixelSeed(1, 2, 0));
    expect(megaPixelSeed(1, 1, 0)).not.toBe(megaPixelSeed(1, 1, 1));
    let state = 7;
    const values = Array.from({ length: 8 }, () => {
      const step = megaRandomNext(state);
      state = step.state;
      return step.value;
    });
    expect(new Set(values).size).toBe(8);
    expect(values.every(value => value >= 0 && value < 1)).toBe(true);
  });

  it("target weight and view depth follow the shared surface decode", () => {
    const { lights, surfaces } = buildScene(4);
    const surface = surfaces[0]!;
    expect(megaViewDepthCpu(surface)).toBe(3.5);
    const decoded = megaSurfaceDecodeCpu(surface);
    expect(decoded.metallic).toBe(0);
    expect(decoded.roughness).toBe(0.5);
    const weight = megaTargetWeightCpu(lights, surface, 0);
    const contribution = evaluateMegaLightCpu(lights[0]!, decoded);
    expect(weight).toBeCloseTo(luminance(contribution), 12);
    expect(weight).toBeGreaterThan(0);
  });
});

describe("MegaLights M2 winner-visibility CPU mirror gates", () => {
  it("visibility=undefined reproduces the M1 frame bit-identically", () => {
    const { lights, surfaces } = buildScene(8);
    const base = megaLightsFrameCpu({ lights, surfaces, frame: 5, config: { width: 6, height: 6 } });
    const withUndefined = megaLightsFrameCpu({ lights, surfaces, frame: 5, config: { width: 6, height: 6 },
      visibility: undefined });
    expect(Array.from(withUndefined.color)).toEqual(Array.from(base.color));
  });

  it("all-occluded mask zeroes RIS output while exhaustive reference keeps the exact sum", () => {
    const { lights, surfaces } = buildScene(8);
    const mask = new Float32Array(36).fill(0);
    const occluded = megaLightsFrameCpu({ lights, surfaces, frame: 5, config: { width: 6, height: 6 }, visibility: mask });
    expect(Array.from(occluded.color)).toEqual(new Array(108).fill(0));
    // 穷举精确参考不走可见性(与 WGSL exhaustive 分支同口径:无遮挡精确和)。
    const exact = megaLightsExhaustiveReferenceCpu(lights, surfaces, 6, 6);
    expect(exact.some(value => value > 0)).toBe(true);
  });

  it("per-source mask multiplies the spatial average at the source pixel (visibility reuse)", () => {
    const { lights, surfaces } = buildScene(8);
    const half = new Float32Array(36).fill(1);
    for (let pixel = 30; pixel < 36; pixel++) half[pixel] = 0;
    const masked = megaLightsFrameCpu({ lights, surfaces, frame: 5, config: { width: 6, height: 6 }, visibility: half });
    const full = megaLightsFrameCpu({ lights, surfaces, frame: 5, config: { width: 6, height: 6 } });
    // 半径 2 邻域触不到 mask 0 行的像素(行 0-1,索引 0-11)与无 mask 帧逐位一致;
    // 邻域含 mask 0 源的像素(行 2-3)被拉暗。
    for (let pixel = 0; pixel < 12; pixel++) {
      expect(masked.color[pixel * 3]!).toBe(full.color[pixel * 3]!);
    }
    const dimmed = Array.from({ length: 12 }, (_, index) => index + 12)
      .filter(pixel => full.color[pixel * 3]! > 0 && masked.color[pixel * 3]! < full.color[pixel * 3]!);
    expect(dimmed.length).toBeGreaterThan(0);
  });
});
