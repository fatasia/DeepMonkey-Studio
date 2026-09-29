import type { SurfaceSize } from "../webgpu/surfaceSize.js";
import type { TemporalUpscaleCpuInput, TemporalUpscaleOptions } from "./temporalUpscaleTypes.js";

/**
 * F4 时域上采样 CPU 参考:与 temporalUpscaleWgsl/temporalUpscale 逐公式同构。
 * 空间核 = Catmull-Rom 16-tap(每轴 4 权重);时域项 = UV 运动重投影 + 深度感知
 * 双线性历史 + YCoCg AABB 邻域钳制(与 temporalAaCpu 同式)。历史失效帧退化
 * 为纯 Catmull-Rom(fail-closed,无 ghosting 累积)。reactiveAlpha 缺省视为全零,
 * 供给时透明/粒子区域历史混合权重按 (1-reactive) 降权(与 WGSL flags.y 同式)。
 */

/** Catmull-Rom(B=0, C=0.5)核:单点距 t 的权重。分段三次,支撑 [-2, 2]。 */
function catmullRomKernel(t: number): number {
  const a = Math.abs(t);
  if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
  if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
  return 0;
}

/**
 * Catmull-Rom 每轴 4 权重:fraction ∈ [0,1) 是输出采样点相对内部 texel 网格的
 * 小数位置;权重对应 texel x0-1, x0, x0+1, x0+2。和恒为 1(测试断言)。
 */
export function catmullRomWeights(fraction: number): readonly [number, number, number, number] {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new Error("Catmull-Rom fraction must be finite inside [0, 1).");
  }
  return Object.freeze([
    catmullRomKernel(1 + fraction), catmullRomKernel(fraction),
    catmullRomKernel(1 - fraction), catmullRomKernel(2 - fraction),
  ]) as readonly [number, number, number, number];
}

/**
 * 联动判定纯函数:仅当超分特性开启且动态分辨率实际降档(<1)时上采样链路激活。
 * scale ≥ 1(或未配 policy)时零介入 —— 渲染分辨率就是显示分辨率,保持逐字节直通。
 */
export function temporalUpscaleActive(enabled: boolean, scale: number): boolean {
  if (typeof enabled !== "boolean") throw new TypeError("Temporal upscale flag must be boolean.");
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error("Resolution scale must be finite inside (0, 1].");
  }
  return enabled && scale < 1;
}

/** 渲染内部尺寸决策:floor 量化 + 1 下限(与 surfaceSize 的下限语义一致)。 */
export function internalRenderSize(surface: SurfaceSize, scale: number): SurfaceSize {
  if (!surface || !Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height)
    || surface.width < 1 || surface.height < 1) throw new Error("Surface size is invalid.");
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error("Resolution scale must be finite inside (0, 1].");
  if (scale === 1) return surface;
  return Object.freeze({
    width: Math.max(1, Math.floor(surface.width * scale)),
    height: Math.max(1, Math.floor(surface.height * scale)),
  });
}

const rgbToYCoCg = (r: number, g: number, b: number): [number, number, number] =>
  [r * .25 + g * .5 + b * .25, r * .5 - b * .5, -r * .25 + g * .5 - b * .25];
const yCoCgToRgb = (y: number, co: number, cg: number): [number, number, number] =>
  [y + co - cg, y + cg, y - co - cg];
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

function assertFinite(values: readonly number[], label: string): void {
  if (!values.every(Number.isFinite)) throw new Error(`${label} must be finite.`);
}

