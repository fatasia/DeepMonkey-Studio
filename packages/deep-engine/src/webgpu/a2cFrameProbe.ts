//! A2C-P1 运行时 a2c 有效性探针(2026-10-05 降级三件套之一)。
//! 背景(A2C-P1-HANDOFF.md + 8-bit A/B 续篇):本机(Windows / D3D12 后端 Dawn)接受
//! `alphaToCoverageEnabled` 管线 descriptor 但不按片元 alpha 生成采样掩码 —— descriptor
//! 接受 ✓、WGSL coverage() 512 位 alpha 直通 ✓、float/8-bit UNORM target0 与 MRT/单目标
//! 均无掩码 ✗,纯 a2c 材质呈全画实心板。修复不在引擎控制面内;本模块在运行时做一次性
//! 有效性自检,判据复用取证脚本同款读数(opaque-hdr 读回,主 pass target0 resolve,
//! present 链之前)。
//!
//! 诚实边界(handoff 原文):edgePixels 阈值 8·W 是取证场景(带 2px 羽化的栅栏/斜条/
//! 圆弧 alpha 贴图)的校准值 —— 二值 alpha(无羽化)材质即使掩码生效也不会产生
//! 亚像素抖动,会被误判无效;alpha 全 opaque(材质未贡献可见 alpha)时不可判定。
//! 场景自适应判据属后续;本刀按 handoff 设计交付校准阈值 + 显式披露。

import { isPbrFrameReadbackSnapshot, PbrFrameReadbackPlan,
  type PbrFrameReadbackResult, type PbrFrameReadbackSnapshot } from "./pbrFrameCaptureReadback.js";

/** 判 a2c 生效所需的最小水平边缘像素密度(每像素宽):取证场景实测抖动图案 2 万+ 像素
 *  (512 宽 ≈ 40·W),实心板仅轮廓量级(636 ≈ 1.2·W);8·W 为 handoff 校准值。 */
export const A2C_PROBE_EDGE_DITHER_PIXELS_PER_WIDTH = 8;

export interface A2cProbeFrameStats {
  /** target0 alpha 非 opaque(<239/255)像素数:coverage() 512 位到达 WGSL 的证据。 */
  readonly alphaNonOpaquePixels: number;
  /** target0 RGB 水平相邻通道差 >12(显示域粗量化)的像素数:覆盖抖动图案密度。 */
  readonly edgePixels: number;
}

export type A2cProbeVerdict = "effective" | "ineffective" | "inconclusive";

export interface A2cProbeMetrics {
  /** 探针实际测量的帧号(读回异步结算,披露滞后 1 帧;非披露帧号)。 */
  readonly frame: number;
  readonly verdict: A2cProbeVerdict;
  readonly alphaNonOpaquePixels: number;
  readonly edgePixels: number;
  /** 显式披露的判据阈值(edgeDitherThreshold = 8·W,校准值非场景自适应)。 */
  readonly edgeDitherThreshold: number;
  /** inconclusive/ineffective 时的判读原因;effective 时缺省。 */
  readonly reason?: string;
}

export type A2cProbeAnalysis = A2cProbeFrameStats | { readonly error: string };

/**
 * opaque-hdr 读回快照的 alpha/RGB 图案统计(与 lab/a2cParityProbe.ts 取证读数同构):
 * - alpha 桶:半精度(float16)或字节(rgba8unorm)解码后按 255 尺度分桶,
 *   <16 transparent / >239 opaque / 其余 partial;此处只计非 opaque 总数。
 * - RGB 边缘:逐行水平相邻像素显示域(0..255 粗量化)通道差 >12 计 1。
 * 格式白名单 fail-closed:rgba16float / rgba8unorm(PBR_HDR_FORMAT 的全部合法取值),
 * 其余格式返回显式 error 而不是猜编码。
 */
