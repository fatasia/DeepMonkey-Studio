import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import type { RuntimePrefilteredIbl } from "../runtimePackage/environmentTypes.js";
import { visitIblBytes } from "../runtimePackage/environmentBytes.js";
import { decodeHalfFloat } from "../rayTracing/probeGridBakeMath.js";
import type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";

/**
 * F8 自动曝光(Z1 默认画质审计提案 P2):环境 mip 亮度静态代理 → ±EV 包络 →
 * 时域平滑。零 GPU readback:亮度全部来自 CPU 侧已有数据(RuntimePrefilteredIbl
 * 的 base64 rgba16float mip 链、RadianceHdrImage 的线性 RGB 像素),不新增任何
 * GPU 往返。对标 UE5/HDRP 默认开启的眼适应;EV 包络 ±2 避免电影级大跨度(Z1)。
 */

export interface PbrAutoExposureOptions {
  /** 适应时间常数 τ(秒);exp 平滑 95% 收敛 ≈ 3τ。缺省 0.35。 */
  readonly adaptationTimeConstantSeconds?: number;
  /** 帧间 EV 变化率上限(EV/秒),防闪烁硬顶;缺省 4。 */
  readonly maxEvPerSecond?: number;
  /** ±EV 包络半宽,曝光被夹在 [2^−env, 2^+env];缺省 2(Z1 建议 [−2,+2])。 */
  readonly evEnvelope?: number;
  /** 中灰锚点(线性亮度);缺省 0.18。 */
  readonly middleGrey?: number;
  /** 场景曝光系数(EV 偏置),承接既有场景曝光语义;缺省 1(不偏置)。 */
  readonly sceneExposureBias?: number;
}

export type PbrAutoExposureProvenance = "prefiltered-ibl-mip" | "radiance-hdr";

export interface PbrAutoExposureEstimate {
  readonly luminance: number;
  readonly provenance: PbrAutoExposureProvenance;
}

export type PbrAutoExposureEstimateOutcome =
  | { readonly status: "estimated"; readonly estimate: PbrAutoExposureEstimate }
  | { readonly status: "unavailable"; readonly reason: string };

export interface PbrAutoExposureFrameResult {
  readonly exposure: number;
  readonly luminance: number;
  readonly targetExposure: number;
  readonly provenance: PbrAutoExposureProvenance;
}

/** FrameMetrics.autoExposure:活跃帧给实测值,降级帧显式 fallbackReason,不伪零。 */
export interface PbrAutoExposureFrameMetrics {
  readonly active: boolean;
  readonly luminance?: number;
  readonly targetExposure?: number;
  readonly exposure?: number;
  readonly provenance?: PbrAutoExposureProvenance;
  readonly fallbackReason?: string;
  readonly adaptationTimeConstantSeconds: number;
  readonly evEnvelope: readonly [number, number];
}

/** 缺省配置(fail-closed 回退目标);数值出处见各字段注释。 */
export const DEFAULT_PBR_AUTO_EXPOSURE = Object.freeze({
  adaptationTimeConstantSeconds: 0.35, maxEvPerSecond: 4, evEnvelope: 2,
  middleGrey: 0.18, sceneExposureBias: 1,
});
export const MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE = 8;

export interface ResolvedPbrAutoExposureOptions {
  readonly adaptationTimeConstantSeconds: number;
  readonly maxEvPerSecond: number;
  readonly evEnvelope: number;
  readonly middleGrey: number;
  readonly sceneExposureBias: number;
}

const MAX_LATITUDE_SAMPLES = 64, MAX_AZIMUTH_SAMPLES = 128, MAX_MIP_SAMPLES_PER_FACE = 32;
const MIN_SAMPLED_SECONDS = 0, MAX_SAMPLED_SECONDS = 0.25;
const LUMA = [0.2126, 0.7152, 0.0722] as const;

function finitePositive(value: number | undefined, fallback: number, ceiling = Number.POSITIVE_INFINITY): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= ceiling ? value : fallback;
}

/** 非法配置 fail-closed 回缺省(G3 probeDirections 门先例),不抛——渲染循环必须存活。 */
export function resolvePbrAutoExposureOptions(options: PbrAutoExposureOptions = {}): ResolvedPbrAutoExposureOptions {
  return {
    adaptationTimeConstantSeconds: finitePositive(options.adaptationTimeConstantSeconds,
      DEFAULT_PBR_AUTO_EXPOSURE.adaptationTimeConstantSeconds),
    maxEvPerSecond: finitePositive(options.maxEvPerSecond, DEFAULT_PBR_AUTO_EXPOSURE.maxEvPerSecond),
    evEnvelope: finitePositive(options.evEnvelope, DEFAULT_PBR_AUTO_EXPOSURE.evEnvelope,
      MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE),
    middleGrey: finitePositive(options.middleGrey, DEFAULT_PBR_AUTO_EXPOSURE.middleGrey),
    sceneExposureBias: finitePositive(options.sceneExposureBias, DEFAULT_PBR_AUTO_EXPOSURE.sceneExposureBias),
  };
}

