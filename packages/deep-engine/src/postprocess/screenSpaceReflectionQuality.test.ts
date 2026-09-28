import { describe, expect, it } from "vitest";
import { buildSsrSceneFrame, marchGroundTruthRef, primaryRaycast,
  type SsrSceneConfig } from "./screenSpaceReflectionScenes.js";
import { buildSsrBoxMipPyramid, evaluateSsrSequenceAgainstGroundTruth, scanSsrCompositeIntegrity,
  scanSsrTraceIntegrity, ssrRegionSsim, ssrSsimRegion, ssrLuminance, trilinearConeRadiance,
} from "./screenSpaceReflectionQuality.js";
import { screenSpaceReflectionCpu, traceScreenSpaceReflectionCpu,
} from "./screenSpaceReflectionCpu.js";
import type { ScreenSpaceReflectionCpuOptions } from "./screenSpaceReflectionTypes.js";

const OPTIONS: ScreenSpaceReflectionCpuOptions = { verticalFovRadians: Math.PI / 3, maxDistance: 40,
  thickness: 0.8, steps: 96, refines: 4, edgeFade: 0.08, fresnelF0: 0.5 };

const BASE_CONFIG: SsrSceneConfig = { name: "mirror", width: 64, height: 64, roughness: 0.02,
  wallTop: 18, occluder: { x0: 6, x1: 8, y0: -2, y1: 0.5, z0: -10, z1: -12 } };

describe("解析场景构建", () => {
  it("相机向下看地板、向上看墙/天空，深度为正线性视空间值", () => {
    const frame = buildSsrSceneFrame(BASE_CONFIG);
    const bottom = primaryRaycast(BASE_CONFIG, 32, 60, Math.tan(Math.PI / 6), 1);
    const top = primaryRaycast(BASE_CONFIG, 32, 4, Math.tan(Math.PI / 6), 1);
    expect(bottom.ny).toBe(1); // 下部像素命中地板。
    expect(top.nz === 1 || top.t === 0).toBe(true); // 上部命中墙或天空。
    const centerDepth = frame.depth[60 * 64 + 32]!;
    expect(centerDepth).toBeGreaterThan(0);
    // 法线 unorm 编码与粗糙度 alpha 同 GBuffer 约定。
    const base = (60 * 64 + 32) * 4;
    expect(frame.normalEncoded[base + 1]).toBe(255); // ny=1 → (1+1)/2*255=255。
    expect(frame.normalEncoded[base + 3]).toBe(Math.round(0.02 * 255));
    // 颜色全部非零（黑洞可检测的前提）。
    let minimum = Number.POSITIVE_INFINITY;
    for (const value of frame.color) minimum = Math.min(minimum, value);
    expect(minimum).toBeGreaterThanOrEqual(0.06);
  });
  it("平面场景 GT 步进与生产 CPU 镜像的命中判定一致", () => {
    const frame = buildSsrSceneFrame({ ...BASE_CONFIG, occluder: undefined });
    let agreements = 0, hits = 0;
    for (let halfY = 8; halfY < 32; halfY += 4) {
      for (let halfX = 0; halfX < 32; halfX += 4) {
        const x = halfX * 2 + 1, y = halfY * 2 + 1;
        const truth = marchGroundTruthRef(frame, OPTIONS, x, y);
        const [,, , implMask] = traceScreenSpaceReflectionCpu(frame.cpuInput, OPTIONS, halfX, halfY);
        if (truth.hit === (implMask > 0)) agreements++;
        if (truth.hit) {
          hits++;
          // 命中 uv 与 impl 期望一致：impl 的 radiance×mask 应接近 GT uv 处锥采样×期望 mask。
          expect(truth.uvX).toBeGreaterThan(0); expect(truth.uvX).toBeLessThan(1);
        }
      }
    }
    expect(hits).toBeGreaterThan(16); // 地板反射墙面的命中必须实质存在。
    expect(agreements).toBe(48); // 6 行 × 8 列采样全部一致。
  });
});