export function analyzeOpaqueHdrAlphaCoverage(snapshot: Pick<PbrFrameReadbackSnapshot,
  "width" | "height" | "format" | "bytesPerRow" | "bytes">): A2cProbeAnalysis {
  const { width, height, format, bytesPerRow, bytes } = snapshot;
  const float16 = format === "rgba16float";
  if (!float16 && format !== "rgba8unorm") {
    return { error: `unsupported opaque-hdr readback format ${format} (expected rgba16float or rgba8unorm)` };
  }
  const stride = float16 ? 8 : 4;
  let alphaNonOpaquePixels = 0, edgePixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    let previousR = NaN, previousG = NaN, previousB = NaN;
    for (let x = 0; x < width; x++) {
      const offset = row + x * stride;
      const alpha = float16 ? halfToFloat(bytes[offset + 6]! | (bytes[offset + 7]! << 8))
        : bytes[offset + 3]! / 255;
      if (alpha * 255 <= 239) alphaNonOpaquePixels++;
      // float16:半精度解码后显示域粗量化(0..1 截断到 32 阶);rgba8unorm:字节直读。
      // 目标是区分"平坦实心板"与"抖动图案",不是色彩度量(与取证脚本同判据)。
      const channel = (bits: number): number => {
        const value = float16 ? halfToFloat(bits) : bits / 255;
        return Math.min(255, Math.max(0, Math.round(value * 255)));
      };
      const r = float16 ? channel(bytes[offset]! | (bytes[offset + 1]! << 8)) : channel(bytes[offset]!);
      const g = float16 ? channel(bytes[offset + 2]! | (bytes[offset + 3]! << 8)) : channel(bytes[offset + 1]!);
      const b = float16 ? channel(bytes[offset + 4]! | (bytes[offset + 5]! << 8)) : channel(bytes[offset + 2]!);
      if (x > 0 && (Math.abs(r - previousR) > 12 || Math.abs(g - previousG) > 12 || Math.abs(b - previousB) > 12)) edgePixels++;
      previousR = r; previousG = g; previousB = b;
    }
  }
  return { alphaNonOpaquePixels, edgePixels };
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1, exponent = (bits & 0x7c00) >> 10, fraction = bits & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * handoff 判据:alpha 非 opaque 像素存在 且 edgePixels ≤ 8·W ⇒ 无效(掩码未生效);
 * alpha 非 opaque 像素存在 且 edgePixels > 8·W ⇒ 有效;alpha 全 opaque 或读回不可用
 * ⇒ 不可判定(fail-open:保持 a2c,原因显式披露,不误伤好机器上的合法场景)。
 */
export function judgeA2cProbeFrame(frame: number, width: number, analysis: A2cProbeAnalysis): A2cProbeMetrics {
  const threshold = width * A2C_PROBE_EDGE_DITHER_PIXELS_PER_WIDTH;
  if ("error" in analysis) {
    return Object.freeze({ frame, verdict: "inconclusive", alphaNonOpaquePixels: 0, edgePixels: 0,
      edgeDitherThreshold: threshold, reason: analysis.error });
  }
  if (analysis.alphaNonOpaquePixels === 0) {
    return Object.freeze({ frame, verdict: "inconclusive", alphaNonOpaquePixels: 0,
      edgePixels: analysis.edgePixels, edgeDitherThreshold: threshold,
      reason: "no non-opaque target alpha: the a2c material contributed no partial coverage to judge" });
  }
  if (analysis.edgePixels > threshold) {
    return Object.freeze({ frame, verdict: "effective", alphaNonOpaquePixels: analysis.alphaNonOpaquePixels,
      edgePixels: analysis.edgePixels, edgeDitherThreshold: threshold });
  }
  return Object.freeze({ frame, verdict: "ineffective", alphaNonOpaquePixels: analysis.alphaNonOpaquePixels,
    edgePixels: analysis.edgePixels, edgeDitherThreshold: threshold,
    reason: "alpha passthrough present but target0 RGB shows no coverage dither: the driver accepted "
      + "alphaToCoverageEnabled without generating sample masks (see test-output/A2C-P1-HANDOFF.md)" });
}

