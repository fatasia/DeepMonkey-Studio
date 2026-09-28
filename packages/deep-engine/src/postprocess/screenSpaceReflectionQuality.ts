/**
 * T03 序列质量评估（纯逻辑，真机采集脚本与单测共用）：
 * - SSIM（标准 8×8 窗口，C1/C2 常数，亮度图参考区间逐窗计算）；
 * - NaN/Inf/黑洞/负值完整性扫描（trace 与 composite）；
 * - 误命中率：trace 判定 vs 独立参考步进（screenSpaceReflectionScenes.marchGroundTruthRef）
 *   的判定不一致率，含「假命中」「假 miss」「反射内容错误」三类；
 * - 回退分档聚合（消费 screenSpaceReflectionFallback 的决策表）。
 * 明确禁项：任何位置不做全屏模糊/平滑后再比较——SSIM 直接在原始亮度图上计算。
 */

import type { ScreenSpaceReflectionCpuOptions } from "./screenSpaceReflectionTypes.js";
import { reflectViewRay, screenSpaceReflectionEdgeFade,
} from "./screenSpaceReflectionCpu.js";
import { decideSsrFallback, aggregateSsrTiers, type SsrFallbackDecision, type SsrTierStats,
} from "./screenSpaceReflectionFallback.js";
import { marchGroundTruthRef, type SsrSceneFrame } from "./screenSpaceReflectionScenes.js";

export interface SsrRegion { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export interface SsrSsimResult {
  readonly mean: number;
  readonly windows: number;
  /** 参考区间峰值亮度，作为 SSIM 动态范围 L（HDR 无固定满量程的透明处理）。 */
  readonly dynamicRange: number;
}

/** 亮度图（Rec.709 系数）。 */
export function ssrLuminance(rgb: Float32Array, pixelCount: number): Float32Array {
  const luma = new Float32Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    luma[pixel] = 0.2126 * (rgb[pixel * 3] ?? 0) + 0.7152 * (rgb[pixel * 3 + 1] ?? 0)
      + 0.0722 * (rgb[pixel * 3 + 2] ?? 0);
  }
  return luma;
}

/** 逐窗 SSIM（窗口内样本统计，不做任何预平滑）。 */
export function ssrSsimRegion(referenceLuma: Float32Array, testLuma: Float32Array,
  width: number, region: SsrRegion, windowSize = 8): SsrSsimResult {
  let peak = 0;
  for (let y = region.y0; y < region.y1; y++) for (let x = region.x0; x < region.x1; x++) {
    peak = Math.max(peak, referenceLuma[y * width + x] ?? 0);
  }
  const dynamicRange = Math.max(peak, 1e-4);
  const c1 = (0.01 * dynamicRange) ** 2, c2 = (0.03 * dynamicRange) ** 2;
  let total = 0, windows = 0;
  for (let y = region.y0; y + windowSize <= region.y1; y += windowSize) {
    for (let x = region.x0; x + windowSize <= region.x1; x += windowSize) {
      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0, count = 0;
      for (let wy = y; wy < y + windowSize; wy++) {
        for (let wx = x; wx < x + windowSize; wx++) {
          const a = referenceLuma[wy * width + wx] ?? 0, b = testLuma[wy * width + wx] ?? 0;
          sumA += a; sumB += b; sumAA += a * a; sumBB += b * b; sumAB += a * b; count++;
        }
      }
      const meanA = sumA / count, meanB = sumB / count;
      const varianceA = sumAA / count - meanA * meanA, varianceB = sumBB / count - meanB * meanB;
      const covariance = sumAB / count - meanA * meanB;
      const ssim = ((2 * meanA * meanB + c1) * (2 * covariance + c2))
        / ((meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2));
      total += ssim; windows += 1;
    }
  }
  return { mean: windows > 0 ? total / windows : 0, windows, dynamicRange };
}

export interface SsrIntegrityReport {
  readonly sampledPixels: number;
  readonly nanCount: number;
  readonly infCount: number;
  readonly negativeCount: number;
  /** mask > 0.25 且 rgb 亮度 < 0.004 的像素数：声称反射但能量近零（黑洞族）。 */
  readonly blackHoleCount: number;
}