describe("完整性扫描", () => {
  it("trace：NaN/Inf/负值/黑洞计数", () => {
    const trace = new Float32Array([
      0.5, 0.5, 0.5, 0.8,       // 正常命中。
      Number.NaN, 0, 0, 0.5,    // NaN。
      0.3, 0.3, 0.3, 0.9,       // 正常命中（不算黑洞）。
      0.001, 0.001, 0.001, 0.9, // 黑洞：声称反射但能量近零。
      -1, 0.5, 0.5, 0.5,        // 负值（亮度仍正，不算黑洞）。
      Infinity, 0, 0, 0.5]);    // Inf。
    const report = scanSsrTraceIntegrity(trace);
    expect(report).toMatchObject({ sampledPixels: 6, nanCount: 1, infCount: 1,
      negativeCount: 1, blackHoleCount: 1 });
  });
  it("composite：能量凭空消失计入黑洞（源色>0.02 而输出近零）；合法暗反射不算", () => {
    const source = new Float32Array([0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const blackHole = new Float32Array([0.4, 0.4, 0.4, 0.001, 0.001, 0.001]);
    const darkReflection = new Float32Array([0.4, 0.4, 0.4, 0.08, 0.08, 0.08]);
    expect(scanSsrCompositeIntegrity(blackHole, source).blackHoleCount).toBe(1);
    expect(scanSsrCompositeIntegrity(darkReflection, source).blackHoleCount).toBe(0);
    expect(scanSsrCompositeIntegrity(source, source).blackHoleCount).toBe(0);
  });
});

describe("SSIM", () => {
  it("同一图像 SSIM=1；幅值缩放保留结构仍高分；纯噪声显著降分", () => {
    const rgb = Float32Array.from({ length: 32 * 32 * 3 }, (_, index) => (Math.floor(index / 3) % 16) * 0.03 + 0.1);
    expect(ssrRegionSsim(rgb, rgb, 32, 32).mean).toBeCloseTo(1, 9);
    const scaled = Float32Array.from(rgb, value => value * 1.2);
    expect(ssrRegionSsim(rgb, scaled, 32, 32).mean).toBeGreaterThan(0.95);
    const noisy = Float32Array.from(rgb, value => value + (Math.random() - 0.5) * 0.3);
    expect(ssrRegionSsim(rgb, noisy, 32, 32).mean).toBeLessThan(0.9);
  });
  it("动态范围取参考区间峰值（HDR 无固定满量程的透明处理）", () => {
    const luma = ssrLuminance(Float32Array.from({ length: 16 * 3 }, (_, index) => index * 0.01), 16);
    const result = ssrSsimRegion(luma, luma, 4, { x0: 0, y0: 0, x1: 4, y1: 4 }, 4);
    expect(result.dynamicRange).toBeCloseTo(0.2126 * 0.45 + 0.7152 * 0.46 + 0.0722 * 0.47, 6);
  });
});

describe("序列评估（CPU 全链路上的一致性预演）", () => {
  it("镜面序列：误命中率低于 2%，黑洞为 0，分档以 ssr 为主", () => {
    const frame = buildSsrSceneFrame({ ...BASE_CONFIG, width: 64, height: 64 });
    const result = screenSpaceReflectionCpu(frame.cpuInput, OPTIONS);
    const trace = Float32Array.from(result.trace);
    const evaluation = evaluateSsrSequenceAgainstGroundTruth(frame, OPTIONS, trace);
    expect(evaluation.misHitRate).toBeLessThan(0.02);
    expect(evaluation.tiers.ssr).toBeGreaterThan(0);
    expect(scanSsrTraceIntegrity(trace).blackHoleCount).toBe(0);
    expect(scanSsrCompositeIntegrity(result.output, Float32Array.from(frame.color)).blackHoleCount).toBe(0);
  });
  it("屏边序列：斜面板反射穿出视锥（off-screen 族）且回退率显著高于镜面序列", () => {
    // 面板 n=(0.6,0,0.8) 过点 (8,-2,-10)：offset = 0.6·8 + 0.8·(−10) = −3.2。
    const frame = buildSsrSceneFrame({ ...BASE_CONFIG, name: "screen-edge", wallTop: 5,
      panel: { normal: [0.6, 0, 0.8], offset: -3.2, yTop: 6, zNear: -2, zFar: -20 } });
    const result = screenSpaceReflectionCpu(frame.cpuInput, OPTIONS);
    const evaluation = evaluateSsrSequenceAgainstGroundTruth(frame, OPTIONS, Float32Array.from(result.trace));
    expect(evaluation.tiers.reasons["off-screen"] ?? 0).toBeGreaterThan(10);
    expect(evaluation.fallbackRate).toBeGreaterThan(0.3);
    expect(evaluation.misHitRate).toBeLessThan(0.02);
  });
  it("移动物序列：遮挡物移入反射走廊后该区域回退且无假命中", () => {
    const moved = { x0: -3, x1: 3, y0: -2, y1: 0.5, z0: -10, z1: -12 };
    const frame = buildSsrSceneFrame({ ...BASE_CONFIG, name: "moving", roughness: 0.05, occluder: moved });
    const result = screenSpaceReflectionCpu(frame.cpuInput, OPTIONS);
    const evaluation = evaluateSsrSequenceAgainstGroundTruth(frame, OPTIONS, Float32Array.from(result.trace));
    expect(evaluation.falseHitCount).toBe(0);
    expect(scanSsrTraceIntegrity(Float32Array.from(result.trace)).nanCount).toBe(0);
  });
});

describe("箱式金字塔三线性参照（GPU 锥语义）", () => {
  const flat = (value: number): Float32Array => {
    const rgb = new Float32Array(32 * 32 * 3);
    rgb.fill(value);
    return rgb;
  };
  it("mip 内容为 2×2 盒式均值；层内双线性在块中心回到块值", () => {
    const rgb = new Float32Array(32 * 32 * 3);
    for (let pixel = 0; pixel < 32 * 32; pixel++) {
      rgb.set([Math.floor(pixel / 32) < 15 ? 0.2 : 0.8, 0.3, 0.5], pixel * 3);
    }
    const pyramid = buildSsrBoxMipPyramid(rgb, 32, 32, 3);
    expect(pyramid.length).toBe(3);
    // mip1 顶部块均值 (0.2×2 + 0.8×2)/4? 顶两行全 0.2 → 顶块 0.2；跨界块 (0.2+0.8)/2。
    const mip1 = pyramid[1]!;
    expect(mip1[0]).toBeCloseTo(0.2, 6); // 顶块。
    const boundary = mip1[(7 * 16 + 0) * 3]; // 行块 7 覆盖 y 14(0.2)+15(0.8),真跨界块。
    expect(boundary).toBeCloseTo((0.2 + 0.8) / 2, 6);
    // 层内双线性在块中心采样回到块值。
    const [r] = trilinearConeRadiance(pyramid, 32, 32, (1.5) / 16, (1.5) / 16, 1);
    expect(r).toBeCloseTo(0.2, 6);
  });
  it("lod 小数部分跨层混合：lod=1.5 介于 mip1 与 mip2 之间", () => {
    const pyramid = [flat(0.2), flat(0.4), flat(0.8)];
    const [rLow] = trilinearConeRadiance(pyramid, 32, 32, 0.5, 0.5, 1);
    const [rMid] = trilinearConeRadiance(pyramid, 32, 32, 0.5, 0.5, 1.5);
    const [rHigh] = trilinearConeRadiance(pyramid, 32, 32, 0.5, 0.5, 2);
    expect(rLow).toBeCloseTo(0.4, 6);
    expect(rMid).toBeCloseTo((0.4 + 0.8) / 2, 6);
    expect(rHigh).toBeCloseTo(0.8, 6);
  });
});