function probeVerdictFromResults(frame: number, width: number,
  results: readonly PbrFrameReadbackResult[]): A2cProbeMetrics {
  for (const result of results) {
    if (result.resourceId !== "opaque-hdr") continue;
    if (isPbrFrameReadbackSnapshot(result)) return judgeA2cProbeFrame(frame, width, analyzeOpaqueHdrAlphaCoverage(result));
    return judgeA2cProbeFrame(frame, width, { error: `opaque-hdr probe readback unavailable: ${result.reason}` });
  }
  return judgeA2cProbeFrame(frame, width,
    { error: `opaque-hdr probe readback missing (${results.length} unrelated result(s))` });
}

/**
 * 渲染器侧一次性探针控制器:空闲 → (首个含 a2c 批次的 MSAA 主 pass 帧)编码 opaque-hdr
 * 读回 → submit 后异步结算 → 终态冻结并经 metrics() 披露。一次性:终态(含
 * inconclusive/取消)后不再探测 —— 渲染器只披露不决策,降级由宿主(桥)消费披露触发。
 * 读回失败/帧取消 settles 为 inconclusive(fail-open 保持 a2c),绝不抛穿渲染循环。
 */
export class A2cFrameProbe {
  private plan: PbrFrameReadbackPlan | undefined;
  private spent = false;
  private measuringFrame = 0;
  private measuringWidth = 0;
  private settled: A2cProbeMetrics | undefined;

  /** 已冻结的判定;未探测/未结算时 undefined(披露滞后于测量帧,与 gpuPassTimings 同族)。 */
  metrics(): A2cProbeMetrics | undefined { return this.settled; }

  /** 空闲且本帧确实携带 a2c 批次时才进入测量。一次性以"已编码"为界(spent):
   * 编码后、读回结算前的间隙也不得二次编码 —— 结算是异步的,二次编码会与首测竞争。 */
  wantsProbe(hasAlphaToCoverageBatches: boolean): boolean {
    return !this.spent && this.settled === undefined && this.plan === undefined && hasAlphaToCoverageBatches;
  }

  /** 在帧 encoder 上编码读回;必须在 encoder.finish() 之前、queue.submit() 之后 collect。 */
  beginFrame(frame: number, device: GPUDevice, encoder: GPUCommandEncoder, opaqueHdr: GPUTexture): void {
    if (this.spent || this.plan !== undefined) return;
    this.spent = true;
    this.measuringFrame = frame;
    this.measuringWidth = opaqueHdr.width;
    this.plan = new PbrFrameReadbackPlan({
      requests: [{ resourceId: "opaque-hdr" }],
      // 一次性探针给足 8K rgba16float 全帧预算(默认 64MiB 会在 4K+ 截断成 unavailable)。
      maxBytesPerFrame: 512 * 1024 * 1024,
    });
    this.plan.beginFrame(`frame-${frame}`, device, encoder, { "opaque-hdr": opaqueHdr, "present-color": undefined, "linear-depth": undefined });
  }

  /** 必须在 queue.submit 之后调用;结算失败(读回不可用/异常)同样冻结为 inconclusive。 */
  collectAfterSubmit(): void {
    const plan = this.plan;
    if (plan === undefined) return;
    this.plan = undefined;
    const frame = this.measuringFrame, width = this.measuringWidth;
    void plan.collectAfterSubmit()
      .then(results => { this.settled ??= probeVerdictFromResults(frame, width, results); })
      .catch(error => { this.settled ??= judgeA2cProbeFrame(frame, width,
        { error: `probe readback failed: ${error instanceof Error ? error.message : String(error)}` }); });
  }

  /** 帧编码/提交失败路径:一次性语义 —— 冻结为 inconclusive,不在后续帧无限重试。 */
  cancelFrame(reason = "frame failed before submit; probe cancelled"): void {
    const plan = this.plan;
    if (plan === undefined) return;
    this.plan = undefined;
    plan.cancel();
    this.settled ??= judgeA2cProbeFrame(this.measuringFrame, this.measuringWidth, { error: reason });
  }
}