/** trace 缓冲完整性扫描（rgba：rgb=rad×mask，a=mask）。 */
export function scanSsrTraceIntegrity(trace: Float32Array): SsrIntegrityReport {
  let nanCount = 0, infCount = 0, negativeCount = 0, blackHoleCount = 0;
  const pixels = Math.floor(trace.length / 4);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const r = trace[pixel * 4]!, g = trace[pixel * 4 + 1]!, b = trace[pixel * 4 + 2]!, a = trace[pixel * 4 + 3]!;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) { nanCount++; continue; }
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) infCount++;
    if (r < 0 || g < 0 || b < 0 || a < 0) negativeCount++;
    if (a > 0.25 && 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.004) blackHoleCount++;
  }
  return { sampledPixels: pixels, nanCount, infCount, negativeCount, blackHoleCount };
}

/**
 * composite 完整性扫描（rgb）。黑洞判据：源色含能量而输出近零——合法的暗反射
 * （把亮墙替换成暗反射）不算黑洞，能量凭空消失才算。
 */
export function scanSsrCompositeIntegrity(composite: Float32Array, source: Float32Array): SsrIntegrityReport {
  let nanCount = 0, infCount = 0, negativeCount = 0, blackHoleCount = 0;
  const pixels = Math.floor(composite.length / 3);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const r = composite[pixel * 3]!, g = composite[pixel * 3 + 1]!, b = composite[pixel * 3 + 2]!;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) { nanCount++; continue; }
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) infCount++;
    if (r < 0 || g < 0 || b < 0) negativeCount++;
    const sourceLuma = 0.2126 * (source[pixel * 3] ?? 0) + 0.7152 * (source[pixel * 3 + 1] ?? 0)
      + 0.0722 * (source[pixel * 3 + 2] ?? 0);
    const outputLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (sourceLuma > 0.02 && outputLuma < 0.004) blackHoleCount++;
  }
  return { sampledPixels: pixels, nanCount, infCount, negativeCount, blackHoleCount };
}

export interface SsrSequenceEvaluation {
  readonly evaluatedPixels: number;
  /** 判定不一致像素 / 可判定像素（假命中 + 假 miss + 反射内容错误）。 */
  readonly misHitRate: number;
  readonly falseHitCount: number;
  readonly falseMissCount: number;
  readonly contentMismatchCount: number;
  readonly fallbackRate: number;
  readonly tiers: SsrTierStats;
  readonly decisions: readonly SsrFallbackDecision[];
}

/**
 * 逐半分辨率像素评估：GT 步进 + 期望能量（生产 CPU 锥采样器在 GT uv 取值）+ 决策分档。
 * roughnessExceedsThreshold 控制粗糙度回退阈分档（默认 1 = 关闭，与决策表默认一致）。
 * historyValid=false 模拟相机切换/动态遮挡后第一帧的分档（所有 miss 记 history-invalid）。
 */
