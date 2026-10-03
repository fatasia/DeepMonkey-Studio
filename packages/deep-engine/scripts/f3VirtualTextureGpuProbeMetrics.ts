// F3/T06 虚拟纹理 probe 度量职责(sourceSizeGate 拆分:自 f3VirtualTextureGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:SSIM(8×8 块标准口径)、差异/缺页哨兵统计、恒值图像哨兵、bridge 遥测尾读与预算判定。
import type { VirtualTextureFrameMetrics } from "../src/webgpu/virtualTextureFrameBridge.js";

export interface SsimStats {
  readonly mean: number; readonly min: number; readonly blocks: number;
  readonly blocksBelow: number; readonly worst: { readonly x: number; readonly y: number; readonly value: number };
}

/** 标准 SSIM(8×8 非重叠块, C1=(0.01·255)², C2=(0.03·255)², luma=Rec.601)。 */
export function computeSsim(a: Float32Array, b: Float32Array, width: number, height: number): SsimStats {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const luma = (buffer: Float32Array, index: number): number => {
    const offset = index * 4;
    return 0.299 * buffer[offset]! * 255 + 0.587 * buffer[offset + 1]! * 255 + 0.114 * buffer[offset + 2]! * 255;
  };
  const blocksX = Math.floor(width / 8), blocksY = Math.floor(height / 8);
  let sum = 0, min = Number.POSITIVE_INFINITY, blocksBelow = 0;
  let worst = { x: 0, y: 0, value: Number.POSITIVE_INFINITY };
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let meanA = 0, meanB = 0;
      const count = 64;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const index = (by * 8 + y) * width + bx * 8 + x;
        meanA += luma(a, index); meanB += luma(b, index);
      }
      meanA /= count; meanB /= count;
      let varianceA = 0, varianceB = 0, covariance = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const index = (by * 8 + y) * width + bx * 8 + x;
        const differenceA = luma(a, index) - meanA, differenceB = luma(b, index) - meanB;
        varianceA += differenceA * differenceA; varianceB += differenceB * differenceB;
        covariance += differenceA * differenceB;
      }
      varianceA /= count - 1; varianceB /= count - 1; covariance /= count - 1;
      const value = ((2 * meanA * meanB + C1) * (2 * covariance + C2))
        / ((meanA * meanA + meanB * meanB + C1) * (varianceA + varianceB + C2));
      sum += value;
      if (value < min) { min = value; worst = { x: bx * 8, y: by * 8, value }; }
      if (value < 0.99) blocksBelow += 1;
    }
  }
  const blocks = blocksX * blocksY;
  return { mean: sum / blocks, min, blocks, blocksBelow, worst };
}

export function diffStats(a: Float32Array, b: Float32Array, width: number): { maxAbsDiff: number; magentaCount: number;
  magentaSamples: readonly { x: number; y: number; vt: number[]; reference: number[] }[] } {
  let maxAbsDiff = 0, magentaCount = 0;
  const magentaSamples: { x: number; y: number; vt: number[]; reference: number[] }[] = [];
  for (let index = 0; index < a.length / 4; index++) {
    const offset = index * 4;
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(a[offset + channel]! - b[offset + channel]!);
      if (difference > maxAbsDiff) maxAbsDiff = difference;
    }
    // 缺页哨兵 = 精确 vec4f(1,0,1)(零过滤直写,rgba8unorm 量化后仍精确 1.0/0.0)。
    // 注意:合成纹理生成器 96+(y*255/h|0) 在 y≥637 溢出 Uint8 回绕,G 合法出现 0,
    // 宽阈/单通道判据都会误报(2026-10-02 实测),必须三元精确相等。
    if (a[offset]! === 1 && a[offset + 1]! === 0 && a[offset + 2]! === 1) {
      magentaCount += 1;
      if (magentaSamples.length < 16) magentaSamples.push({
        x: index % width, y: Math.floor(index / width),
        vt: [a[offset]!, a[offset + 1]!, a[offset + 2]!],
        reference: [b[offset]!, b[offset + 1]!, b[offset + 2]!] });
    }
  }
  return { maxAbsDiff, magentaCount, magentaSamples };
}

/** 恒值图像哨兵:两图全等且恒值(如读回链断裂后的全零)时 SSIM 恒 1,属无效证据。 */
export function imageRange(image: Float32Array): { min: number; max: number; constant: boolean } {
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < image.length; index++) {
    const value = image[index]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max, constant: !(max > min) };
}

export function metricsTail(frames: readonly VirtualTextureFrameMetrics[]): Record<string, unknown> {
  const last = frames[frames.length - 1]!;
  return { framesObserved: frames.length, last: { frame: last.frame, residentPages: last.residentPages,
    residentBytes: last.residentBytes, uploadsQueued: last.uploadsQueued, uploadsCommitted: last.uploadsCommitted,
    uploadsRolledBack: last.uploadsRolledBack, uploadBacklog: last.uploadBacklog, evictions: last.evictions,
    atlasLayers: last.atlasLayers, atlasBytes: last.atlasBytes, fallbackActive: last.fallbackActive },
    // 遥测 evictions 是累计计数器:阶段口径取阶段末值,跨阶段差分才是本阶段驱逐数。
    evictionsAtPhaseEnd: last.evictions };
}

/** 阶段驱逐差分:阶段末累计 − 前阶段末累计(计数器跨帧求和会重复计数,禁用)。 */
export function evictionsDuring(frames: readonly VirtualTextureFrameMetrics[], before: number): number {
  return frames[frames.length - 1]!.evictions - before;
}

export function residentBytesWithinBudget(frames: readonly VirtualTextureFrameMetrics[],
  budgetBytes: number): boolean {
  return frames.every(frame => frame.residentBytes <= budgetBytes);
}