/**
 * 亮度 → 曝光目标。ACES 拟合前有 /0.6 归一化(pbrDisplayColorWgsl deepThreeAcesFit),
 * middle grey 0.18 对应 exposure = 0.6·middleGrey / L;叠加场景偏置后夹进 ±EV 包络。
 */
export function targetExposureFromLuminance(luminance: number, options: PbrAutoExposureOptions | ResolvedPbrAutoExposureOptions = {}): number {
  const config = resolvePbrAutoExposureOptions(options);
  const physicalExposure = config.middleGrey * 0.6 / Math.max(luminance, 1e-6);
  const ev = Math.log2(physicalExposure) + Math.log2(config.sceneExposureBias);
  return 2 ** Math.min(Math.max(ev, -config.evEnvelope), config.evEnvelope);
}

function luminanceOutcome(sum: number, weight: number, provenance: PbrAutoExposureProvenance): PbrAutoExposureEstimateOutcome {
  if (!(weight > 0)) return { status: "unavailable", reason: `${provenance}:no-samples` };
  const luminance = sum / weight;
  if (!Number.isFinite(luminance) || luminance <= 0) {
    return { status: "unavailable", reason: `${provenance}:luminance-not-positive` };
  }
  return { status: "estimated", estimate: Object.freeze({ luminance, provenance }) };
}

function texelOutcome(): PbrAutoExposureEstimateOutcome {
  return { status: "unavailable", reason: "environment-texel-invalid" };
}

/** 等距柱状全景:纬度立体角 ∝ sin(纬度),按行加权;抽样上限约 64×128。 */
function estimateFromRadianceHdr(image: RadianceHdrImage): PbrAutoExposureEstimateOutcome {
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || data.length < width * height * 3) {
    return { status: "unavailable", reason: "radiance-hdr:image-shape-invalid" };
  }
  const stepX = Math.max(1, Math.floor(width / MAX_AZIMUTH_SAMPLES));
  const stepY = Math.max(1, Math.floor(height / MAX_LATITUDE_SAMPLES));
  let weight = 0, sum = 0;
  for (let y = stepY >> 1; y < height; y += stepY) {
    const latitudeWeight = Math.sin(Math.PI * (y + 0.5) / height);
    for (let x = stepX >> 1; x < width; x += stepX) {
      const offset = (y * width + x) * 3;
      const texel = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
      if (!texel.every(Number.isFinite) || texel.some(value => value < 0)) return texelOutcome();
      sum += latitudeWeight * (LUMA[0] * texel[0]! + LUMA[1] * texel[1]! + LUMA[2] * texel[2]!);
      weight += latitudeWeight;
    }
  }
  return luminanceOutcome(sum, weight, "radiance-hdr");
}

/**
 * 预滤波 IBL:取最粗 specular mip(≈全环境平均辐射,静态代理),六面逐纹素按
 * 立体角 1/(1+s²+t²)^{3/2} 加权(权重归一,面基向量方向不影响)。字节经
 * visitIblBytes 流式校验后按 rgba16float 解码,全程 CPU、零 readback。
 */
function estimateFromPrefilteredIbl(ibl: RuntimePrefilteredIbl): PbrAutoExposureEstimateOutcome {
  const mips = ibl.specular?.mips;
  const mip = mips?.[mips.length - 1];
  if (!mips?.length || !mip) return { status: "unavailable", reason: "prefiltered-ibl:specular-mips-empty" };
  const size = mip.size;
  if (!Number.isSafeInteger(size) || size < 1) {
    return { status: "unavailable", reason: "prefiltered-ibl:mip-size-invalid" };
  }
  const bytes = new Uint8Array(size * size * 6 * 8);
  try {
    visitIblBytes(mip.dataBase64, bytes.length, "$.specular.mips[last]", (value, index) => { bytes[index] = value; });
  } catch (error) {
    return { status: "unavailable", reason: `prefiltered-ibl:mip-decode-failed(${(error as Error).message})` };
  }
  const words = new Uint16Array(bytes.buffer);
  const stride = Math.max(1, Math.ceil(size / MAX_MIP_SAMPLES_PER_FACE));
  let weight = 0, sum = 0;
  for (let face = 0; face < 6; face++) {
    for (let y = stride >> 1; y < size; y += stride) {
      for (let x = stride >> 1; x < size; x += stride) {
        const s = 2 * (x + 0.5) / size - 1, t = 2 * (y + 0.5) / size - 1;
        const texelWeight = 1 / (1 + s * s + t * t) ** 1.5;
        const word = (face * size * size + y * size + x) * 4;
        const texel = [decodeHalfFloat(words[word]!), decodeHalfFloat(words[word + 1]!),
          decodeHalfFloat(words[word + 2]!)];
        if (!texel.every(Number.isFinite) || texel.some(value => value < 0)) return texelOutcome();
        sum += texelWeight * (LUMA[0] * texel[0]! + LUMA[1] * texel[1]! + LUMA[2] * texel[2]!);
        weight += texelWeight;
      }
    }
  }
  return luminanceOutcome(sum, weight, "prefiltered-ibl-mip");
}