export function evaluateSsrSequenceAgainstGroundTruth(frame: SsrSceneFrame,
  options: ScreenSpaceReflectionCpuOptions, trace: Float32Array,
  roughnessFallbackThreshold?: number, historyValid = true): SsrSequenceEvaluation {
  const traceWidth = Math.ceil(frame.width / 2), traceHeight = Math.ceil(frame.height / 2);
  const maxLod = Math.min((options.coneMipLevels ?? 6) - 1, Math.floor(Math.log2(Math.max(frame.width, frame.height))));
  const pyramid = buildSsrBoxMipPyramid(Float32Array.from(frame.color), frame.width, frame.height, maxLod + 1);
  let evaluated = 0, falseHits = 0, falseMiss = 0, contentMismatch = 0, fallbacks = 0;
  const decisions: SsrFallbackDecision[] = [];
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = frame.width / frame.height;
  for (let halfY = 0; halfY < traceHeight; halfY++) {
    for (let halfX = 0; halfX < traceWidth; halfX++) {
      const x = Math.min(halfX * 2 + 1, frame.width - 1), y = Math.min(halfY * 2 + 1, frame.height - 1);
      const truth = marchGroundTruthRef(frame, options, x, y);
      const mask = trace[(halfY * traceWidth + halfX) * 4 + 3] ?? 0;
      if (truth.reason === "no-origin") {
        decisions.push(decideSsrFallback({ ssrMask: 0, originDepth: 0, roughness: frame.roughness,
          historyValid }));
        fallbacks++; continue;
      }
      if (truth.reason === "reflected-behind") {
        evaluated++;
        if (mask > 0.02) falseHits++;
        decisions.push(decideSsrFallback({ ssrMask: 0, originDepth: frame.depth[y * frame.width + x] ?? 0,
          reflectedZ: 1, roughness: frame.roughness, historyValid }));
        fallbacks++; continue;
      }
      evaluated++;
      const originDepth = frame.depth[y * frame.width + x] ?? 0;
      const expectedMask = expectedHitMask(frame, options, x, y, tanHalfFov, aspect);
      if (truth.hit) {
        const expectedRadiance = trilinearConeRadiance(pyramid, frame.width, frame.height,
          truth.uvX, truth.uvY, frame.roughness * frame.roughness * maxLod);
        const expectedLuma = 0.2126 * expectedRadiance[0] + 0.7152 * expectedRadiance[1]
          + 0.0722 * expectedRadiance[2];
        const actualLuma = 0.2126 * (trace[(halfY * traceWidth + halfX) * 4] ?? 0)
          + 0.7152 * (trace[(halfY * traceWidth + halfX) * 4 + 1] ?? 0)
          + 0.0722 * (trace[(halfY * traceWidth + halfX) * 4 + 2] ?? 0);
        if (mask > 0.02 && expectedLuma > 1e-4
          && Math.abs(actualLuma / mask - expectedLuma) / expectedLuma > 0.1) contentMismatch++;
        else if (mask <= 0.02 && expectedMask > 0.02) falseMiss++;
      } else if (mask > 0.02) falseHits++;
      const decision = decideSsrFallback({ ssrMask: mask, originDepth,
        reflectedZ: truth.hit ? -1 : 0, roughness: frame.roughness, historyValid,
        ...(roughnessFallbackThreshold === undefined ? {} : { roughnessFallbackThreshold }),
        ...(truth.hit ? {} : { missReason: truth.reason }) });
      decisions.push(decision);
      if (decision.weight <= 0) fallbacks++;
    }
  }
  return { evaluatedPixels: evaluated, misHitRate: evaluated > 0 ? (falseHits + falseMiss + contentMismatch) / evaluated : 0,
    falseHitCount: falseHits, falseMissCount: falseMiss, contentMismatchCount: contentMismatch,
    fallbackRate: decisions.length > 0 ? fallbacks / decisions.length : 0,
    tiers: aggregateSsrTiers(decisions), decisions };
}

function expectedHitMask(frame: SsrSceneFrame, options: ScreenSpaceReflectionCpuOptions,
  x: number, y: number, tanHalfFov: number, aspect: number): number {
  const depth = frame.depth[y * frame.width + x] ?? 0;
  if (!(depth > 0)) return 0;
  const uvX0 = (x + 0.5) / frame.width, uvY0 = (y + 0.5) / frame.height;
  const px = (uvX0 * 2 - 1) * depth * tanHalfFov * aspect, py = (1 - uvY0 * 2) * depth * tanHalfFov;
  const base = (y * frame.width + x) * 4;
  const nx = ((frame.normalEncoded[base] ?? 0) / 255) * 2 - 1;
  const ny = ((frame.normalEncoded[base + 1] ?? 0) / 255) * 2 - 1;
  const nz = ((frame.normalEncoded[base + 2] ?? 0) / 255) * 2 - 1;
  const [, , , , , , dotProduct] = reflectViewRay([px, py, -depth], depth, nx, ny, nz);
  const cosTheta = Math.min(1, Math.max(-dotProduct, 0));
  const fresnel = options.fresnelF0 + (1 - options.fresnelF0) * Math.pow(1 - cosTheta, 5);
  return fresnel; // 调用方再乘 hit uv 的 edgeFade；此处仅作 miss 判定的下界。
}

/** 参考区间（默认下半屏地板反射区）的 SSIM：reference=CPU 可执行规范帧，test=GPU 实测帧。 */
export function ssrRegionSsim(referenceRgb: Float32Array, testRgb: Float32Array, width: number,
  height: number, region?: SsrRegion): SsrSsimResult {
  const referenceLuma = ssrLuminance(referenceRgb, width * height);
  const testLuma = ssrLuminance(testRgb, width * height);
  return ssrSsimRegion(referenceLuma, testLuma, width, region ?? { x0: 0, y0: Math.floor(height / 2), x1: width, y1: height });
}