/** 参考实现校验:尺寸/比例/缓冲长度/值域。 */
export function validateTemporalUpscaleCpuInput(input: TemporalUpscaleCpuInput): void {
  const { displayWidth, displayHeight, scale } = input;
  if (!Number.isSafeInteger(displayWidth) || !Number.isSafeInteger(displayHeight)
    || displayWidth < 1 || displayHeight < 1) throw new Error("Display size must be positive safe integers.");
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error("Scale must be finite inside (0, 1].");
  const internalWidth = Math.max(1, Math.floor(displayWidth * scale));
  const internalHeight = Math.max(1, Math.floor(displayHeight * scale));
  if (input.color.length !== internalWidth * internalHeight * 4 || input.depth.length !== internalWidth * internalHeight
    || input.motion.length !== internalWidth * internalHeight * 2) {
    throw new Error("Temporal upscale CPU buffers must match the internal render size.");
  }
  for (const [values, label] of [[input.color, "color"], [input.depth, "depth"], [input.motion, "motion"]] as const) {
    assertFinite(values, label);
  }
  if (input.depth.some(value => value < 0)) throw new Error("Depth must be nonnegative linear view depth.");
  for (const jitter of [input.currentJitter, input.previousJitter]) {
    if (jitter.length !== 2 || !jitter.every(Number.isFinite) || Math.abs(jitter[0]) > 0.5 || Math.abs(jitter[1]) > 0.5) {
      throw new Error("Jitter must contain two finite internal-pixel offsets inside [-0.5, 0.5].");
    }
  }
  if (input.historyValid && (!input.previousColor || !input.previousDepth
    || input.previousColor.length !== displayWidth * displayHeight * 4
    || input.previousDepth.length !== displayWidth * displayHeight
    || !input.previousColor.every(Number.isFinite) || !input.previousDepth.every(Number.isFinite))) {
    throw new Error("Valid history requires display-sized previous color and depth.");
  }
  if (input.reactiveAlpha !== undefined
    && (input.reactiveAlpha.length !== internalWidth * internalHeight
      || !input.reactiveAlpha.every(value => Number.isFinite(value) && value >= 0 && value <= 1))) {
    throw new Error("Reactive alpha requires internal-sized finite values inside [0, 1].");
  }
}

/**
 * 逐显示像素参考:Catmull-Rom 空间基线 + (历史有效时的)时域重投影合成。
 * 输出按显示分辨率 RGBA 排布;深度通道复制合成深度(与 GPU 输出语义一致,便于对拍)。
 */