/** 环境源 → 亮度估计;studio 环境为 GPU compute 程序生成(CPU 无纹理数据),零 readback 约束下不可估计。 */
export function estimateEnvironmentLuminance(source: PbrEnvironmentSource | undefined): PbrAutoExposureEstimateOutcome {
  if (source === undefined) return { status: "unavailable", reason: "no-environment-source" };
  if (source.kind === "studio") return { status: "unavailable", reason: "studio-environment-is-gpu-procedural" };
  if (source.kind === "radiance-hdr") return estimateFromRadianceHdr(source.image);
  return estimateFromPrefilteredIbl(source.environment);
}

function clampSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, MIN_SAMPLED_SECONDS), MAX_SAMPLED_SECONDS) : 0;
}

/**
 * 逐渲染器实例的曝光状态:EV 空间指数平滑(时间常数参数化)+ 帧间收敛硬顶
 * (maxEvPerSecond·Δt)防闪烁;首帧/相机切换直取目标。无可靠亮度时 advance 返回
 * undefined,调用方保持 view.exposure(fail-closed)。
 */
export class PbrAutoExposureRuntime {
  private readonly config: ResolvedPbrAutoExposureOptions;
  private estimate: PbrAutoExposureEstimate | undefined;
  private fallbackReason = "no-environment-source";
  private currentEv = 0;
  private seeded = false;
  private lastNowMs = Number.NaN;

  constructor(options: PbrAutoExposureOptions = {}, initialSource?: PbrEnvironmentSource | undefined) {
    this.config = resolvePbrAutoExposureOptions(options);
    if (initialSource !== undefined) this.observeSource(initialSource);
  }

  /** 环境每次 stage 时观察新源;估计失败即落回 fail-closed 原因,不抛。 */
  observeSource(source: PbrEnvironmentSource | undefined): void {
    const outcome = estimateEnvironmentLuminance(source);
    this.estimate = outcome.status === "estimated" ? outcome.estimate : undefined;
    if (outcome.status === "unavailable") { this.fallbackReason = outcome.reason; this.seeded = false; }
  }

  /** 每个实际渲染帧调用一次;返回 undefined 表示本帧沿用调用方曝光。 */
  advance(nowMs: number, snap: boolean): PbrAutoExposureFrameResult | undefined {
    if (this.estimate === undefined) return undefined;
    const target = targetExposureFromLuminance(this.estimate.luminance, this.config);
    const targetEv = Math.log2(target);
    if (!this.seeded || snap) {
      this.currentEv = targetEv;
      this.seeded = true;
    } else {
      const deltaSeconds = clampSeconds((nowMs - this.lastNowMs) / 1000);
      const alpha = 1 - Math.exp(-deltaSeconds / this.config.adaptationTimeConstantSeconds);
      const maxStep = this.config.maxEvPerSecond * deltaSeconds;
      this.currentEv += Math.min(Math.max((targetEv - this.currentEv) * alpha, -maxStep), maxStep);
    }
    this.lastNowMs = nowMs;
    return Object.freeze({ exposure: 2 ** this.currentEv, luminance: this.estimate.luminance,
      targetExposure: target, provenance: this.estimate.provenance });
  }

  /** 遥测:活跃帧给实测值;降级帧显式给 fail-closed 原因,不伪零。 */
  metrics(): PbrAutoExposureFrameMetrics {
    const envelope: readonly [number, number] = [2 ** -this.config.evEnvelope, 2 ** this.config.evEnvelope];
    if (this.estimate === undefined) {
      return { active: false, fallbackReason: this.fallbackReason,
        adaptationTimeConstantSeconds: this.config.adaptationTimeConstantSeconds, evEnvelope: envelope };
    }
    return { active: true, luminance: this.estimate.luminance, targetExposure: targetExposureFromLuminance(this.estimate.luminance, this.config),
      exposure: 2 ** this.currentEv, provenance: this.estimate.provenance,
      adaptationTimeConstantSeconds: this.config.adaptationTimeConstantSeconds, evEnvelope: envelope };
  }
}