/**
 * 箱式 mip 金字塔 + 三线性锥采样：与 GPU 语义忠实（2×2 盒式下采样内容 + 层内双线性 +
 * lod 小数部分跨层混合）。CPU 镜像（screenSpaceReflectionCpu）的锥采样是块均值近似，
 * 不含层内双线性；lod≥1 且反射内容跨条带时两者出现可见差，质量评估一律用本参照。
 */
export function buildSsrBoxMipPyramid(rgb: Float32Array, width: number, height: number,
  levels: number): readonly Float32Array[] {
  const pyramid: Float32Array[] = [rgb];
  for (let level = 1; level < levels; level++) {
    const previous = pyramid[level - 1]!;
    const previousWidth = Math.max(1, width >> (level - 1)), previousHeight = Math.max(1, height >> (level - 1));
    const currentWidth = Math.max(1, width >> level), currentHeight = Math.max(1, height >> level);
    const current = new Float32Array(currentWidth * currentHeight * 3);
    for (let y = 0; y < currentHeight; y++) {
      for (let x = 0; x < currentWidth; x++) {
        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const sx = Math.min(x * 2 + dx, previousWidth - 1), sy = Math.min(y * 2 + dy, previousHeight - 1);
          const base = (sy * previousWidth + sx) * 3;
          sumR += previous[base] ?? 0; sumG += previous[base + 1] ?? 0; sumB += previous[base + 2] ?? 0;
          count += 1;
        }
        current.set([sumR / count, sumG / count, sumB / count], (y * currentWidth + x) * 3);
      }
    }
    pyramid.push(current);
  }
  return pyramid;
}

function bilinearMipSample(level: Float32Array, levelWidth: number, levelHeight: number,
  uvX: number, uvY: number): readonly [number, number, number] {
  const x = uvX * levelWidth - 0.5, y = uvY * levelHeight - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const at = (px: number, py: number, channel: number): number => {
    const cx = Math.min(Math.max(px, 0), levelWidth - 1), cy = Math.min(Math.max(py, 0), levelHeight - 1);
    return level[(cy * levelWidth + cx) * 3 + channel] ?? 0;
  };
  const top = [0, at(x0, y0, 0) * (1 - tx) + at(x0 + 1, y0, 0) * tx,
    at(x0, y0, 1) * (1 - tx) + at(x0 + 1, y0, 1) * tx, at(x0, y0, 2) * (1 - tx) + at(x0 + 1, y0, 2) * tx];
  const bottom = [0, at(x0, y0 + 1, 0) * (1 - tx) + at(x0 + 1, y0 + 1, 0) * tx,
    at(x0, y0 + 1, 1) * (1 - tx) + at(x0 + 1, y0 + 1, 1) * tx,
    at(x0, y0 + 1, 2) * (1 - tx) + at(x0 + 1, y0 + 1, 2) * tx];
  return [(top[1]! * (1 - ty) + bottom[1]! * ty), (top[2]! * (1 - ty) + bottom[2]! * ty),
    (top[3]! * (1 - ty) + bottom[3]! * ty)];
}

/** lod = roughness² × (activeMipLevels−1) 的三线性采样（GPU textureSampleLevel 同语义）。 */
export function trilinearConeRadiance(pyramid: readonly Float32Array[], width: number, height: number,
  uvX: number, uvY: number, lod: number): readonly [number, number, number] {
  const maxLevel = pyramid.length - 1;
  const lowLevel = Math.min(Math.max(Math.floor(lod), 0), maxLevel);
  const highLevel = Math.min(lowLevel + 1, maxLevel);
  const blend = Math.min(1, Math.max(0, lod - lowLevel));
  const low = bilinearMipSample(pyramid[lowLevel]!, Math.max(1, width >> lowLevel),
    Math.max(1, height >> lowLevel), uvX, uvY);
  const high = bilinearMipSample(pyramid[highLevel]!, Math.max(1, width >> highLevel),
    Math.max(1, height >> highLevel), uvX, uvY);
  return [low[0] * (1 - blend) + high[0] * blend, low[1] * (1 - blend) + high[1] * blend,
    low[2] * (1 - blend) + high[2] * blend];
}