export function resolveTemporalUpscaleCpu(input: TemporalUpscaleCpuInput, options: TemporalUpscaleOptions): Float32Array {
  validateTemporalUpscaleCpuInput(input);
  if (!Number.isFinite(options.feedback) || options.feedback < 0 || options.feedback > 0.99) {
    throw new Error("Feedback must be inside [0, 0.99].");
  }
  if (!Number.isFinite(options.depthThreshold) || options.depthThreshold < 0
    || !Number.isFinite(options.relativeDepthThreshold) || options.relativeDepthThreshold < 0) {
    throw new Error("Depth thresholds must be nonnegative finite.");
  }
  const internalWidth = Math.max(1, Math.floor(input.displayWidth * input.scale));
  const internalHeight = Math.max(1, Math.floor(input.displayHeight * input.scale));
  const output = new Float32Array(input.displayWidth * input.displayHeight * 4);
  // 内部 texel 中心的连续坐标 = displayUV * internalSize - 0.5。
  for (let y = 0; y < input.displayHeight; y++) {
    const posY = (y + 0.5) / input.displayHeight * internalHeight - 0.5;
    const y0 = Math.floor(posY), fy = posY - y0;
    const wy = catmullRomWeights(fy);
    for (let x = 0; x < input.displayWidth; x++) {
      const posX = (x + 0.5) / input.displayWidth * internalWidth - 0.5;
      const x0 = Math.floor(posX), fx = posX - x0;
      const wx = catmullRomWeights(fx);
      // 空间核:16-tap Catmull-Rom(load 语义,边界 clamp)。
      // 深度独立走显式 4-tap 双线性(中心 2×2,权重和恒 1):Catmull-Rom 外圈
      // 权重可为负,对视深无意义,不与颜色共享权重。
      let r = 0, g = 0, b = 0, a = 0;
      const dx = [1 - fx, fx] as const, dy = [1 - fy, fy] as const;
      let depthSum = 0;
      for (let ty = 0; ty < 4; ty++) {
        const sampleY = clamp(y0 - 1 + ty, 0, internalHeight - 1);
        for (let tx = 0; tx < 4; tx++) {
          const sampleX = clamp(x0 - 1 + tx, 0, internalWidth - 1);
          const weight = wy[ty]! * wx[tx]!;
          const texel = sampleY * internalWidth + sampleX;
          const offset = texel * 4;
          r += input.color[offset]! * weight;
          g += input.color[offset + 1]! * weight;
          b += input.color[offset + 2]! * weight;
          a += input.color[offset + 3]! * weight;
        }
      }
      for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
        const sampleX = clamp(x0 + tx, 0, internalWidth - 1);
        const sampleY = clamp(y0 + ty, 0, internalHeight - 1);
        depthSum += input.depth[sampleY * internalWidth + sampleX]! * dy[ty]! * dx[tx]!;
      }
      const depth = depthSum;
      let resolvedR = r, resolvedG = g, resolvedB = b;
      if (input.historyValid && input.previousColor && input.previousDepth && depth > 0) {
        // 时域重投影:UV 运动与分辨率无关 → 显示像素 delta = motion × displaySize;
        // 内部像素抖动差按 scale 等比映射为显示像素差(与 WGSL 同式)。
        // motion 取当前像素中心最近的内部 texel(与 WGSL textureLoad 最近邻一致)。
        const motionX0 = clamp(Math.round(posX), 0, internalWidth - 1);
        const motionY0 = clamp(Math.round(posY), 0, internalHeight - 1);
        const texel = motionY0 * internalWidth + motionX0;
        const motionX = input.motion[texel * 2]!, motionY = input.motion[texel * 2 + 1]!;
        const prevX = x + 0.5 + motionX * input.displayWidth
          + (input.previousJitter[0] - input.currentJitter[0]) * input.scale;
        const prevY = y + 0.5 + motionY * input.displayHeight
          + (input.previousJitter[1] - input.currentJitter[1]) * input.scale;
        if (prevX >= 0 && prevY >= 0 && prevX < input.displayWidth && prevY < input.displayHeight) {
          const historical = sampleHistory(input, prevX, prevY, depth,
            Math.max(options.depthThreshold, depth * options.relativeDepthThreshold));
          if (historical) {
            // YCoCg AABB 邻域钳制:3×3 内部 texel 窗,中心 = 当前像素中心所在内部 texel
            // (与 TAA 同式;窗口随内部网格而非显示网格,避免钳制窗被放大稀释)。
            const cx = motionX0, cy = motionY0;
            const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
              const nx = clamp(cx + ox, 0, internalWidth - 1), ny = clamp(cy + oy, 0, internalHeight - 1);
              const no = (ny * internalWidth + nx) * 4;
              const value = rgbToYCoCg(input.color[no]!, input.color[no + 1]!, input.color[no + 2]!);
              for (let channel = 0; channel < 3; channel++) {
                minimum[channel] = Math.min(minimum[channel]!, value[channel]!);
                maximum[channel] = Math.max(maximum[channel]!, value[channel]!);
              }
            }
            const history = rgbToYCoCg(historical[0], historical[1], historical[2]);
            const clamped = yCoCgToRgb(
              clamp(history[0]!, minimum[0]!, maximum[0]!),
              clamp(history[1]!, minimum[1]!, maximum[1]!),
              clamp(history[2]!, minimum[2]!, maximum[2]!));
            // reactive 覆盖(center 内部 texel 最近邻,与 WGSL textureLoad(center) 同点):
            // 透明/粒子区域历史按 (1-reactive) 降权;缺省视为全零,混合权重不变。
            const reactive = input.reactiveAlpha?.[motionY0 * internalWidth + motionX0] ?? 0;
            const blend = options.feedback * (1 - clamp(reactive, 0, 1));
            resolvedR = r * (1 - blend) + clamped[0] * blend;
            resolvedG = g * (1 - blend) + clamped[1] * blend;
            resolvedB = b * (1 - blend) + clamped[2] * blend;
          }
        }
      }
      const out = (y * input.displayWidth + x) * 4;
      output[out] = Math.max(0, resolvedR);
      output[out + 1] = Math.max(0, resolvedG);
      output[out + 2] = Math.max(0, resolvedB);
      output[out + 3] = Math.max(0, a);
    }
  }
  return output;
}

/** 深度感知双线性历史采样:被拒 tap 不贡献(与 temporalAaCpu.sampleHistory 同式)。 */
function sampleHistory(input: TemporalUpscaleCpuInput, px: number, py: number, depth: number,
  threshold: number): [number, number, number] | undefined {
  const sx = px - 0.5, sy = py - 0.5;
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  let r = 0, g = 0, b = 0, accepted = 0;
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
    const weight = (tx === 0 ? 1 - fx : fx) * (ty === 0 ? 1 - fy : fy);
    const hx = clamp(x0 + tx, 0, input.displayWidth - 1);
    const hy = clamp(y0 + ty, 0, input.displayHeight - 1);
    const texel = hy * input.displayWidth + hx;
    const historicalDepth = input.previousDepth![texel]!;
    if (weight <= 0 || historicalDepth <= 0 || Math.abs(historicalDepth - depth) > threshold) continue;
    r += input.previousColor![texel * 4]! * weight;
    g += input.previousColor![texel * 4 + 1]! * weight;
    b += input.previousColor![texel * 4 + 2]! * weight;
    accepted += weight;
  }
  return accepted > 0 ? [r / accepted, g / accepted, b / accepted] : undefined;
}
